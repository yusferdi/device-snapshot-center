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
$serverLongPollMs = effective_agent_long_poll_ms();
$requestedWaitMs = max(0, min(25000, (int) ($body['wait_ms'] ?? $serverLongPollMs)));
$waitMs = min($requestedWaitMs, $serverLongPollMs);
$probeMs = max(50, min(1000, (int) ($liveConfig['agent_poll_probe_ms'] ?? 120)));
$deadline = microtime(true) + ($waitMs / 1000);

$stmt = $pdo->prepare(
    $agentVersion === ''
        ? 'UPDATE devices SET last_seen = NOW() WHERE id = ?'
        : 'UPDATE devices SET last_seen = NOW(), agent_version = ? WHERE id = ?'
);
$agentVersion === ''
    ? $stmt->execute([(int) $device['id']])
    : $stmt->execute([$agentVersion, (int) $device['id']]);

$command = null;
do {
    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare(
            "SELECT * FROM commands
             WHERE device_id = ? AND status = 'queued'
             ORDER BY id ASC
             LIMIT 1
             FOR UPDATE"
        );
        $stmt->execute([(int) $device['id']]);
        $candidate = $stmt->fetch();

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

    if ($command || microtime(true) >= $deadline) {
        break;
    }

    $remainingMs = max(1, (int) (($deadline - microtime(true)) * 1000));
    usleep(min($probeMs, $remainingMs) * 1000);
} while (true);

$transport = [
    'selected' => $waitMs > 0 ? 'http-long-poll' : 'http-poll',
    'available' => $waitMs > 0 ? ['http-long-poll', 'http-poll'] : ['http-poll'],
    'wait_ms' => $waitMs,
    'probe_ms' => $probeMs,
    'pointer_batch_ms' => (int) ($liveConfig['pointer_batch_ms'] ?? 48),
    'pointer_max_events' => (int) ($liveConfig['pointer_max_events'] ?? 64),
    'pointer_release_timeout_ms' => (int) ($liveConfig['pointer_release_timeout_ms'] ?? 2500),
];

if (!$command) {
    json_response([
        'ok' => true,
        'command' => null,
        'poll_after_ms' => $waitMs > 0 ? 15 : 250,
        'transport' => $transport,
    ]);
}

if (!is_ephemeral_action((string) $command['action'])) {
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
]);
