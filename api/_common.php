<?php
/**
 * 御三家 API 真伪检测站 —— 后端公共配置 & 工具
 * =====================================================================
 * 所有 api/*.php 都 require 本文件。把需要管理员填写的东西全集中在这里。
 *
 * 部署：宝塔新建 PHP7.4+ 站点，把整个 claude-detector 目录传到根目录，
 *      安装并开启 PHP 的 curl 扩展即可。详见「部署说明.md」。
 */

// ===================== 管理员需要填写的配置 =====================

// 智谱 GLM 的 API Key（用于「生成 AI 总结报告」）。
// 去 https://open.bigmodel.cn/ 申请，填到这里。留空则总结功能回退到本地规则。
const GLM_KEY   = 'sk-xxx';                 // ← 改成你的智谱 key
const GLM_MODEL = 'glm-4.7-flash';            // 免费款；若智谱更新型号名，改这里
const GLM_URL   = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

// （可选）Anthropic 官方 count_tokens 用的 key，用于精确核对中转站上报的 input_tokens。
// 没有就留空，token 探针会跳过这一项精确核对。
const OFFICIAL_COUNT_KEY = '';              // 形如 sk-ant2-xxx
const OFFICIAL_BASE_URL  = 'https://api.anthropic.com';

// 分享报告里的「品牌广告位」——管理员自填。报告页顶栏、页脚、PNG 水印都会显示。
const SITE_NAME   = '公益 AI 检测站';
const SITE_URL    = 'https://www.aabao.ai';   // ← 改成你的官网
const SITE_SLOGAN = '一键鉴别 Claude / OpenAI / Gemini 中转站真伪';

// 分享报告保存目录（相对本文件所在的 api/ 的上一级）。需要可写权限。
const DATA_DIR = __DIR__ . '/../data';

// 转发探针请求的超时（秒）。长上下文探针可能很慢，这里给宽一点。
const PROBE_TIMEOUT = 240;

// ===================== 通用：CORS / 响应 =====================

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Access-Key');
header('Content-Type: application/json; charset=utf-8');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

/** 统一 JSON 输出并结束。*/
function out($code, $data) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/** 读取并解析 POST 的 JSON body；失败给 400。*/
function read_json_body() {
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        out(400, ['ok' => false, 'error' => 'invalid json body']);
    }
    return $data;
}

/** 把品牌信息打包，给前端/报告页用。*/
function brand_info() {
    return [
        'name'   => SITE_NAME,
        'url'    => SITE_URL,
        'slogan' => SITE_SLOGAN,
    ];
}

/**
 * 用 curl 转发一个 HTTP 请求，原样回传状态码 / 头 / 体。
 * @param string $url
 * @param string $method GET|POST
 * @param array  $headers  ["Key: Value", ...]
 * @param ?string $body
 * @return array {httpStatus, headers:{}, body, error}
 */
function curl_forward($url, $method, $headers, $body = null) {
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL            => $url,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER         => true,          // 把响应头也拿回来
        CURLOPT_TIMEOUT        => PROBE_TIMEOUT,
        CURLOPT_CONNECTTIMEOUT => 20,
        CURLOPT_SSL_VERIFYPEER => false,         // 中转站证书五花八门，放宽
        CURLOPT_SSL_VERIFYHOST => false,
        CURLOPT_ENCODING       => '',            // 自动解 gzip
    ]);
    if ($method === 'POST' && $body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }

    $resp       = curl_exec($ch);
    $errno      = curl_errno($ch);
    $errmsg     = curl_error($ch);
    $status     = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);

    if ($errno) {
        return ['httpStatus' => 0, 'headers' => [], 'body' => '', 'error' => "curl[$errno]: $errmsg"];
    }

    $rawHeaders = substr($resp, 0, $headerSize);
    $bodyStr    = substr($resp, $headerSize);

    // 解析响应头为关联数组（只保留我们关心的几个 + 全部小写键）
    $headers = [];
    foreach (explode("\r\n", $rawHeaders) as $line) {
        if (strpos($line, ':') !== false) {
            [$k, $v] = explode(':', $line, 2);
            $headers[strtolower(trim($k))] = trim($v);
        }
    }

    return ['httpStatus' => $status, 'headers' => $headers, 'body' => $bodyStr, 'error' => null];
}
