<?php

require dirname(__DIR__) . '/server/lib/helpers.php';

function check(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

ensure_runtime_schema();

$schemaVersion = db()->query("SELECT meta_value FROM app_meta WHERE meta_key = 'schema_version' LIMIT 1")->fetchColumn();
check((int) $schemaVersion === runtime_schema_version(), 'runtime schema version marker is stale');

$deviceColumns = table_columns('devices');
$commandColumns = table_columns('commands');
$commandIndexes = table_indexes('commands');
check(isset($deviceColumns['agent_boot_id']), 'devices.agent_boot_id is missing');
check(isset($deviceColumns['agent_boot_started_at']), 'devices.agent_boot_started_at is missing');
check(isset($commandColumns['expires_at']), 'commands.expires_at is missing');
check(isset($commandIndexes['idx_commands_device_expiry']), 'commands expiry index is missing');

$pdo = db();
$uid = 'qa-reliability-' . bin2hex(random_bytes(6));
$pdo->prepare(
    'INSERT INTO devices (device_uid, name, api_token_hash, last_seen)
     VALUES (?, ?, ?, NOW())'
)->execute([$uid, 'QA reliability', hash('sha256', $uid)]);
$deviceId = (int) $pdo->lastInsertId();

try {
    queue_device_command($deviceId, 'mouse_input', ['kind' => 'move'], 1);
    sleep(2);
    check(prune_expired_commands($deviceId) === 1, 'expired live command was not pruned');

    $normalId = queue_device_command($deviceId, 'health_check');
    $liveId = queue_device_command($deviceId, 'keyboard_state', ['kind' => 'state'], 10);
    $pdo->prepare("UPDATE commands SET status = 'running' WHERE id IN (?, ?)")
        ->execute([$normalId, $liveId]);

    $firstBoot = claim_agent_boot($deviceId, 'qa-current-boot', 2000);
    check(!empty($firstBoot['accepted']) && !empty($firstBoot['changed']), 'new agent boot was not accepted');
    check((int) $firstBoot['recovered'] === 1, 'stuck durable command was not recovered');
    check((int) $firstBoot['discarded_live'] === 1, 'stale live command was not discarded');

    $sameBoot = claim_agent_boot($deviceId, 'qa-current-boot', 2000);
    check(!empty($sameBoot['accepted']) && empty($sameBoot['changed']), 'same agent boot was not idempotent');

    $olderBoot = claim_agent_boot($deviceId, 'qa-older-boot', 1000);
    check(empty($olderBoot['accepted']), 'older agent boot was not rejected');

    $pdo->prepare('UPDATE devices SET last_seen = DATE_SUB(NOW(), INTERVAL 10 MINUTE) WHERE id = ?')
        ->execute([$deviceId]);
    $staleTakeover = claim_agent_boot($deviceId, 'qa-older-boot', 1000);
    check(
        !empty($staleTakeover['accepted']) && !empty($staleTakeover['changed']),
        'stale agent session could not be recovered after its online window'
    );

    $stmt = $pdo->prepare('SELECT status, error_text FROM commands WHERE id = ? LIMIT 1');
    $stmt->execute([$normalId]);
    $normal = $stmt->fetch();
    check(($normal['status'] ?? '') === 'failed', 'stuck durable command did not fail cleanly');
    check(
        ($normal['error_text'] ?? '') === 'Agent restarted before command completed',
        'recovered command has an unexpected error'
    );

    echo "Reliability integration test: PASS\n";
} finally {
    $pdo->prepare('DELETE FROM devices WHERE id = ?')->execute([$deviceId]);
}
