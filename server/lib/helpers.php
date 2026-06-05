<?php

require_once __DIR__ . DIRECTORY_SEPARATOR . 'db.php';

function json_response(array $data, int $status = 200): void
{
    apply_security_headers();
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, max-age=0');
    echo json_encode($data, JSON_UNESCAPED_SLASHES);
    exit;
}

function read_json_body(): array
{
    $maxBytes = (int) (app_config()['max_json_body_bytes'] ?? 0);
    $contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($maxBytes > 0 && $contentLength > $maxBytes) {
        json_response(['ok' => false, 'error' => 'JSON body too large'], 413);
    }

    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        json_response(['ok' => false, 'error' => 'Invalid JSON body'], 400);
    }

    return $decoded;
}

function bearer_token(): ?string
{
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if ($header === '' && function_exists('apache_request_headers')) {
        $headers = apache_request_headers();
        $header = $headers['Authorization'] ?? $headers['authorization'] ?? '';
    }

    if (!preg_match('/^Bearer\s+(.+)$/i', $header, $matches)) {
        return null;
    }

    return trim($matches[1]);
}

function is_https_request(): bool
{
    if (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off') {
        return true;
    }

    $config = app_config()['app'] ?? [];
    if (!empty($config['behind_https_proxy'])) {
        $proto = strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''));
        return $proto === 'https';
    }

    return false;
}

function apply_security_headers(): void
{
    if (headers_sent()) {
        return;
    }

    header("Content-Security-Policy: default-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    header('Referrer-Policy: no-referrer');
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Cross-Origin-Opener-Policy: same-origin');
    if (is_https_request()) {
        header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
    }
}

function normalize_base_path(?string $path): string
{
    $path = trim((string) $path);
    if ($path === '' || $path === '/') {
        return '';
    }

    $path = '/' . trim($path, '/');
    return $path === '/' ? '' : $path;
}

function detected_base_path(): string
{
    $script = str_replace('\\', '/', (string) ($_SERVER['SCRIPT_NAME'] ?? ''));
    $dir = str_replace('\\', '/', dirname($script));
    if ($dir === '.' || $dir === '/') {
        return '';
    }

    if (basename($dir) === 'api') {
        $dir = dirname($dir);
    }

    return normalize_base_path($dir);
}

function app_base_path(): string
{
    static $basePath = null;
    if ($basePath !== null) {
        return $basePath;
    }

    $configured = (string) (app_config()['app']['base_path'] ?? 'auto');
    $basePath = strtolower($configured) === 'auto'
        ? detected_base_path()
        : normalize_base_path($configured);

    return $basePath;
}

function app_url(string $path = ''): string
{
    $base = app_base_path();
    $path = trim($path);
    if ($path === '') {
        return $base === '' ? '/' : $base . '/';
    }

    return ($base === '' ? '' : $base) . '/' . ltrim($path, '/');
}

function app_release_files(): array
{
    $serverRoot = dirname(__DIR__);
    return [
        'index.php' => $serverRoot . DIRECTORY_SEPARATOR . 'index.php',
        'artifact.php' => $serverRoot . DIRECTORY_SEPARATOR . 'artifact.php',
        'version.php' => $serverRoot . DIRECTORY_SEPARATOR . 'version.php',
        'api/artifact-download.php' => $serverRoot . DIRECTORY_SEPARATOR . 'api' . DIRECTORY_SEPARATOR . 'artifact-download.php',
        'api/complete.php' => $serverRoot . DIRECTORY_SEPARATOR . 'api' . DIRECTORY_SEPARATOR . 'complete.php',
        'api/enroll.php' => $serverRoot . DIRECTORY_SEPARATOR . 'api' . DIRECTORY_SEPARATOR . 'enroll.php',
        'api/live.php' => $serverRoot . DIRECTORY_SEPARATOR . 'api' . DIRECTORY_SEPARATOR . 'live.php',
        'api/poll.php' => $serverRoot . DIRECTORY_SEPARATOR . 'api' . DIRECTORY_SEPARATOR . 'poll.php',
        'api/upload.php' => $serverRoot . DIRECTORY_SEPARATOR . 'api' . DIRECTORY_SEPARATOR . 'upload.php',
        'lib/config.php' => __DIR__ . DIRECTORY_SEPARATOR . 'config.php',
        'lib/db.php' => __DIR__ . DIRECTORY_SEPARATOR . 'db.php',
        'lib/helpers.php' => __FILE__,
        'assets/app.js' => $serverRoot . DIRECTORY_SEPARATOR . 'assets' . DIRECTORY_SEPARATOR . 'app.js',
        'assets/style.css' => $serverRoot . DIRECTORY_SEPARATOR . 'assets' . DIRECTORY_SEPARATOR . 'style.css',
        'schema.sql' => $serverRoot . DIRECTORY_SEPARATOR . 'schema.sql',
    ];
}

function app_release(): string
{
    static $release = null;
    if ($release !== null) {
        return $release;
    }

    $configured = trim((string) (app_config()['app']['release'] ?? 'auto'));
    if ($configured !== '' && strtolower($configured) !== 'auto') {
        $release = preg_replace('/[^A-Za-z0-9._-]/', '-', $configured) ?: 'custom';
        return $release;
    }

    $context = hash_init('sha256');
    foreach (app_release_files() as $name => $path) {
        hash_update($context, $name . ':');
        if (is_file($path) && is_readable($path)) {
            hash_update_file($context, $path);
        } else {
            hash_update($context, 'missing');
        }
    }
    $release = substr(hash_final($context), 0, 12);
    return $release;
}

function asset_url(string $path): string
{
    $serverRoot = realpath(dirname(__DIR__));
    $candidate = realpath(dirname(__DIR__) . DIRECTORY_SEPARATOR . str_replace(['/', '\\'], DIRECTORY_SEPARATOR, ltrim($path, '/')));
    $version = app_release();
    if (
        $serverRoot !== false
        && $candidate !== false
        && is_file($candidate)
        && strpos($candidate, $serverRoot . DIRECTORY_SEPARATOR) === 0
    ) {
        $version = substr((string) hash_file('sha256', $candidate), 0, 12);
    }

    return app_url($path) . '?v=' . rawurlencode($version);
}

function redirect_to(string $path = ''): void
{
    header('Location: ' . app_url($path), true, 303);
    exit;
}

function client_ip(): string
{
    return (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

function require_api_device(): array
{
    ensure_runtime_schema();

    $token = bearer_token();
    if ($token === null || $token === '') {
        json_response(['ok' => false, 'error' => 'Missing bearer token'], 401);
    }

    $hash = hash('sha256', $token);
    $stmt = db()->prepare(
        'SELECT *, CASE WHEN live_until IS NOT NULL AND live_until >= NOW() THEN 1 ELSE 0 END AS live_active
         FROM devices
         WHERE api_token_hash = ?
         LIMIT 1'
    );
    $stmt->execute([$hash]);
    $device = $stmt->fetch();

    if (!$device) {
        json_response(['ok' => false, 'error' => 'Invalid bearer token'], 401);
    }

    return $device;
}

function table_columns(string $table): array
{
    $stmt = db()->query('SHOW COLUMNS FROM `' . str_replace('`', '', $table) . '`');
    $columns = [];
    foreach ($stmt->fetchAll() as $column) {
        $columns[(string) $column['Field']] = true;
    }

    return $columns;
}

function ensure_runtime_schema(): void
{
    static $done = false;
    if ($done) {
        return;
    }

    $columns = table_columns('devices');
    $updates = [
        'favorite' => "ALTER TABLE devices ADD COLUMN favorite TINYINT(1) NOT NULL DEFAULT 0 AFTER last_seen",
        'tags' => "ALTER TABLE devices ADD COLUMN tags VARCHAR(255) NOT NULL DEFAULT '' AFTER favorite",
        'permission_profile' => "ALTER TABLE devices ADD COLUMN permission_profile VARCHAR(32) NOT NULL DEFAULT 'full' AFTER tags",
        'transport_mode' => "ALTER TABLE devices ADD COLUMN transport_mode VARCHAR(32) NOT NULL DEFAULT 'poll' AFTER permission_profile",
        'transport_selected' => "ALTER TABLE devices ADD COLUMN transport_selected VARCHAR(32) NOT NULL DEFAULT 'http-poll' AFTER transport_mode",
        'live_profile' => "ALTER TABLE devices ADD COLUMN live_profile VARCHAR(16) NOT NULL DEFAULT 'flow' AFTER transport_selected",
        'live_until' => "ALTER TABLE devices ADD COLUMN live_until DATETIME DEFAULT NULL AFTER live_profile",
    ];

    foreach ($updates as $column => $sql) {
        if (empty($columns[$column])) {
            db()->exec($sql);
        }
    }

    $done = true;
}

function session_boot(): void
{
    if (session_status() !== PHP_SESSION_ACTIVE) {
        $config = app_config();
        $cookieParams = session_get_cookie_params();
        session_name((string) ($config['app']['session_name'] ?? 'dcc_session'));
        session_set_cookie_params([
            'lifetime' => 0,
            'path' => app_base_path() === '' ? '/' : app_base_path() . '/',
            'domain' => $cookieParams['domain'] ?? '',
            'secure' => (bool) ($config['app']['secure_cookies'] ?? false) || is_https_request(),
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        session_start();
    }
}

function release_session_lock(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
}

function csrf_token(): string
{
    session_boot();
    if (empty($_SESSION['csrf_token']) || !is_string($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }

    return $_SESSION['csrf_token'];
}

function csrf_field(): string
{
    return '<input type="hidden" name="csrf_token" value="' . h(csrf_token()) . '">';
}

function require_csrf_value(string $token): void
{
    session_boot();
    $expected = (string) ($_SESSION['csrf_token'] ?? '');
    if ($token === '' || $expected === '' || !hash_equals($expected, $token)) {
        http_response_code(403);
        throw new RuntimeException('CSRF token tidak valid. Refresh halaman lalu coba lagi.');
    }
}

function require_csrf(): void
{
    require_csrf_value((string) ($_POST['csrf_token'] ?? ''));
}

function login_bucket(): array
{
    session_boot();
    $config = app_config()['app'] ?? [];
    $window = max(60, (int) ($config['login_window_seconds'] ?? 600));
    $now = time();
    $bucket = $_SESSION['login_bucket'] ?? null;
    if (!is_array($bucket) || (int) ($bucket['reset_at'] ?? 0) <= $now) {
        $bucket = [
            'count' => 0,
            'reset_at' => $now + $window,
            'ip' => client_ip(),
        ];
        $_SESSION['login_bucket'] = $bucket;
    }

    return $bucket;
}

function can_attempt_login(): bool
{
    $bucket = login_bucket();
    $max = max(1, (int) ((app_config()['app'] ?? [])['login_max_attempts'] ?? 8));
    return (int) ($bucket['count'] ?? 0) < $max;
}

function record_failed_login(): void
{
    session_boot();
    $bucket = login_bucket();
    $bucket['count'] = (int) ($bucket['count'] ?? 0) + 1;
    $bucket['ip'] = client_ip();
    $_SESSION['login_bucket'] = $bucket;
}

function clear_login_attempts(): void
{
    session_boot();
    unset($_SESSION['login_bucket']);
}

function is_admin_logged_in(): bool
{
    session_boot();
    return !empty($_SESSION['admin_logged_in']);
}

function require_admin(): void
{
    if (!is_admin_logged_in()) {
        redirect_to();
    }
}

function verify_admin_login(string $username, string $password): bool
{
    $admin = app_config()['admin'];
    if (($admin['username'] ?? '') === '') {
        return false;
    }
    if (!hash_equals((string) $admin['username'], $username)) {
        return false;
    }

    $hash = (string) ($admin['password_hash'] ?? '');
    if ($hash !== '') {
        return password_verify($password, $hash);
    }

    $configuredPassword = (string) ($admin['password'] ?? '');
    return $configuredPassword !== '' && hash_equals($configuredPassword, $password);
}

function h(?string $value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
}

function clean_text(string $value, int $maxLength): string
{
    $value = trim($value);
    if (function_exists('mb_substr')) {
        return mb_substr($value, 0, $maxLength);
    }

    return substr($value, 0, $maxLength);
}

function audit_event(?int $deviceId, ?int $commandId, string $type, array $details = []): void
{
    $stmt = db()->prepare(
        'INSERT INTO audit_events (device_id, command_id, event_type, details_json) VALUES (?, ?, ?, ?)'
    );
    $stmt->execute([
        $deviceId,
        $commandId,
        $type,
        $details ? json_encode($details, JSON_UNESCAPED_SLASHES) : null,
    ]);
}

function safe_original_filename(string $name): string
{
    $name = basename(str_replace('\\', '/', $name));
    $name = preg_replace('/[^a-zA-Z0-9._ ()-]/', '_', $name) ?: 'artifact.bin';
    $name = trim($name, '. ');
    return $name === '' ? 'artifact.bin' : substr($name, 0, 160);
}

function mime_allowed(string $mime): bool
{
    $mime = strtolower(trim($mime));
    foreach ((array) (app_config()['allowed_artifact_mime_prefixes'] ?? []) as $prefix) {
        $prefix = strtolower((string) $prefix);
        if ($prefix !== '' && substr($mime, 0, strlen($prefix)) === $prefix) {
            return true;
        }
    }

    return false;
}

function is_image_mime(?string $mime): bool
{
    $mime = strtolower(trim((string) $mime));
    return $mime !== '' && substr($mime, 0, 6) === 'image/';
}

function allowed_actions(): array
{
    return app_config()['allowed_actions'];
}

function is_ephemeral_action(string $action): bool
{
    return in_array($action, ['mouse_input', 'keyboard_state'], true);
}

function transport_modes(): array
{
    return [
        'poll' => 'Polling',
        'long-poll' => 'Long poll',
        'auto' => 'Auto',
    ];
}

function effective_agent_long_poll_ms(string $mode = 'poll'): int
{
    if ($mode === 'poll') {
        return 0;
    }

    $liveConfig = app_config()['live'] ?? [];
    $waitMs = max(0, min(25000, (int) ($liveConfig['agent_long_poll_ms'] ?? 15000)));
    if (PHP_SAPI === 'cli-server' && empty($liveConfig['allow_cli_server_long_poll'])) {
        return 0;
    }

    return $waitMs;
}

function normalize_live_profile(string $profile): string
{
    $profile = strtolower(trim($profile));
    return in_array($profile, ['eco', 'flow', 'burst'], true) ? $profile : 'flow';
}

function touch_live_session(int $deviceId, string $profile): void
{
    $ttl = max(3, min(60, (int) ((app_config()['live'] ?? [])['activity_ttl_seconds'] ?? 12)));
    $profile = normalize_live_profile($profile);
    db()->prepare(
        "UPDATE devices
         SET live_profile = ?, live_until = DATE_ADD(NOW(), INTERVAL {$ttl} SECOND)
         WHERE id = ?"
    )->execute([$profile, $deviceId]);
}

function effective_agent_poll_after_ms(array $device, bool $longPoll): int
{
    if ($longPoll) {
        return 15;
    }

    $live = app_config()['live'] ?? [];
    $active = !empty($device['live_active']);
    if (!$active) {
        return max(100, min(5000, (int) ($live['agent_poll_idle_ms'] ?? 500)));
    }

    $profile = normalize_live_profile((string) ($device['live_profile'] ?? 'flow'));
    $key = 'agent_poll_' . str_replace('-', '_', $profile) . '_ms';
    $fallback = ['eco' => 180, 'flow' => 75, 'burst' => 30][$profile];
    return max(10, min(2000, (int) ($live[$key] ?? $fallback)));
}

function permission_profiles(): array
{
    return [
        'view' => 'View only',
        'control' => 'Remote control',
        'files' => 'File transfer',
        'full' => 'Full support',
    ];
}

function device_action_allowed(array $device, string $action): bool
{
    $profile = (string) ($device['permission_profile'] ?? 'full');
    $base = ['health_check', 'system_info', 'network_interfaces', 'list_log_files', 'upload_log_file', 'run_diagnostic', 'capture_screen'];
    $groups = [
        'view' => $base,
        'control' => array_merge($base, ['mouse_click', 'mouse_input', 'keyboard_input', 'keyboard_state', 'record_session']),
        'files' => array_merge($base, ['file_list', 'file_pull', 'file_put']),
        'full' => array_merge($base, ['mouse_click', 'mouse_input', 'keyboard_input', 'keyboard_state', 'file_list', 'file_pull', 'file_put', 'record_session']),
    ];

    return in_array($action, $groups[$profile] ?? $groups['full'], true);
}

function latest_screen_command(int $deviceId): ?array
{
    $stmt = db()->prepare(
        "SELECT commands.*,
                (
                    SELECT completed_at
                    FROM commands recent_capture
                    WHERE recent_capture.device_id = commands.device_id
                      AND recent_capture.action = 'capture_screen'
                      AND recent_capture.status = 'succeeded'
                    ORDER BY recent_capture.id DESC
                    LIMIT 1
                ) AS observed_at
         FROM commands
         WHERE device_id = ?
           AND action = 'capture_screen'
           AND status = 'succeeded'
           AND artifact_path IS NOT NULL
         ORDER BY id DESC
         LIMIT 1"
    );
    $stmt->execute([$deviceId]);
    $command = $stmt->fetch();

    return $command ?: null;
}

function delete_artifact_file(?string $artifactPath): void
{
    if ($artifactPath === null || trim($artifactPath) === '') {
        return;
    }

    $uploadRoot = realpath(app_config()['upload_dir']);
    if (!$uploadRoot) {
        return;
    }

    $file = realpath(app_config()['upload_dir'] . DIRECTORY_SEPARATOR . $artifactPath);
    if (!$file || strpos($file, $uploadRoot . DIRECTORY_SEPARATOR) !== 0 || !is_file($file)) {
        return;
    }

    @unlink($file);
}

function prune_screen_captures(int $deviceId): int
{
    $keep = max(1, (int) ((app_config()['live'] ?? [])['frame_retention'] ?? 12));
    $stmt = db()->prepare(
        "SELECT id, artifact_path
         FROM commands
         WHERE device_id = ?
           AND action = 'capture_screen'
           AND status = 'succeeded'
           AND artifact_path IS NOT NULL
         ORDER BY id DESC"
    );
    $stmt->execute([$deviceId]);
    $rows = $stmt->fetchAll();
    if (count($rows) <= $keep) {
        return 0;
    }

    $deleteRows = array_slice($rows, $keep);
    $ids = array_map(static fn (array $row): int => (int) $row['id'], $deleteRows);
    foreach ($deleteRows as $row) {
        delete_artifact_file($row['artifact_path'] ?? null);
    }

    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    db()->prepare("DELETE FROM audit_events WHERE command_id IN ($placeholders)")->execute($ids);
    db()->prepare("DELETE FROM commands WHERE id IN ($placeholders)")->execute($ids);

    return count($ids);
}

function has_pending_action(int $deviceId, string $action): bool
{
    $stmt = db()->prepare(
        "SELECT 1
         FROM commands
         WHERE device_id = ?
           AND action = ?
           AND status IN ('queued', 'running')
         LIMIT 1"
    );
    $stmt->execute([$deviceId, $action]);

    return (bool) $stmt->fetchColumn();
}

function pending_action_flags(int $deviceId): array
{
    $actions = ['capture_screen', 'mouse_click', 'mouse_input', 'keyboard_input', 'keyboard_state'];
    $flags = array_fill_keys($actions, false);
    $placeholders = implode(',', array_fill(0, count($actions), '?'));
    $stmt = db()->prepare(
        "SELECT action
         FROM commands
         WHERE device_id = ?
           AND status IN ('queued', 'running')
           AND action IN ({$placeholders})
         GROUP BY action"
    );
    $stmt->execute(array_merge([$deviceId], $actions));
    foreach ($stmt->fetchAll() as $row) {
        $action = (string) ($row['action'] ?? '');
        if (array_key_exists($action, $flags)) {
            $flags[$action] = true;
        }
    }

    return $flags;
}

function compact_queued_screen_captures(int $deviceId): int
{
    $pdo = db();
    $pdo->prepare(
        "DELETE audit_events
         FROM audit_events
         JOIN commands stale ON stale.id = audit_events.command_id
         JOIN commands newer
           ON newer.device_id = stale.device_id
          AND newer.action = 'capture_screen'
          AND newer.status = 'queued'
          AND newer.id > stale.id
         WHERE stale.device_id = ?
           AND stale.action = 'capture_screen'
           AND stale.status = 'queued'"
    )->execute([$deviceId]);

    $stmt = $pdo->prepare(
        "DELETE stale
         FROM commands stale
         JOIN commands newer
           ON newer.device_id = stale.device_id
          AND newer.action = 'capture_screen'
          AND newer.status = 'queued'
          AND newer.id > stale.id
         WHERE stale.device_id = ?
           AND stale.action = 'capture_screen'
           AND stale.status = 'queued'"
    );
    $stmt->execute([$deviceId]);
    return $stmt->rowCount();
}

function prune_empty_screen_captures(int $deviceId): int
{
    $pdo = db();
    $pdo->prepare(
        "DELETE audit_events
         FROM audit_events
         JOIN commands capture ON capture.id = audit_events.command_id
         WHERE capture.device_id = ?
           AND capture.action = 'capture_screen'
           AND capture.status = 'succeeded'
           AND capture.artifact_path IS NULL"
    )->execute([$deviceId]);

    $stmt = $pdo->prepare(
        "DELETE FROM commands
         WHERE device_id = ?
           AND action = 'capture_screen'
           AND status = 'succeeded'
           AND artifact_path IS NULL"
    );
    $stmt->execute([$deviceId]);
    return $stmt->rowCount();
}

function queue_device_command(int $deviceId, string $action, ?array $payload = null): int
{
    if (!array_key_exists($action, allowed_actions())) {
        throw new RuntimeException('Action tidak valid.');
    }

    $payloadJson = $payload === null ? null : json_encode($payload, JSON_UNESCAPED_SLASHES);
    $stmt = db()->prepare(
        'INSERT INTO commands (device_id, action, payload_json) VALUES (?, ?, ?)'
    );
    $stmt->execute([$deviceId, $action, $payloadJson]);
    $commandId = (int) db()->lastInsertId();
    $isLiveCapture = $action === 'capture_screen' && !empty($payload['dedupe']);
    if ($isLiveCapture) {
        compact_queued_screen_captures($deviceId);
    } elseif (!is_ephemeral_action($action)) {
        audit_event($deviceId, $commandId, 'command_created', ['action' => $action]);
    }

    return $commandId;
}

function decode_payload_text(string $payload): ?string
{
    $payload = trim($payload);
    if ($payload === '') {
        return null;
    }

    json_decode($payload, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        throw new RuntimeException('Payload harus JSON valid.');
    }

    return $payload;
}
