<?php
/**
 * sig_verify.php —— 思考签名三步验证·第②步「真实性核验」
 * =====================================================================
 * 把前端拼好的「回放对话」（含原始思考块+签名）转发给 Anthropic 官方，
 * 用管理员在 config.php 配置的 OFFICIAL_COUNT_KEY 鉴权。
 * 未配置则返回 ok:false，前端据此跳过这一步（不计分不扣分）。
 *
 * 与 probe.php 的区别：本接口不接受前端传入 targetUrl/apiKey——鉴权固定
 * 走服务器配置的官方 Key，避免被当作任意转发代理滥用。
 *
 * POST body: {
 *   model:      "claude-opus-4-8",
 *   maxTokens?: 300,
 *   thinking:   {...},           // 与原探针请求一致的 thinking 配置
 *   messages:   [...],           // 回放对话（含 assistant 思考块+签名）
 *   betaHeader?:"interleaved-thinking-2025-05-14,..."
 * }
 * 返回: { ok, httpStatus, body }  // body 为官方原始响应字符串，前端自行解析
 */

require __DIR__ . '/_common.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    out(405, ['ok' => false, 'error' => 'use POST']);
}

if (OFFICIAL_COUNT_KEY === '') {
    out(200, ['ok' => false, 'error' => '未配置官方Key', 'skip' => true]);
}

$in = read_json_body();

$model    = $in['model'] ?? 'claude-opus-4-8';
$messages = $in['messages'] ?? [];
if (!is_array($messages) || !count($messages)) {
    out(400, ['ok' => false, 'error' => '缺少 messages']);
}

$payload = [
    'model'      => $model,
    'max_tokens' => (int) ($in['maxTokens'] ?? 300),
    'messages'   => $messages,
];
if (!empty($in['thinking'])) {
    $payload['thinking'] = $in['thinking'];
}

$headers = [
    'Content-Type: application/json',
    'x-api-key: ' . OFFICIAL_COUNT_KEY,
    'anthropic-version: 2023-06-01',
];
if (!empty($in['betaHeader'])) {
    $headers[] = 'anthropic-beta: ' . $in['betaHeader'];
}

$res = curl_forward(OFFICIAL_BASE_URL . '/v1/messages', 'POST', $headers,
    json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));

if ($res['error']) {
    out(200, [
        'ok'         => false,
        'httpStatus' => 0,
        'error'      => $res['error'],
    ]);
}

out(200, [
    'ok'         => true,
    'httpStatus' => $res['httpStatus'],
    'body'       => $res['body'],
]);
