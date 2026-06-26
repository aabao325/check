<?php
/**
 * share.php —— 保存 / 读取分享报告
 * =====================================================================
 * POST：把一次检测的完整结果存成 data/<id>.json，返回 {ok, id}。
 *       前端据此生成 report.html?id=<id> 短链接。
 * GET ?id=xxx：读回该报告 JSON（report.html 加载时用）。无需 key，只读。
 *
 * 若 data/ 不可写，POST 返回 ok:false，前端会自动退化为 URL hash 静态分享。
 */

require __DIR__ . '/_common.php';

// -------- 读取报告 --------
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    $id = $_GET['id'] ?? '';
    if (!preg_match('/^[a-zA-Z0-9]{6,40}$/', $id)) {
        out(400, ['ok' => false, 'error' => 'bad id']);
    }
    $file = DATA_DIR . '/' . $id . '.json';
    if (!is_file($file)) {
        out(404, ['ok' => false, 'error' => 'report not found']);
    }
    $content = file_get_contents($file);
    $data = json_decode($content, true);
    if (!is_array($data)) {
        out(500, ['ok' => false, 'error' => 'corrupt report']);
    }
    // 注入最新品牌信息（管理员可能换了官网）
    $data['brand'] = brand_info();
    out(200, ['ok' => true, 'report' => $data]);
}

// -------- 保存报告 --------
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    out(405, ['ok' => false, 'error' => 'use GET or POST']);
}

$in = read_json_body();
if (empty($in['results']) && empty($in['totalScore'])) {
    out(400, ['ok' => false, 'error' => '空报告']);
}

// 确保目录存在且可写
if (!is_dir(DATA_DIR)) {
    @mkdir(DATA_DIR, 0775, true);
}
if (!is_dir(DATA_DIR) || !is_writable(DATA_DIR)) {
    out(200, ['ok' => false, 'error' => 'data 目录不可写', 'fallback' => true]);
}

// 生成短 id（时间戳片段 + 随机）
$id = substr(base_convert((string)time(), 10, 36), -4) . bin2hex(random_bytes(4));

// 只保留必要字段，剥离可能很大的原始请求/响应体（报告页不需要全文）
$store = [
    'savedAt'    => date('c'),
    'protocol'   => $in['protocol']   ?? '',
    'model'      => $in['model']      ?? '',
    'targetHost' => $in['targetHost'] ?? '',
    'channel'    => $in['channel']    ?? '',
    'totalScore' => $in['totalScore'] ?? 0,
    'verdict'    => $in['verdict']    ?? '',
    'critical'   => $in['critical']   ?? false,
    'summary'    => $in['summary']    ?? '',
    'results'    => array_map(function ($r) {
        return [
            'name'     => $r['name']     ?? '',
            'score'    => $r['score']    ?? null,
            'weight'   => $r['weight']   ?? null,
            'verdict'  => $r['verdict']  ?? '',
            'severity' => $r['severity'] ?? '',
            'features' => array_slice($r['features'] ?? [], 0, 12),
            'diffs'    => array_slice($r['diffs'] ?? [], 0, 12),
        ];
    }, $in['results'] ?? []),
];

$file = DATA_DIR . '/' . $id . '.json';
$ok = file_put_contents($file, json_encode($store, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));

if ($ok === false) {
    out(200, ['ok' => false, 'error' => '写入失败', 'fallback' => true]);
}

out(200, ['ok' => true, 'id' => $id]);
