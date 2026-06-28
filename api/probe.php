<?php
/**
 * probe.php —— 探针请求转发器（绕过浏览器 CORS）
 * =====================================================================
 * 前端把「目标中转站地址 + key + 请求体」发给本接口，本接口用 curl 转发到目标，
 * 然后把【真实的 HTTP 状态码 / 响应头 / 原始响应体】原样回传给前端。
 * 前端拿到后自己解析特征，保证「请求体 / 响应体」完全真实可见。
 *
 * 流式(stream:true)：目标返回的是 SSE 文本，这里也原样收下整体回传，
 * 前端用 parseSSE() 还原事件序列。
 *
 * 接口：
 *   GET  probe.php?action=ping  → {"service":"ai-detector","ok":true,"brand":{...}}
 *   GET  probe.php?action=diag  → 诊断 PHP 扩展
 *   POST probe.php  (JSON)      → {ok, httpStatus, headers, body, requestId, ...}
 *     body: {
 *       targetUrl:  "https://xxx/v1/messages",
 *       apiKey:     "sk-...",
 *       authStyle:  "x-api-key" | "bearer" | "gemini",  // Claude 用 x-api-key，OpenAI 用 bearer，Gemini 原生用 gemini(x-goog-api-key)
 *       payload:    {...},                     // 要发给目标的请求体（对象）
 *       extraHeaders: { "anthropic-beta": "..." }  // 可选附加头
 *     }
 */

require __DIR__ . '/_common.php';

// -------- ping --------
if (($_GET['action'] ?? '') === 'ping') {
    out(200, ['service' => 'ai-detector', 'ok' => true, 'brand' => brand_info()]);
}

// -------- diag：诊断当前 PHP 环境 --------
if (($_GET['action'] ?? '') === 'diag') {
    out(200, [
        'php_version'    => PHP_VERSION,
        'php_sapi'       => PHP_SAPI,
        'curl_loaded'    => extension_loaded('curl'),
        'openssl_loaded' => extension_loaded('openssl'),
        'data_dir'       => DATA_DIR,
        'data_writable'  => is_dir(DATA_DIR) ? is_writable(DATA_DIR) : 'dir_missing',
        'glm_configured' => GLM_KEY !== '' && GLM_KEY !== 'sk-xxx',
    ]);
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    out(405, ['ok' => false, 'error' => 'use POST']);
}

$in = read_json_body();

$targetUrl = trim($in['targetUrl'] ?? '');
$apiKey    = trim($in['apiKey'] ?? '');
$authStyle = $in['authStyle'] ?? 'x-api-key';
$payload   = $in['payload'] ?? null;
$extra     = $in['extraHeaders'] ?? [];

if ($targetUrl === '' || $payload === null) {
    out(400, ['ok' => false, 'error' => '缺少 targetUrl 或 payload']);
}
if (!preg_match('#^https?://#i', $targetUrl)) {
    out(400, ['ok' => false, 'error' => 'targetUrl 必须以 http(s):// 开头']);
}

// 组装转发头
$headers = ['Content-Type: application/json'];
if ($apiKey !== '') {
    if ($authStyle === 'gemini') {
        // Gemini 原生路径（…/models/{model}:generateContent）：key 走 x-goog-api-key 头，
        // 不加任何 Authorization / anthropic-version（多余的 Authorization 会被部分严格上游拒绝）。
        $headers[] = 'x-goog-api-key: ' . $apiKey;
    } elseif ($authStyle === 'bearer') {
        $headers[] = 'Authorization: Bearer ' . $apiKey;
    } else {
        // Claude 协议：同时给 x-api-key 和 Authorization，兼容各种中转站写法
        $headers[] = 'x-api-key: ' . $apiKey;
        $headers[] = 'Authorization: Bearer ' . $apiKey;
        $headers[] = 'anthropic-version: 2023-06-01';
    }
}
if (is_array($extra)) {
    foreach ($extra as $k => $v) {
        if ($k !== '' && $v !== '') {
            $headers[] = $k . ': ' . $v;
        }
    }
}

$bodyStr = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

$res = curl_forward($targetUrl, 'POST', $headers, $bodyStr);

if ($res['error']) {
    out(200, [
        'ok'         => false,
        'httpStatus' => 0,
        'error'      => $res['error'],
        'hint'       => '目标地址连接失败：可能地址错误、超时，或目标站拒绝服务器代理。',
    ]);
}

// 提取常见的请求 id 响应头（不同渠道叫法不一）
$h = $res['headers'];
$requestId = $h['request-id'] ?? $h['anthropic-request-id'] ?? $h['x-request-id'] ?? null;

out(200, [
    'ok'         => true,
    'httpStatus' => $res['httpStatus'],
    'headers'    => $res['headers'],
    'body'       => $res['body'],     // 原始字符串，前端自己 JSON.parse 或按 SSE 解析
    'requestId'  => $requestId,
]);
