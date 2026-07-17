<?php
/**
 * sig_verify.php —— 思考签名三步验证·第②步「真实性核验」
 * =====================================================================
 * 只需要一个思考签名字符串：把它包进一个最小化的 thinking 块（thinking 文本留空，
 * 签名验证不依赖文本内容，只依赖 signature 本身）+ 一句 "hi"，max_tokens=1，
 * 用管理员配置的官方 Key + 固定的最便宜模型（OFFICIAL_VERIFY_MODEL）直接问官方——
 * 签名验证与被测渠道用什么模型无关，官方只按 thinking 块本身校验签名，因此固定用
 * 最便宜的 Haiku 系列即可，核验成本几乎为零。
 *
 * 未配置 OFFICIAL_COUNT_KEY 则返回 ok:false + skip:true，前端据此跳过这一步（不计分不扣分）。
 * 与 probe.php 的区别：本接口不接受前端传入 targetUrl/apiKey/model——鉴权和模型都固定走
 * 服务器配置，避免被当作任意转发代理滥用。
 *
 * POST body: { signature: "<思考签名字符串>" }
 * 返回: { ok, httpStatus, body }  // body 为官方原始响应字符串，前端自行解析
 *   （响应体里若含 context_management.applied_edits[].type === "clear_thinking_20251015"，
 *    是官方确认「识别并处理了该思考签名」的强证据，前端据此判定签名真实。）
 */

require __DIR__ . '/_common.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    out(405, ['ok' => false, 'error' => 'use POST']);
}

if (OFFICIAL_COUNT_KEY === '') {
    out(200, ['ok' => false, 'error' => '未配置官方Key', 'skip' => true]);
}

$in = read_json_body();

$signature = trim((string) ($in['signature'] ?? ''));
if ($signature === '') {
    out(400, ['ok' => false, 'error' => '缺少 signature']);
}

$payload = [
    'model'      => OFFICIAL_VERIFY_MODEL,
    'max_tokens' => 1,
    'messages'   => [
        [
            'role'    => 'assistant',
            'content' => [
                ['type' => 'thinking', 'thinking' => '', 'signature' => $signature],
            ],
        ],
        ['role' => 'user', 'content' => 'hi'],
    ],
];

$headers = [
    'Content-Type: application/json',
    'x-api-key: ' . OFFICIAL_COUNT_KEY,
    'anthropic-version: 2023-06-01',
];

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
