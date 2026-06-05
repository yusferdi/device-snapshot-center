<?php

require_once __DIR__ . '/../lib/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['ok' => false, 'error' => 'POST required'], 405);
}

$device = require_api_device();
$body = read_json_body();

$commandId = (int) ($body['command_id'] ?? 0);
$status = (string) ($body['status'] ?? '');
if ($commandId <= 0 || !in_array($status, ['succeeded', 'failed'], true)) {
    json_response(['ok' => false, 'error' => 'command_id and valid status are required'], 400);
}

$resultText = isset($body['result_text']) ? (string) $body['result_text'] : null;
$resultJson = isset($body['result_json'])
    ? json_encode($body['result_json'], JSON_UNESCAPED_SLASHES)
    : null;
$errorText = isset($body['error_text']) ? (string) $body['error_text'] : null;

$stmt = db()->prepare(
    "UPDATE commands
     SET status = ?, result_text = ?, result_json = ?, error_text = ?, completed_at = NOW()
     WHERE id = ? AND device_id = ? AND status IN ('running', 'queued')"
);
$stmt->execute([$status, $resultText, $resultJson, $errorText, $commandId, (int) $device['id']]);

if ($stmt->rowCount() < 1) {
    json_response(['ok' => false, 'error' => 'Task not found or already completed'], 404);
}

audit_event((int) $device['id'], $commandId, 'command_completed', [
    'status' => $status,
]);

$stmt = db()->prepare('SELECT action FROM commands WHERE id = ? AND device_id = ? LIMIT 1');
$stmt->execute([$commandId, (int) $device['id']]);
$completedCommand = $stmt->fetch();
if ($status === 'succeeded' && ($completedCommand['action'] ?? '') === 'capture_screen') {
    $deleted = prune_screen_captures((int) $device['id']);
    if ($deleted > 0) {
        audit_event((int) $device['id'], $commandId, 'screen_capture_pruned', ['deleted' => $deleted]);
    }
}

json_response(['ok' => true]);
