# 🧪 大模型检测站

三个独立的大模型检测工具，从不同角度回答同一个问题：**你正在用的这个「模型」，到底是不是你以为的那个？**

每个站都能单独部署、单独使用；放在同一个仓库里，是为了共用一套视觉、一套导航和一套部署说明。

<p>
  <a href="https://github.com/aabao325/check"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg"></a>
  <img alt="PHP" src="https://img.shields.io/badge/PHP-7.4%2B-777BB4.svg">
  <img alt="Frontend" src="https://img.shields.io/badge/Frontend-Vanilla%20JS%20(ESM)-f7df1e.svg">
  <img alt="Build" src="https://img.shields.io/badge/Build-Zero%20config-success.svg">
</p>

---

## 📖 三个站分别做什么

| 目录 | 检测什么 | 靠什么判断 | 详细说明 |
| --- | --- | --- | --- |
| [`check/`](./check/) | **API 中转站真伪**：掺假冒充、协议篡改、能力降级、隐藏提示词注入 | 23 项 Claude 探针 + 6 项 OpenAI / Gemini 探针，交叉验证后加权评分 | [README](./check/README.md) |
| [`iq/`](./iq/) | **模型是否降智**：同一道题，旗舰模型与便宜小模型画得出来吗 | 让模型用 SVG 画动画，与标准答案左右对比，再由视觉模型点评差在哪 | — |
| [`modeltrace/`](./modeltrace/) | **背后究竟是哪个模型**：中转站有没有偷偷换成别的 | 让模型写约 300 个随机数，与各模型官方基准做数字指纹归因 | [README](./modeltrace/README.md) |

**它们的边界：**

- `check` 查的是「**这个渠道**有没有骗你」—— 协议、计费、签名、注入，偏证据链；
- `iq` 查的是「**这个模型**现在还够不够聪明」—— 偏能力体感；
- `modeltrace` 查的是「**这个模型**到底是谁」—— 偏身份归因。

三者结论可以互相印证：比如 `check` 显示签名异常、`modeltrace` 指向另一个模型，基本可以确定被换过。

---

## 🔒 隐私口径（三个站一致）

- **请求由你的浏览器直连目标接口**，API Key 不经过本站服务器；后端 PHP 只做两件事：绕 CORS 转发、存分享报告。
- **检测历史只存在你本机浏览器**（localStorage），换设备看不到。
- **只有你主动点「分享报告」并确认**，报告的脱敏快照才会存到服务器以生成短链；中转站地址默认只保留域名。

---

## 🏗️ 目录结构

```
.
├── index.html              # 总入口：三张卡片，进入各自的检测站
├── nav-drop.js             # 三站共用的「大模型检测」下拉
├── og-cover.svg            # favicon / 分享封面
├── nginx-伪静态.conf        # 三个站共用的一份 Nginx 规则
│
├── check/                  # ① 真伪检测
│   ├── index.html          #   主界面（自动 / 手动双视图）
│   ├── report.html         #   可分享的报告页
│   ├── api/                #   PHP：转发探针 / AI 总结 / 分享存取
│   ├── assets/             #   样式、引擎、三协议探针集
│   └── data/               #   分享报告（运行时生成，勿提交）
│
├── iq/                     # ② 智商检测
│   ├── index.html          #   选题 → 检测 → 左右对比
│   ├── iq-report.html      #   可分享的报告页
│   ├── iq-assets/          #   前端逻辑 + 标准答案（baselines/）
│   ├── iq-config.example.php
│   ├── iq-proxy.php        #   CORS 兜底转发（不落盘）
│   ├── iq-summary.php      #   视觉裁判（AI 总结）
│   └── iq-share.php        #   分享报告存取
│
└── modeltrace/             # ③ 归因检测
    ├── index.html          #   检测页
    ├── report.html         #   可分享的报告页
    ├── admin.html          #   指纹采集台（管理员，密码保护）
    ├── api/                #   建档 / 分享 / 鉴权
    ├── assets/engine/      #   指纹特征、归因、探针调度
    ├── data/bank/          #   内置指纹基准库（随仓库发布）
    └── data/runtime/       #   档案与会话（运行时生成，勿提交）
```

---

## 🚀 部署

三站共用一套 PHP 环境，把整个仓库放到**站点根目录**即可。只想要其中一个，也可以单独把对应子目录放上去。

### 步骤

1. **建站**：宝塔 →【网站】→【添加站点】，PHP 选 **7.4 或以上**，站点根指向本仓库根目录。
2. **装扩展**：`【软件商店】→ PHP →【安装扩展】`，安装 **curl**（必装）与 **openssl**。
3. **填配置**：三个站各自复制一份模板为真实配置文件（模板本身不含任何密钥）：
   ```bash
   cp check/api/config.example.php      check/api/config.php
   cp iq/iq-config.example.php          iq/iq-config.php
   cp modeltrace/api/config.example.php modeltrace/api/config.php
   ```
   全部留空也能跑：`check` 的 AI 总结会回退成本地规则，`iq` 的 AI 总结按钮不可用，`modeltrace` 的采集台无法登录（前台检测不受影响）。
4. **给写权限**：确保各站的数据目录对 PHP 可写（755，属主为运行用户）：
   ```
   check/data/          iq/data/          modeltrace/data/runtime/
   ```
5. **配伪静态**：把 [`nginx-伪静态.conf`](./nginx-伪静态.conf) 里 `server{}` 内的段落粘进【站点设置 → 伪静态】。
   不配也能用，但**分享短链会退化成长链接**，且 `data/` 下的运行数据可能被直接下载。
6. **申请 SSL**：Key 走网络，建议强制 HTTPS。
7. **访问**：浏览器打开 `https://你的域名/`，从总入口进入三个站。

### 只部署其中一个

把对应的子目录当成站点根上传即可，此时：

- `check/` 内部没有任何对上级目录的依赖，可独立运行；
- `iq/` 与 `modeltrace/` 的导航下拉会去 `../nav-drop.js` 取脚本，缺了它只是**没有下拉菜单**，检测功能不受影响；
- `modeltrace/` 复用 `../check/assets/qrcode.min.js` 生成二维码，缺了它报告页的二维码不显示，其余正常。

---

## ⚙️ 配置要点

三个站的配置键不同，下面只列最容易踩的：

| 文件 | 键 | 说明 |
| --- | --- | --- |
| `check/api/config.php` | `GLM_KEY` | 智谱 GLM，用于「生成 AI 总结」；留空回退本地规则 |
| | `OFFICIAL_COUNT_KEY` | （可选）Anthropic 官方 key，用于精确核对 token 计费与思考签名回放核验 |
| | `SITE_NAME` / `SITE_URL` | 分享报告页的品牌位与回链地址 |
| `iq/iq-config.php` | `JUDGE_KEY` / `JUDGE_MODEL` | 视觉裁判模型，必须**支持读图**；留空则 AI 总结不可用 |
| | `IQ_DATA_DIR` | 分享报告目录，留空用 `iq/data` |
| `modeltrace/api/config.php` | `MT_ADMIN_PASSWORD_HASH` | 采集台口令的 bcrypt 哈希（不是明文）；留空则采集台无法登录 |
| | `MT_DATA_DIR` | 运行时目录，留空用 `modeltrace/data/runtime` |

> 生成哈希：`php -r "echo password_hash('你的密码', PASSWORD_DEFAULT), PHP_EOL;"`

**配置文件一律不要提交。** 仓库的 `.gitignore` 已经排除了三个站的真实配置与数据目录；如果你新增了配置项，请同步更新对应的 `*.example.php`。

---

## 🧪 测试

三站的测试都是「不联网、不开浏览器」的纯本地测试，需要 Node 18+ 与 PHP 8：

```bash
# check：协议解析、特征识别、签名判据、UI 逻辑
node check/tests/openai_signals.test.mjs
node check/tests/sig_batch_ui.test.mjs
php  check/tests/sig_verify_judge.test.php

# modeltrace：指纹建库、归因引擎、传输层、分享接口
node modeltrace/tests/bank_builder.test.mjs
node modeltrace/tests/engine_parity.test.mjs
node modeltrace/tests/transport_runner.test.mjs
php  modeltrace/tests/share_api.test.php
```

`modeltrace` 的 `engine_parity.test.mjs` 会与上游原版逐位对拍 —— 改归因算法后务必跑它。

---

## 🙏 致谢

- [veridrop](https://github.com/canarybyte/veridrop)、[claude-detector](https://github.com/7836246/claude-detector) —— `check` 的检测思路参考
- [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace)（MIT）—— `modeltrace` 的归因算法与初始指纹库
- [hanlinwenyuan/hlwy-ai-checker](https://github.com/hanlinwenyuan/hlwy-ai-checker) —— 「用随机数偏好识别渠道」的思路来源
- [Simon Willison 的 pelican-bicycle 基准](https://github.com/simonw/pelican-bicycle) —— `iq` 的题目灵感

---

## 📄 License

[MIT](./check/LICENSE)。三个站的检测结论都是**统计推断**，不构成任何担保，也不建议作为纠纷证据使用。
