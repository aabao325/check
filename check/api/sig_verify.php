<?php
/**
 * sig_verify.php —— 思考签名「官方回放核验」
 * =====================================================================
 * 原理：把待核验的签名包进一个最小 thinking 块，回放给 Anthropic 官方，让官方用自己的
 * 密钥去验签——官方接受说明是官方真实签发的，官方明确报签名错误说明是伪造的。
 * 官方按 thinking 块本身校验签名、不看当前请求用什么模型，所以固定用最便宜的 Haiku
 * （OFFICIAL_VERIFY_MODEL），max_tokens=1，成本几乎为零。
 *
 * 判据：篡改过的思考签名会被上游拒绝，所以「官方正常出话」本身就是签名通过校验的证据。
 * 不要再用 input_tokens 去反推「签名有没有被校验」——官方可以先验签、再把思考内容丢掉
 * 不计费（实测见过 3464 字符签名只报 15 tokens），input_tokens 反映的是计费口径而非校验
 * 口径。早期版本拿它当闸门（要求 ≥ 签名长度/8），结果把真签名判成「无法验真」，已移除。
 *
 * 成本：请求体已收到最小（见下方 $payload 注释），实测 2012 字符签名 input≈283 / output=1。
 * 早期版本加过 thinking budget_tokens 与 tools/tool_result，二者既不带来验签、又把成本推到
 * 三倍（input 902 / output 21），且 budget_tokens 会让 max_tokens=1 失效——已移除，别加回来。
 *
 * 未配置 OFFICIAL_COUNT_KEY 则返回 ok:false + skip:true，调用方据此跳过（不计分不扣分）。
 * 与 probe.php 的区别：本接口不接受前端传入 targetUrl/apiKey/model——鉴权和模型都固定走
 * 服务器配置，避免被当作任意转发代理滥用。
 *
 * POST body: { signature: "<思考签名字符串>" }
 * 返回: { ok, httpStatus, body, verdict, reason }
 *   verdict: real    官方接受该签名并正常返回 → 官方真实签发
 *            fake    官方明确报签名校验失败 → 坐实伪造
 *            unknown 通道故障/限流/鉴权，或本接口请求体被上游判为非法 → 无法判断（不计分不扣分）
 */

require __DIR__ . '/_common.php';
require __DIR__ . '/sig_verify_judge.php';   // sigv_judge()：判据逻辑，可单独单测

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
// 签名是 base64（含 URL-safe 变体）。长度上限防止拿本接口当大流量转发用。
if (strlen($signature) > 65536) {
    out(413, ['ok' => false, 'error' => '签名过长']);
}
if (preg_match('/^[A-Za-z0-9+\/=_-]+$/', $signature) !== 1) {
    out(400, ['ok' => false, 'error' => '签名不是合法 base64 字符串']);
}

/* 最小请求体：user 开头、assistant 夹在中间（thinking 块 + 一个 text 块）、user 收尾。
 * thinking 文本留空：验签只看 signature 本身，不依赖思考文本内容。
 *
 * ⚠ 这三条消息的顺序与块的排列都是踩过坑定下来的，改之前先读完（实测 2026-09）：
 *
 * ① assistant 消息不能以 thinking 块结尾。严格上游（如 Amazon
 *    Bedrock）会直接 400：`The final block in an assistant message cannot be 'thinking'`。
 *    宽松路由却返回 200 —— 同一个请求体在不同上游行为不一致，所以「本地测通」不等于合法。
 *
 * ② assistant 也不要是最后一条消息（thinking 在前、user 在后的老写法）：那样 1168 字符的
 *    签名只换来 input_tokens=23，改成 user 收尾后 input≈281。虽然判定已不看 input_tokens，
 *    但签名进入上下文更接近真实调用场景，保持 user 收尾。
 *
 * ③ 别加 thinking: {budget_tokens: N}：它要求 max_tokens > budget_tokens，
 *    max_tokens=1 与 1024 冲突 —— 官方直连报 400，中转则不报错、自行把 max_tokens 抬上去，
 *    模型于是把话说完（output 21 tokens、stop_reason=end_turn），成本白涨三倍。
 *
 * ④ 别加 tools + tool_use + tool_result：input 从 283 涨到 636，既不省钱也换不来验签。
 *
 * 另注：本形态偶发（实测 8 次中 2 次）input_tokens 掉到 16 —— 上游那一发没把思考内容计费。
 * 这不影响判定（判据只看是否被拒），无需重试。 */
$payload = [
    'model'      => OFFICIAL_VERIFY_MODEL,
    'max_tokens' => 1,
    'messages'   => [
        ['role' => 'user', 'content' => 'hi'],
        ['role' => 'assistant', 'content' => [
            ['type' => 'thinking', 'thinking' => '', 'signature' => $signature]
        ]],
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
        'verdict'    => 'unknown',
        'reason'     => '无法连通官方接口：' . $res['error'],
    ]);
}

[$verdict, $reason] = sigv_judge((int) $res['httpStatus'], (string) $res['body'], strlen($signature));

out(200, [
    'ok'         => true,
    'httpStatus' => $res['httpStatus'],
    'body'       => $res['body'],
    'verdict'    => $verdict,
    'reason'     => $reason,
]);
