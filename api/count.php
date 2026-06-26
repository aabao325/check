<?php
/**
 * count.php —— （可选）调用 Anthropic 官方 count_tokens 精确核对 input_tokens
 * =====================================================================
 * 需要管理员在 _common.php 配置 OFFICIAL_COUNT_KEY。未配置则返回 ok:false。
 *
 * POST body: { model, messages, system? }  —— 与发给中转站的相同消息
 * 返回: { ok, input_tokens }
 */

require __DIR__ . '/_common.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    out(405, ['ok' => false, 'error' => 'use POST']);
}
if (OFFICIAL_COUNT_KEY === '') {
    out(200, ['ok' => false, 'error' => '未配置官方 count key', 'skip' => true]);
}

$in = read_json_body();
$payload = [
    'model'    => $in['model'] ?? 'claude-opus-4-8',
    'messages' => $in['messages'] ?? [],
];
if (!empty($in['system'])) {
    $payload['system'] = $in['system'];
}

$headers = [
    'Content-Type: application/json',
    'x-api-key: ' . OFFICIAL_COUNT_KEY,
    'anthropic-version: 2023-06-01',
];

$res = curl_forward(OFFICIAL_BASE_URL . '/v1/messages/count_tokens', 'POST', $headers,
    json_encode($payload, JSON_UNESCAPED_UNICODE));

if ($res['error'] || $res['httpStatus'] < 200 || $res['httpStatus'] >= 300) {
    out(200, ['ok' => false, 'error' => 'count_tokens 调用失败', 'skip' => true]);
}

$data = json_decode($res['body'], true);
out(200, ['ok' => true, 'input_tokens' => $data['input_tokens'] ?? null]);
