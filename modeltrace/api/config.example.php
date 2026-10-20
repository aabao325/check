<?php
/**
 * 配置模板 —— 复制为同目录下的 config.php 再填写（config.php 已被 .gitignore 排除）。
 * 也支持同名环境变量覆盖（优先级最高）。
 */
return [
    // 管理员采集台密码的 bcrypt 哈希（不是明文！）。生成方式：
    //   php -r "echo password_hash('你的密码', PASSWORD_DEFAULT), PHP_EOL;"
    // 留空则采集台无法登录（前台检测不受影响）。
    'MT_ADMIN_PASSWORD_HASH' => '',

    // 运行时数据目录（档案 / 会话 / 限流计数）。默认 modeltrace/data/runtime，需 PHP 可写。
    // 档案里含中转站 Base URL，与分享报告同级敏感：放在网站根目录外最安全；
    // 放站内时统一放 <站点根>/data/modeltrace —— 与 check、iq 同一父目录，
    // 一条 location ~* ^/(data|tests)/ { deny all; } 就挡住三个站的运行数据（见 README）。
    // 'MT_DATA_DIR' => '/www/wwwroot/your-site/data/modeltrace',

    // ---- 闸门（一般不用改）----
    // 'MT_SESSION_TTL'        => 43200,   // 登录有效期（秒）
    // 'MT_LOGIN_MAX_FAILS'    => 5,       // 连续失败几次锁定
    // 'MT_LOGIN_LOCK_SECONDS' => 900,     // 锁定时长（秒）
    // 'MT_MAX_ARCHIVES'       => 300,     // 档案总数上限
    // 'MT_MAX_ARCHIVE_BYTES'  => 409600,  // 单个档案上限
    // 'MT_RATE_LIMIT'         => 60,      // 每个 IP 每窗口最多请求数
    // 'MT_RATE_WINDOW'        => 60,      // 限流窗口（秒）
];
