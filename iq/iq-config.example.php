<?php
/**
 * 配置模板 —— 复制本文件为同目录下的 iq-config.php，再按需修改。
 * =====================================================================
 *  - iq-config.php 不随代码更新覆盖，你的私密/自定义配置原样保留。
 *  - 也支持服务器真实环境变量覆盖（同名 getenv 优先级最高）。
 *  - 本文件是 .php，被浏览器直接访问会被执行、只返回数组、不输出内容。
 *
 * 用法：复制 iq-config.example.php → iq-config.php，编辑 iq-config.php。
 */

return [
    // 说明：模型检测请求已改为【浏览器本地直连】，不再经服务器转发，故无需转发超时配置。

    // ---- 分享报告保存目录（需可写权限；留空用默认 <根>/data/iq）----
    // 与 check / modeltrace 统一放站点根 data/<项目>：一条
    // location ~* ^/(data|tests)/ { deny all; } 就挡住全部三个站的运行数据。
    // 'IQ_DATA_DIR' => '/www/wwwroot/your-site/data/iq',

    // =================================================================
    // 视觉裁判模型（用于「AI 总结」）
    // -----------------------------------------------------------------
    // AI 总结会把「题目要求 + 标准答案渲染图 + 被测模型渲染图」发给这个模型，
    // 让它评判被测模型画得对不对、和标准差在哪。所以这里必须填一个【支持读图】
    // 的多模态模型（如 glm-4.1v-thinking-flashx / gpt-5.5 / gemini-3-pro 等）。
    // 走 OpenAI Chat Completions 视觉格式（image_url + base64 data URI）。
    // 若用【思考型】模型（reasoning_content / <think> 输出思维链），接口会自动把
    // 思考与正文拆开，前端用独立的「💭 模型思考过程」折叠区展示（默认展开）。
    // 不配置则「AI 总结」按钮不可用，其余功能不受影响。
    // =================================================================
    'JUDGE_URL'   => '',   // 形如 https://api.aabao.ai/v1/chat/completions
    'JUDGE_KEY'   => '',   // 形如 sk-xxx
    'JUDGE_MODEL' => 'glm-4.1v-thinking-flashx',
    // 裁判模型思考档位（reasoning_effort）：留空不传；可填 minimal/low/medium/high
    // 注意：glm-4.1v-thinking 这类模型自带思考，传了可能报错，建议留空
    'JUDGE_EFFORT' => '',
    // 裁判调用超时（秒）
    'JUDGE_TIMEOUT' => 120,
    // 输出上限：思考型模型的思维链也占这个额度，太小会把正文挤掉
    'JUDGE_MAXTOKENS' => 4096,
];
