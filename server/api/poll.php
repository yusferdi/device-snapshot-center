<?php

require_once __DIR__ . '/../lib/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['ok' => false, 'error' => 'POST required'], 405);
}

$device = require_api_device();
$body = read_json_body();
$pdo = db();

$agentVersion = clean_text((string) ($body['agent_version'] ?? ''), 40);
$stmt = $pdo->prepare(
    $agentVersion === ''
        ? 'UPDATE devices SET last_seen = NOW() WHERE id = ?'
        : 'UPDATE devices SET last_seen = NOW(), agent_version = ? WHERE id = ?'
);
$agentVersion === ''
    ? $stmt->execute([(int) $device['id']])
    : $stmt->execute([$agentVersion, (int) $device['id']]);

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
    $command = $stmt->fetch();

    if (!$command) {
        $pdo->commit();
        json_response(['ok' => true, 'command' => null]);
    }

    if (!array_key_exists($command['action'], allowed_actions())) {
        $stmt = $pdo->prepare(
            "UPDATE commands
             SET status = 'failed', error_text = 'Action is not allowed by server config', completed_at = NOW()
             WHERE id = ?"
        );
        $stmt->execute([(int) $command['id']]);
        $pdo->commit();
        json_response(['ok' => true, 'command' => null]);
    }

    if (!device_action_allowed($device, (string) $command['action'])) {
        $stmt = $pdo->prepare(
            "UPDATE commands
             SET status = 'failed', error_text = 'Action is blocked by this device permission profile', completed_at = NOW()
             WHERE id = ?"
        );
        $stmt->execute([(int) $command['id']]);
        $pdo->commit();
        json_response(['ok' => true, 'command' => null]);
    }

    $stmt = $pdo->prepare("UPDATE commands SET status = 'running', claimed_at = NOW() WHERE id = ?");
    $stmt->execute([(int) $command['id']]);
    $pdo->commit();
} catch (Throwable $error) {
    $pdo->rollBack();
    throw $error;
}

audit_event((int) $device['id'], (int) $command['id'], 'command_claimed', [
    'action' => $command['action'],
]);

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
]);
