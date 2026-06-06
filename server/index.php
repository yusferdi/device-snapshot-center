<?php

require_once __DIR__ . '/lib/helpers.php';

session_boot();

$message = '';
$error = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['form'] ?? '') === 'login') {
    try {
        require_csrf();
        if (!can_attempt_login()) {
            throw new RuntimeException('Terlalu banyak percobaan login. Tunggu beberapa menit lalu coba lagi.');
        }

        if (verify_admin_login((string) ($_POST['username'] ?? ''), (string) ($_POST['password'] ?? ''))) {
            session_regenerate_id(true);
            $_SESSION['admin_logged_in'] = true;
            unset($_SESSION['csrf_token']);
            clear_login_attempts();
            redirect_to();
        }

        record_failed_login();
        $error = 'Login gagal.';
    } catch (Throwable $th) {
        $error = $th->getMessage();
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['form'] ?? '') === 'create_command') {
    require_admin();

    try {
        require_csrf();
        $deviceId = (int) ($_POST['device_id'] ?? 0);
        $action = (string) ($_POST['action'] ?? '');
        $payload = decode_payload_text((string) ($_POST['payload_json'] ?? ''));

        if ($deviceId <= 0) {
            throw new RuntimeException('Pilih device.');
        }
        if (!array_key_exists($action, allowed_actions())) {
            throw new RuntimeException('Action tidak valid.');
        }

        $stmt = db()->prepare('SELECT id FROM devices WHERE id = ? LIMIT 1');
        $stmt->execute([$deviceId]);
        if (!$stmt->fetch()) {
            throw new RuntimeException('Device tidak ditemukan.');
        }

        $payloadArray = $payload === null ? null : json_decode($payload, true);
        queue_device_command($deviceId, $action, is_array($payloadArray) ? $payloadArray : null);
        $message = 'Tugas dibuat.';
    } catch (Throwable $th) {
        $error = $th->getMessage();
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['form'] ?? '') === 'quick_capture') {
    require_admin();

    try {
        require_csrf();
        $deviceId = (int) ($_POST['device_id'] ?? 0);
        if ($deviceId <= 0) {
            throw new RuntimeException('Pilih device.');
        }

        $stmt = db()->prepare('SELECT id FROM devices WHERE id = ? LIMIT 1');
        $stmt->execute([$deviceId]);
        if (!$stmt->fetch()) {
            throw new RuntimeException('Device tidak ditemukan.');
        }

        queue_device_command($deviceId, 'capture_screen', ['timeoutMs' => 15000]);
        $message = 'Snapshot layar diminta.';
    } catch (Throwable $th) {
        $error = $th->getMessage();
    }
}

function require_existing_device(int $deviceId): array
{
    if ($deviceId <= 0) {
        throw new RuntimeException('Pilih device.');
    }

    $stmt = db()->prepare('SELECT * FROM devices WHERE id = ? LIMIT 1');
    $stmt->execute([$deviceId]);
    $device = $stmt->fetch();
    if (!$device) {
        throw new RuntimeException('Device tidak ditemukan.');
    }

    return $device;
}

function store_admin_upload_for_command(int $deviceId, int $commandId): void
{
    $config = app_config();
    $maxUploadBytes = (int) ($config['max_upload_bytes'] ?? 0);

    if (empty($_FILES['transfer_file']) || !is_uploaded_file($_FILES['transfer_file']['tmp_name'])) {
        throw new RuntimeException('Pilih file untuk dikirim.');
    }
    if ((int) $_FILES['transfer_file']['size'] <= 0) {
        throw new RuntimeException('File kosong.');
    }
    if ($maxUploadBytes <= 0 || (int) $_FILES['transfer_file']['size'] > $maxUploadBytes) {
        throw new RuntimeException('File terlalu besar.');
    }

    $uploadRoot = rtrim((string) $config['upload_dir'], DIRECTORY_SEPARATOR);
    if (!is_dir($uploadRoot) && !mkdir($uploadRoot, 0775, true)) {
        throw new RuntimeException('Upload directory tidak bisa dibuat.');
    }

    $resolvedUploadRoot = realpath($uploadRoot);
    if (!$resolvedUploadRoot || !is_dir($resolvedUploadRoot)) {
        throw new RuntimeException('Upload directory tidak tersedia.');
    }

    $bucket = date('Y-m');
    $targetDir = $resolvedUploadRoot . DIRECTORY_SEPARATOR . $bucket;
    if (!is_dir($targetDir) && !mkdir($targetDir, 0775, true)) {
        throw new RuntimeException('Upload bucket tidak bisa dibuat.');
    }

    $originalName = safe_original_filename((string) $_FILES['transfer_file']['name']);
    $storedName = bin2hex(random_bytes(12)) . '-' . $originalName;
    $target = $targetDir . DIRECTORY_SEPARATOR . $storedName;
    if (!move_uploaded_file($_FILES['transfer_file']['tmp_name'], $target)) {
        throw new RuntimeException('Gagal menyimpan upload.');
    }

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
        throw new RuntimeException('Tipe file tidak diizinkan.');
    }

    $relativePath = $bucket . '/' . $storedName;
    $stmt = db()->prepare(
        'UPDATE commands SET artifact_path = ?, artifact_name = ?, artifact_mime = ? WHERE id = ? AND device_id = ?'
    );
    $stmt->execute([$relativePath, $originalName, $mime, $commandId, $deviceId]);
    audit_event($deviceId, $commandId, 'admin_artifact_uploaded', [
        'name' => $originalName,
        'bytes' => (int) $_FILES['transfer_file']['size'],
    ]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['form'] ?? '') === 'update_device_settings') {
    require_admin();

    try {
        require_csrf();
        $deviceId = (int) ($_POST['device_id'] ?? 0);
        require_existing_device($deviceId);
        $profile = (string) ($_POST['permission_profile'] ?? 'full');
        if (!array_key_exists($profile, permission_profiles())) {
            throw new RuntimeException('Permission profile tidak valid.');
        }

        $name = clean_text((string) ($_POST['name'] ?? ''), 190);
        $tags = clean_text((string) ($_POST['tags'] ?? ''), 255);
        if ($name === '') {
            throw new RuntimeException('Nama device wajib diisi.');
        }

        $stmt = db()->prepare('UPDATE devices SET name = ?, favorite = ?, tags = ?, permission_profile = ? WHERE id = ?');
        $stmt->execute([$name, !empty($_POST['favorite']) ? 1 : 0, $tags, $profile, $deviceId]);
        audit_event($deviceId, null, 'device_settings_updated', ['profile' => $profile, 'tags' => $tags]);
        $message = 'Device diperbarui.';
    } catch (Throwable $th) {
        $error = $th->getMessage();
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['form'] ?? '') === 'file_refresh') {
    require_admin();

    try {
        require_csrf();
        $deviceId = (int) ($_POST['device_id'] ?? 0);
        require_existing_device($deviceId);
        $path = clean_text((string) ($_POST['path'] ?? ''), 240);
        queue_device_command($deviceId, 'file_list', ['path' => $path]);
        $message = 'Daftar file diminta.';
    } catch (Throwable $th) {
        $error = $th->getMessage();
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['form'] ?? '') === 'file_download') {
    require_admin();

    try {
        require_csrf();
        $deviceId = (int) ($_POST['device_id'] ?? 0);
        require_existing_device($deviceId);
        $relativePath = clean_text((string) ($_POST['relative_path'] ?? ''), 240);
        if ($relativePath === '') {
            throw new RuntimeException('Relative path wajib diisi.');
        }
        queue_device_command($deviceId, 'file_pull', ['relativePath' => $relativePath]);
        $message = 'Download remote diminta.';
    } catch (Throwable $th) {
        $error = $th->getMessage();
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['form'] ?? '') === 'file_upload') {
    require_admin();

    $commandId = null;
    try {
        require_csrf();
        $deviceId = (int) ($_POST['device_id'] ?? 0);
        require_existing_device($deviceId);
        $targetName = safe_original_filename((string) ($_POST['target_name'] ?? ($_FILES['transfer_file']['name'] ?? 'upload.bin')));
        $commandId = queue_device_command($deviceId, 'file_put', ['targetName' => $targetName]);
        store_admin_upload_for_command($deviceId, $commandId);
        $message = 'Upload ke device diminta.';
    } catch (Throwable $th) {
        if ($commandId !== null) {
            db()->prepare("UPDATE commands SET status = 'cancelled', error_text = ?, completed_at = NOW() WHERE id = ?")
                ->execute([$th->getMessage(), $commandId]);
        }
        $error = $th->getMessage();
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['form'] ?? '') === 'send_clipboard') {
    require_admin();

    try {
        require_csrf();
        $deviceId = (int) ($_POST['device_id'] ?? 0);
        require_existing_device($deviceId);
        $text = str_replace(["\r\n", "\r"], "\n", (string) ($_POST['text'] ?? ''));
        $maxBytes = 8192;
        if (trim($text) === '') {
            throw new RuntimeException('Clipboard text wajib diisi.');
        }
        if (strlen($text) > $maxBytes) {
            throw new RuntimeException('Clipboard text maksimal 8 KB.');
        }
        if (strpos($text, "\0") !== false) {
            throw new RuntimeException('Clipboard text tidak boleh berisi byte NUL.');
        }
        if (function_exists('mb_check_encoding') && !mb_check_encoding($text, 'UTF-8')) {
            throw new RuntimeException('Clipboard text harus UTF-8 valid.');
        }
        $pasteNow = ($_POST['paste_now'] ?? '') === '1';
        queue_device_command($deviceId, 'clipboard_write', [
            'text' => $text,
            'paste' => $pasteNow,
        ]);
        $message = $pasteNow
            ? 'Clipboard agent diperbarui dan paste diminta.'
            : 'Clipboard agent diperbarui.';
    } catch (Throwable $th) {
        $error = $th->getMessage();
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['form'] ?? '') === 'record_session') {
    require_admin();

    try {
        require_csrf();
        $deviceId = (int) ($_POST['device_id'] ?? 0);
        require_existing_device($deviceId);
        $durationSeconds = max(3, min(30, (int) ($_POST['duration_seconds'] ?? 10)));
        $intervalMs = max(800, min(5000, (int) ($_POST['interval_ms'] ?? 1500)));
        queue_device_command($deviceId, 'record_session', [
            'durationSeconds' => $durationSeconds,
            'intervalMs' => $intervalMs,
        ]);
        $message = 'Recording session diminta.';
    } catch (Throwable $th) {
        $error = $th->getMessage();
    }
}

$loggedIn = is_admin_logged_in();
$devices = [];
$commands = [];
$events = [];
$latestFileList = null;
$liveConfig = app_config()['live'] ?? [];

if ($loggedIn) {
    try {
        ensure_runtime_schema();
        $devices = db()->query(
            'SELECT *, TIMESTAMPDIFF(SECOND, last_seen, NOW()) AS last_seen_age_seconds
             FROM devices
             ORDER BY last_seen DESC, id DESC'
        )->fetchAll();
        $commands = db()->query(
            'SELECT c.*, d.name AS device_name, d.device_uid
             FROM commands c
             JOIN devices d ON d.id = c.device_id
             ORDER BY c.id DESC
             LIMIT 100'
        )->fetchAll();
        $events = db()->query(
            'SELECT e.*, d.name AS device_name
             FROM audit_events e
             LEFT JOIN devices d ON d.id = e.device_id
             ORDER BY e.id DESC
             LIMIT 20'
        )->fetchAll();
        $latestFileList = db()->query(
            "SELECT c.*, d.name AS device_name
             FROM commands c
             JOIN devices d ON d.id = c.device_id
             WHERE c.action = 'file_list' AND c.status = 'succeeded'
             ORDER BY c.id DESC
             LIMIT 1"
        )->fetch();
    } catch (Throwable $th) {
        $error = $th->getMessage();
    }
}

$primaryDeviceId = $devices ? (int) $devices[0]['id'] : 0;
$activeDeviceCount = 0;
$favoriteDeviceCount = 0;
$onlineWindowSeconds = (int) ($liveConfig['agent_online_window_seconds'] ?? 60);
foreach ($devices as $device) {
    if (!empty($device['favorite'])) {
        $favoriteDeviceCount++;
    }
    $lastSeenAgeSeconds = $device['last_seen_age_seconds'] === null
        ? null
        : max(0, (int) $device['last_seen_age_seconds']);
    if ($lastSeenAgeSeconds !== null && $lastSeenAgeSeconds <= $onlineWindowSeconds) {
        $activeDeviceCount++;
    }
}
$pendingCommandCount = 0;
foreach ($commands as $command) {
    if (in_array((string) $command['status'], ['queued', 'running'], true)) {
        $pendingCommandCount++;
    }
}
$fileListResult = [];
$fileListEntries = [];
if ($latestFileList && !empty($latestFileList['result_json'])) {
    $decoded = json_decode((string) $latestFileList['result_json'], true);
    if (is_array($decoded)) {
        $fileListResult = $decoded;
        $fileListEntries = is_array($decoded['entries'] ?? null) ? $decoded['entries'] : [];
    }
}

apply_security_headers();
header('X-App-Release: ' . app_release());
?>
<!doctype html>
<html lang="id">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="app-release" content="<?= h(app_release()) ?>">
    <title>Device Snapshot Center</title>
    <link rel="stylesheet" href="<?= h(asset_url('assets/style.css')) ?>">
    <?php if ($loggedIn): ?>
        <script src="<?= h(asset_url('assets/app.js')) ?>" defer></script>
    <?php endif; ?>
</head>
<body>
<main class="shell">
    <header class="topbar">
        <div>
            <h1>Device Snapshot Center</h1>
            <p>Remote operations workspace untuk device yang kamu miliki.</p>
        </div>
        <?php if ($loggedIn): ?>
            <form class="logout-form" method="post" action="<?= h(app_url('logout.php')) ?>">
                <?= csrf_field() ?>
                <button class="button secondary" type="submit">Logout</button>
            </form>
        <?php endif; ?>
    </header>

    <?php if ($message): ?>
        <div class="notice success"><?= h($message) ?></div>
    <?php endif; ?>
    <?php if ($error): ?>
        <div class="notice error"><?= h($error) ?></div>
    <?php endif; ?>

    <?php if (!$loggedIn): ?>
        <section class="panel login-panel">
            <h2>Admin Login</h2>
            <form method="post" action="<?= h(app_url()) ?>">
                <input type="hidden" name="form" value="login">
                <?= csrf_field() ?>
                <label>
                    Username
                    <input name="username" autocomplete="username" required>
                </label>
                <label>
                    Password
                    <input name="password" type="password" autocomplete="current-password" required>
                </label>
                <button class="button" type="submit">Login</button>
            </form>
        </section>
    <?php else: ?>
        <section class="overview-strip" aria-label="Workspace summary">
            <div class="overview-item">
                <span>Devices</span>
                <strong><?= count($devices) ?></strong>
            </div>
            <div class="overview-item">
                <span>Active</span>
                <strong><?= $activeDeviceCount ?></strong>
            </div>
            <div class="overview-item">
                <span>Favorites</span>
                <strong><?= $favoriteDeviceCount ?></strong>
            </div>
            <div class="overview-item">
                <span>Queue</span>
                <strong><?= $pendingCommandCount ?></strong>
            </div>
        </section>

        <?php if ($devices): ?>
            <section
                class="panel live-panel"
                data-live-dashboard
                data-live-api="<?= h(app_url('api/live.php')) ?>"
                data-csrf-token="<?= h(csrf_token()) ?>"
                data-capture-interval="<?= (int) ($liveConfig['capture_interval_ms'] ?? 1800) ?>"
                data-status-interval="<?= (int) ($liveConfig['status_interval_ms'] ?? 900) ?>"
                data-idle-status-interval="<?= (int) ($liveConfig['idle_status_interval_ms'] ?? 5000) ?>"
                data-pointer-batch="<?= (int) ($liveConfig['pointer_batch_ms'] ?? 48) ?>"
                data-pointer-max-events="<?= (int) ($liveConfig['pointer_max_events'] ?? 64) ?>"
                data-wheel-pixel-per-line="<?= (int) ($liveConfig['wheel_pixel_per_line'] ?? 16) ?>"
                data-wheel-page-lines="<?= (int) ($liveConfig['wheel_page_lines'] ?? 12) ?>"
                data-wheel-max-lines="<?= (int) ($liveConfig['wheel_max_lines'] ?? 90) ?>"
            >
                <div class="panel-heading">
                    <div>
                        <h2>Live Screen</h2>
                        <div class="live-metrics">
                            <span class="live-pill" data-live-freshness>Frame -</span>
                            <span class="live-pill" data-live-queue>Queue -</span>
                            <span class="live-pill" data-live-transport>Adaptive HTTP</span>
                            <span class="live-pill" data-live-mode>Idle</span>
                        </div>
                    </div>
                </div>
                <div class="live-workspace">
                    <div class="live-viewer" data-live-viewer>
                        <div class="live-stage" tabindex="0" aria-label="Live remote screen" data-live-stage>
                            <img data-live-screen alt="Live screen">
                            <div class="live-empty" data-live-empty>Belum ada frame.</div>
                        </div>
                        <div class="live-viewer-bar">
                            <div class="live-status" data-live-status>Idle</div>
                            <div class="live-view-actions" aria-label="Screen view controls">
                                <button class="button compact icon-button" type="button" aria-label="Capture frame" title="Capture frame" data-live-refresh>
                                    <svg aria-hidden="true" viewBox="0 0 24 24">
                                        <path d="M20 12a8 8 0 0 1-13.6 5.7l-1.8-1.8"></path>
                                        <path d="M4 12A8 8 0 0 1 17.6 6.3l1.8 1.8"></path>
                                        <path d="M4 18v-4h4"></path>
                                        <path d="M20 6v4h-4"></path>
                                    </svg>
                                    <span class="sr-only">Capture frame</span>
                                </button>
                                <button class="button compact secondary icon-button" type="button" aria-label="Toggle coordinate grid" title="Coordinate grid untuk cek mapping klik" aria-pressed="false" data-live-grid>
                                    <svg aria-hidden="true" viewBox="0 0 24 24">
                                        <path d="M4 4h16v16H4z"></path>
                                        <path d="M4 12h16"></path>
                                        <path d="M12 4v16"></path>
                                    </svg>
                                    <span class="sr-only">Toggle coordinate grid</span>
                                </button>
                                <button class="button compact secondary icon-button" type="button" aria-label="Show detailed live status" title="Show detailed live status" aria-pressed="false" data-live-verbose>
                                    <svg aria-hidden="true" viewBox="0 0 24 24">
                                        <path d="M12 17v-6"></path>
                                        <path d="M12 7h.01"></path>
                                        <path d="M4 12a8 8 0 1 0 16 0 8 8 0 0 0-16 0z"></path>
                                    </svg>
                                    <span class="sr-only" data-verbose-label>Show detailed live status</span>
                                </button>
                                <button class="button compact icon-button" type="button" aria-label="Enter focus view" title="Focus view tanpa mengunci taskbar" data-live-fullscreen>
                                    <svg aria-hidden="true" viewBox="0 0 24 24">
                                        <path d="M8 4H4v4"></path>
                                        <path d="M16 4h4v4"></path>
                                        <path d="M20 16v4h-4"></path>
                                        <path d="M4 16v4h4"></path>
                                    </svg>
                                    <span class="sr-only" data-button-label>Enter focus view</span>
                                </button>
                                <button class="button compact danger icon-button" type="button" aria-label="Stop control" title="Stop control (Ctrl+Alt+Escape)" data-live-stop>
                                    <svg aria-hidden="true" viewBox="0 0 24 24">
                                        <path d="M7 7h10v10H7z"></path>
                                    </svg>
                                    <span class="sr-only">Stop control</span>
                                </button>
                            </div>
                        </div>
                    </div>
                    <aside class="live-controls" aria-label="Live session controls">
                        <div class="control-cluster device-cluster">
                            <span class="control-cluster-title">Device</span>
                            <div class="select-wrap">
                                <select data-live-device>
                                    <?php foreach ($devices as $device): ?>
                                        <option
                                            value="<?= (int) $device['id'] ?>"
                                            data-transport-mode="<?= h((string) ($device['transport_mode'] ?? 'poll')) ?>"
                                        >
                                            <?= h($device['name']) ?>
                                        </option>
                                    <?php endforeach; ?>
                                </select>
                            </div>
                        </div>
                        <div class="control-cluster connection-cluster">
                            <span class="control-cluster-title">Connection</span>
                            <div class="select-wrap">
                                <select aria-label="Connection method" data-live-transport-select>
                                    <?php foreach (transport_modes() as $transportKey => $transportLabel): ?>
                                        <option value="<?= h($transportKey) ?>"><?= h($transportLabel) ?></option>
                                    <?php endforeach; ?>
                                </select>
                            </div>
                        </div>
                        <div class="control-cluster speed-cluster">
                            <span class="control-cluster-title">Speed</span>
                            <div class="segmented-control" role="group" aria-label="Live speed">
                                <button class="segment" type="button" aria-pressed="false" title="Hemat bandwidth" data-live-speed="eco">Eco</button>
                                <button class="segment" type="button" aria-pressed="true" title="Seimbang" data-live-speed="flow">Flow</button>
                                <button class="segment" type="button" aria-pressed="false" title="Respons tercepat" data-live-speed="burst">Burst</button>
                            </div>
                        </div>
                        <div class="control-cluster access-cluster">
                            <span class="control-cluster-title">Access</span>
                            <label class="switch-row">
                                <input type="checkbox" role="switch" aria-checked="false" aria-label="Live screen" data-live-toggle>
                                <span>Live</span>
                            </label>
                            <label class="switch-row">
                                <input type="checkbox" role="switch" aria-checked="false" aria-label="Kontrol klik layar" data-control-toggle>
                                <span>Mouse</span>
                            </label>
                            <label class="switch-row">
                                <input type="checkbox" role="switch" aria-checked="false" aria-label="Input keyboard remote" data-keyboard-toggle>
                                <span>Keys</span>
                            </label>
                        </div>
                    </aside>
                </div>
            </section>
        <?php endif; ?>

        <nav class="workspace-tabs" aria-label="Workspace sections" data-workspace-tabs>
            <button class="workspace-tab is-active" type="button" aria-selected="true" data-workspace-tab="devices">Devices</button>
            <button class="workspace-tab" type="button" aria-selected="false" data-workspace-tab="operations">Operations</button>
            <button class="workspace-tab" type="button" aria-selected="false" data-workspace-tab="advanced">Advanced</button>
            <button class="workspace-tab" type="button" aria-selected="false" data-workspace-tab="history">History</button>
            <button class="workspace-tab" type="button" aria-selected="false" data-workspace-tab="audit">Audit</button>
        </nav>

        <section class="panel address-panel workspace-panel is-active" data-workspace-panel="devices">
            <div class="panel-heading">
                <div>
                    <h2>Address Book</h2>
                    <p>Kelola profile, tag, dan favorite device.</p>
                </div>
                <label class="compact-label">
                    Search
                    <input type="search" placeholder="Cari nama, host, tag..." data-device-search>
                </label>
            </div>
            <div class="device-cards" data-device-list>
                <?php foreach ($devices as $device): ?>
                    <?php $profile = (string) ($device['permission_profile'] ?? 'full'); ?>
                    <article
                        class="device-card"
                        data-device-card
                        data-search="<?= h(strtolower(($device['name'] ?? '') . ' ' . ($device['hostname'] ?? '') . ' ' . ($device['tags'] ?? '') . ' ' . ($device['platform'] ?? ''))) ?>"
                    >
                        <form method="post" action="<?= h(app_url()) ?>">
                            <input type="hidden" name="form" value="update_device_settings">
                            <input type="hidden" name="device_id" value="<?= (int) $device['id'] ?>">
                            <?= csrf_field() ?>
                            <div class="device-card-top">
                                <label class="favorite-toggle">
                                    <input type="checkbox" name="favorite" value="1" <?= !empty($device['favorite']) ? 'checked' : '' ?>>
                                    <span>Favorite</span>
                                </label>
                                <span class="profile-badge"><?= h(permission_profiles()[$profile] ?? 'Full support') ?></span>
                            </div>
                            <label>
                                Nama
                                <input name="name" value="<?= h($device['name']) ?>" required>
                            </label>
                            <label>
                                Tags
                                <input name="tags" value="<?= h($device['tags'] ?? '') ?>" placeholder="ops, laptop, lab">
                            </label>
                            <label>
                                Permission
                                <select name="permission_profile">
                                    <?php foreach (permission_profiles() as $key => $label): ?>
                                        <option value="<?= h($key) ?>" <?= $profile === $key ? 'selected' : '' ?>><?= h($label) ?></option>
                                    <?php endforeach; ?>
                                </select>
                            </label>
                            <div class="device-meta">
                                <span><?= h($device['hostname']) ?></span>
                                <span><?= h($device['last_seen']) ?></span>
                            </div>
                            <button class="button compact" type="submit">Simpan</button>
                        </form>
                    </article>
                <?php endforeach; ?>
                <?php if (!$devices): ?>
                    <p class="muted">Belum ada device enroll.</p>
                <?php endif; ?>
            </div>
        </section>

        <?php if ($devices): ?>
            <section class="grid two ops-grid workspace-panel" data-workspace-panel="operations" hidden>
                <div class="panel">
                    <div class="panel-heading">
                        <div>
                            <h2>File Transfer</h2>
                            <p>Browse, download, dan kirim file ke folder allowlist agent.</p>
                        </div>
                    </div>
                    <form method="post" action="<?= h(app_url()) ?>">
                        <input type="hidden" name="form" value="file_refresh">
                        <?= csrf_field() ?>
                        <label>
                            Device
                            <select name="device_id">
                                <?php foreach ($devices as $device): ?>
                                    <option value="<?= (int) $device['id'] ?>" <?= (int) $device['id'] === $primaryDeviceId ? 'selected' : '' ?>>
                                        <?= h($device['name']) ?>
                                    </option>
                                <?php endforeach; ?>
                            </select>
                        </label>
                        <label>
                            Remote path
                            <input name="path" value="<?= h((string) ($fileListResult['path'] ?? '')) ?>" placeholder="kosong = root transfer">
                        </label>
                        <button class="button" type="submit">Refresh File</button>
                    </form>
                    <div class="file-list">
                        <div class="file-list-head">
                            <strong><?= h($latestFileList['device_name'] ?? 'Remote files') ?></strong>
                            <span><?= h((string) ($fileListResult['path'] ?? 'root')) ?></span>
                        </div>
                        <?php foreach ($fileListEntries as $entry): ?>
                            <form class="file-row" method="post" action="<?= h(app_url()) ?>">
                                <input type="hidden" name="form" value="file_download">
                                <input type="hidden" name="device_id" value="<?= (int) ($latestFileList['device_id'] ?? $primaryDeviceId) ?>">
                                <input type="hidden" name="relative_path" value="<?= h((string) ($entry['relativePath'] ?? '')) ?>">
                                <?= csrf_field() ?>
                                <span class="file-kind"><?= !empty($entry['isDirectory']) ? 'DIR' : 'FILE' ?></span>
                                <span class="file-name"><?= h((string) ($entry['name'] ?? '-')) ?></span>
                                <span class="file-size"><?= !empty($entry['isDirectory']) ? '-' : number_format((int) ($entry['sizeBytes'] ?? 0)) . ' B' ?></span>
                                <button class="button compact secondary" type="submit" <?= !empty($entry['isDirectory']) ? 'disabled' : '' ?>>Ambil</button>
                            </form>
                        <?php endforeach; ?>
                        <?php if (!$fileListEntries): ?>
                            <p class="muted">Klik Refresh File untuk membaca folder transfer device.</p>
                        <?php endif; ?>
                    </div>
                    <form class="upload-form" method="post" action="<?= h(app_url()) ?>" enctype="multipart/form-data">
                        <input type="hidden" name="form" value="file_upload">
                        <?= csrf_field() ?>
                        <label>
                            Kirim ke device
                            <select name="device_id">
                                <?php foreach ($devices as $device): ?>
                                    <option value="<?= (int) $device['id'] ?>"><?= h($device['name']) ?></option>
                                <?php endforeach; ?>
                            </select>
                        </label>
                        <label>
                            File
                            <input type="file" name="transfer_file" required>
                        </label>
                        <label>
                            Nama tujuan
                            <input name="target_name" placeholder="opsional, default nama file">
                        </label>
                        <button class="button" type="submit">Kirim File</button>
                    </form>
                </div>

                <div class="panel">
                    <div class="panel-heading">
                        <div>
                            <h2>Clipboard & Recording</h2>
                            <p>Copy/paste ke agent dan session recording eksplisit.</p>
                        </div>
                    </div>
                    <form method="post" action="<?= h(app_url()) ?>">
                        <input type="hidden" name="form" value="send_clipboard">
                        <?= csrf_field() ?>
                        <label>
                            Device
                            <select name="device_id">
                                <?php foreach ($devices as $device): ?>
                                    <option value="<?= (int) $device['id'] ?>"><?= h($device['name']) ?></option>
                                <?php endforeach; ?>
                            </select>
                        </label>
                        <label>
                            Clipboard text
                            <textarea name="text" rows="4" maxlength="8192" placeholder="Text akan disalin ke clipboard agent. Centang paste untuk langsung Ctrl+V di window aktif."></textarea>
                        </label>
                        <label class="switch-row">
                            <input type="checkbox" name="paste_now" value="1" checked>
                            <span>Paste ke window aktif</span>
                        </label>
                        <button class="button" type="submit">Copy/Paste ke Agent</button>
                    </form>
                    <form method="post" action="<?= h(app_url()) ?>">
                        <input type="hidden" name="form" value="record_session">
                        <?= csrf_field() ?>
                        <label>
                            Device
                            <select name="device_id">
                                <?php foreach ($devices as $device): ?>
                                    <option value="<?= (int) $device['id'] ?>"><?= h($device['name']) ?></option>
                                <?php endforeach; ?>
                            </select>
                        </label>
                        <div class="inline-fields">
                            <label>
                                Durasi
                                <input name="duration_seconds" type="number" min="3" max="30" value="10">
                            </label>
                            <label>
                                Interval ms
                                <input name="interval_ms" type="number" min="800" max="5000" value="1500">
                            </label>
                        </div>
                        <button class="button secondary" type="submit">Rekam Sesi</button>
                    </form>
                </div>
            </section>
        <?php endif; ?>

        <section class="grid two workspace-panel" data-workspace-panel="advanced" hidden>
            <div class="panel">
                <h2>Buat Tugas</h2>
                <form method="post" action="<?= h(app_url()) ?>">
                    <input type="hidden" name="form" value="create_command">
                    <?= csrf_field() ?>
                    <label>
                        Device
                        <select name="device_id" required>
                            <option value="">Pilih device</option>
                            <?php foreach ($devices as $device): ?>
                                <option value="<?= (int) $device['id'] ?>">
                                    <?= h($device['name']) ?> (<?= h($device['device_uid']) ?>)
                                </option>
                            <?php endforeach; ?>
                        </select>
                    </label>
                    <label>
                        Aksi
                        <select name="action" required>
                            <?php foreach (allowed_actions() as $key => $label): ?>
                                <option value="<?= h($key) ?>"><?= h($label) ?></option>
                            <?php endforeach; ?>
                        </select>
                    </label>
                    <label>
                        Payload JSON
                        <textarea name="payload_json" rows="6" placeholder='{"name":"node_version"}'></textarea>
                    </label>
                    <button class="button" type="submit">Tambahkan Tugas</button>
                </form>
            </div>

            <div class="panel">
                <h2>Devices</h2>
                <div class="table-wrap">
                    <table>
                        <thead>
                        <tr>
                            <th>Name</th>
                            <th>Host</th>
                            <th>Platform</th>
                            <th>Last Seen</th>
                            <th>Snapshot</th>
                        </tr>
                        </thead>
                        <tbody>
                        <?php foreach ($devices as $device): ?>
                            <tr>
                                <td data-label="Name"><?= h($device['name']) ?></td>
                                <td data-label="Host"><?= h($device['hostname']) ?></td>
                                <td data-label="Platform"><?= h($device['platform']) ?></td>
                                <td data-label="Last Seen"><?= h($device['last_seen']) ?></td>
                                <td data-label="Snapshot">
                                    <form class="inline-form" method="post" action="<?= h(app_url()) ?>">
                                        <input type="hidden" name="form" value="quick_capture">
                                        <input type="hidden" name="device_id" value="<?= (int) $device['id'] ?>">
                                        <?= csrf_field() ?>
                                        <button class="button compact" type="submit">Ambil</button>
                                    </form>
                                </td>
                            </tr>
                        <?php endforeach; ?>
                        <?php if (!$devices): ?>
                            <tr><td colspan="5" class="muted no-label">Belum ada device enroll.</td></tr>
                        <?php endif; ?>
                        </tbody>
                    </table>
                </div>
            </div>
        </section>

        <section class="panel workspace-panel" data-workspace-panel="history" hidden>
            <h2>Riwayat Tugas</h2>
            <div class="table-wrap">
                <table>
                    <thead>
                    <tr>
                        <th>ID</th>
                        <th>Device</th>
                        <th>Aksi</th>
                        <th>Status</th>
                        <th>Result</th>
                        <th>Artifact</th>
                        <th>Dibuat</th>
                    </tr>
                    </thead>
                    <tbody>
                    <?php $historyPreviewBudget = 4; ?>
                    <?php foreach ($commands as $command): ?>
                        <tr>
                            <td data-label="ID"><?= (int) $command['id'] ?></td>
                            <td data-label="Device"><?= h($command['device_name']) ?></td>
                            <td data-label="Aksi"><code><?= h($command['action']) ?></code></td>
                            <td data-label="Status"><span class="status <?= h($command['status']) ?>"><?= h($command['status']) ?></span></td>
                            <td data-label="Result">
                                <?php if ($command['error_text']): ?>
                                    <pre><?= h($command['error_text']) ?></pre>
                                <?php elseif ($command['result_text']): ?>
                                    <pre><?= h($command['result_text']) ?></pre>
                                <?php elseif ($command['result_json']): ?>
                                    <pre><?= h($command['result_json']) ?></pre>
                                <?php else: ?>
                                    <span class="muted">-</span>
                                <?php endif; ?>
                            </td>
                            <td data-label="Artifact">
                                <?php if ($command['artifact_path']): ?>
                                    <?php
                                    $artifactDownloadUrl = app_url('artifact.php?id=' . (int) $command['id']);
                                    $artifactInlineUrl = app_url('artifact.php?id=' . (int) $command['id'] . '&inline=1');
                                    ?>
                                    <a href="<?= h($artifactDownloadUrl) ?>"><?= h($command['artifact_name']) ?></a>
                                    <?php if (is_image_mime($command['artifact_mime']) && $historyPreviewBudget > 0): ?>
                                        <?php $historyPreviewBudget--; ?>
                                        <a class="artifact-preview-link" href="<?= h($artifactInlineUrl) ?>">
                                            <img class="artifact-preview" src="<?= h($artifactInlineUrl) ?>" loading="lazy" alt="Preview <?= (int) $command['id'] ?>">
                                        </a>
                                    <?php endif; ?>
                                <?php else: ?>
                                    <span class="muted">-</span>
                                <?php endif; ?>
                            </td>
                            <td data-label="Dibuat"><?= h($command['created_at']) ?></td>
                        </tr>
                    <?php endforeach; ?>
                    <?php if (!$commands): ?>
                        <tr><td colspan="7" class="muted no-label">Belum ada tugas.</td></tr>
                    <?php endif; ?>
                    </tbody>
                </table>
            </div>
        </section>

        <section class="panel workspace-panel" data-workspace-panel="audit" hidden>
            <h2>Audit Events</h2>
            <div class="table-wrap">
                <table>
                    <thead>
                    <tr>
                        <th>Time</th>
                        <th>Device</th>
                        <th>Event</th>
                        <th>Details</th>
                    </tr>
                    </thead>
                    <tbody>
                    <?php foreach ($events as $event): ?>
                        <tr>
                            <td data-label="Time"><?= h($event['created_at']) ?></td>
                            <td data-label="Device"><?= h($event['device_name'] ?? '-') ?></td>
                            <td data-label="Event"><code><?= h($event['event_type']) ?></code></td>
                            <td data-label="Details"><pre><?= h($event['details_json']) ?></pre></td>
                        </tr>
                    <?php endforeach; ?>
                    <?php if (!$events): ?>
                        <tr><td colspan="4" class="muted no-label">Belum ada event.</td></tr>
                    <?php endif; ?>
                    </tbody>
                </table>
            </div>
        </section>
    <?php endif; ?>
</main>
</body>
</html>
