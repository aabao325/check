<?php
/**
 * modeltrace/api/_common.php —— 大模型归因检测 · 后端公共层
 * =====================================================================
 * 后端只服务管理员采集台，而且只做秒级短请求（采集用的模型请求一律浏览器直连）：
 *   admin.php    密码登录 / 中转站档案的增删查
 *
 * 官方指纹库【不】经后端发布：采集台在浏览器里建好库导出文件，由人提交进仓库。
 * 这样密码即使泄露，也改不了所有访客看到的检测结论；每次变更都可审查、可回滚。
 *
 * 写入端点四件套（见 2026-10-10 check/ 事故复盘）：
 *   ① 单请求体封顶    mt_read_json 先看 Content-Length，再按实际长度兜底
 *   ② 总量封顶        档案数量上限 + 单档大小上限，字段逐个截断后才落盘
 *   ③ 按客户端限流    只认 REMOTE_ADDR，绝不掺请求头
 *   ④ 回收            过期会话 / 失败计数 / 窗口外限流记录自动清理
 * 唯一不需登录的写入是「登录本身」：先查锁、再比哈希（反过来锁定只挡成功登录，挡不住刷 CPU）。
 *
 * 运行时数据默认在 data/runtime/，生产建议把 MT_DATA_DIR 指到站点根 data/modeltrace
 * （与 check / iq 同一父目录，一条 nginx 规则挡住三站；见 README）。不入库：
 *   archives/<id>.json   中转站档案       sessions/<sha256>   管理员会话
 *   attempts.json        登录失败计数     rate.json           限流计数
 * ===================================================================== */

declare(strict_types=1);

$__cfg = [];
foreach ([__DIR__ . '/config.php', __DIR__ . '/config.example.php'] as $__f) {
    if (is_file($__f)) {
        $__loaded = require $__f;
        if (is_array($__loaded)) { $__cfg = $__loaded; }
        break;
    }
}

/** 取配置：同名环境变量优先，其次配置文件，最后默认值。 */
function mt_cfg(array $cfg, string $key, $default) {
    $env = getenv($key);
    if ($env !== false && $env !== '') { return $env; }
    return (isset($cfg[$key]) && $cfg[$key] !== '') ? $cfg[$key] : $default;
}

/* 管理员密码只存 bcrypt 哈希。生成：php -r "echo password_hash('你的密码', PASSWORD_DEFAULT);" */
define('MT_ADMIN_PASSWORD_HASH', (string) mt_cfg($__cfg, 'MT_ADMIN_PASSWORD_HASH', ''));
define('MT_DATA_DIR',            rtrim((string) mt_cfg($__cfg, 'MT_DATA_DIR', __DIR__ . '/../data/runtime'), '/\\'));

// ---- 闸门（数值可用同名环境变量或 config.php 覆盖；测试直接引用这些常量） ----
define('MT_SESSION_TTL',        max(600, (int) mt_cfg($__cfg, 'MT_SESSION_TTL', 12 * 3600)));
define('MT_LOGIN_MAX_FAILS',    max(3, (int) mt_cfg($__cfg, 'MT_LOGIN_MAX_FAILS', 5)));
define('MT_LOGIN_LOCK_SECONDS', max(60, (int) mt_cfg($__cfg, 'MT_LOGIN_LOCK_SECONDS', 15 * 60)));
define('MT_MAX_BODY_BYTES',     max(64 * 1024, min(16 * 1024 * 1024, (int) mt_cfg($__cfg, 'MT_MAX_BODY_BYTES', 512 * 1024))));
define('MT_MAX_ARCHIVE_BYTES',  max(64 * 1024, min(8 * 1024 * 1024, (int) mt_cfg($__cfg, 'MT_MAX_ARCHIVE_BYTES', 400 * 1024))));
define('MT_MAX_ARCHIVES',       max(10, min(5000, (int) mt_cfg($__cfg, 'MT_MAX_ARCHIVES', 300))));
define('MT_RATE_LIMIT',         max(5, min(1000, (int) mt_cfg($__cfg, 'MT_RATE_LIMIT', 60))));
define('MT_RATE_WINDOW',        max(10, min(3600, (int) mt_cfg($__cfg, 'MT_RATE_WINDOW', 60))));

/** 统一 JSON 输出并结束。 */
function mt_out(int $code, array $data): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/** 先看 Content-Length 提前拒绝，再以实际长度兜底（Content-Length 可缺失或伪造）。 */
function mt_read_json(int $limit = 0): array {
    $limit = $limit > 0 ? $limit : MT_MAX_BODY_BYTES;
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $limit) { mt_out(413, ['ok' => false, 'error' => '请求体过大']); }
    $raw = file_get_contents('php://input', false, null, 0, $limit + 1);
    if ($raw === false || trim($raw) === '') { return []; }
    if (strlen($raw) > $limit) { mt_out(413, ['ok' => false, 'error' => '请求体过大']); }
    $data = json_decode($raw, true);
    if (!is_array($data)) { mt_out(400, ['ok' => false, 'error' => '请求体不是合法 JSON']); }
    return $data;
}

/** 客户端标识只取 REMOTE_ADDR：UA / XFF / CF-Connecting-IP 都可伪造，掺进来限流就失效。 */
function mt_client(): string {
    return hash('sha256', 'mt|' . ($_SERVER['REMOTE_ADDR'] ?? 'unknown'));
}

function mt_dir(string $sub = ''): string {
    $dir = MT_DATA_DIR . ($sub !== '' ? '/' . $sub : '');
    if (!is_dir($dir) && !@mkdir($dir, 0750, true) && !is_dir($dir)) {
        mt_out(500, ['ok' => false, 'error' => '数据目录不可写：' . basename($dir)]);
    }
    return $dir;
}

/** 原子写：先写同目录临时文件再 rename，进程中途被杀也不会留下半截 JSON。 */
function mt_write_atomic(string $path, string $content): void {
    $tmp = $path . '.tmp-' . bin2hex(random_bytes(4));
    if (@file_put_contents($tmp, $content, LOCK_EX) === false || !@rename($tmp, $path)) {
        @unlink($tmp);
        mt_out(500, ['ok' => false, 'error' => '写入失败']);
    }
}

/** 带文件锁的读-改-写（登录计数、限流共用）。$fn 收到当前数组，返回新数组。 */
function mt_locked_json(string $path, callable $fn) {
    $fp = @fopen($path, 'c+');
    if (!$fp) { mt_out(500, ['ok' => false, 'error' => '状态文件不可写']); }
    flock($fp, LOCK_EX);
    $raw = stream_get_contents($fp);
    $data = json_decode($raw ?: '[]', true);
    if (!is_array($data)) { $data = []; }
    [$next, $ret] = $fn($data);
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($next, JSON_UNESCAPED_SLASHES));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    return $ret;
}

/** 滑动窗口限流（按客户端）。超限直接 429。顺带清掉窗口外的旧客户端，文件不会无限长。 */
function mt_rate_limit(string $bucket): void {
    $now = time();
    $key = $bucket . ':' . mt_client();
    $allowed = mt_locked_json(mt_dir() . '/rate.json', function (array $d) use ($now, $key) {
        foreach ($d as $k => $v) { if (!is_array($v) || ($v['t'] ?? 0) + MT_RATE_WINDOW <= $now) { unset($d[$k]); } }
        $cur = $d[$key] ?? ['t' => $now, 'n' => 0];
        $cur['n'] = (int) $cur['n'] + 1;
        $d[$key] = $cur;
        return [$d, $cur['n'] <= MT_RATE_LIMIT];
    });
    if (!$allowed) {
        header('Retry-After: ' . MT_RATE_WINDOW);
        mt_out(429, ['ok' => false, 'error' => '请求太频繁，请稍后再试']);
    }
}
/* ===================== 登录：先查锁，再比哈希 ===================== */

/** 剩余锁定秒数；0 表示未锁。顺带清理已解锁且长期不活跃的记录。 */
function mt_login_locked(): int {
    $now = time();
    $client = mt_client();
    return (int) mt_locked_json(mt_dir() . '/attempts.json', function (array $d) use ($now, $client) {
        foreach ($d as $k => $v) {
            if (!is_array($v) || (($v['until'] ?? 0) <= $now && ($v['last'] ?? 0) + MT_LOGIN_LOCK_SECONDS <= $now)) { unset($d[$k]); }
        }
        $until = (int) ($d[$client]['until'] ?? 0);
        return [$d, $until > $now ? $until - $now : 0];
    });
}

/** 记一次失败；达到上限则锁定并清零计数，返回锁定秒数（0 = 未锁）。 */
function mt_login_failed(): int {
    $now = time();
    $client = mt_client();
    return (int) mt_locked_json(mt_dir() . '/attempts.json', function (array $d) use ($now, $client) {
        $row = $d[$client] ?? ['n' => 0, 'until' => 0, 'last' => 0];
        if (($row['until'] ?? 0) > 0 && $row['until'] <= $now) { $row = ['n' => 0, 'until' => 0, 'last' => 0]; }
        $row['n'] = (int) $row['n'] + 1;
        $row['last'] = $now;
        $lock = 0;
        if ($row['n'] >= MT_LOGIN_MAX_FAILS) { $row = ['n' => 0, 'until' => $now + MT_LOGIN_LOCK_SECONDS, 'last' => $now]; $lock = MT_LOGIN_LOCK_SECONDS; }
        $d[$client] = $row;
        return [$d, $lock];
    });
}

function mt_login_cleared(): void {
    $client = mt_client();
    mt_locked_json(mt_dir() . '/attempts.json', function (array $d) use ($client) { unset($d[$client]); return [$d, null]; });
}

/** 校验密码并签发会话令牌。令牌只在内存里给客户端，服务端存的是它的 sha256。 */
function mt_login(string $password): array {
    if (MT_ADMIN_PASSWORD_HASH === '') {
        mt_out(503, ['ok' => false, 'error' => '管理员密码未配置：在 modeltrace/api/config.php 填写 MT_ADMIN_PASSWORD_HASH']);
    }
    $locked = mt_login_locked();
    if ($locked > 0) {
        header('Retry-After: ' . $locked);
        mt_out(429, ['ok' => false, 'error' => "密码错误次数过多，请 " . ceil($locked / 60) . " 分钟后再试", 'retry_after' => $locked]);
    }
    if (strlen($password) > 256 || !password_verify($password, MT_ADMIN_PASSWORD_HASH)) {
        $lock = mt_login_failed();
        if ($lock > 0) {
            header('Retry-After: ' . $lock);
            mt_out(429, ['ok' => false, 'error' => '密码错误次数过多，已锁定 ' . ceil($lock / 60) . ' 分钟', 'retry_after' => $lock]);
        }
        mt_out(401, ['ok' => false, 'error' => '密码错误']);
    }
    mt_login_cleared();
    mt_sessions_sweep();
    $token = bin2hex(random_bytes(32));
    $expires = time() + MT_SESSION_TTL;
    mt_write_atomic(mt_dir('sessions') . '/' . hash('sha256', $token), json_encode(['expires' => $expires]));
    return ['token' => $token, 'expires' => $expires];
}

function mt_bearer(): string {
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if ($h === '' && function_exists('getallheaders')) {
        foreach (getallheaders() as $k => $v) { if (strcasecmp($k, 'Authorization') === 0) { $h = $v; break; } }
    }
    return preg_match('/^Bearer\s+([a-f0-9]{64})$/i', trim((string) $h), $m) ? strtolower($m[1]) : '';
}

/** 要求已登录；否则 401。 */
function mt_require_admin(): void {
    $token = mt_bearer();
    $file = $token !== '' ? MT_DATA_DIR . '/sessions/' . hash('sha256', $token) : '';
    $row = ($file !== '' && is_file($file)) ? json_decode((string) file_get_contents($file), true) : null;
    if (!is_array($row) || (int) ($row['expires'] ?? 0) <= time()) {
        if ($file !== '' && is_file($file)) { @unlink($file); }
        mt_out(401, ['ok' => false, 'error' => '未登录或登录已过期', 'relogin' => true]);
    }
}

function mt_logout(): void {
    $token = mt_bearer();
    if ($token !== '') { @unlink(MT_DATA_DIR . '/sessions/' . hash('sha256', $token)); }
}

function mt_sessions_sweep(): void {
    $now = time();
    foreach (glob(mt_dir('sessions') . '/*') ?: [] as $f) {
        $row = json_decode((string) @file_get_contents($f), true);
        if (!is_array($row) || (int) ($row['expires'] ?? 0) <= $now) { @unlink($f); }
    }
}

/* ===================== 档案 ===================== */

function mt_archive_id(): string { return 'a' . date('ymd') . bin2hex(random_bytes(5)); }

function mt_valid_archive_id(string $id): bool { return (bool) preg_match('/^a\d{6}[a-f0-9]{10}$/', $id); }

/** 档案只收已知字段、逐个截断，避免把任意大对象原样落盘。Key 永远不落盘。 */
function mt_clean_archive(array $in): array {
    $str = static fn($v, int $n) => mb_substr(trim((string) ($v ?? '')), 0, $n);
    $base = $str($in['base_url'] ?? '', 300);
    $host = parse_url($base, PHP_URL_HOST) ?: '';
    $rows = [];
    foreach (array_slice(is_array($in['rows'] ?? null) ? $in['rows'] : [], 0, 60) as $r) {
        if (!is_array($r)) { continue; }
        $nums = array_values(array_filter(array_slice(is_array($r['numbers'] ?? null) ? $r['numbers'] : [], 0, 600), static fn($n) => is_int($n) && $n >= 1 && $n <= 355));
        $rows[] = [
            'challenge_id' => $str($r['challenge_id'] ?? '', 16),
            'condition_id' => $str($r['condition_id'] ?? '', 24),
            'expected_count' => (int) ($r['expected_count'] ?? 0),
            'numbers' => $nums,
            'ms' => (int) ($r['ms'] ?? 0),
        ];
    }
    return [
        'label' => $str($in['label'] ?? '', 60),
        'note' => $str($in['note'] ?? '', 500),
        'base_url' => $base,
        'host' => $str($host, 120),
        'model' => $str($in['model'] ?? '', 80),
        'format' => in_array($in['format'] ?? '', ['openai', 'anthropic'], true) ? $in['format'] : '',
        'kind' => in_array($in['kind'] ?? '', ['official', 'relay'], true) ? $in['kind'] : 'relay',
        'family_id' => $str($in['family_id'] ?? '', 24),
        'family_name' => $str($in['family_name'] ?? '', 24),
        'rows' => $rows,
        'errors' => array_map(static fn($e) => mb_substr((string) $e, 0, 200), array_slice(is_array($in['errors'] ?? null) ? $in['errors'] : [], 0, 40)),
        'analysis' => is_array($in['analysis'] ?? null) ? mt_clean_analysis($in['analysis']) : null,
    ];
}

/** 归因摘要只留展示要用的标量与前 8 名，不存整份结果。 */
function mt_clean_analysis(array $a): array {
    $top = [];
    foreach (array_slice(is_array($a['top'] ?? null) ? $a['top'] : [], 0, 8) as $t) {
        if (!is_array($t)) { continue; }
        $top[] = ['model' => mb_substr((string) ($t['model'] ?? ''), 0, 80), 'probability' => (float) ($t['probability'] ?? 0), 'similarity' => (float) ($t['similarity'] ?? 0)];
    }
    return [
        'prediction' => mb_substr((string) ($a['prediction'] ?? ''), 0, 80),
        'probability' => (float) ($a['probability'] ?? 0),
        'claimed_probability' => isset($a['claimed_probability']) ? (float) $a['claimed_probability'] : null,
        'claimed_similarity' => isset($a['claimed_similarity']) ? (float) $a['claimed_similarity'] : null,
        'verdict' => in_array($a['verdict'] ?? '', ['match', 'mismatch', 'split', 'inconclusive', 'unknown'], true) ? $a['verdict'] : 'unknown',
        'agree' => (int) ($a['agree'] ?? 0),
        'used' => (int) ($a['used'] ?? 0),
        'bank_built_at' => mb_substr((string) ($a['bank_built_at'] ?? ''), 0, 40),
        'top' => $top,
    ];
}
