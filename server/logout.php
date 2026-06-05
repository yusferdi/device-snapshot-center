<?php

require_once __DIR__ . '/lib/helpers.php';

require_admin();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    apply_security_headers();
    echo 'POST required';
    exit;
}

try {
    require_csrf();
} catch (Throwable $th) {
    http_response_code(403);
    apply_security_headers();
    echo h($th->getMessage());
    exit;
}

$_SESSION = [];
session_destroy();

redirect_to();
