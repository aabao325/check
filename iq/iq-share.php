<?php
/**
 * iq-share.php —— 大模型智商检测 · 分享报告 存/读
 * =====================================================================
 * POST：把一次检测存成 <IQ_DATA_DIR>/reports/<id>.json，返回 {ok, id}。
 *       前端据此生成 /iq/s/<id> 短链（整条约 42 字符）。
 * GET ?id=xxx：读回该报告 JSON（iq-report 加载时用）。只读，无需 key。
 *
 * 这是本站无需登录的公开写入端点，所以四道闸一个不少：
 *   ① 截断  单侧 HTML 400KB / 原文 20KB / 总结 4KB / 思考 8KB
 *   ② 封顶  单档 IQ_MAX_REPORT_BYTES，总量 IQ_MAX_REPORTS
 *   ③ 限流  nginx 的（本站与 check 同域，规则见仓库根 nginx-伪静态.conf）
 *   ④ 回收  超量删最旧的，而不是拒绝新写入
 *
 * 存储内容含两侧 HTML 源码（供报告页 iframe 活图渲染）与 AI 总结。
 * ===================================================================== */

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: application/json; charset=utf-8');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }

// ---- 配置 ----
$__cfg = [];
foreach ([__DIR__ . '/iq-config.php', dirname(__DIR__) . '/iq-config.php', __DIR__ . '/iq-config.example.php'] as $__f) {
    if (is_file($__f)) { $__l = require $__f; if (is_array($__l)) $__cfg = $__l; break; }
}
function iqsh_cfg($cfg, $key, $def) {
    $env = getenv($key);
    if ($env !== false && $env !== '') return $env;
    return (isset($cfg[$key]) && $cfg[$key] !== '') ? $cfg[$key] : $def;
}
define('IQ_DATA_DIR', iqsh_cfg($__cfg, 'IQ_DATA_DIR', dirname(__DIR__) . '/data/iq'));
define('IQ_REPORT_DIR', rtrim(IQ_DATA_DIR, '/\\') . DIRECTORY_SEPARATOR . 'reports');

/** 新 id 长度：1 位前缀 'a' + 9 位 base36 随机码（与 modeltrace / check 同形）。
 *
 *  为什么不是「时间戳 + 随机 hex」：链接要发进微信 / QQ，id 每一位都直接决定
 *  读者看到多长的一串乱码。旧 id 20 字符 + `iq-report?id=` 前缀，整条 URL 60 字符；
 *  新 id 10 字符 + `/s/` 前缀（nginx 重写），整条 42 字符出头。
 *
 *  ⚠️ 缩短后不能再从 id 里读出任何信息，所以：
 *    ① 唯一性交给碰撞重试，不靠时间戳保序
 *    ② 「同一份报告复用同一个链接」改由内容哈希 _h 查重实现（见 iqsh_find_by_hash）
 *    ③ 回收排序不能用文件名（随机码无序），改用文档里的 _c 毫秒时间戳
 *
 *  9 位 base36 ≈ 46.5 bit；1000 条时生日碰撞概率约 5e-9，比磁盘出错还低。 */
const IQ_ID_LEN = 9;

/** 生成随机 id 时的重试次数；撞上已有文件就换一个码重来。 */
const IQ_ID_RETRY = 5;

/** 内容哈希在文档里的字段名（不参与哈希计算本身，只用来查重）。 */
const IQ_HASH_KEY = '_h';

/** 文档里记录「第一次写入」的毫秒时间戳，供回收排序用。
 *
 *  为什么不用文件 mtime：随机 id 无时间信息，而 PHP 的 stat 只有秒级精度 ——
 *  同一秒内分享的多份报告 mtime 完全相同，排序退化成按随机文件名排，
 *  「最旧的先删」就变成了随机删。 */
const IQ_TS_KEY = '_c';

/** 单份报告体积上限（落盘前编码后的字节数）。两侧 HTML 各 400KB 已是极宽裕。 */
define('IQ_MAX_REPORT_BYTES',
    max(64 * 1024, min(8 * 1024 * 1024, (int) iqsh_cfg($__cfg, 'IQ_MAX_REPORT_BYTES', 2 * 1024 * 1024))));

/** 分享报告总量上限。每条含两侧 HTML，按平均 200KB 估约 200MB。 */
define('IQ_MAX_REPORTS', max(1, min(100000, (int) iqsh_cfg($__cfg, 'IQ_MAX_REPORTS', 1000))));

/** 单次回收删掉的比例：一次删够，避免每来一条就 glob 一次全目录。 */
const IQ_SWEEP_RATIO = 0.1;

function iqsh_out($code, $data) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/** id 白名单：两种形状都收。
 *    ① 新格式：'a' + 9 位 base36（共 10 字符）
 *    ② 旧格式：4 位 base36 时间戳片段 + 16 位 hex（共 20 字符）
 *  旧格式必须继续放行 —— 已经发出去的分享链接不能因为改了生成方式就全部失效。
 *  只允许这两种精确形状，也就杜绝了 ../ 之类的路径穿越（比「6~40 位字母数字」严）。 */
function iqsh_valid_id(string $id): bool {
    return (bool) preg_match('/^(?:a[a-z0-9]{' . IQ_ID_LEN . '}|[a-z0-9]{4}[a-f0-9]{16})$/', $id);
}

/** 递归按键名排序（只排关联数组；列表数组保持原序 —— 顺序对它们是语义的一部分）。 */
function iqsh_ksort_deep(array &$a): void {
    if (!iqsh_is_list($a)) { ksort($a); }
    foreach ($a as &$v) { if (is_array($v)) { iqsh_ksort_deep($v); } }
    unset($v);
}
function iqsh_is_list(array $a): bool {
    $i = 0;
    foreach ($a as $k => $_) { if ($k !== $i++) { return false; } }
    return true;
}

/** 内容哈希：剔除时间字段后做一次键名排序的稳定序列化，再 sha256。
 *
 *  ⚠️ 必须排序：PHP 数组顺序即插入顺序，json_encode 会照此输出 ——
 *     同一份内容若字段顺序不同，hash 就变了，复用直接失效。 */
function iqsh_content_hash(array $doc): string {
    unset($doc['savedAt'], $doc[IQ_TS_KEY], $doc[IQ_HASH_KEY]);
    iqsh_ksort_deep($doc);
    return hash('sha256', (string) json_encode($doc, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

/** 目录里所有分享报告。 */
function iqsh_glob_reports(): array {
    $files = [];
    foreach ((array) @glob(IQ_REPORT_DIR . '/*.json') as $f) {
        if (is_file($f) && iqsh_valid_id(basename($f, '.json'))) { $files[] = $f; }
    }
    return $files;
}

/** 找出内容相同的那一份报告文件名（没有则 null）—— 同一份报告重复分享复用同一个链接。
 *  ⚠️ 只读文件头 512 字节：_h 写在文档最前面。 */
function iqsh_find_by_hash(string $hash): ?string {
    if ($hash === '') { return null; }
    foreach (iqsh_glob_reports() as $file) {
        $fh = @fopen($file, 'rb');
        if ($fh === false) { continue; }
        $head = (string) fread($fh, 512);
        fclose($fh);
        if (preg_match('/"' . IQ_HASH_KEY . '"\s*:\s*"([0-9a-f]{64})"/', $head, $m) && hash_equals($m[1], $hash)) {
            return $file;
        }
    }
    return null;
}

/** 生成一个没用过的随机 id（'a' + IQ_ID_LEN 位 base36）。 */
function iqsh_new_id(): string {
    $digits = '0123456789abcdefghijklmnopqrstuvwxyz';
    for ($try = 0; $try < IQ_ID_RETRY; $try++) {
        $s = 'a';
        for ($i = 0; $i < IQ_ID_LEN; $i++) { $s .= $digits[random_int(0, 35)]; }
        if (!is_file(IQ_REPORT_DIR . DIRECTORY_SEPARATOR . $s . '.json')) { return $s; }
    }
    // 连续撞上 5 次：宁可报错，也绝不覆盖别人的报告
    iqsh_out(500, ['ok' => false, 'error' => '生成分享编号失败，请重试']);
    return '';
}

/** 取一份落盘文档的创建时间（毫秒）；没有 _c（旧文件）就退回 mtime（秒 → 毫秒）。 */
function iqsh_created_at(string $file): int {
    $fh = @fopen($file, 'rb');
    if ($fh !== false) {
        $head = (string) fread($fh, 256);
        fclose($fh);
        if (preg_match('/"' . IQ_TS_KEY . '"\s*:\s*(\d+)/', $head, $m)) { return (int) $m[1]; }
    }
    $mtime = @filemtime($file);
    return $mtime === false ? 0 : $mtime * 1000;
}

/** 回收：超过 IQ_MAX_REPORTS 时删掉最旧的一批。返回删除条数。 */
function iqsh_sweep(): int {
    $files = iqsh_glob_reports();
    $over = count($files) - IQ_MAX_REPORTS;
    if ($over <= 0) { return 0; }
    $drop = max(1, (int) ceil(IQ_MAX_REPORTS * IQ_SWEEP_RATIO), $over);
    usort($files, static function ($x, $y) {
        return [iqsh_created_at($x), basename($x)] <=> [iqsh_created_at($y), basename($y)];
    });
    $n = 0;
    foreach (array_slice($files, 0, $drop) as $f) { if (@unlink($f)) { $n++; } }
    return $n;
}

// -------- 读取 --------
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    $id = $_GET['id'] ?? '';
    if (!iqsh_valid_id($id)) iqsh_out(400, ['ok' => false, 'error' => 'bad id']);
    $file = IQ_REPORT_DIR . DIRECTORY_SEPARATOR . $id . '.json';
    if (!is_file($file)) iqsh_out(404, ['ok' => false, 'error' => 'report not found']);
    $data = json_decode((string) file_get_contents($file), true);
    if (!is_array($data)) iqsh_out(500, ['ok' => false, 'error' => 'corrupt report']);
    iqsh_out(200, ['ok' => true, 'report' => $data]);
}

// -------- 保存 --------
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') iqsh_out(405, ['ok' => false, 'error' => 'use GET or POST']);

// 先按 Content-Length 提前拒，读完再校验实际长度（Content-Length 可缺失或被伪造）
$bodyMax = IQ_MAX_REPORT_BYTES * 4 + 64 * 1024;
$declared = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($declared > $bodyMax) iqsh_out(413, ['ok' => false, 'error' => '报告过大']);
$rawBody = (string) file_get_contents('php://input');
if (strlen($rawBody) > $bodyMax) iqsh_out(413, ['ok' => false, 'error' => '报告过大']);

$in = json_decode($rawBody, true);
if (!is_array($in)) iqsh_out(400, ['ok' => false, 'error' => 'invalid json body']);
if (empty($in['modelHtml']) && empty($in['modelCode']) && empty($in['modelRaw'])) {
    iqsh_out(400, ['ok' => false, 'error' => '空报告']);
}

if (!is_dir(IQ_REPORT_DIR)) { @mkdir(IQ_REPORT_DIR, 0775, true); }
if (!is_dir(IQ_REPORT_DIR) || !is_writable(IQ_REPORT_DIR)) {
    iqsh_out(200, ['ok' => false, 'error' => '服务器暂时无法保存分享，请稍后再试', 'fallback' => true]);
}

// 限制单侧 HTML 体积，避免异常大文件（正常 SVG 页面几十 KB 足够）
$cap = function ($s) { $s = (string) $s; return mb_strlen($s) > 400000 ? mb_substr($s, 0, 400000) : $s; };

$store = [
    // ⚠️ _c / _h 必须排在最前面：回收排序与查重都靠「只读文件头 512 字节」拿它们。
    IQ_TS_KEY      => (int) round(microtime(true) * 1000),
    'savedAt'      => date('c'),
    'questionId'   => mb_substr((string) ($in['questionId']   ?? ''), 0, 64),
    'questionName' => mb_substr((string) ($in['questionName'] ?? ''), 0, 128),
    'questionEmoji'=> mb_substr((string) ($in['questionEmoji']?? '🧠'), 0, 8),
    'prompt'       => mb_substr((string) ($in['prompt']       ?? ''), 0, 4000),
    'model'        => mb_substr((string) ($in['model']        ?? ''), 0, 128),
    'think'        => mb_substr((string) ($in['think']        ?? ''), 0, 32),
    'protocol'     => mb_substr((string) ($in['protocol']     ?? ''), 0, 32),
    'targetHost'   => mb_substr((string) ($in['targetHost']   ?? ''), 0, 255),
    // 地址口径：'host'（默认，只留域名）/ 'none'（报告里完全不出现）。
    // 白名单收敛而非直接透传：这个字段会被报告页拿去当渲染条件，
    // 放任意字符串进来等于给前端塞了个不可控的分支值。非法值落回 host。
    // ⚠️ targetHost 本身照存不误 —— 它是「检测了什么」的事实记录，
    //    口径只控制**要不要展示**，不该反过来篡改记录。
    // ⚠️ 只能排在 _c / savedAt 之后：那两行占的是文件头（查重只读头 512 字节）。
    'urlMode'      => (($in['urlMode'] ?? '') === 'none' ? 'none' : 'host'),
    'baselineHtml' => $cap($in['baselineHtml'] ?? ''),  // 标准答案（可空=未填基线）
    'modelHtml'    => $cap($in['modelHtml']    ?? ''),   // 被测模型输出 HTML
    'modelRaw'     => mb_substr((string) ($in['modelRaw'] ?? ''), 0, 20000),  // 无 HTML 时的原文
    'summary'      => mb_substr((string) ($in['summary'] ?? ''), 0, 4000),    // AI 总结
    'summaryThink' => mb_substr((string) ($in['summaryThink'] ?? ''), 0, 8000), // 裁判模型的思考过程（思考型模型才有）
];

// 查重复用：同一份报告（内容哈希一致）复用上次那条记录的 id，不堆内容相同的副本，
// 也不刷新它的 _c（免得旧报告永远不被回收）。
$hash = iqsh_content_hash($store);
$existing = iqsh_find_by_hash($hash);
if ($existing !== null) {
    iqsh_out(200, ['ok' => true, 'id' => basename($existing, '.json'), 'reused' => true]);
}

$store[IQ_HASH_KEY] = $hash;
$encoded = (string) json_encode($store, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
// 截断之后仍可能超限（两侧 HTML 各 400KB 的极端情况），编码后再夹一道
if (strlen($encoded) > IQ_MAX_REPORT_BYTES) {
    iqsh_out(413, ['ok' => false, 'error' => '报告过大']);
}

$id = iqsh_new_id();
$file = IQ_REPORT_DIR . DIRECTORY_SEPARATOR . $id . '.json';
$ok = file_put_contents($file, $encoded, LOCK_EX);

if ($ok === false) iqsh_out(200, ['ok' => false, 'error' => '服务器暂时无法保存分享，请稍后再试', 'fallback' => true]);

// 写入成功后再回收：顺序反过来的话，新报告会被自己这次清理删掉的旧文件配额挤掉。
iqsh_sweep();

iqsh_out(200, ['ok' => true, 'id' => $id]);
