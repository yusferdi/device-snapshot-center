<?php

require_once __DIR__ . '/../lib/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['ok' => false, 'error' => 'POST required'], 405);
}

if (!is_admin_logged_in()) {
    json_response(['ok' => false, 'error' => 'Login diperlukan'], 401);
}
$body = read_json_body();
require_csrf_value((string) ($body['csrf_token'] ?? ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '')));

function live_keyboard_payload(array $body): array
{
    $kind = strtolower((string) ($body['kind'] ?? 'key'));
    if (!in_array($kind, ['text', 'key'], true)) {
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
        'insert', 'capslock',
        'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
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

    return [
        'kind' => 'key',
        'key' => $key,
        'modifiers' => $modifiers,
    ];
}

function live_pointer_payload(array $body): array
{
    $events = $body['events'] ?? null;
    $maxEvents = (int) ((app_config()['live'] ?? [])['pointer_max_events'] ?? 64);
    if (!is_array($events) || $events === [] || count($events) > $maxEvents) {
        json_response(['ok' => false, 'error' => 'Batch pointer tidak valid'], 400);
    }

    $allowedTypes = ['move' => true, 'down' => true, 'up' => true, 'cancel' => true];
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
        if ($type !== 'cancel') {
            $x = filter_var($event['x'] ?? null, FILTER_VALIDATE_INT);
            $y = filter_var($event['y'] ?? null, FILTER_VALIDATE_INT);
            if ($x === false || $y === false || $x < 0 || $y < 0 || $x > 20000 || $y > 20000) {
                json_response(['ok' => false, 'error' => 'Koordinat pointer tidak valid'], 400);
            }
            $normalized['x'] = $x;
            $normalized['y'] = $y;
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

function queue_pointer_command(int $deviceId, array $payload): int
{
    if (($payload['kind'] ?? '') !== 'move') {
        return queue_device_command($deviceId, 'mouse_input', $payload);
    }

    $stmt = db()->prepare(
        "SELECT id, payload_json
         FROM commands
         WHERE device_id = ? AND action = 'mouse_input' AND status = 'queued'
         ORDER BY id DESC
         LIMIT 5"
    );
    $stmt->execute([$deviceId]);
    foreach ($stmt->fetchAll() as $queued) {
        $existing = json_decode((string) ($queued['payload_json'] ?? ''), true);
        if (!is_array($existing) || ($existing['kind'] ?? '') !== 'move') {
            continue;
        }

        $update = db()->prepare(
            "UPDATE commands SET payload_json = ?, created_at = NOW()
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

    return queue_device_command($deviceId, 'mouse_input', $payload);
}

$deviceId = (int) ($body['device_id'] ?? 0);
$action = (string) ($body['action'] ?? 'status');

if ($deviceId <= 0) {
    json_response(['ok' => false, 'error' => 'device_id required'], 400);
}

$stmt = db()->prepare('SELECT id, name, hostname, platform, agent_version, last_seen FROM devices WHERE id = ? LIMIT 1');
$stmt->execute([$deviceId]);
$device = $stmt->fetch();
if (!$device) {
    json_response(['ok' => false, 'error' => 'Device tidak ditemukan'], 404);
}

if ($action === 'capture') {
    $recentFrame = false;
    $stmt = db()->prepare(
        "SELECT 1
         FROM commands
         WHERE device_id = ?
           AND action = 'capture_screen'
           AND status = 'succeeded'
           AND completed_at >= DATE_SUB(NOW(), INTERVAL 1 SECOND)
         LIMIT 1"
    );
    $stmt->execute([$deviceId]);
    $recentFrame = (bool) $stmt->fetchColumn();

    if (!$recentFrame && !has_pending_action($deviceId, 'capture_screen')) {
        queue_device_command($deviceId, 'capture_screen', [
            'timeoutMs' => 15000,
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
    ]);
}

if ($action === 'pointer') {
    queue_pointer_command($deviceId, live_pointer_payload($body));
}

if ($action === 'key') {
    queue_device_command($deviceId, 'keyboard_input', live_keyboard_payload($body));
}

if (!in_array($action, ['status', 'capture', 'click', 'pointer', 'key'], true)) {
    json_response(['ok' => false, 'error' => 'Action live tidak valid'], 400);
}

$latest = latest_screen_command($deviceId);
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
        'last_seen' => $device['last_seen'],
    ],
    'pending_capture' => has_pending_action($deviceId, 'capture_screen'),
    'pending_click' => has_pending_action($deviceId, 'mouse_click'),
    'pending_pointer' => has_pending_action($deviceId, 'mouse_input'),
    'pending_keyboard' => has_pending_action($deviceId, 'keyboard_input'),
    'transport' => [
        'profile' => 'adaptive-http',
        'primary' => effective_agent_long_poll_ms() > 0
            ? 'http-long-poll'
            : 'http-poll',
        'fallback' => 'http-poll',
    ],
    'capabilities' => [
        'pointer_input' => version_compare((string) ($device['agent_version'] ?? '0.0.0'), '1.5.0', '>='),
    ],
    'frame' => $frame,
]);
