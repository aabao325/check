<?php
/**
 * 配置模板 —— 复制本文件为同目录下的 config.php，再填写你的私密配置（令牌等）。
 * =====================================================================
 *  - config.php 不随代码更新覆盖：以后更新代码只覆盖源码与本 *.example.php，
 *    你的 config.php 原样保留，令牌不会丢。
 *  - 也支持服务器真实环境变量覆盖（同名 getenv 优先级最高）。
 *  - 安全：本文件是 .php，被浏览器直接访问会被 PHP 执行、只返回数组、不输出任何内容，
 *    令牌不会像 .env 纯文本那样被人下载泄露。
 *
 * 用法：把整个目录传到服务器后，复制 config.example.php → config.php，编辑 config.php。
 */

return [
    // ---- 智谱 GLM（用于「生成 AI 总结」）。留空则回退本地规则总结 ----
    // 申请：https://open.bigmodel.cn/
    'GLM_KEY'   => '',                        // ← 改成你的智谱 key，如 sk-xxx
    'GLM_MODEL' => 'glm-4.7-flash',           // 免费款；若智谱更新型号名，改这里
    'GLM_URL'   => 'https://open.bigmodel.cn/api/paas/v4/chat/completions',

    // ---- （可选）Anthropic 官方 count_tokens 的 key，用于精确核对中转站上报的 input_tokens ----
    // 没有就留空，token 探针会跳过这一项精确核对。
    'OFFICIAL_COUNT_KEY' => '',               // 形如 sk-ant2-xxx
    'OFFICIAL_BASE_URL'  => 'https://api.anthropic.com',

    // ---- 分享报告的「品牌位」（报告页顶栏 / 页脚 / PNG 水印都会显示）----
    'SITE_NAME'   => '公益 AI 检测站',
    'SITE_URL'    => 'https://www.aabao.ai',  // ← 改成你的官网
    'SITE_SLOGAN' => '一键鉴别 Claude / OpenAI / Gemini 中转站真伪',

    // ---- 转发探针请求超时（秒）。长上下文探针较慢，给宽一点 ----
    'PROBE_TIMEOUT' => 240,

    // ---- 分享报告保存目录（路径，需可写权限；留空用默认 api/../data）----
    // 'DATA_DIR' => '/www/wwwroot/your-site/data',
];
