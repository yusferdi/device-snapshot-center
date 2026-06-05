<?php

require_once __DIR__ . '/../lib/helpers.php';

apply_security_headers();
http_response_code(404);
echo 'Not found';
