<?php

require_once __DIR__ . '/../lib/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_response(['ok' => false, 'error' => 'GET required'], 405);
}

$device = require_api_device();
$commandId = (int) ($_GET['command_id'] ?? 0);
if ($commandId <= 0) {
    http_response_code(400);
    echo 'command_id required';
    exit;
}

$stmt = db()->prepare(
    "SELECT artifact_path, artifact_name, artifact_mime
     FROM commands
     WHERE id = ?
       AND device_id = ?
       AND action = 'file_put'
       AND artifact_path IS NOT NULL
     LIMIT 1"
);
$stmt->execute([$commandId, (int) $device['id']]);
$artifact = $stmt->fetch();
if (!$artifact) {
    http_response_code(404);
    echo 'Artifact not found';
    exit;
}

$uploadRoot = realpath(app_config()['upload_dir']);
$file = realpath(app_config()['upload_dir'] . DIRECTORY_SEPARATOR . $artifact['artifact_path']);
if (!$uploadRoot || !$file || strpos($file, $uploadRoot . DIRECTORY_SEPARATOR) !== 0 || !is_file($file)) {
    http_response_code(404);
    echo 'Artifact file missing';
    exit;
}

apply_security_headers();
$downloadName = safe_original_filename((string) $artifact['artifact_name']);
header('Content-Type: ' . ($artifact['artifact_mime'] ?: 'application/octet-stream'));
header('Content-Length: ' . filesize($file));
header('Cache-Control: private, no-store, max-age=0');
header('Content-Disposition: attachment; filename="' . $downloadName . '"');
readfile($file);
