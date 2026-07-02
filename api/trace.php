<?php
/**
 * trace.php —— 末端上游回链探测端点
 * =====================================================================
 * 原理：发一条【视觉请求】给目标中转站，图片 URL 指向本端点（action=img）。中转站通常只转发
 * JSON、不下图；真正去 GET 图片的是【链路最末端的官方上游】，它来抓图时把自己的出口 IP 暴露
 * 给本端点 → ip-api.com 查 org/ASN → 区分 Azure / OpenAI 直连。
 *
 * 接口：
 *   GET  trace.php?action=img&id=<sid>   → 记录命中 IP 并返回一张图片
 *   POST trace.php?action=start (JSON)   → 生成 sid+回链URL，注入 payload 后转发到目标
 *     body: { targetUrl, apiKey, authStyle, payload, extraHeaders }
 *     resp: { ok, sid, imgUrl, httpStatus, body, error }
 *   GET  trace.php?action=logs&id=<sid>  → { ok, sid, hits:[{ip,org,as,asname,isp,country,...}] }
 *
 * 边界：① 仅能看到「真正下图的节点」（中转站若自己下图会变成它的 IP）；② 需上游接受 URL 形式
 * 图片（Azure 部分部署只认 base64、不 fetch URL，此时无命中）；③ 本站须公网可达（本地跑不通）。
 */

require __DIR__ . '/_common.php';

$action = $_GET['action'] ?? '';

// -------- action=img：记录来抓图的节点【真实 IP】+ UA + 请求头，返回图片 --------
if ($action === 'img') {
    $sid = (string) ($_GET['id'] ?? '');
    if (valid_sid($sid)) {
        // 穿透 CDN 取真实 IP：本站若在 Cloudflare 后，REMOTE_ADDR 是 CF 边缘节点(AS13335)，
        // 必须读 CF-Connecting-IP 等才是真正来抓图的上游 IP。
        [$ip, $ipSource] = real_client_ip();
        $ua  = str_replace(["\t", "\r", "\n"], ' ', $_SERVER['HTTP_USER_AGENT'] ?? '');
        // 收集本次抓图请求的相关头（供前端展示「上游回链请求头」，类似参考项目）
        $reqHeaders = [];
        foreach ($_SERVER as $k => $v) {
            if (strpos($k, 'HTTP_') === 0) {
                $name = strtolower(str_replace('_', '-', substr($k, 5)));
                $reqHeaders[$name] = is_string($v) ? str_replace(["\r", "\n"], ' ', $v) : $v;
            }
        }
        $rec = [
            't'         => date('H:i:s'),
            'ip'        => $ip,
            'ipSource'  => $ipSource,
            'ua'        => $ua,
            'remoteAddr'=> $_SERVER['REMOTE_ADDR'] ?? '',
            'headers'   => $reqHeaders,
        ];
        // 每行一条 JSON，便于 logs 解析（避免制表符字段顺序问题）
        @file_put_contents(trace_log_file($sid), json_encode($rec, JSON_UNESCAPED_UNICODE) . "\n", FILE_APPEND | LOCK_EX);
    }
    // 覆盖 _common.php 设的 JSON Content-Type，返回图片
    header('Content-Type: image/png');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    $bytes = trace_image_bytes();
    header('Content-Length: ' . strlen($bytes));
    echo $bytes;
    exit;
}

// -------- action=logs：返回命中节点研判（含真实出口 IP + 归属 + UA + 抓图请求头）--------
if ($action === 'logs') {
    $sid = (string) ($_GET['id'] ?? '');
    if (!valid_sid($sid)) {
        out(400, ['ok' => false, 'error' => 'bad sid', 'hits' => []]);
    }
    $file = trace_log_file($sid);
    $hits = [];
    if (is_file($file)) {
        $seen = [];
        foreach (explode("\n", trim((string) @file_get_contents($file))) as $raw) {
            if ($raw === '') { continue; }
            $rec = json_decode($raw, true);
            if (!is_array($rec)) { continue; }
            $ip = (string) ($rec['ip'] ?? '');
            if ($ip === '' || isset($seen[$ip])) { continue; }
            $seen[$ip] = true;
            $info = asn_lookup($ip);
            [$kind, $label] = classify_org_kind(($info['org'] ?? '') . ' ' . ($info['isp'] ?? '') . ' ' . ($info['as'] ?? ''));
            $hits[] = [
                'ip'       => $ip,                       // 真实出口 IP（你自测工具，IP 是核心信息，照实给）
                'ipSource' => $rec['ipSource'] ?? '',    // 命中来源头（如 CF-Connecting-IP）
                'kind'     => $kind,
                'label'    => $label,
                'org'      => $info['org'] ?? ($info['isp'] ?? ''),
                'as'       => $info['as'] ?? '',
                'country'  => $info['country'] ?? '',
                'region'   => $info['regionName'] ?? '',
                'city'     => $info['city'] ?? '',
                'ua'       => $rec['ua'] ?? '',
                'uaKind'   => classify_exit_ua($rec['ua'] ?? ''),  // 'openai'|'azure'|''
                'headers'  => $rec['headers'] ?? [],      // 抓图请求的完整头
            ];
        }
    }
    out(200, ['ok' => true, 'sid' => $sid, 'hits' => $hits]);
}

// -------- action=start：注入回链 URL 并转发视觉请求 --------
if ($action === 'start') {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        out(405, ['ok' => false, 'error' => 'use POST']);
    }
    $in        = read_json_body();
    $targetUrl = trim($in['targetUrl'] ?? '');
    $apiKey    = trim($in['apiKey'] ?? '');
    $authStyle = $in['authStyle'] ?? 'bearer';
    $payload   = $in['payload'] ?? null;
    $extra     = $in['extraHeaders'] ?? [];

    if ($targetUrl === '' || $payload === null) {
        out(400, ['ok' => false, 'error' => '缺少 targetUrl 或 payload']);
    }
    if (!preg_match('#^https?://#i', $targetUrl)) {
        out(400, ['ok' => false, 'error' => 'targetUrl 必须以 http(s):// 开头']);
    }

    // 生成 sid + 本站公网回链 URL（用 SCRIPT_NAME 拼，兼容子路径部署）
    $sid    = bin2hex(random_bytes(8));
    $self   = $_SERVER['SCRIPT_NAME'] ?? '/api/trace.php';
    $imgUrl = trace_public_base() . $self . '?action=img&id=' . $sid;
    @file_put_contents(trace_log_file($sid), ''); // 预建空日志

    // 把 payload 里的占位符替换成真实回链 URL
    $payload = trace_inject_url($payload, $imgUrl);

    // 组装转发头（与 probe.php 一致）
    $headers = ['Content-Type: application/json'];
    if ($apiKey !== '') {
        if ($authStyle === 'gemini') {
            $headers[] = 'x-goog-api-key: ' . $apiKey;
        } elseif ($authStyle === 'bearer') {
            $headers[] = 'Authorization: Bearer ' . $apiKey;
        } else {
            $headers[] = 'x-api-key: ' . $apiKey;
            $headers[] = 'Authorization: Bearer ' . $apiKey;
            $headers[] = 'anthropic-version: 2023-06-01';
        }
    }
    if (is_array($extra)) {
        foreach ($extra as $k => $v) {
            if ($k !== '' && $v !== '') { $headers[] = $k . ': ' . $v; }
        }
    }

    $bodyStr = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $res = curl_forward($targetUrl, 'POST', $headers, $bodyStr);

    out(200, [
        'ok'         => $res['error'] ? false : true,
        'sid'        => $sid,
        'imgUrl'     => $imgUrl,
        'httpStatus' => $res['httpStatus'],
        'body'       => $res['body'],
        'error'      => $res['error'],
    ]);
}

out(400, ['ok' => false, 'error' => 'unknown action']);
