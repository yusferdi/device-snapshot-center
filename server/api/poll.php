<?php

require_once __DIR__ . '/../lib/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['ok' => false, 'error' => 'POST required'], 405);
}

$device = require_api_device();
$body = read_json_body();
$pdo = db();
$liveConfig = app_config()['live'] ?? [];

$agentVersion = clean_text((string) ($body['agent_version'] ?? ''), 40);
$agentBootId = preg_replace('/[^A-Za-z0-9._-]/', '', clean_text((string) ($body['agent_boot_id'] ?? ''), 64)) ?: '';
$agentBootStartedAt = max(0, (int) ($body['agent_boot_started_at'] ?? 0));
if ($agentBootId === '' && !empty($device['agent_boot_id'])) {
    json_response(['ok' => false, 'error' => 'Agent must be restarted with boot-session support'], 409);
}
if ($agentBootId !== '' && $agentBootStartedAt <= 0) {
    json_response(['ok' => false, 'error' => 'agent_boot_started_at is required'], 400);
}
$agentSession = $agentBootId !== '' && (string) ($device['agent_boot_id'] ?? '') === $agentBootId
    ? ['accepted' => true, 'changed' => false, 'recovered' => 0, 'discarded_live' => 0]
    : claim_agent_boot((int) $device['id'], $agentBootId, $agentBootStartedAt);
if (empty($agentSession['accepted'])) {
    json_response(['ok' => false, 'error' => 'Agent process was superseded by a newer boot'], 409);
}
prune_expired_commands((int) $device['id']);

$transportMode = (string) ($device['transport_mode'] ?? 'poll');
if (!array_key_exists($transportMode, transport_modes())) {
    $transportMode = 'poll';
}
$serverLongPollMs = effective_agent_long_poll_ms($transportMode);
$requestedWaitMs = max(0, min(25000, (int) ($body['wait_ms'] ?? $serverLongPollMs)));
$waitMs = min($requestedWaitMs, $serverLongPollMs);
$probeMs = max(50, min(1000, (int) ($liveConfig['agent_poll_probe_ms'] ?? 120)));
$modeRecheckMs = max(250, min(5000, (int) ($liveConfig['agent_mode_recheck_ms'] ?? 1000)));
$deadline = microtime(true) + ($waitMs / 1000);
$nextModeCheckAt = microtime(true);

$stmt = $pdo->prepare(
    $agentVersion === ''
        ? 'UPDATE devices
           SET last_seen = NOW()
           WHERE id = ? AND (last_seen IS NULL OR last_seen < DATE_SUB(NOW(), INTERVAL 5 SECOND))'
        : 'UPDATE devices
           SET last_seen = NOW(), agent_version = ?
           WHERE id = ?
             AND (
               last_seen IS NULL
               OR last_seen < DATE_SUB(NOW(), INTERVAL 5 SECOND)
               OR agent_version IS NULL
               OR agent_version <> ?
             )'
);
$agentVersion === ''
    ? $stmt->execute([(int) $device['id']])
    : $stmt->execute([$agentVersion, (int) $device['id'], $agentVersion]);

$queuedCommandStmt = $pdo->prepare(
    "SELECT * FROM commands
     WHERE device_id = ?
       AND status = 'queued'
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY
       CASE action
         WHEN 'mouse_input' THEN 0
         WHEN 'keyboard_state' THEN 0
         WHEN 'mouse_click' THEN 1
         WHEN 'keyboard_input' THEN 1
         WHEN 'capture_screen' THEN 3
         ELSE 2
       END ASC,
       id ASC
     LIMIT 1"
);
$lockCommandStmt = $pdo->prepare(
    "SELECT * FROM commands
     WHERE id = ?
       AND device_id = ?
       AND status = 'queued'
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1
     FOR UPDATE"
);
$lockAgentSessionStmt = $pdo->prepare(
    'SELECT agent_boot_id
     FROM devices
     WHERE id = ?
     LIMIT 1
     FOR UPDATE'
);
$modeStmt = $pdo->prepare('SELECT transport_mode FROM devices WHERE id = ? LIMIT 1');
$command = null;
$agentSuperseded = false;
do {
    $queuedCommandStmt->execute([(int) $device['id']]);
    $candidate = $queuedCommandStmt->fetch();

    if ($candidate) {
        $pdo->beginTransaction();
        try {
            $lockAgentSessionStmt->execute([(int) $device['id']]);
            $currentBootId = (string) ($lockAgentSessionStmt->fetchColumn() ?: '');
            if ($agentBootId !== '' && $currentBootId !== $agentBootId) {
                $pdo->commit();
                $agentSuperseded = true;
                break;
            }

            $lockCommandStmt->execute([(int) $candidate['id'], (int) $device['id']]);
            $candidate = $lockCommandStmt->fetch();

            if (!$candidate) {
                $pdo->commit();
            } elseif (!array_key_exists($candidate['action'], allowed_actions())) {
                $stmt = $pdo->prepare(
                    "UPDATE commands
                     SET status = 'failed', error_text = 'Action is not allowed by server config', completed_at = NOW()
                     WHERE id = ?"
                );
                $stmt->execute([(int) $candidate['id']]);
                $pdo->commit();
            } elseif (!device_action_allowed($device, (string) $candidate['action'])) {
                $stmt = $pdo->prepare(
                    "UPDATE commands
                     SET status = 'failed', error_text = 'Action is blocked by this device permission profile', completed_at = NOW()
                     WHERE id = ?"
                );
                $stmt->execute([(int) $candidate['id']]);
                $pdo->commit();
            } else {
                $stmt = $pdo->prepare("UPDATE commands SET status = 'running', claimed_at = NOW() WHERE id = ?");
                $stmt->execute([(int) $candidate['id']]);
                $pdo->commit();
                $command = $candidate;
            }
        } catch (Throwable $error) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $error;
        }
    }

    if ($command || microtime(true) >= $deadline) {
        break;
    }

    $now = microtime(true);
    if ($now >= $nextModeCheckAt) {
        $nextModeCheckAt = $now + ($modeRecheckMs / 1000);
        $modeStmt->execute([(int) $device['id']]);
        $latestTransportMode = (string) ($modeStmt->fetchColumn() ?: 'poll');
        if (array_key_exists($latestTransportMode, transport_modes())) {
            $transportMode = $latestTransportMode;
        }
        if ($waitMs > 0 && effective_agent_long_poll_ms($transportMode) === 0) {
            $waitMs = 0;
            break;
        }
    }

    $remainingMs = max(1, (int) (($deadline - microtime(true)) * 1000));
    usleep(min($probeMs, $remainingMs) * 1000);
} while (true);

if ($agentSuperseded) {
    json_response(['ok' => false, 'error' => 'Agent process was superseded by a newer boot'], 409);
}

$transport = [
    'requested' => $transportMode,
    'selected' => $waitMs > 0 ? 'http-long-poll' : 'http-poll',
    'available' => effective_agent_long_poll_ms('long-poll') > 0
        ? ['http-poll', 'http-long-poll']
        : ['http-poll'],
    'wait_ms' => $waitMs,
    'probe_ms' => $probeMs,
    'mode_recheck_ms' => $modeRecheckMs,
    'pointer_batch_ms' => (int) ($liveConfig['pointer_batch_ms'] ?? 48),
    'pointer_max_events' => (int) ($liveConfig['pointer_max_events'] ?? 64),
    'pointer_release_timeout_ms' => (int) ($liveConfig['pointer_release_timeout_ms'] ?? 2500),
];
$pdo->prepare('UPDATE devices SET transport_selected = ? WHERE id = ? AND transport_selected <> ?')
    ->execute([$transport['selected'], (int) $device['id'], $transport['selected']]);
$pollAfterMs = effective_agent_poll_after_ms($device, $waitMs > 0);
$transport['live_profile'] = normalize_live_profile((string) ($device['live_profile'] ?? 'flow'));
$transport['live_active'] = !empty($device['live_active']);
$transport['next_poll_ms'] = $pollAfterMs;

if (!$command) {
    json_response([
        'ok' => true,
        'command' => null,
        'poll_after_ms' => $pollAfterMs,
        'transport' => $transport,
        'agent_session' => $agentSession,
    ]);
}

if (empty($command['expires_at']) && !is_ephemeral_action((string) $command['action'])) {
    audit_event((int) $device['id'], (int) $command['id'], 'command_claimed', [
        'action' => $command['action'],
        'transport' => $transport['selected'],
    ]);
}

$payload = null;
if ($command['payload_json'] !== null && trim((string) $command['payload_json']) !== '') {
    $payload = json_decode((string) $command['payload_json'], true);
}

json_response([
    'ok' => true,
    'command' => [
        'id' => (int) $command['id'],
        'action' => $command['action'],
        'payload' => is_array($payload) ? $payload : new stdClass(),
    ],
    'poll_after_ms' => 0,
    'transport' => $transport,
    'agent_session' => $agentSession,
]);
