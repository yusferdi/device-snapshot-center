<?php

require_once __DIR__ . '/lib/helpers.php';

$files = [];
foreach (app_release_files() as $name => $path) {
    $files[$name] = [
        'present' => is_file($path),
        'bytes' => is_file($path) ? (int) filesize($path) : null,
        'sha256' => is_file($path) && is_readable($path)
            ? substr((string) hash_file('sha256', $path), 0, 12)
            : null,
    ];
}

header('X-App-Release: ' . app_release());
json_response([
    'ok' => true,
    'app' => 'Device Snapshot Center',
    'contract_version' => 3,
    'release' => app_release(),
    'base_path' => app_base_path(),
    'features' => [
        'adaptive_polling' => true,
        'asset_cache_busting' => true,
        'capture_queue_compaction' => true,
        'deployment_verification' => true,
        'idle_agent_status' => true,
        'agent_boot_recovery' => true,
        'live_command_expiry' => true,
    ],
    'files' => $files,
    'generated_at' => gmdate('c'),
]);
