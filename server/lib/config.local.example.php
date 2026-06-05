<?php

$env = static function (string $key, $default = null) {
    $value = getenv($key);
    return $value === false ? $default : $value;
};

$envBool = static function (string $key, bool $default = false) use ($env): bool {
    $value = $env($key);
    if ($value === null || $value === '') {
        return $default;
    }

    return in_array(strtolower((string) $value), ['1', 'true', 'yes', 'on'], true);
};

$envInt = static function (string $key, int $default) use ($env): int {
    $value = $env($key);
    if ($value === null || $value === '' || !is_numeric($value)) {
        return $default;
    }

    return max(0, (int) $value);
};

return [
    'app' => [
        'base_path' => $env('APP_BASE_PATH', 'auto'),
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
    'upload_dir' => $env(
        'APP_UPLOAD_DIR',
        dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'uploads'
    ),
    'max_upload_bytes' => $envInt('APP_MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
    'max_json_body_bytes' => $envInt('APP_MAX_JSON_BODY_BYTES', 1024 * 1024),
    'allowed_artifact_mime_prefixes' => [
        'text/',
        'application/json',
        'application/zip',
        'application/gzip',
        'application/x-gzip',
        'application/octet-stream',
    ],
];
