<?php

require_once __DIR__ . '/lib/helpers.php';

require_admin();
apply_security_headers();

$id = (int) ($_GET['id'] ?? 0);
if ($id <= 0) {
    http_response_code(400);
    echo 'Invalid artifact id';
    exit;
}

$stmt = db()->prepare(
    'SELECT artifact_path, artifact_name, artifact_mime FROM commands WHERE id = ? AND artifact_path IS NOT NULL LIMIT 1'
);
$stmt->execute([$id]);
$artifact = $stmt->fetch();

if (!$artifact) {
    http_response_code(404);
    echo 'Artifact not found';
    exit;
}

$uploadRoot = realpath(app_config()['upload_dir']);
$file = realpath(app_config()['upload_dir'] . DIRECTORY_SEPARATOR . $artifact['artifact_path']);

$insideUploadRoot = $uploadRoot && $file && strpos($file, $uploadRoot . DIRECTORY_SEPARATOR) === 0;
if (!$insideUploadRoot || !is_file($file)) {
    http_response_code(404);
    echo 'Artifact file missing';
    exit;
}

$downloadName = safe_original_filename((string) $artifact['artifact_name']);
$mime = (string) ($artifact['artifact_mime'] ?: 'application/octet-stream');
$disposition = (!empty($_GET['inline']) && is_image_mime($mime)) ? 'inline' : 'attachment';
header('Content-Type: ' . ($artifact['artifact_mime'] ?: 'application/octet-stream'));
header('Content-Length: ' . filesize($file));
header('Cache-Control: private, no-store, max-age=0');
header('Content-Disposition: ' . $disposition . '; filename="' . $downloadName . '"');
readfile($file);
