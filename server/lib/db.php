<?php

function app_config(): array
{
    static $config = null;

    if ($config === null) {
        $config = require __DIR__ . DIRECTORY_SEPARATOR . 'config.php';
    }

    return $config;
}

function db(): PDO
{
    static $pdo = null;

    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $config = app_config()['db'];
    if (($config['dsn'] ?? '') === '') {
        throw new RuntimeException('Database belum dikonfigurasi. Set APP_DB_DSN atau buat server/lib/config.local.php.');
    }

    $pdo = new PDO($config['dsn'], $config['username'], $config['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);

    return $pdo;
}
