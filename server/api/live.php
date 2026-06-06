<?php

require_once __DIR__ . '/../lib/helpers.php';

$requestStartedAt = microtime(true);

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['ok' => false, 'error' => 'POST required'], 405);
}

if (!is_admin_logged_in()) {
    json_response(['ok' => false, 'error' => 'Login diperlukan'], 401);
}
$body = read_json_body();
require_csrf_value((string) ($body['csrf_token'] ?? ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '')));
release_session_lock();
ensure_runtime_schema();

function live_keyboard_payload(array $body): array
{
    $kind = strtolower((string) ($body['kind'] ?? 'key'));
    if (!in_array($kind, ['text', 'key', 'state'], true)) {
        json_response(['ok' => false, 'error' => 'Jenis input keyboard tidak valid'], 400);
    }

    if ($kind === 'text') {
        $text = (string) ($body['text'] ?? '');
        if ($text === '' || strlen($text) > 512 || preg_match('/[\x00-\x1F\x7F]/', $text)) {
            json_response(['ok' => false, 'error' => 'Text keyboard tidak valid'], 400);
        }

        return [
            'kind' => 'text',
            'text' => $text,
        ];
    }

    $allowedKeys = array_fill_keys([
        'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
        'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
        ',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`',
        'space', 'backspace', 'delete', 'enter', 'tab', 'escape',
        'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
        'insert', 'capslock', 'printscreen', 'menu',
        'control', 'alt', 'shift', 'command',
        'audio_mute', 'audio_vol_down', 'audio_vol_up', 'audio_play', 'audio_stop',
        'audio_pause', 'audio_prev', 'audio_next',
        'numpad_lock', 'numpad_0', 'numpad_1', 'numpad_2', 'numpad_3', 'numpad_4',
        'numpad_5', 'numpad_6', 'numpad_7', 'numpad_8', 'numpad_9',
        'numpad_+', 'numpad_-', 'numpad_*', 'numpad_/', 'numpad_.',
        'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
        'f13', 'f14', 'f15', 'f16', 'f17', 'f18', 'f19', 'f20', 'f21', 'f22', 'f23', 'f24',
    ], true);

    $key = strtolower((string) ($body['key'] ?? ''));
    if (!isset($allowedKeys[$key])) {
        json_response(['ok' => false, 'error' => 'Key keyboard tidak valid'], 400);
    }

    $rawModifiers = $body['modifiers'] ?? [];
    if (is_string($rawModifiers)) {
        $rawModifiers = [$rawModifiers];
    }
    if (!is_array($rawModifiers)) {
        json_response(['ok' => false, 'error' => 'Modifier keyboard tidak valid'], 400);
    }

    $modifierMap = [
        'ctrl' => 'control',
        'control' => 'control',
        'alt' => 'alt',
        'shift' => 'shift',
    ];
    $modifiers = [];
    foreach ($rawModifiers as $modifier) {
        $normalized = $modifierMap[strtolower((string) $modifier)] ?? null;
        if ($normalized === null) {
            json_response(['ok' => false, 'error' => 'Modifier keyboard tidak didukung'], 400);
        }
        $modifiers[$normalized] = true;
    }
    $modifiers = array_keys($modifiers);

    if ($key === 'delete' && in_array('control', $modifiers, true) && in_array('alt', $modifiers, true)) {
        json_response(['ok' => false, 'error' => 'Kombinasi keyboard ini tidak didukung'], 400);
    }

    $payload = [
        'kind' => $kind,
        'key' => $key,
        'modifiers' => $modifiers,
    ];
    if ($kind === 'state') {
        $state = strtolower((string) ($body['state'] ?? ''));
        if (!in_array($state, ['down', 'up'], true)) {
            json_response(['ok' => false, 'error' => 'State keyboard tidak valid'], 400);
        }
        $payload['state'] = $state;
    }

    return $payload;
}

function live_pointer_payload(array $body): array
{
    $events = $body['events'] ?? null;
    $liveConfig = app_config()['live'] ?? [];
    $maxEvents = (int) ($liveConfig['pointer_max_events'] ?? 64);
    $wheelMaxLines = (int) ($liveConfig['wheel_max_lines'] ?? 60);
    if (!is_array($events) || $events === [] || count($events) > $maxEvents) {
        json_response(['ok' => false, 'error' => 'Batch pointer tidak valid'], 400);
    }

    $allowedTypes = ['move' => true, 'down' => true, 'up' => true, 'cancel' => true, 'wheel' => true];
    $allowedButtons = ['left' => true, 'right' => true, 'middle' => true];
    $normalizedEvents = [];
    foreach ($events as $event) {
        if (!is_array($event)) {
            json_response(['ok' => false, 'error' => 'Event pointer tidak valid'], 400);
        }

        $type = strtolower((string) ($event['type'] ?? ''));
        $button = strtolower((string) ($event['button'] ?? 'left'));
        if (!isset($allowedTypes[$type]) || !isset($allowedButtons[$button])) {
            json_response(['ok' => false, 'error' => 'Tipe pointer tidak didukung'], 400);
        }

        $normalized = [
            'type' => $type,
            'button' => $button,
            'sequence' => max(0, (int) ($event['sequence'] ?? 0)),
        ];
        if (!in_array($type, ['cancel', 'wheel'], true)) {
            $x = filter_var($event['x'] ?? null, FILTER_VALIDATE_INT);
            $y = filter_var($event['y'] ?? null, FILTER_VALIDATE_INT);
            if ($x === false || $y === false || $x < 0 || $y < 0 || $x > 20000 || $y > 20000) {
                json_response(['ok' => false, 'error' => 'Koordinat pointer tidak valid'], 400);
            }
            $normalized['x'] = $x;
            $normalized['y'] = $y;
        }
        if ($type === 'wheel') {
            $normalized['deltaX'] = max(-$wheelMaxLines, min($wheelMaxLines, (int) ($event['deltaX'] ?? 0)));
            $normalized['deltaY'] = max(-$wheelMaxLines, min($wheelMaxLines, (int) ($event['deltaY'] ?? 0)));
            if ($normalized['deltaX'] === 0 && $normalized['deltaY'] === 0) {
                continue;
            }
        }
        $normalizedEvents[] = $normalized;
    }

    $kind = 'move';
    foreach ($normalizedEvents as $event) {
        if (($event['type'] ?? '') !== 'move') {
            $kind = 'boundary';
            break;
        }
    }

    return [
        'gestureId' => clean_text((string) ($body['gesture_id'] ?? ''), 80),
        'epoch' => max(0, (int) ($body['epoch'] ?? 0)),
        'kind' => $kind,
        'events' => $normalizedEvents,
        'releaseTimeoutMs' => (int) ((app_config()['live'] ?? [])['pointer_release_timeout_ms'] ?? 2500),
    ];
}

function queue_pointer_command(int $deviceId, array $payload, int $ttlSeconds): int
{
    if (($payload['kind'] ?? '') !== 'move') {
        return queue_device_command($deviceId, 'mouse_input', $payload, $ttlSeconds);
    }

    $stmt = db()->prepare(
        "SELECT id, payload_json
         FROM commands
         WHERE device_id = ?
           AND action = 'mouse_input'
           AND status = 'queued'
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY id DESC
         LIMIT 1"
    );
    $stmt->execute([$deviceId]);
    foreach ($stmt->fetchAll() as $queued) {
        $existing = json_decode((string) ($queued['payload_json'] ?? ''), true);
        if (!is_array($existing) || ($existing['kind'] ?? '') !== 'move') {
            break;
        }

        $update = db()->prepare(
            "UPDATE commands
             SET payload_json = ?,
                 created_at = NOW(),
                 expires_at = DATE_ADD(NOW(), INTERVAL {$ttlSeconds} SECOND)
             WHERE id = ? AND device_id = ? AND status = 'queued'"
        );
        $update->execute([
            json_encode($payload, JSON_UNESCAPED_SLASHES),
            (int) $queued['id'],
            $deviceId,
        ]);
        if ($update->rowCount() > 0) {
            return (int) $queued['id'];
        }
    }

    return queue_device_command($deviceId, 'mouse_input', $payload, $ttlSeconds);
}

$deviceId = (int) ($body['device_id'] ?? 0);
$action = (string) ($body['action'] ?? 'status');

if ($deviceId <= 0) {
    json_response(['ok' => false, 'error' => 'device_id required'], 400);
}

$stmt = db()->prepare(
    'SELECT id, name, hostname, platform, agent_version, transport_mode, transport_selected,
            live_profile, live_until, last_seen, TIMESTAMPDIFF(SECOND, last_seen, NOW()) AS last_seen_age_seconds
     FROM devices
     WHERE id = ?
     LIMIT 1'
);
$stmt->execute([$deviceId]);
$device = $stmt->fetch();
if (!$device) {
    json_response(['ok' => false, 'error' => 'Device tidak ditemukan'], 404);
}
prune_expired_commands($deviceId);
$liveConfig = app_config()['live'] ?? [];
$pointerCommandTtl = (int) ($liveConfig['pointer_command_ttl_seconds'] ?? 3);
$inputCommandTtl = (int) ($liveConfig['input_command_ttl_seconds'] ?? 5);

$lastSeenAgeSeconds = $device['last_seen_age_seconds'] === null
    ? null
    : max(0, (int) $device['last_seen_age_seconds']);
$onlineWindowSeconds = (int) ((app_config()['live'] ?? [])['agent_online_window_seconds'] ?? 60);

$liveProfile = normalize_live_profile((string) ($body['profile'] ?? ($device['live_profile'] ?? 'flow')));
if (!empty($body['live_active'])) {
    touch_live_session($deviceId, $liveProfile);
    $device['live_profile'] = $liveProfile;
    $device['live_until'] = date('Y-m-d H:i:s', time() + max(3, min(60, (int) ((app_config()['live'] ?? [])['activity_ttl_seconds'] ?? 12))));
}

if ($action === 'capture') {
    $profile = $liveProfile;
    $cooldownSeconds = [
        'eco' => 3,
        'flow' => 1,
        'burst' => 0,
    ][$profile] ?? 1;
    $recentFrame = false;
    if ($cooldownSeconds > 0) {
        $cooldownSeconds = max(1, min(10, $cooldownSeconds));
        $stmt = db()->prepare(
            "SELECT 1
             FROM commands
             WHERE device_id = ?
               AND action = 'capture_screen'
               AND status = 'succeeded'
               AND completed_at >= DATE_SUB(NOW(), INTERVAL {$cooldownSeconds} SECOND)
             LIMIT 1"
        );
        $stmt->execute([$deviceId]);
        $recentFrame = (bool) $stmt->fetchColumn();
    }

    if (!$recentFrame && !has_pending_action($deviceId, 'capture_screen')) {
        queue_device_command($deviceId, 'capture_screen', [
            'timeoutMs' => 15000,
            'profile' => $profile,
            'dedupe' => true,
        ]);
    }
}

if ($action === 'click') {
    $x = filter_var($body['x'] ?? null, FILTER_VALIDATE_INT);
    $y = filter_var($body['y'] ?? null, FILTER_VALIDATE_INT);
    $button = (string) ($body['button'] ?? 'left');

    if ($x === false || $y === false || $x < 0 || $y < 0 || $x > 20000 || $y > 20000) {
        json_response(['ok' => false, 'error' => 'Koordinat klik tidak valid'], 400);
    }
    if (!in_array($button, ['left', 'right', 'middle'], true)) {
        json_response(['ok' => false, 'error' => 'Button klik tidak valid'], 400);
    }

    queue_device_command($deviceId, 'mouse_click', [
        'x' => $x,
        'y' => $y,
        'button' => $button,
        'double' => !empty($body['double']),
    ], $inputCommandTtl);
}

if ($action === 'pointer') {
    queue_pointer_command($deviceId, live_pointer_payload($body), $pointerCommandTtl);
}

if ($action === 'key') {
    $keyboardPayload = live_keyboard_payload($body);
    queue_device_command(
        $deviceId,
        ($keyboardPayload['kind'] ?? '') === 'state' ? 'keyboard_state' : 'keyboard_input',
        $keyboardPayload,
        $inputCommandTtl
    );
}

if ($action === 'transport') {
    $transportMode = strtolower((string) ($body['mode'] ?? 'poll'));
    if (!array_key_exists($transportMode, transport_modes())) {
        json_response(['ok' => false, 'error' => 'Metode koneksi tidak valid'], 400);
    }
    db()->prepare('UPDATE devices SET transport_mode = ? WHERE id = ?')->execute([$transportMode, $deviceId]);
    $device['transport_mode'] = $transportMode;
}

if (!in_array($action, ['status', 'capture', 'click', 'pointer', 'key', 'transport'], true)) {
    json_response(['ok' => false, 'error' => 'Action live tidak valid'], 400);
}

$latest = latest_screen_command($deviceId);
$pending = pending_action_flags($deviceId);
$frame = null;
if ($latest) {
    $result = [];
    if (!empty($latest['result_json'])) {
        $decoded = json_decode((string) $latest['result_json'], true);
        $result = is_array($decoded) ? $decoded : [];
    }

    $frame = [
        'id' => (int) $latest['id'],
        'url' => app_url('artifact.php?id=' . (int) $latest['id'] . '&inline=1'),
        'download_url' => app_url('artifact.php?id=' . (int) $latest['id']),
        'name' => $latest['artifact_name'],
        'mime' => $latest['artifact_mime'],
        'created_at' => $latest['created_at'],
        'completed_at' => $latest['completed_at'],
        'observed_at' => $latest['observed_at'] ?? $latest['completed_at'],
        'screen' => $result['screen'] ?? null,
    ];
}

json_response([
    'ok' => true,
    'device' => [
        'id' => (int) $device['id'],
        'name' => $device['name'],
        'hostname' => $device['hostname'],
        'platform' => $device['platform'],
        'agent_version' => $device['agent_version'],
        'last_seen' => $device['last_seen'],
        'last_seen_age_seconds' => $lastSeenAgeSeconds,
        'online' => $lastSeenAgeSeconds !== null && $lastSeenAgeSeconds <= $onlineWindowSeconds,
    ],
    'pending_capture' => $pending['capture_screen'],
    'pending_click' => $pending['mouse_click'],
    'pending_pointer' => $pending['mouse_input'],
    'pending_keyboard' => $pending['keyboard_input'],
    'pending_keyboard_state' => $pending['keyboard_state'],
    'transport' => [
        'profile' => 'adaptive-http',
        'requested' => (string) ($device['transport_mode'] ?? 'poll'),
        'primary' => (string) ($device['transport_selected'] ?? 'http-poll'),
        'fallback' => 'http-poll',
        'available' => effective_agent_long_poll_ms('long-poll') > 0
            ? ['poll', 'long-poll', 'auto']
            : ['poll', 'auto'],
        'live_profile' => (string) ($device['live_profile'] ?? 'flow'),
        'live_until' => $device['live_until'] ?? null,
    ],
    'capabilities' => [
        'pointer_input' => version_compare((string) ($device['agent_version'] ?? '0.0.0'), '1.5.0', '>='),
        'keyboard_state' => version_compare((string) ($device['agent_version'] ?? '0.0.0'), '1.6.0', '>='),
        'wheel_input' => version_compare((string) ($device['agent_version'] ?? '0.0.0'), '1.6.0', '>='),
    ],
    'frame' => $frame,
    'performance' => [
        'server_ms' => (int) round((microtime(true) - $requestStartedAt) * 1000),
    ],
]);
