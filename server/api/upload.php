<?php

require_once __DIR__ . '/../lib/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['ok' => false, 'error' => 'POST required'], 405);
}

$device = require_api_device();
$config = app_config();
$commandId = (int) ($_POST['command_id'] ?? 0);
$maxUploadBytes = (int) ($config['max_upload_bytes'] ?? 0);

if ($commandId <= 0) {
    json_response(['ok' => false, 'error' => 'command_id required'], 400);
}

if (empty($_FILES['artifact']) || !is_uploaded_file($_FILES['artifact']['tmp_name'])) {
    json_response(['ok' => false, 'error' => 'artifact file required'], 400);
}

if ((int) $_FILES['artifact']['size'] <= 0) {
    json_response(['ok' => false, 'error' => 'artifact cannot be empty'], 400);
}

if ($maxUploadBytes <= 0 || (int) $_FILES['artifact']['size'] > $maxUploadBytes) {
    json_response(['ok' => false, 'error' => 'artifact too large'], 413);
}

$stmt = db()->prepare('SELECT id FROM commands WHERE id = ? AND device_id = ? LIMIT 1');
$stmt->execute([$commandId, (int) $device['id']]);
if (!$stmt->fetch()) {
    json_response(['ok' => false, 'error' => 'Task not found for this device'], 404);
}

$uploadRoot = rtrim((string) $config['upload_dir'], DIRECTORY_SEPARATOR);
if (!is_dir($uploadRoot) && !mkdir($uploadRoot, 0775, true)) {
    json_response(['ok' => false, 'error' => 'Cannot create upload directory'], 500);
}

$resolvedUploadRoot = realpath($uploadRoot);
if (!$resolvedUploadRoot || !is_dir($resolvedUploadRoot)) {
    json_response(['ok' => false, 'error' => 'Upload directory is not available'], 500);
}

$bucket = date('Y-m');
$targetDir = $resolvedUploadRoot . DIRECTORY_SEPARATOR . $bucket;
if (!is_dir($targetDir) && !mkdir($targetDir, 0775, true)) {
    json_response(['ok' => false, 'error' => 'Cannot create upload bucket'], 500);
}

$originalName = safe_original_filename((string) $_FILES['artifact']['name']);
$safeName = safe_original_filename($originalName);
$storedName = bin2hex(random_bytes(12)) . '-' . $safeName;
$target = $targetDir . DIRECTORY_SEPARATOR . $storedName;

if (!move_uploaded_file($_FILES['artifact']['tmp_name'], $target)) {
    json_response(['ok' => false, 'error' => 'Failed to store upload'], 500);
}

$relativePath = $bucket . '/' . $storedName;
$mime = 'application/octet-stream';
if (function_exists('finfo_open')) {
    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    if ($finfo) {
        $detected = finfo_file($finfo, $target);
        finfo_close($finfo);
        if (is_string($detected) && $detected !== '') {
            $mime = $detected;
        }
    }
}

if (!mime_allowed($mime)) {
    @unlink($target);
    json_response(['ok' => false, 'error' => 'artifact mime type is not allowed'], 415);
}

$stmt = db()->prepare(
    'UPDATE commands SET artifact_path = ?, artifact_name = ?, artifact_mime = ? WHERE id = ? AND device_id = ?'
);
$stmt->execute([$relativePath, $originalName, $mime, $commandId, (int) $device['id']]);

audit_event((int) $device['id'], $commandId, 'artifact_uploaded', [
    'name' => $originalName,
    'bytes' => (int) $_FILES['artifact']['size'],
]);

json_response([
    'ok' => true,
    'artifact' => [
        'path' => $relativePath,
        'name' => $originalName,
        'mime' => $mime,
    ],
]);
