<?php
/**
 * 御三家 API 真伪检测站 —— 后端公共配置 & 工具
 * =====================================================================
 * 所有 api/*.php 都 require 本文件。把需要管理员填写的东西全集中在这里。
 *
 * 部署：宝塔新建 PHP7.4+ 站点，把整个 claude-detector 目录传到根目录，
 *      安装并开启 PHP 的 curl 扩展即可。详见「部署说明.md」。
 */

// ===================== 配置加载（令牌等放在独立配置文件，更新代码不丢失） =====================
// 所有可自定义项（GLM 令牌、官方 count key、品牌位、超时）都放在 api/config.php。
// 复制 api/config.example.php 为 api/config.php 后填写；更新代码时只覆盖源码，
// 不要覆盖你的 api/config.php，令牌就不会被冲掉。
// 取值优先级：服务器环境变量(getenv) > api/config.php > api/config.example.php > 内置默认。
// 说明：用 .php 配置文件（而非 .env 纯文本）是为安全——直接用浏览器访问 config.php
//      会被 PHP 执行、只返回数组、不输出任何内容，令牌不会泄露。

$__cfg = [];
foreach ([__DIR__ . '/config.php', __DIR__ . '/config.example.php'] as $__f) {
    if (is_file($__f)) {
        $__loaded = require $__f;       // 优先用第一个存在的（config.php 优先）
        if (is_array($__loaded)) { $__cfg = $__loaded; }
        break;
    }
}

/** 取配置：同名环境变量优先，其次配置文件，最后默认值。 */
function cfg_get($cfg, $key, $default) {
    $env = getenv($key);
    if ($env !== false && $env !== '') { return $env; }
    return (isset($cfg[$key]) && $cfg[$key] !== '') ? $cfg[$key] : $default;
}

define('GLM_KEY',            cfg_get($__cfg, 'GLM_KEY', ''));
define('GLM_MODEL',          cfg_get($__cfg, 'GLM_MODEL', 'glm-4-flash'));
define('GLM_URL',            cfg_get($__cfg, 'GLM_URL', 'https://open.bigmodel.cn/api/paas/v4/chat/completions'));

define('OFFICIAL_COUNT_KEY', cfg_get($__cfg, 'OFFICIAL_COUNT_KEY', ''));
define('OFFICIAL_BASE_URL',  cfg_get($__cfg, 'OFFICIAL_BASE_URL', 'https://api.anthropic.com'));

define('SITE_NAME',          cfg_get($__cfg, 'SITE_NAME', '开源 AI 检测站'));
define('SITE_URL',           cfg_get($__cfg, 'SITE_URL', 'https://www.aabao.ai'));
define('SITE_SLOGAN',        cfg_get($__cfg, 'SITE_SLOGAN', '一键鉴别 Claude / OpenAI / Gemini 中转站真伪'));

// 转发探针请求的超时（秒）。长上下文探针可能很慢，这里给宽一点。
define('PROBE_TIMEOUT',      (int) cfg_get($__cfg, 'PROBE_TIMEOUT', 240));

// 分享报告保存目录（路径，非密钥；需可写权限）。可用环境变量 / 配置项 DATA_DIR 覆盖。
define('DATA_DIR',           cfg_get($__cfg, 'DATA_DIR', __DIR__ . '/../data'));

// 回链探测对外公网基址（如 https://www.aabao.ai）。留空则自动用请求的 scheme://host 推断。
// 仅当站点在反代/子路径下、自动推断不准时才需要在 config.php 里显式填写。
define('TRACE_PUBLIC_BASE',  cfg_get($__cfg, 'TRACE_PUBLIC_BASE', ''));

// ===================== 通用：CORS / 响应 =====================

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Access-Key');
header('Content-Type: application/json; charset=utf-8');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

/** 统一 JSON 输出并结束。*/
function out($code, $data) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/** 读取并解析 POST 的 JSON body；失败给 400。*/
function read_json_body() {
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        out(400, ['ok' => false, 'error' => 'invalid json body']);
    }
    return $data;
}

/** 把品牌信息打包，给前端/报告页用。*/
function brand_info() {
    return [
        'name'   => SITE_NAME,
        'url'    => SITE_URL,
        'slogan' => SITE_SLOGAN,
    ];
}

/**
 * 用 curl 转发一个 HTTP 请求，原样回传状态码 / 头 / 体。
 * @param string $url
 * @param string $method GET|POST
 * @param array  $headers  ["Key: Value", ...]
 * @param ?string $body
 * @return array {httpStatus, headers:{}, body, error}
 */
function curl_forward($url, $method, $headers, $body = null) {
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL            => $url,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER         => true,          // 把响应头也拿回来
        CURLOPT_TIMEOUT        => PROBE_TIMEOUT,
        CURLOPT_CONNECTTIMEOUT => 20,
        CURLOPT_SSL_VERIFYPEER => false,         // 中转站证书五花八门，放宽
        CURLOPT_SSL_VERIFYHOST => false,
        CURLOPT_ENCODING       => '',            // 自动解 gzip
    ]);
    if ($method === 'POST' && $body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }

    $resp       = curl_exec($ch);
    $errno      = curl_errno($ch);
    $errmsg     = curl_error($ch);
    $status     = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);

    if ($errno) {
        return ['httpStatus' => 0, 'headers' => [], 'body' => '', 'error' => "curl[$errno]: $errmsg"];
    }

    $rawHeaders = substr($resp, 0, $headerSize);
    $bodyStr    = substr($resp, $headerSize);

    // 解析响应头为关联数组（只保留我们关心的几个 + 全部小写键）
    $headers = [];
    foreach (explode("\r\n", $rawHeaders) as $line) {
        if (strpos($line, ':') !== false) {
            [$k, $v] = explode(':', $line, 2);
            $headers[strtolower(trim($k))] = trim($v);
        }
    }

    return ['httpStatus' => $status, 'headers' => $headers, 'body' => $bodyStr, 'error' => null];
}

// ===================== 回链探测（末端上游 IP/ASN/org）公共工具 =====================

/** 确保数据目录存在且可写。 */
function ensure_data_dir() {
    if (!is_dir(DATA_DIR)) { @mkdir(DATA_DIR, 0775, true); }
    return is_dir(DATA_DIR) && is_writable(DATA_DIR);
}

/** 简单 HTTP GET（用于 ip-api.com 等只读查询），失败返回 null。 */
function http_get($url, $timeout = 8) {
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL            => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_CONNECTTIMEOUT => 6,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_USERAGENT      => 'ai-detector-trace/1.0',
    ]);
    $out   = curl_exec($ch);
    $errno = curl_errno($ch);
    curl_close($ch);
    return $errno ? null : $out;
}

/**
 * 查询 IP 归属（ASN / org / 地理）。结果按 IP 文件缓存 TTL 7 天，避开 ip-api.com 45 次/分限流；
 * 查询失败/私网地址不阻断主流程（返回带 error 的数组）。
 * @return array {ip, as, asname, isp, org, country, countryCode, regionName, city} 或 {ip, error}
 */
function asn_lookup($ip) {
    $ip = trim((string) $ip);
    if ($ip === '' || !filter_var($ip, FILTER_VALIDATE_IP)) {
        return ['ip' => $ip, 'error' => 'invalid ip'];
    }
    // 私网/保留地址不外查
    if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
        return ['ip' => $ip, 'org' => '内网/保留地址', 'error' => 'private/reserved'];
    }
    $cacheFile = rtrim(DATA_DIR, '/\\') . DIRECTORY_SEPARATOR . 'asn_cache.json';
    $cache = [];
    if (is_file($cacheFile)) {
        $j = json_decode((string) @file_get_contents($cacheFile), true);
        if (is_array($j)) { $cache = $j; }
    }
    $now = time();
    if (isset($cache[$ip]) && is_array($cache[$ip]) && ($now - (int) ($cache[$ip]['_ts'] ?? 0)) < 7 * 86400) {
        $hit = $cache[$ip];
        unset($hit['_ts']);
        return $hit;
    }
    $url = 'http://ip-api.com/json/' . urlencode($ip)
         . '?lang=zh-CN&fields=status,message,country,countryCode,regionName,city,isp,org,as,asname,query';
    $raw  = http_get($url);
    $info = $raw ? json_decode($raw, true) : null;
    if (!is_array($info) || ($info['status'] ?? '') !== 'success') {
        return ['ip' => $ip, 'error' => is_array($info) ? ($info['message'] ?? 'lookup failed') : 'lookup failed'];
    }
    $res = [
        'ip'          => $ip,
        'as'          => (string) ($info['as'] ?? ''),
        'asname'      => (string) ($info['asname'] ?? ''),
        'isp'         => (string) ($info['isp'] ?? ''),
        'org'         => (string) ($info['org'] ?? ''),
        'country'     => (string) ($info['country'] ?? ''),
        'countryCode' => (string) ($info['countryCode'] ?? ''),
        'regionName'  => (string) ($info['regionName'] ?? ''),
        'city'        => (string) ($info['city'] ?? ''),
    ];
    if (ensure_data_dir()) {
        $cache[$ip] = $res + ['_ts' => $now];
        @file_put_contents($cacheFile, json_encode($cache, JSON_UNESCAPED_UNICODE), LOCK_EX);
    }
    return $res;
}

/** trace 会话 id 校验（仅允许 hex，杜绝路径穿越）。 */
function valid_sid($sid) {
    return is_string($sid) && preg_match('/^[a-f0-9]{8,32}$/', $sid) === 1;
}

/** 把 org/asn 文本归类（与前端 openai_signals.classifyOrg 对齐）。返回 [kind,label]。 */
function classify_org_kind($hay) {
    $hay = strtolower((string) $hay);
    if (trim($hay) === '') { return ['unknown', '未知']; }
    if (preg_match('/\bmicrosoft\b|azure|msft/', $hay)) { return ['azure', '☁️ Azure / 微软云（Azure OpenAI 常见出口）']; }
    if (strpos($hay, 'openai') !== false) { return ['openai', '🤖 OpenAI 自有网段']; }
    if (strpos($hay, 'cloudflare') !== false) { return ['cdn', 'Cloudflare（CDN / 前置）']; }
    if (preg_match('/amazon|\baws\b|ec2/', $hay)) { return ['cloud', 'Amazon AWS（疑中转）']; }
    if (preg_match('/google|gcp|1e100/', $hay)) { return ['cloud', 'Google Cloud（疑中转）']; }
    if (preg_match('/oracle|\bovh\b|hetzner|digitalocean|linode|akamai|fastly|vultr|tencent|alibaba|aliyun|huawei|ucloud/', $hay)) {
        return ['cloud', '云厂商 / IDC（疑中转）'];
    }
    return ['other', '第三方机房 / VPS'];
}

/** 从出口 UA 提取归属信号（UA 可伪造，仅作参考）。返回 ['openai'|'azure'|'']。 */
function classify_exit_ua($ua) {
    $u = strtolower((string) $ua);
    if (strpos($u, 'openai') !== false) { return 'openai'; }
    if (strpos($u, 'azure') !== false) { return 'azure'; }
    return '';
}

/**
 * 提取「真正的客户端 IP」，穿透 CDN/反代。
 * 关键：若本站挂在 Cloudflare 后面，REMOTE_ADDR 是 CF 边缘节点 IP（AS13335），不是真实上游！
 * 必须优先读 CF-Connecting-IP / True-Client-IP（CF/Akamai 注入的真实访客 IP）。
 * 按优先级：CF-Connecting-IP > True-Client-IP > X-Real-IP > X-Forwarded-For(首个公网) > REMOTE_ADDR。
 * @return array [ip, source]  source 为命中的头名（便于展示「来源:CF-Connecting-IP」）
 */
function real_client_ip() {
    // 1) CDN 注入的真实访客 IP（最可信）
    $direct = [
        'HTTP_CF_CONNECTING_IP' => 'CF-Connecting-IP',
        'HTTP_TRUE_CLIENT_IP'   => 'True-Client-IP',
        'HTTP_X_REAL_IP'        => 'X-Real-IP',
    ];
    foreach ($direct as $key => $label) {
        $v = trim((string) ($_SERVER[$key] ?? ''));
        if ($v !== '' && filter_var($v, FILTER_VALIDATE_IP)) {
            return [$v, $label];
        }
    }
    // 2) X-Forwarded-For：取链中第一个【合法公网】IP（最左 = 最初的客户端）
    $xff = (string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '');
    if ($xff !== '') {
        foreach (explode(',', $xff) as $part) {
            $ip = trim($part);
            if ($ip !== '' && filter_var($ip, FILTER_VALIDATE_IP)
                && filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                return [$ip, 'X-Forwarded-For'];
            }
        }
    }
    // 3) 兜底：直连 IP（无 CDN 时即真实 IP；有 CDN 时是边缘节点 IP）
    return [(string) ($_SERVER['REMOTE_ADDR'] ?? ''), 'REMOTE_ADDR'];
}

/** trace 会话命中日志文件路径。 */
function trace_log_file($sid) {
    ensure_data_dir();
    return rtrim(DATA_DIR, '/\\') . DIRECTORY_SEPARATOR . 'trace_' . $sid . '.log';
}

/** 对外公网基址：优先 TRACE_PUBLIC_BASE 配置，否则按请求的 scheme://host 推断。 */
function trace_public_base() {
    if (defined('TRACE_PUBLIC_BASE') && TRACE_PUBLIC_BASE !== '') {
        return rtrim(TRACE_PUBLIC_BASE, '/');
    }
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
          || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    $scheme = $https ? 'https' : 'http';
    $host   = $_SERVER['HTTP_HOST'] ?? 'localhost';
    return $scheme . '://' . $host;
}

/** 递归把请求体里的占位符 __TRACE_IMG_URL__ 替换为真实回链 URL。 */
function trace_inject_url($node, $url) {
    if (is_array($node)) {
        foreach ($node as $k => $v) { $node[$k] = trace_inject_url($v, $url); }
        return $node;
    }
    if (is_string($node)) {
        return str_replace('__TRACE_IMG_URL__', $url, $node);
    }
    return $node;
}

/** 生成一张回链图片字节（GD 画 4 位数字；无 GD 则兜底 1x1 PNG）。 */
function trace_image_bytes() {
    if (function_exists('imagecreatetruecolor')) {
        $w = 120; $h = 60;
        $im = imagecreatetruecolor($w, $h);
        $bg = imagecolorallocate($im, 245, 245, 245);
        $fg = imagecolorallocate($im, 30, 30, 30);
        imagefilledrectangle($im, 0, 0, $w, $h, $bg);
        $num = str_pad((string) mt_rand(0, 9999), 4, '0', STR_PAD_LEFT);
        imagestring($im, 5, 34, 20, $num, $fg);
        ob_start();
        imagepng($im);
        $bytes = (string) ob_get_clean();
        imagedestroy($im);
        return $bytes;
    }
    // 兜底：1x1 PNG（仍能触发上游 GET，足以捕获出口 IP）
    return base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
}
