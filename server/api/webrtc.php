<?php

require_once __DIR__ . '/../lib/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['ok' => false, 'error' => 'POST required'], 405);
}

$body = read_json_body();
$action = strtolower((string) ($body['action'] ?? ''));
ensure_runtime_schema();

function webrtc_ttl_seconds(): int
{
    return max(10, min(180, (int) ((app_config()['live'] ?? [])['webrtc_signal_ttl_seconds'] ?? 45)));
}

function prune_webrtc_sessions(): void
{
    db()->exec("UPDATE webrtc_sessions SET status = 'expired' WHERE expires_at < NOW() AND status IN ('offered','answered')");
    db()->exec("DELETE FROM webrtc_sessions WHERE expires_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)");
}

function valid_session_description(mixed $value, string $expectedType): array
{
    if (!is_array($value)) {
        json_response(['ok' => false, 'error' => 'Session description tidak valid'], 400);
    }

    $type = strtolower((string) ($value['type'] ?? ''));
    $sdp = (string) ($value['sdp'] ?? '');
    if ($type !== $expectedType || $sdp === '' || strlen($sdp) > 160000) {
        json_response(['ok' => false, 'error' => 'SDP WebRTC tidak valid'], 400);
    }

    return [
        'type' => $type,
        'sdp' => $sdp,
        'candidates' => array_values(array_filter(
            is_array($value['candidates'] ?? null) ? $value['candidates'] : [],
            static fn ($candidate): bool => is_array($candidate) && isset($candidate['candidate'])
        )),
    ];
}

function require_admin_webrtc_body(array $body): void
{
    if (!is_admin_logged_in()) {
        json_response(['ok' => false, 'error' => 'Login diperlukan'], 401);
    }
    require_csrf_value((string) ($body['csrf_token'] ?? ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '')));
}

prune_webrtc_sessions();

if (in_array($action, ['create_offer', 'get_answer', 'close'], true)) {
    require_admin_webrtc_body($body);
    release_session_lock();

    if ($action === 'create_offer') {
        $deviceId = (int) ($body['device_id'] ?? 0);
        if ($deviceId <= 0) {
            json_response(['ok' => false, 'error' => 'device_id required'], 400);
        }

        $stmt = db()->prepare('SELECT id FROM devices WHERE id = ? LIMIT 1');
        $stmt->execute([$deviceId]);
        if (!$stmt->fetch()) {
            json_response(['ok' => false, 'error' => 'Device tidak ditemukan'], 404);
        }

        $offer = valid_session_description($body['offer'] ?? null, 'offer');
        $sessionUid = bin2hex(random_bytes(16));
        $ttl = webrtc_ttl_seconds();

        db()->prepare("UPDATE webrtc_sessions SET status = 'closed' WHERE device_id = ? AND status IN ('offered','answered','connected')")
            ->execute([$deviceId]);
        db()->prepare(
            "INSERT INTO webrtc_sessions (session_uid, device_id, offer_json, expires_at)
             VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL {$ttl} SECOND))"
        )->execute([
            $sessionUid,
            $deviceId,
            json_encode($offer, JSON_UNESCAPED_SLASHES),
        ]);
        db()->prepare('UPDATE devices SET transport_mode = ? WHERE id = ?')->execute(['webrtc', $deviceId]);

        json_response([
            'ok' => true,
            'session_uid' => $sessionUid,
            'expires_in_seconds' => $ttl,
        ]);
    }

    $sessionUid = preg_replace('/[^a-f0-9]/', '', strtolower((string) ($body['session_uid'] ?? '')));
    if ($sessionUid === '') {
        json_response(['ok' => false, 'error' => 'session_uid required'], 400);
    }

    if ($action === 'close') {
        db()->prepare("UPDATE webrtc_sessions SET status = 'closed' WHERE session_uid = ?")->execute([$sessionUid]);
        json_response(['ok' => true]);
    }

    $stmt = db()->prepare(
        'SELECT session_uid, answer_json, status, error_text, expires_at
         FROM webrtc_sessions
         WHERE session_uid = ?
         LIMIT 1'
    );
    $stmt->execute([$sessionUid]);
    $session = $stmt->fetch();
    if (!$session) {
        json_response(['ok' => false, 'error' => 'Session WebRTC tidak ditemukan'], 404);
    }

    $answer = null;
    if (!empty($session['answer_json'])) {
        $decoded = json_decode((string) $session['answer_json'], true);
        $answer = is_array($decoded) ? $decoded : null;
    }

    json_response([
        'ok' => true,
        'session_uid' => $sessionUid,
        'status' => $session['status'],
        'error' => $session['error_text'],
        'answer' => $answer,
        'expires_at' => $session['expires_at'],
    ]);
}

$device = require_api_device();
release_session_lock();

if ($action === 'agent_poll') {
    $stmt = db()->prepare(
        "SELECT session_uid, offer_json, expires_at
         FROM webrtc_sessions
         WHERE device_id = ?
           AND status = 'offered'
           AND expires_at >= NOW()
         ORDER BY id DESC
         LIMIT 1"
    );
    $stmt->execute([(int) $device['id']]);
    $session = $stmt->fetch();
    if (!$session) {
        json_response(['ok' => true, 'session' => null]);
    }

    $offer = json_decode((string) $session['offer_json'], true);
    json_response([
        'ok' => true,
        'session' => [
            'session_uid' => $session['session_uid'],
            'offer' => is_array($offer) ? $offer : null,
            'expires_at' => $session['expires_at'],
        ],
    ]);
}

if ($action === 'agent_answer') {
    $sessionUid = preg_replace('/[^a-f0-9]/', '', strtolower((string) ($body['session_uid'] ?? '')));
    $answer = valid_session_description($body['answer'] ?? null, 'answer');
    $stmt = db()->prepare(
        "UPDATE webrtc_sessions
         SET answer_json = ?, status = 'answered', answered_at = NOW()
         WHERE session_uid = ?
           AND device_id = ?
           AND status = 'offered'
           AND expires_at >= NOW()"
    );
    $stmt->execute([
        json_encode($answer, JSON_UNESCAPED_SLASHES),
        $sessionUid,
        (int) $device['id'],
    ]);
    if ($stmt->rowCount() < 1) {
        json_response(['ok' => false, 'error' => 'Session WebRTC tidak tersedia'], 409);
    }
    db()->prepare('UPDATE devices SET transport_selected = ? WHERE id = ?')->execute(['webrtc-data', (int) $device['id']]);
    json_response(['ok' => true]);
}

if ($action === 'agent_status') {
    $sessionUid = preg_replace('/[^a-f0-9]/', '', strtolower((string) ($body['session_uid'] ?? '')));
    $status = strtolower((string) ($body['status'] ?? ''));
    if (!in_array($status, ['connected', 'failed', 'closed'], true)) {
        json_response(['ok' => false, 'error' => 'Status WebRTC tidak valid'], 400);
    }
    $errorText = clean_text((string) ($body['error'] ?? ''), 1000);
    db()->prepare(
        "UPDATE webrtc_sessions
         SET status = ?, error_text = ?, connected_at = IF(? = 'connected', NOW(), connected_at)
         WHERE session_uid = ? AND device_id = ?"
    )->execute([$status, $errorText, $status, $sessionUid, (int) $device['id']]);
    db()->prepare('UPDATE devices SET transport_selected = ? WHERE id = ?')
        ->execute([$status === 'connected' ? 'webrtc-data' : 'http-poll', (int) $device['id']]);
    json_response(['ok' => true]);
}

json_response(['ok' => false, 'error' => 'Action WebRTC tidak valid'], 400);
