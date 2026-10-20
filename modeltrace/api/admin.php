<?php
/**
 * modeltrace/api/admin.php —— 管理员采集台后端
 * =====================================================================
 * POST JSON { action, ... }；除 login 外都要 Authorization: Bearer <token>。
 *
 *   login          { password }          → { token, expires }
 *   logout                                → {}
 *   ping                                  → { ok }               （校验会话是否仍有效）
 *   list                                  → { archives:[摘要...], limits }
 *   get            { id }                → { archive }
 *   save           { archive, id? }      → { id }                （带 id 为覆盖，否则新建）
 *   delete         { id }                → {}
 *
 * 档案里永远不存 API Key（字段白名单里就没有这一项）。
 * ===================================================================== */

declare(strict_types=1);
require __DIR__ . '/_common.php';

header('X-Robots-Tag: noindex');
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { mt_out(405, ['ok' => false, 'error' => '只接受 POST']); }

mt_rate_limit('admin');
$in = mt_read_json();
$action = (string) ($in['action'] ?? '');

if ($action === 'login') {
    $s = mt_login((string) ($in['password'] ?? ''));
    mt_out(200, ['ok' => true] + $s);
}

mt_require_admin();

switch ($action) {
    case 'ping':
        mt_out(200, ['ok' => true]);

    case 'logout':
        mt_logout();
        mt_out(200, ['ok' => true]);

    case 'list': {
        $list = [];
        foreach (glob(mt_dir('archives') . '/a*.json') ?: [] as $f) {
            $a = json_decode((string) file_get_contents($f), true);
            if (!is_array($a)) { continue; }
            $list[] = [
                'id' => $a['id'] ?? basename($f, '.json'),
                'label' => $a['label'] ?? '', 'host' => $a['host'] ?? '', 'model' => $a['model'] ?? '',
                'kind' => $a['kind'] ?? 'relay', 'format' => $a['format'] ?? '',
                'rows' => count($a['rows'] ?? []),
                'numbers' => array_sum(array_map(static fn($r) => count($r['numbers'] ?? []), $a['rows'] ?? [])),
                'analysis' => $a['analysis'] ?? null,
                'created_at' => $a['created_at'] ?? 0, 'updated_at' => $a['updated_at'] ?? 0,
            ];
        }
        usort($list, static fn($x, $y) => ($y['updated_at'] <=> $x['updated_at']));
        mt_out(200, ['ok' => true, 'archives' => $list, 'limits' => ['max_archives' => MT_MAX_ARCHIVES, 'max_archive_bytes' => MT_MAX_ARCHIVE_BYTES]]);
    }

    case 'get': {
        $id = (string) ($in['id'] ?? '');
        $f = mt_dir('archives') . "/$id.json";
        if (!mt_valid_archive_id($id) || !is_file($f)) { mt_out(404, ['ok' => false, 'error' => '档案不存在']); }
        mt_out(200, ['ok' => true, 'archive' => json_decode((string) file_get_contents($f), true)]);
    }

    case 'save': {
        if (!is_array($in['archive'] ?? null)) { mt_out(400, ['ok' => false, 'error' => '缺少 archive']); }
        $clean = mt_clean_archive($in['archive']);
        if ($clean['label'] === '' || $clean['model'] === '') { mt_out(400, ['ok' => false, 'error' => '档案名和模型名不能为空']); }
        if (!$clean['rows']) { mt_out(400, ['ok' => false, 'error' => '没有有效回答，不建档']); }
        $dir = mt_dir('archives');
        $id = (string) ($in['id'] ?? '');
        $now = time();
        if ($id !== '') {
            if (!mt_valid_archive_id($id) || !is_file("$dir/$id.json")) { mt_out(404, ['ok' => false, 'error' => '要覆盖的档案不存在']); }
            $old = json_decode((string) file_get_contents("$dir/$id.json"), true);
            $created = (int) ($old['created_at'] ?? $now);
        } else {
            if (count(glob("$dir/a*.json") ?: []) >= MT_MAX_ARCHIVES) {
                mt_out(409, ['ok' => false, 'error' => '档案数已达上限 ' . MT_MAX_ARCHIVES . '，请先删除旧档案']);
            }
            $id = mt_archive_id();
            $created = $now;
        }
        $doc = ['id' => $id] + $clean + ['created_at' => $created, 'updated_at' => $now];
        $json = json_encode($doc, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (strlen($json) > MT_MAX_ARCHIVE_BYTES) { mt_out(413, ['ok' => false, 'error' => '档案过大']); }
        mt_write_atomic("$dir/$id.json", $json);
        mt_out(200, ['ok' => true, 'id' => $id]);
    }

    case 'delete': {
        $id = (string) ($in['id'] ?? '');
        $f = mt_dir('archives') . "/$id.json";
        if (!mt_valid_archive_id($id) || !is_file($f)) { mt_out(404, ['ok' => false, 'error' => '档案不存在']); }
        @unlink($f);
        mt_out(200, ['ok' => true]);
    }

    default:
        mt_out(400, ['ok' => false, 'error' => '未知 action']);
}
