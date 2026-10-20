<?php
/**
 * iq-summary.php —— 大模型智商检测 · 视觉裁判 AI 总结
 * =====================================================================
 * 前端把「题目要求 + 标准答案渲染图 + 被测模型渲染图（PNG base64）」发来，
 * 本接口转发给 iq-config.php 里配置的【视觉裁判模型】（OpenAI Chat Completions
 * 视觉格式），让它评判被测模型画得对不对、和标准差在哪，返回中文总结。
 *
 * 截图缺失时（非 SVG 等）可只发源码做代码级评估（mode=code）。
 * 未配置 JUDGE_URL/KEY 时返回 ok:false + needConfig:true。
 *
 * 思考型裁判（如 glm-4.1v-thinking-flashx）会把思维链放在 reasoning_content /
 * reasoning / <think> 里：本接口把【思考】与【正文】拆开分别返回，前端分开渲染。
 *
 * POST body: {
 *   question:    "题目标题",
 *   prompt:      "发给被测模型的完整题目要求",
 *   baselineImg: "data:image/png;base64,..."  | null,   // 标准答案渲染图
 *   modelImg:    "data:image/png;base64,..."  | null,   // 被测模型渲染图
 *   baselineCode:"<html>...",  // 截图缺失时的兜底源码（可空）
 *   modelCode:   "<html>...",  // 同上
 * }
 * 返回: { ok, summary, thinking } | { ok:false, error, needConfig? }
 */

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: application/json; charset=utf-8');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }

// ---- 配置 ----
$__cfg = [];
foreach ([__DIR__ . '/iq-config.php', dirname(__DIR__) . '/iq-config.php', __DIR__ . '/iq-config.example.php'] as $__f) {
    if (is_file($__f)) { $__l = require $__f; if (is_array($__l)) $__cfg = $__l; break; }
}
function iqs_cfg($cfg, $key, $def) {
    $env = getenv($key);
    if ($env !== false && $env !== '') return $env;
    return (isset($cfg[$key]) && $cfg[$key] !== '') ? $cfg[$key] : $def;
}
define('JUDGE_URL',     iqs_cfg($__cfg, 'JUDGE_URL', ''));
define('JUDGE_KEY',     iqs_cfg($__cfg, 'JUDGE_KEY', ''));
define('JUDGE_MODEL',   iqs_cfg($__cfg, 'JUDGE_MODEL', 'gpt-5.5'));
define('JUDGE_EFFORT',  iqs_cfg($__cfg, 'JUDGE_EFFORT', ''));
define('JUDGE_TIMEOUT', (int) iqs_cfg($__cfg, 'JUDGE_TIMEOUT', 120));
// 输出上限：思考型裁判的 reasoning 也计入这里，太小会把正文挤掉（默认 4096 兼顾速度与完整度）
define('JUDGE_MAXTOKENS', (int) iqs_cfg($__cfg, 'JUDGE_MAXTOKENS', 4096));

function iqs_out($code, $data) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') iqs_out(405, ['ok' => false, 'error' => 'use POST']);
if (JUDGE_URL === '' || JUDGE_KEY === '') {
    iqs_out(200, ['ok' => false, 'needConfig' => true, 'error' => '未配置视觉裁判模型（请在 iq-config.php 填写 JUDGE_URL / JUDGE_KEY）']);
}

$raw = file_get_contents('php://input');
$in  = json_decode($raw, true);
if (!is_array($in)) iqs_out(400, ['ok' => false, 'error' => '请求体不是合法 JSON']);

$question = trim((string) ($in['question'] ?? ''));
$prompt   = trim((string) ($in['prompt'] ?? ''));
$bImg     = $in['baselineImg'] ?? null;
$mImg     = $in['modelImg'] ?? null;
$bCode    = trim((string) ($in['baselineCode'] ?? ''));
$mCode    = trim((string) ($in['modelCode'] ?? ''));

function is_data_png($s) { return is_string($s) && strpos($s, 'data:image/') === 0 && strlen($s) < 8_000_000; }

$sys =
    "你是一名「大模型智商检测」评审。用户让被测大模型用 SVG/HTML 画一幅图，现在给你【题目要求】、" .
    "【标准答案的渲染结果】和【被测模型的渲染结果】。\n\n" .
    "【重要 · 你看到的是静态截图】：两侧给你的都是【静止的 PNG 截图】，画面停在某一瞬间。" .
    "因此【不要评判任何动态效果】——不要提「没有动画」「车轮不转动」「缺少踏板蹬动」「没有循环播放」" .
    "「动画未体现」这类意见，截图本来就看不出动静，这不是被测模型的缺陷，写进评审就是误判。" .
    "只评价静态画面上能看见的东西：主体形象、构图布局、形状比例、颜色、元素齐全度、可辨识度。\n\n" .
    "【核心评判原则 · 务必宽松】：标准答案只是【参考之一】，不是唯一正确答案。判断的唯一核心是——" .
    "『被测模型画出的东西，能不能让人一眼认出题目要求的主体，且大体合理』。\n" .
    "- 只要主体可辨认、题目要素基本齐全（哪怕画风、配色、构图、细节与标准答案差别很大），就算【正常】，不算降智。\n" .
    "- 画风不同、更简约、比例略怪、缺个太阳/云朵这类枝节，都【不算降智】，顶多算『小瑕疵』。\n" .
    "- 只有当出现以下【严重失败】时才判降智：主体根本认不出是什么、题目主体整个缺失、画面严重错乱破碎、" .
    "完全答非所问、或几乎一片空白。这才叫『降智』。\n" .
    "记住：宁可放过，不可误伤。人类看着觉得『画得挺像、能认出来』的，一律给正常。\n\n" .
    "【输出方式 · 严格照做】：不要输出你的分析过程，直接给出最终评审结果；" .
    "如果系统支持，把思考放在专门的思考通道里，正文只留下面的结构化结论。\n\n" .
    "请用简体中文输出评审，【严格照下面的固定格式与标签】，方便前端解析渲染：\n\n" .
    "结论：从这四档里选恰好一档，档位名必须【原样带方括号】写出——【正常发挥】（可辨认、要素基本齐全，即使和标准差异大）/" .
    "【略有瑕疵】（能认出但有明显小问题，仍属正常水平）/【明显降智】（主体难以辨认或严重缺失错乱）/【完全跑偏】（答非所问/空白）；" .
    "档位后紧跟一句话理由。\n" .
    "亮点：\n- 画得不错的点（1-3 条，每条一行，以「- 」开头，可用 **加粗** 强调关键词）\n" .
    "可以更好：\n- 客观描述可改进处（1-3 条，同样「- 」开头；只写静态画面上能改的，风格差异不必苛责）\n" .
    "总评：一句话总评。\n\n" .
    "要求：必须保留「结论：」「亮点：」「可以更好：」「总评：」这四个标签开头；" .
    "列表项一律用「- 」；关键词可用 **两个星号** 包裹加粗；不要用 markdown 标题(#)；语气客观中肯、不吹毛求疵；总字数 300 字以内。" .
    "若某侧图确实缺失或无法辨认，如实说明并基于可用信息评估，不要编造。";

// 组装 user content（视觉格式）
$userParts = [];
$userParts[] = ['type' => 'text', 'text' => "【题目要求】\n" . ($prompt ?: $question)];

$hasImg = false;
if (is_data_png($bImg)) {
    $userParts[] = ['type' => 'text', 'text' => "\n【标准答案 · 渲染结果】"];
    $userParts[] = ['type' => 'image_url', 'image_url' => ['url' => $bImg]];
    $hasImg = true;
} elseif ($bCode !== '') {
    $userParts[] = ['type' => 'text', 'text' => "\n【标准答案 · HTML 源码（无渲染图，请据代码推断画面）】\n" . mb_substr($bCode, 0, 6000)];
}
if (is_data_png($mImg)) {
    $userParts[] = ['type' => 'text', 'text' => "\n【被测模型 · 渲染结果】"];
    $userParts[] = ['type' => 'image_url', 'image_url' => ['url' => $mImg]];
    $hasImg = true;
} elseif ($mCode !== '') {
    $userParts[] = ['type' => 'text', 'text' => "\n【被测模型 · HTML 源码（无渲染图，请据代码推断画面）】\n" . mb_substr($mCode, 0, 6000)];
}
if (!$hasImg) {
    $userParts[] = ['type' => 'text', 'text' => "\n（注：本次无渲染截图，请基于源码进行代码级评估，并在结论中说明。）"];
}

$payload = [
    'model'    => JUDGE_MODEL,
    'messages' => [
        ['role' => 'system', 'content' => $sys],
        ['role' => 'user',   'content' => $userParts],
    ],
    // 思考型裁判（glm-4.1v-thinking 等）的思维链也吃 max_tokens，给足否则正文会被截断
    'max_tokens' => JUDGE_MAXTOKENS,
];
if (JUDGE_EFFORT !== '') $payload['reasoning_effort'] = JUDGE_EFFORT;

$headers = ['Content-Type: application/json', 'Authorization: Bearer ' . JUDGE_KEY];
$bodyJson = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
// ---- 转发（含瞬时故障重试）----
function iqs_curl($url, $headers, $body) {
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL => $url, CURLOPT_POST => true, CURLOPT_HTTPHEADER => $headers,
        CURLOPT_POSTFIELDS => $body, CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => JUDGE_TIMEOUT, CURLOPT_CONNECTTIMEOUT => 20,
        CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => false, CURLOPT_ENCODING => '',
    ]);
    $resp = curl_exec($ch);
    $errno = curl_errno($ch); $err = curl_error($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ['status' => $errno ? 0 : $status, 'body' => $resp, 'error' => $errno ? "curl[$errno]: $err" : null];
}

$res = iqs_curl(JUDGE_URL, $headers, $bodyJson);
for ($i = 1; $i <= 2; $i++) {
    $transient = $res['error'] || $res['status'] === 429 || $res['status'] >= 500;
    if (!$transient) break;
    sleep($i);
    $res = iqs_curl(JUDGE_URL, $headers, $bodyJson);
}

// ---- 400 自愈：思考型模型的接口往往不认 reasoning_effort ----
// （glm-4.1v-thinking 等自带思考，多传一个未知字段就可能 400）。
// 此时去掉该字段原样重试一次，避免用户还要去改配置。
if ($res['status'] === 400 && isset($payload['reasoning_effort'])) {
    unset($payload['reasoning_effort']);
    $bodyJson = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $res = iqs_curl(JUDGE_URL, $headers, $bodyJson);
}

if ($res['error'] || $res['status'] < 200 || $res['status'] >= 300) {
    iqs_out(200, ['ok' => false, 'error' => '裁判模型调用失败: ' . ($res['error'] ?: ('HTTP ' . $res['status'])), 'raw' => mb_substr((string) $res['body'], 0, 400)]);
}

$data = json_decode($res['body'], true);
$msg  = $data['choices'][0]['message'] ?? [];
$text = trim((string) ($msg['content'] ?? ''));

// ---- 思考型裁判：把思维链与正文拆开 ----
// 兼容三种来源：① 正文里的 <think>…</think> 块（glm/qwen 系）
//               ② reasoning_content / reasoning / thinking 字段（DeepSeek/GLM 系）
//               ③ 完全没有思考字段（普通模型）
$thinking = '';
$strip = function ($t) {
    $t = preg_replace('/<think(?:ing)?>.*?<\/think(?:ing)?>/is', '', $t);   // 成对标签整块删
    $t = preg_replace('/<\/?think(?:ing)?>/i', '', $t);                      // 残缺标签只去标记
    return trim((string) $t);
};
$grab = function ($t) {
    if (preg_match('/<think(?:ing)?>(.*?)<\/think(?:ing)?>/is', $t, $m)) return trim($m[1]);
    return '';
};

foreach (['reasoning_content', 'reasoning', 'thinking', 'reasoning_details'] as $k) {
    if ($thinking !== '') break;
    $v = $msg[$k] ?? null;
    if (is_string($v)) $thinking = trim($v);
}
if ($thinking === '') $thinking = $grab($text);   // 只认「成对」标签，避免正文里提 <think> 被误切
$answer = $strip($text);

// 正文为空但思考有货：模型可能只把结果写在思考通道里，退回用思考当正文
if ($answer === '' && $thinking !== '') { $answer = $strip($thinking); $thinking = ''; }
if ($answer === '') $answer = trim((string) ($msg['reasoning_content'] ?? ''));
if ($answer === '' && $thinking === '') {
    iqs_out(200, ['ok' => false, 'error' => '裁判模型返回为空', 'raw' => mb_substr((string) $res['body'], 0, 400)]);
}

// 思考也截断一下，避免异常长的思维链把报告撑爆
if (mb_strlen($thinking) > 6000) $thinking = mb_substr($thinking, 0, 6000) . '…';

iqs_out(200, [
    'ok'         => true,
    'summary'    => $answer,
    'thinking'   => $thinking,
    'usedImages' => $hasImg,
]);
