<?php
/**
 * summary.php —— 调用智谱 GLM 生成「人话总结报告」
 * =====================================================================
 * 前端把结构化的检测结果发来，这里喂给 GLM，返回一段简洁中文结论。
 * 未配置 GLM_KEY 时返回 ok:false，前端回退到本地规则结论。
 *
 * POST body: {
 *   protocol:   "anthropic"|"openai"|"gemini",
 *   model:      "claude-opus-4-8",
 *   channel:    "Anthropic 直连"|"逆向套壳"|...,
 *   totalScore: 87,
 *   verdict:    "可信"|"存疑"|...,
 *   results: [ { name, score, verdict, weight, severity, diffs:[...] }, ... ]
 * }
 */

require __DIR__ . '/_common.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    out(405, ['ok' => false, 'error' => 'use POST']);
}

if (GLM_KEY === '' || GLM_KEY === 'sk-xxx') {
    out(200, ['ok' => false, 'error' => 'GLM_KEY 未配置', 'fallback' => true]);
}

$in = read_json_body();

// 把检测结果压成给大模型看的紧凑文本（避免过长）
$lines = [];
$lines[] = "协议: " . ($in['protocol'] ?? '?');
$lines[] = "请求模型: " . ($in['model'] ?? '?');
$lines[] = "渠道判定: " . ($in['channel'] ?? '?');
$lines[] = "综合得分: " . ($in['totalScore'] ?? '?') . "/100";
$lines[] = "本地初判: " . ($in['verdict'] ?? '?');
$lines[] = "";
$lines[] = "各检测项明细：";
foreach (($in['results'] ?? []) as $r) {
    $name = $r['name'] ?? '?';
    $score = $r['score'] ?? '-';
    $verdict = $r['verdict'] ?? '-';
    $sev = $r['severity'] ?? '';
    $diffs = is_array($r['diffs'] ?? null) ? implode('；', $r['diffs']) : '';
    $line = "- {$name}：{$verdict}（{$score}分）" . ($sev === 'critical' ? ' [严重]' : '');
    if ($diffs !== '') $line .= "　差异: {$diffs}";
    $lines[] = $line;
}
$detail = implode("\n", $lines);

$systemPrompt =
    "你是一名 AI API 真伪检测分析师。下面是对某个 API 端点的多项自动化检测结果。" .
    "请用简洁、直观、面向普通用户的简体中文，给出一份总结报告，包含：" .
    "①一句话核心结论（这是官方直连 / 正规中转 / 还是逆向套壳冒充）；" .
    "②2-4 条最关键的判断依据（引用具体检测项）；" .
    "③存在的风险或注意事项；④最终可信度评价。" .
    "语气客观、不夸张，不要罗列所有检测项，只挑重点。总字数控制在 350 字以内，用纯文本+短分段，不要用 markdown 标题。";

$payload = [
    'model'    => GLM_MODEL,
    'messages' => [
        ['role' => 'system', 'content' => $systemPrompt],
        ['role' => 'user',   'content' => $detail],
    ],
    'temperature' => 0.3,
    'max_tokens'  => 800,
];

$headers = [
    'Content-Type: application/json',
    'Authorization: Bearer ' . GLM_KEY,
];

$res = curl_forward(GLM_URL, 'POST', $headers, json_encode($payload, JSON_UNESCAPED_UNICODE));

if ($res['error'] || $res['httpStatus'] < 200 || $res['httpStatus'] >= 300) {
    out(200, [
        'ok' => false,
        'error' => 'GLM 调用失败: ' . ($res['error'] ?: ('HTTP ' . $res['httpStatus'])),
        'raw' => mb_substr($res['body'] ?? '', 0, 500),
        'fallback' => true,
    ]);
}

$data = json_decode($res['body'], true);
$text = $data['choices'][0]['message']['content'] ?? '';

if ($text === '') {
    out(200, ['ok' => false, 'error' => 'GLM 返回为空', 'fallback' => true]);
}

out(200, ['ok' => true, 'summary' => trim($text)]);
