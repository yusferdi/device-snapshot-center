<?php

function load_dotenv_file(string $path): void
{
    if (!is_file($path) || !is_readable($path)) {
        return;
    }

    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (!is_array($lines)) {
        return;
    }

    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || substr($line, 0, 1) === '#') {
            continue;
        }

        if (substr($line, 0, 7) === 'export ') {
            $line = trim(substr($line, 7));
        }

        $separator = strpos($line, '=');
        if ($separator === false) {
            continue;
        }

        $key = trim(substr($line, 0, $separator));
        $value = trim(substr($line, $separator + 1));
        if ($key === '' || getenv($key) !== false) {
            continue;
        }

        if (
            strlen($value) >= 2
            && (($value[0] === '"' && substr($value, -1) === '"') || ($value[0] === "'" && substr($value, -1) === "'"))
        ) {
            $value = substr($value, 1, -1);
        }

        $value = str_replace(['\n', '\r'], ["\n", "\r"], $value);
        putenv($key . '=' . $value);
        $_ENV[$key] = $value;
        $_SERVER[$key] = $value;
    }
}

load_dotenv_file(dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . '.env');
load_dotenv_file(dirname(__DIR__) . DIRECTORY_SEPARATOR . '.env');

$env = static function (string $key, $default = null) {
    $value = getenv($key);
    return $value === false ? $default : $value;
};

$envInt = static function (string $key, int $default) use ($env): int {
    $value = $env($key);
    if ($value === null || $value === '' || !is_numeric($value)) {
        return $default;
    }

    return max(0, (int) $value);
};

$envNonEmpty = static function (string $key, string $default) use ($env): string {
    $value = $env($key);
    if ($value === null || trim((string) $value) === '') {
        return $default;
    }

    return (string) $value;
};

$envBool = static function (string $key, bool $default = false) use ($env): bool {
    $value = $env($key);
    if ($value === null || $value === '') {
        return $default;
    }

    return in_array(strtolower((string) $value), ['1', 'true', 'yes', 'on'], true);
};

$config = [
    'app' => [
        'base_path' => $env('APP_BASE_PATH', 'auto'),
        'release' => $env('APP_RELEASE', 'auto'),
        'session_name' => $env('APP_SESSION_NAME', 'dcc_session'),
        'secure_cookies' => $envBool('APP_SECURE_COOKIES', false),
        'behind_https_proxy' => $envBool('APP_BEHIND_HTTPS_PROXY', false),
        'login_max_attempts' => $envInt('APP_LOGIN_MAX_ATTEMPTS', 8),
        'login_window_seconds' => $envInt('APP_LOGIN_WINDOW_SECONDS', 600),
    ],
    'db' => [
        'dsn' => $env('APP_DB_DSN', ''),
        'username' => $env('APP_DB_USER', ''),
        'password' => $env('APP_DB_PASSWORD', ''),
    ],
    'admin' => [
        'username' => $env('APP_ADMIN_USER', ''),
        'password' => $env('APP_ADMIN_PASSWORD', ''),
        'password_hash' => $env('APP_ADMIN_PASSWORD_HASH', ''),
    ],
    'enrollment_code' => $env('APP_ENROLLMENT_CODE', ''),
    'upload_dir' => $envNonEmpty(
        'APP_UPLOAD_DIR',
        dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'uploads'
    ),
    'max_upload_bytes' => $envInt('APP_MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
    'max_json_body_bytes' => $envInt('APP_MAX_JSON_BODY_BYTES', 1024 * 1024),
    'live' => [
        'capture_interval_ms' => max(800, $envInt('APP_LIVE_CAPTURE_INTERVAL_MS', 1800)),
        'status_interval_ms' => max(500, $envInt('APP_LIVE_STATUS_INTERVAL_MS', 900)),
        'idle_status_interval_ms' => max(2000, min(60000, $envInt('APP_IDLE_STATUS_INTERVAL_MS', 5000))),
        'agent_online_window_seconds' => max(15, min(600, $envInt('APP_AGENT_ONLINE_WINDOW_SECONDS', 60))),
        'frame_retention' => max(1, $envInt('APP_LIVE_FRAME_RETENTION', 12)),
        'agent_long_poll_ms' => min(25000, $envInt('APP_AGENT_LONG_POLL_MS', 15000)),
        'agent_poll_probe_ms' => max(50, min(1000, $envInt('APP_AGENT_POLL_PROBE_MS', 120))),
        'agent_mode_recheck_ms' => max(250, min(5000, $envInt('APP_AGENT_MODE_RECHECK_MS', 1000))),
        'allow_cli_server_long_poll' => $envBool('APP_AGENT_LONG_POLL_ALLOW_CLI_SERVER', false),
        'activity_ttl_seconds' => max(3, min(60, $envInt('APP_LIVE_ACTIVITY_TTL_SECONDS', 12))),
        'agent_poll_idle_ms' => max(100, min(5000, $envInt('APP_AGENT_POLL_IDLE_MS', 500))),
        'agent_poll_eco_ms' => max(50, min(2000, $envInt('APP_AGENT_POLL_ECO_MS', 180))),
        'agent_poll_flow_ms' => max(20, min(1000, $envInt('APP_AGENT_POLL_FLOW_MS', 75))),
        'agent_poll_burst_ms' => max(10, min(500, $envInt('APP_AGENT_POLL_BURST_MS', 30))),
        'pointer_batch_ms' => max(24, min(250, $envInt('APP_POINTER_BATCH_MS', 48))),
        'pointer_max_events' => max(4, min(128, $envInt('APP_POINTER_MAX_EVENTS', 64))),
        'pointer_release_timeout_ms' => max(500, min(10000, $envInt('APP_POINTER_RELEASE_TIMEOUT_MS', 2500))),
        'pointer_command_ttl_seconds' => max(1, min(30, $envInt('APP_POINTER_COMMAND_TTL_SECONDS', 3))),
        'input_command_ttl_seconds' => max(1, min(30, $envInt('APP_INPUT_COMMAND_TTL_SECONDS', 5))),
        'wheel_pixel_per_line' => max(8, min(160, $envInt('APP_WHEEL_PIXEL_PER_LINE', 16))),
        'wheel_page_lines' => max(3, min(60, $envInt('APP_WHEEL_PAGE_LINES', 12))),
        'wheel_max_lines' => max(3, min(120, $envInt('APP_WHEEL_MAX_LINES', 90))),
    ],
    'allowed_artifact_mime_prefixes' => [
        'image/',
        'text/',
        'application/json',
        'application/zip',
        'application/gzip',
        'application/x-gzip',
        'application/octet-stream',
    ],
    'allowed_actions' => [
        'health_check' => 'Cek kesehatan',
        'system_info' => 'Info sistem',
        'network_interfaces' => 'Interface jaringan',
        'list_log_files' => 'Daftar file log',
        'upload_log_file' => 'Upload file log',
        'run_diagnostic' => 'Jalankan diagnostic',
        'capture_screen' => 'Ambil snapshot layar',
        'mouse_click' => 'Klik mouse',
        'mouse_input' => 'Input pointer realtime',
        'keyboard_input' => 'Input keyboard',
        'keyboard_state' => 'Input keyboard stateful',
        'clipboard_write' => 'Clipboard: tulis/paste text',
        'file_list' => 'File manager: daftar file',
        'file_pull' => 'File manager: ambil file',
        'file_put' => 'File manager: kirim file',
        'record_session' => 'Rekam sesi layar',
    ],
];

$localConfig = __DIR__ . DIRECTORY_SEPARATOR . 'config.local.php';
if (is_file($localConfig)) {
    $local = require $localConfig;
    if (is_array($local)) {
        $config = array_replace_recursive($config, $local);
    }
}

return $config;
