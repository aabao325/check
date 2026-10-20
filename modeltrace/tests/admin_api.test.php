<?php
/**
 * tests/admin_api.test.php —— 采集台后端：登录锁定、会话、档案闸门
 *
 * 起一个 PHP 内置服务器跑真实的 admin.php（mt_out 会 exit，只能从外部打 HTTP 来测状态码），
 * 数据目录指到临时目录，测完删除。用法：php modeltrace/tests/admin_api.test.php
 *
 * 锁住的事：
 *   ① 连续输错 MT_LOGIN_MAX_FAILS 次被锁；锁定期间连正确密码也进不去（先查锁、再比哈希）
 *   ② 无令牌 / 伪造令牌 / 登出后的令牌 一律 401
 *   ③ 档案字段白名单：传进来的 api_key 不会落盘；超范围数字被丢弃
 *   ④ 档案数量封顶；请求体过大 413；限流 429
 */

$root = realpath(__DIR__ . '/..');
$tmp = sys_get_temp_dir() . '/mt-admin-test-' . bin2hex(random_bytes(4));
mkdir($tmp, 0777, true);
$password = 'correct horse battery staple';
$hash = password_hash($password, PASSWORD_DEFAULT);
$port = 18000 + random_int(0, 999);

$env = array_merge(getenv(), [
    'MT_ADMIN_PASSWORD_HASH' => $hash,
    'MT_DATA_DIR' => $tmp,
    'MT_LOGIN_MAX_FAILS' => '3',
    'MT_MAX_ARCHIVES' => '10',
    'MT_RATE_LIMIT' => '40',
    'MT_RATE_WINDOW' => '60',
]);
$cmd = [PHP_BINARY, '-S', "127.0.0.1:$port", '-t', $root];
$proc = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['file', $tmp . '/server.log', 'a'], 2 => ['file', $tmp . '/server.log', 'a']], $pipes, $root, $env);
for ($i = 0; $i < 50; $i++) { if (@fsockopen('127.0.0.1', $port)) break; usleep(100000); }

$pass = 0; $fail = 0;
function ok($cond, string $msg): void { global $pass, $fail; if ($cond) { $pass++; return; } $fail++; fwrite(STDERR, "FAIL: $msg\n"); }

function call(array $body, string $token = '', ?string $raw = null): array {
    global $port;
    $ch = curl_init("http://127.0.0.1:$port/api/admin.php");
    $headers = ['Content-Type: application/json'];
    if ($token !== '') $headers[] = "Authorization: Bearer $token";
    curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $raw ?? json_encode($body), CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20]);
    $out = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$code, json_decode((string) $out, true) ?: ['_raw' => $out]];
}

try {
    // ---- ② 未登录 ----
    [$c] = call(['action' => 'list']);
    ok($c === 401, "未带令牌应 401，实际 $c");
    [$c] = call(['action' => 'list'], str_repeat('a', 64));
    ok($c === 401, "伪造令牌应 401，实际 $c");

    // ---- 正常登录 ----
    [$c, $j] = call(['action' => 'login', 'password' => $password]);
    ok($c === 200 && strlen($j['token'] ?? '') === 64, "正确密码应登录成功，实际 $c");
    $token = $j['token'] ?? '';
    ok(!is_file("$tmp/sessions/$token"), '服务端不应以明文令牌命名会话文件');
    ok(is_file("$tmp/sessions/" . hash('sha256', $token)), '会话文件应以令牌哈希命名');

    // ---- ③ 档案白名单 ----
    $archive = [
        'label' => '测试中转 A', 'base_url' => 'https://relay.example.com/v1', 'model' => 'claude-opus-5', 'format' => 'anthropic', 'kind' => 'relay',
        'api_key' => 'sk-should-never-be-stored', 'evil' => str_repeat('x', 1000),
        'rows' => [['challenge_id' => 'query-01', 'condition_id' => 'environment-01', 'expected_count' => 218, 'numbers' => [1, 2, 355, 356, 0, -5, 'x', 100]]],
        'analysis' => ['prediction' => 'claude-opus-5', 'probability' => 0.99, 'verdict' => 'match', 'top' => [['model' => 'claude-opus-5', 'probability' => 0.99, 'similarity' => 0.8]]],
    ];
    [$c, $j] = call(['action' => 'save', 'archive' => $archive], $token);
    ok($c === 200 && preg_match('/^a\d{6}[a-f0-9]{10}$/', $j['id'] ?? ''), "保存档案应成功，实际 $c");
    $id = $j['id'] ?? '';
    $disk = (string) @file_get_contents("$tmp/archives/$id.json");
    ok($disk !== '' && strpos($disk, 'sk-should-never-be-stored') === false, 'API Key 绝不能落盘');
    ok(strpos($disk, '"evil"') === false, '白名单外字段不应落盘');
    $saved = json_decode($disk, true);
    ok(($saved['rows'][0]['numbers'] ?? null) === [1, 2, 355, 100], '超出 1..355 的数字与非整数应被丢弃');
    ok(($saved['host'] ?? '') === 'relay.example.com', '应从 base_url 提取 host');

    [$c, $j] = call(['action' => 'list'], $token);
    ok($c === 200 && count($j['archives'] ?? []) === 1 && ($j['archives'][0]['numbers'] ?? 0) === 4, '列表应返回 1 条摘要');
    [$c, $j] = call(['action' => 'get', 'id' => $id], $token);
    ok($c === 200 && ($j['archive']['label'] ?? '') === '测试中转 A', '读取档案');
    [$c] = call(['action' => 'get', 'id' => '../../etc/passwd'], $token);
    ok($c === 404, "路径穿越 id 应 404，实际 $c");

    // 覆盖保存保留 created_at
    $created = $saved['created_at'];
    sleep(1);
    [$c] = call(['action' => 'save', 'id' => $id, 'archive' => ['label' => '改名', 'model' => 'x'] + $archive], $token);
    $re = json_decode((string) file_get_contents("$tmp/archives/$id.json"), true);
    ok($c === 200 && $re['label'] === '改名' && $re['created_at'] === $created && $re['updated_at'] > $created, '覆盖保存应保留 created_at');

    // 空档案拒绝
    [$c] = call(['action' => 'save', 'archive' => ['label' => 'x', 'model' => 'y', 'rows' => []]], $token);
    ok($c === 400, "无回答的档案应 400，实际 $c");

    // ---- ④ 数量封顶 ----
    for ($i = 0; $i < 9; $i++) call(['action' => 'save', 'archive' => $archive], $token);
    [$c] = call(['action' => 'save', 'archive' => $archive], $token);
    ok($c === 409, "超过档案数上限应 409，实际 $c");
    ok(count(glob("$tmp/archives/a*.json")) === 10, '磁盘上档案数不应超过上限');

    // ---- ④ 请求体过大 ----
    [$c] = call([], $token, json_encode(['action' => 'save', 'archive' => ['note' => str_repeat('y', 600 * 1024)]]));
    ok($c === 413, "超大请求体应 413，实际 $c");

    // ---- 删除 ----
    [$c] = call(['action' => 'delete', 'id' => $id], $token);
    ok($c === 200 && !is_file("$tmp/archives/$id.json"), '删除档案');

    // ---- 登出后令牌失效 ----
    call(['action' => 'logout'], $token);
    [$c] = call(['action' => 'list'], $token);
    ok($c === 401, "登出后令牌应失效，实际 $c");

    // ---- ① 登录锁定：先查锁再比哈希 ----
    for ($i = 0; $i < 2; $i++) { [$c] = call(['action' => 'login', 'password' => 'wrong']); ok($c === 401, "第 " . ($i + 1) . " 次错误密码应 401，实际 $c"); }
    [$c, $j] = call(['action' => 'login', 'password' => 'wrong']);
    ok($c === 429 && ($j['retry_after'] ?? 0) > 0, "第 3 次错误应触发锁定 429，实际 $c");
    [$c] = call(['action' => 'login', 'password' => $password]);
    ok($c === 429, "锁定期间正确密码也应 429，实际 $c");

    // ---- ④ 限流 ----
    $codes = [];
    for ($i = 0; $i < 45; $i++) { [$c] = call(['action' => 'ping']); $codes[] = $c; }
    ok(in_array(429, $codes, true), '超出限流阈值应出现 429');
} finally {
    proc_terminate($proc);
    proc_close($proc);
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($tmp, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($it as $f) { $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname()); }
    @rmdir($tmp);
}

echo "admin_api: $pass passed, $fail failed\n";
exit($fail ? 1 : 0);
