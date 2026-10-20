<?php
/**
 * iq-proxy.php —— 大模型智商检测 · 【流式】转发器（仅在浏览器直连 CORS 失败时兜底）
 * =====================================================================
 * 与旧版阻塞转发的关键区别：
 *   旧版用 CURLOPT_RETURNTRANSFER，等目标全部返回完才吐第一个字节 →
 *   静默 100s+ → Cloudflare 524/502。
 *   本版用 CURLOPT_WRITEFUNCTION 逐块回调，收到即 echo+flush，并在空闲期
 *   发 SSE 注释心跳（`: ping`），把 CF 的 idle 计时器一直压在 100s 内。
 *   CF 的 100s 是「两次收到字节的间隔」，不是总时长上限，故长流可穿透。
 *
 * 另注：CF 会缓冲 SSE，需 Content-Type: text/event-stream + X-Accel-Buffering: no 抑制。
 *
 * POST body: {
 *   targetUrl:    "https://xxx/v1/chat/completions",
 *   apiKey:       "sk-...",
 *   authStyle:    "bearer" | "x-api-key",
 *   payload:      {...},                       // 原样转发给目标的请求体
 *   extraHeaders: { "anthropic-version": "..." }
 * }
 * 输出：目标的 SSE 原文（透传）。附加的控制事件：
 *   `: ping`                        —— 心跳（注释行，前端只认 data: 故天然忽略）
 *   data: {"__iq_error":"..."}      —— 转发层错误（连接失败 / HTTP 非 2xx）
 *   data: {"__iq_json":"<base64>"}  —— 目标忽略了 stream:true 返回整包 JSON
 * =====================================================================
 */

// ---- 关闭一切缓冲，禁超时 ----
while (ob_get_level() > 0) { ob_end_clean(); }
ignore_user_abort(false);
set_time_limit(0);
@ini_set('output_buffering', '0');
@ini_set('zlib.output_compression', '0');
@ini_set('implicit_flush', '1');

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: text/event-stream; charset=utf-8');
header('Cache-Control: no-cache, no-store, must-revalidate');
header('X-Accel-Buffering: no');   // 关键：抑制 nginx / CF 缓冲

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }

/** 立即输出并 flush（喂 CF 计时器） */
function iqp_emit($s) {
    echo $s;
    @flush();
}
/** 下发一个控制用 data 事件 */
function iqp_event($obj) {
    iqp_emit('data: ' . json_encode($obj, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n\n");
}
function iqp_die($msg) {
    iqp_event(['__iq_error' => $msg]);
    iqp_emit("data: [DONE]\n\n");
    exit;
}

// ---- 首字节：立刻发一行注释，CF 从此刻开始计 idle ----
iqp_emit(": iq-proxy stream open\n\n");

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') iqp_die('请用 POST 调用本接口');
if (!extension_loaded('curl')) iqp_die('服务器未启用 PHP curl 扩展，无法中转');

$raw = file_get_contents('php://input');
$in  = json_decode($raw, true);
if (!is_array($in)) iqp_die('请求体不是合法 JSON');

$targetUrl = trim((string) ($in['targetUrl'] ?? ''));
$apiKey    = trim((string) ($in['apiKey'] ?? ''));
$authStyle = (string) ($in['authStyle'] ?? 'bearer');
$payload   = $in['payload'] ?? null;
$extra     = $in['extraHeaders'] ?? [];

if ($targetUrl === '' || $payload === null) iqp_die('缺少 targetUrl 或 payload');
if (!preg_match('#^https?://#i', $targetUrl)) iqp_die('targetUrl 必须以 http(s):// 开头');

/**
 * SSRF 防护：拒绝内网 / 环回 / 链路本地 / 元数据地址。
 * 解析主机名后逐个 IP 校验，避免「域名解析到内网」绕过。
 */
function iqp_is_blocked_host($host) {
    $host = strtolower(trim($host, '[]'));
    if ($host === '' || $host === 'localhost' || substr($host, -6) === '.local' || substr($host, -9) === '.internal') return true;
    $ips = [];
    if (filter_var($host, FILTER_VALIDATE_IP)) {
        $ips[] = $host;
    } else {
        $recs = @dns_get_record($host, DNS_A | DNS_AAAA);
        if (is_array($recs)) foreach ($recs as $r) {
            if (!empty($r['ip']))   $ips[] = $r['ip'];
            if (!empty($r['ipv6'])) $ips[] = $r['ipv6'];
        }
        $r4 = @gethostbyname($host);
        if ($r4 && $r4 !== $host) $ips[] = $r4;
        if (!$ips) return true;   // 解析不出来，宁可拒绝
    }
    foreach ($ips as $ip) {
        if (!filter_var($ip, FILTER_VALIDATE_IP)) return true;
        // 私有 + 保留地址一律拒绝（含 10./172.16-31./192.168./127./169.254./::1/fc00::）
        if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) return true;
    }
    return false;
}

$hostPart = parse_url($targetUrl, PHP_URL_HOST);
if (!$hostPart || iqp_is_blocked_host($hostPart)) iqp_die('目标地址不被允许（内网/环回地址已拒绝）');

// ---- 组装转发头（与前端 buildHeaders 同规则）----
$headers = ['Content-Type: application/json', 'Accept: text/event-stream'];
if ($apiKey !== '') {
    if ($authStyle === 'x-api-key') {
        $headers[] = 'x-api-key: ' . $apiKey;
        $headers[] = 'Authorization: Bearer ' . $apiKey;
    } else {
        $headers[] = 'Authorization: Bearer ' . $apiKey;
    }
}
if (is_array($extra)) {
    foreach ($extra as $k => $v) {
        if ($k !== '' && $v !== '' && stripos($k, 'host') !== 0) $headers[] = $k . ': ' . $v;
    }
}

$bodyJson = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

// ---- 流式转发 ----
$lastOut   = microtime(true);   // 上次向下游输出的时刻（心跳判据）
$httpCode  = 0;
$isStream  = null;              // 目标是否真流式（从响应头判定，先于正文到达）
$errBuf    = '';                // 非 2xx 时收集目标错误正文
$jsonBuf   = '';                // 目标非流式时缓冲整包 JSON
$HEARTBEAT = 15;                // 空闲超过 15s 补一次心跳，远小于 CF 100s

$ch = curl_init();
curl_setopt_array($ch, [
    CURLOPT_URL            => $targetUrl,
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $bodyJson,
    CURLOPT_HTTPHEADER     => $headers,
    CURLOPT_RETURNTRANSFER => false,   // 不缓冲，走 WRITEFUNCTION
    CURLOPT_TIMEOUT        => 0,       // 不限总时长（心跳保活）
    CURLOPT_CONNECTTIMEOUT => 25,
    CURLOPT_SSL_VERIFYPEER => false,
    CURLOPT_SSL_VERIFYHOST => false,
    CURLOPT_BUFFERSIZE     => 1024,    // 小块回调，尽快吐给前端
    // 先读响应头：拿到状态码与 content-type，决定正文是「透传」还是「缓冲」
    CURLOPT_HEADERFUNCTION => function ($c, $line) use (&$httpCode, &$isStream) {
        $l = trim($line);
        if (preg_match('#^HTTP/[\d.]+\s+(\d{3})#i', $l, $m)) {
            $httpCode = (int) $m[1];   // 可能有多段（重定向/100-continue），取最后一段
            $isStream = null;
        } elseif (stripos($l, 'content-type:') === 0) {
            $v = strtolower(substr($l, 13));
            $isStream = (strpos($v, 'event-stream') !== false || strpos($v, 'stream') !== false);
        }
        return strlen($line);
    },
    // 正文：2xx+流式→透传；2xx+非流式→缓冲成整包；非 2xx→攒错误正文
    CURLOPT_WRITEFUNCTION  => function ($c, $chunk) use (&$lastOut, &$httpCode, &$isStream, &$errBuf, &$jsonBuf) {
        if ($httpCode >= 200 && $httpCode < 300) {
            if ($isStream) {
                iqp_emit($chunk);                 // 透传目标 SSE 原文
                $lastOut = microtime(true);
            } elseif (strlen($jsonBuf) < 4000000) {
                $jsonBuf .= $chunk;               // 非流式：先收全，末尾统一下发
            }
        } elseif (strlen($errBuf) < 4000) {
            $errBuf .= $chunk;
        }
        return strlen($chunk);
    },
    // 空闲心跳：curl 没数据时也会周期性回调这里
    CURLOPT_NOPROGRESS       => false,
    CURLOPT_PROGRESSFUNCTION => function () use (&$lastOut, $HEARTBEAT) {
        if (microtime(true) - $lastOut >= $HEARTBEAT) {
            iqp_emit(": ping\n\n");
            $lastOut = microtime(true);
        }
        return 0;   // 非 0 会中断传输
    },
]);

curl_exec($ch);
$errno  = curl_errno($ch);
$errmsg = curl_error($ch);
if ($httpCode === 0) $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($errno)                              iqp_die("连接目标失败 curl[$errno]: $errmsg");
if ($httpCode < 200 || $httpCode >= 300) iqp_die("目标返回 HTTP $httpCode：" . mb_substr(trim($errBuf), 0, 300));

// 目标忽略了 stream:true，返回整包 JSON → base64 包进一个事件，避免换行破坏 SSE 分帧
if ($jsonBuf !== '') {
    iqp_event(['__iq_json' => base64_encode($jsonBuf)]);
}

iqp_emit("data: [DONE]\n\n");
