<?php
/**
 * 御三家 API 真伪检测站 —— 后端公共配置 & 工具
 * =====================================================================
 * 所有 api/*.php 都 require 本文件。把需要管理员填写的东西全集中在这里。
 *
 * 部署：宝塔新建 PHP7.4+ 站点，把整个 claude-detector 目录传到根目录，
 *      安装并开启 PHP 的 curl 扩展即可。详见「部署说明.md」。
 */

// ===================== 配置加载（令牌等放在独立配置文件，更新代码不丢失） =====================
// 所有可自定义项（GLM 令牌、官方 count key、品牌位、超时）都放在 api/config.php。
// 复制 api/config.example.php 为 api/config.php 后填写；更新代码时只覆盖源码，
// 不要覆盖你的 api/config.php，令牌就不会被冲掉。
// 取值优先级：服务器环境变量(getenv) > api/config.php > api/config.example.php > 内置默认。
// 说明：用 .php 配置文件（而非 .env 纯文本）是为安全——直接用浏览器访问 config.php
//      会被 PHP 执行、只返回数组、不输出任何内容，令牌不会泄露。

$__cfg = [];
foreach ([__DIR__ . '/config.php', __DIR__ . '/config.example.php'] as $__f) {
    if (is_file($__f)) {
        $__loaded = require $__f;       // 优先用第一个存在的（config.php 优先）
        if (is_array($__loaded)) { $__cfg = $__loaded; }
        break;
    }
}

/** 取配置：同名环境变量优先，其次配置文件，最后默认值。 */
function cfg_get($cfg, $key, $default) {
    $env = getenv($key);
    if ($env !== false && $env !== '') { return $env; }
    return (isset($cfg[$key]) && $cfg[$key] !== '') ? $cfg[$key] : $default;
}

define('GLM_KEY',            cfg_get($__cfg, 'GLM_KEY', ''));
define('GLM_MODEL',          cfg_get($__cfg, 'GLM_MODEL', 'glm-4.7-flash'));
define('GLM_URL',            cfg_get($__cfg, 'GLM_URL', 'https://open.bigmodel.cn/api/paas/v4/chat/completions'));

define('OFFICIAL_COUNT_KEY', cfg_get($__cfg, 'OFFICIAL_COUNT_KEY', ''));
define('OFFICIAL_BASE_URL',  cfg_get($__cfg, 'OFFICIAL_BASE_URL', 'https://api.anthropic.com'));

define('SITE_NAME',          cfg_get($__cfg, 'SITE_NAME', '公益 AI 检测站'));
define('SITE_URL',           cfg_get($__cfg, 'SITE_URL', 'https://www.aabao.ai'));
define('SITE_SLOGAN',        cfg_get($__cfg, 'SITE_SLOGAN', '一键鉴别 Claude / OpenAI / Gemini 中转站真伪'));

// 转发探针请求的超时（秒）。长上下文探针可能很慢，这里给宽一点。
define('PROBE_TIMEOUT',      (int) cfg_get($__cfg, 'PROBE_TIMEOUT', 240));

// 分享报告保存目录（路径，非密钥；需可写权限）。可用环境变量 / 配置项 DATA_DIR 覆盖。
define('DATA_DIR',           cfg_get($__cfg, 'DATA_DIR', __DIR__ . '/../data'));

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
