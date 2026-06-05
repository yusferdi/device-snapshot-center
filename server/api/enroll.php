<?php

require_once __DIR__ . '/../lib/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['ok' => false, 'error' => 'POST required'], 405);
}

$body = read_json_body();
$config = app_config();

$enrollmentCode = (string) ($config['enrollment_code'] ?? '');
if ($enrollmentCode === '') {
    json_response(['ok' => false, 'error' => 'Enrollment is disabled until enrollment_code is configured'], 503);
}

if (!hash_equals($enrollmentCode, (string) ($body['enrollment_code'] ?? ''))) {
    json_response(['ok' => false, 'error' => 'Invalid enrollment code'], 403);
}

$deviceUid = preg_replace('/[^a-zA-Z0-9_.:-]/', '', (string) ($body['device_uid'] ?? ''));
if ($deviceUid === '') {
    json_response(['ok' => false, 'error' => 'device_uid required'], 400);
}

$name = trim((string) ($body['name'] ?? $deviceUid));
$platform = trim((string) ($body['platform'] ?? ''));
$hostname = trim((string) ($body['hostname'] ?? ''));
$agentVersion = trim((string) ($body['agent_version'] ?? ''));
$token = bin2hex(random_bytes(32));
$tokenHash = hash('sha256', $token);

$pdo = db();
$stmt = $pdo->prepare('SELECT id FROM devices WHERE device_uid = ? LIMIT 1');
$stmt->execute([$deviceUid]);
$existing = $stmt->fetch();

if ($existing) {
    $stmt = $pdo->prepare(
        'UPDATE devices
         SET name = ?, api_token_hash = ?, platform = ?, hostname = ?, agent_version = ?, last_seen = NOW()
         WHERE id = ?'
    );
    $stmt->execute([$name, $tokenHash, $platform, $hostname, $agentVersion, (int) $existing['id']]);
    $deviceId = (int) $existing['id'];
    audit_event($deviceId, null, 'device_reenrolled', ['device_uid' => $deviceUid]);
} else {
    $stmt = $pdo->prepare(
        'INSERT INTO devices (device_uid, name, api_token_hash, platform, hostname, agent_version, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, NOW())'
    );
    $stmt->execute([$deviceUid, $name, $tokenHash, $platform, $hostname, $agentVersion]);
    $deviceId = (int) $pdo->lastInsertId();
    audit_event($deviceId, null, 'device_enrolled', ['device_uid' => $deviceUid]);
}

json_response([
    'ok' => true,
    'device_id' => $deviceId,
    'device_token' => $token,
]);
