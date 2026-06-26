<div align="right">

**简体中文** | [English](./README_EN.md)

</div>

<div align="center">

# 🛡️ 御三家 API 真伪检测站

### 一键鉴别 Claude / OpenAI / Gemini 中转站真伪

掺假冒充、协议篡改、能力降级、隐藏提示词注入 —— 逐项可见、有理有据。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![PHP](https://img.shields.io/badge/PHP-7.4%2B-777BB4.svg)](https://www.php.net/)
[![Frontend](https://img.shields.io/badge/Frontend-Vanilla%20JS%20(ESM)-f7df1e.svg)](#-技术栈)
[![No Build](https://img.shields.io/badge/Build-Zero%20config-success.svg)](#-快速开始)

</div>

---

## 📖 这是什么

很多人用「中转站 / 镜像站 / API 聚合」来访问 Claude、OpenAI、Gemini，但你很难知道对方给你的到底是：

- **真模型** 还是 **便宜小模型冒充**（例如拿 GPT-3.5 假装 Claude Opus）；
- 是否在 **篡改协议**（剥离工具调用、伪造思考链、吞掉系统提示）；
- 是否在 **token 计费上造假**；
- 是否在你的请求里 **偷偷注入隐藏提示词**。

本项目是一个**公益的、在浏览器本地运行**的检测站：填入你的中转站地址、Key、模型名，一键发起一整套探针请求，从**渠道来源、密码学签名、协议结构、推理智商、token 计费**等多个维度交叉验证，最终给出**加权评分 + 真伪判定 + 人话报告**，并支持**生成可分享的链接 / PNG 图片**。

> 🔒 **隐私优先**：所有特征判定逻辑**全部前端开源、在你本地运行**。我们**不在云端保存你的 API Key 或检测数据**，请求记录仅存于你本地浏览器。后端 PHP 仅做一次性请求转发以绕过浏览器跨域限制，**不落库**；只有当你**主动点「分享报告」**时，报告才会上传以生成短链。

---

## ✨ 核心特性

| 特性 | 说明 |
| --- | --- |
| 🎯 **御三家全覆盖** | 同一界面检测 Claude（Anthropic）/ OpenAI / Gemini 三种协议 |
| ⭐ **思考签名验证** | 校验 Claude 思考链的**服务端密码学签名**（中转站无法伪造）—— 最强证据 |
| 🧬 **协议污染检测** | OpenAI 端响应里若混入 `claude_*` 等字段，直接判定套壳冒充 |
| 🧠 **推理智商题库** | 12 道精选中文逻辑/陷阱题，区分真旗舰与便宜小模型蒙混 |
| 💉 **隐藏提示词注入检测** | 故意不发 system，让模型自爆中转层偷偷塞进来的系统提示 |
| 💰 **Token 计费核对** | 长短请求增量比对，可选接官方 `count_tokens` 精确核验 |
| 📊 **加权评分 + 硬否决** | 多维加权打分；命中严重异常（CRITICAL）直接封顶评级 |
| 🛠️ **自动 / 手动双模式** | 自动跑全套探针，或手动粘贴响应 JSON 做特征识别（内置特征识别的迷你 Apifox） |
| 🤖 **AI 人话总结** | 可接入智谱 GLM 生成简明中文结论（未配置则回退本地规则） |
| 🔗 **一键分享报告** | 生成短链或静态链接，报告页支持导出带品牌水印的 PNG |

---

## 🔬 检测原理

检测站通过**主动发起探针请求 + 被动解析响应特征**两类手段，对响应进行多维度交叉验证：

| 维度 | 原理 |
| --- | --- |
| **渠道识别** | 看响应 `id` 前缀：`msg_` = Anthropic 直连、`msg_bdrk_` = AWS Bedrock、`msg_vrtx_` = Google Vertex（均为真 Claude）；出现 `chatcmpl-` = 疑似 OpenAI 套壳 ⚠️ |
| **思考签名**（最强） | 真 Claude 的思考链带服务端密码学签名 `signature`，长且为合法 base64，**中转站无法伪造** |
| **协议污染** | OpenAI 端响应的 `usage` 里若出现 `claude_*` / Gemini 计数字段 = 套壳冒充 |
| **结构与规范** | 校验 `id` / `type` / `stop_reason` / `usage` 等字段是否符合官方 schema，工具 id 是否为 `toolu_` 前缀 |
| **能力一致性** | 同一请求多次发送，比对模型名稳定性与输出 token 方差（变异系数 CV），识别「轮询多模型」 |
| **智商与知识** | 逻辑陷阱题 + Anthropic 事实题，识别便宜小模型冒充旗舰 |
| **计费真实性** | 长短 prompt 的 token 增量是否合理；可选与官方 `count_tokens` 精确比对 |
| **流式真实性** | 校验 SSE 事件顺序（`message_start` 起、`message_stop` 止）、流式/非流式结果一致性 |
| **缓存行为** | 两轮同请求是否出现「创建→命中」的官方 prompt caching 行为 |

> **打分逻辑**：各探针按权重加权平均得到综合分。评级分四档 —— **高度可信 (≥85) / 基本可信 (≥70) / 存疑 (≥50) / 不可信 (<50)**。一旦命中**严重异常（CRITICAL）**（如 id 前缀套壳、思考签名缺失、身份冒充、隐藏提示词注入），评级最高只能为「存疑」，实行**硬否决封顶**。

---

## 🧪 检测项一览

### 🟠 Claude（Anthropic）—— 23 项探针

| 探针 | 权重 | 档位 | 说明 |
| --- | :---: | :---: | --- |
| 渠道来源识别 | 5 | Q/S/F | 按 `id` 前缀判定渠道来源 |
| 身份识别 | 5 | Q/S/F | 问「你是谁」，检查是否暴露竞品身份或被换弱模型 |
| **思考签名验证 ⭐** | **25** | Q/S/F | 验证思考链密码学签名（最强证据，无法伪造） |
| 消息 ID 规范 | 5 | Q/S/F | `id` / `tool_use.id` 等是否符合官方格式 |
| 协议规范 | 5 | Q/S/F | 响应结构 / `usage` 新结构是否合法 |
| 一致性（模型/稳定性） | 10 | Q/S/F | 多次请求模型名稳定、输出方差合理 |
| 结构化输出（tool_use） | 12 | S/F | 强制工具调用，校验结构化结果与 `toolu_` id |
| 结构化输出（JSON Schema） | 10 | S/F | 按复杂 JSON Schema 输出并校验字段合规 |
| 工具调用+复杂Schema+SSE | 10 | S/F | 工具 + 复杂 Schema + 流式三合一 |
| 流式事件顺序 | 6 | S/F | 校验 SSE 事件序列与顺序 |
| 行为指纹 | 15 | S/F | 加粗/列表等典型表现是否符合官方 |
| 推理/智商题 | 10 | S/F | 12 道中文逻辑陷阱题 |
| 知识准确度 | 10 | S/F | Anthropic 相关事实题 |
| 系统提示词遵从 | 8 | S/F | system 指令是否被中转层吞掉 |
| **隐藏提示词注入** | 12 | S/F | 检测中转层是否偷偷注入系统提示 |
| 多轮对话记忆 | 6 | S/F | 历史上下文是否完整透传 |
| 联网搜索能力 | 8 | S/F | 官方 web_search 结构是否完整 |
| 多模态（PDF/图片） | 8 | S/F | 是否真正具备图片理解能力 |
| 流式/非流式一致 | 5 | S/F | 两种模式结果是否一致 |
| Prompt 缓存行为 | 8 | S/F | 两轮请求是否「创建→命中」缓存 |
| Token 计费 | 10 | S/F | 长短请求 token 增量是否合理 |
| 错误参数报错 | 5 | S/F | 非法参数是否返回标准 Anthropic 错误结构 |
| 长上下文真实性 | 15 | F | 大文本暗号回捞（防上下文截断） |

### 🔵 OpenAI —— 6 项探针

基础可用 · 模型一致性（防掺假） · **协议规范 + 污染检测** · 函数调用 · 结构化输出 · Token 计费

### 🟢 Gemini —— 6 项探针

基础可用 · 模型一致性 · 协议规范 · 函数调用 · 结构化输出 · Token 计费

> 不同检测深度运行不同数量的探针：**快速 (Q)** 只跑最核心几项、**标准 (S)** 覆盖绝大多数、**完整 (F)** 额外加上耗时较高的长上下文真实性等。深度越高越准，但耗费的 token 也越多。

---

## 🏗️ 架构与目录

```
check/
├── index.html              # 主界面（自动检测 / 手动检测 双视图）
├── report.html             # 可分享的报告页
├── assets/
│   ├── app.css             # 样式
│   ├── app.js              # 主运行器：串起协议 / 探针 / UI / 打分 / 分享
│   ├── core.js             # 通用引擎：代理请求 / SSE 解析 / Schema 校验 / 打分 / 导出
│   ├── report.js           # 报告页渲染
│   ├── icons/              # 各协议图标（svg）
│   └── protocols/
│       ├── anthropic.js    # Claude 协议探针集（23 个）
│       ├── openai.js       # OpenAI 协议探针集（6 个）
│       └── gemini.js       # Gemini 协议探针集（6 个）
├── api/                    # 轻量 PHP 后端（仅转发，不落库）
│   ├── _common.php         # ⚙️ 全部配置集中在此（Key / 品牌 / 超时）
│   ├── probe.php           # 转发探针请求（绕过浏览器跨域）
│   ├── summary.php         # 调用智谱 GLM 生成人话总结
│   ├── share.php           # 保存 / 读取分享报告短链
│   └── count.php           # （可选）官方 count_tokens 精确核对
└── data/                   # 分享报告存储目录（需写权限）
```

**数据流**：浏览器前端 → `api/probe.php`（仅转发，绕过 CORS）→ 目标中转站 → 原样回传 → 前端本地解析、打分、渲染。Key 只在「你的浏览器 ↔ 转发代理」之间一次性使用，不写入任何数据库。

---

## 🛠️ 技术栈

- **前端**：原生 JavaScript（ES Modules），**零构建、零框架、零依赖**，浏览器直接运行。
- **后端**：PHP 7.4+（仅 `curl` 转发与可选 GLM 调用），任意支持 PHP 的虚拟主机 / 宝塔即可部署。
- **可选服务**：智谱 GLM（AI 人话总结）、Anthropic 官方 `count_tokens`（精确计费核对）、html2canvas（PNG 导出）。

---

## 🚀 快速开始

```bash
git clone https://github.com/aabao325/check.git
```

### 方式一：宝塔面板（推荐，全程图形界面）

1. **建站**：宝塔 →【网站】→【添加站点】，PHP 版本选 **7.4 或以上**，把整个 `check/` 目录上传到站点根目录。
2. **装扩展**：【软件商店】→ 你的 PHP →【安装扩展】，安装 **curl**（必装）与 **openssl**。
3. **填配置**：编辑 `api/_common.php`（详见下方）。
4. **给写权限**：把 `data/` 目录权限设为 **755**（属主可写），用于保存分享报告。
5. **申请 SSL**：【SSL】→【Let's Encrypt】，建议开启强制 HTTPS（Key 走网络）。
6. **访问**：浏览器打开 `https://你的域名/index.html`，右上角圆点变绿即为后端正常。

> 更详细的图文步骤见仓库内 [`部署说明.md`](./部署说明.md)。

### 方式二：任意 PHP 环境

将 `check/` 目录置于任意 PHP 7.4+ 站点根目录，确保 `curl` 扩展开启、`data/` 可写即可。本地自用可不开 HTTPS。

---

## ⚙️ 配置说明

打开 `api/_common.php`，修改顶部常量：

```php
// 智谱 GLM —— 用于「生成 AI 总结报告」。去 https://open.bigmodel.cn/ 申请（有免费额度）。
// 留空也能用，AI 总结会回退成本地规则文字。
const GLM_KEY   = 'sk-xxx';
const GLM_MODEL = 'glm-4.7-flash';

// （可选）Anthropic 官方 count_tokens 的 key，用于精确核对 token 计费造假；没有就留空。
const OFFICIAL_COUNT_KEY = '';

// 品牌广告位 —— 显示在分享报告页顶栏、页脚和导出的 PNG 水印上。
const SITE_NAME   = '公益 AI 检测站';
const SITE_URL    = 'https://your-site.example.com';
const SITE_SLOGAN = '一键鉴别 Claude / OpenAI / Gemini 中转站真伪';
```

> 此外，前端 `assets/app.js` 顶部的 `REPO_URL` / `ISSUE_URL` 已配置为本仓库地址（用于页脚链接与「反馈题目」入口）；如需 fork 自用可改为你的仓库。

---

## 📋 使用流程

1. 顶部选择协议（**Claude / OpenAI / Gemini**）。
2. 填写**接口地址、API Key、模型名**，选择检测深度（**快速 / 标准 / 完整**）。
3. 点击「**🟢 开始检测**」，自动发起整套探针请求并逐项给出真伪判定。
4. 每个检测项并排展示【请求体（可改）/ 响应体 / 特征 / 差异】，结果一目了然。
5. 点「**🤖 生成 AI 总结**」得到人话报告；点「**🔗 分享报告**」生成可发给别人的链接。
6. 分享报告页右上角可「**导出 PNG 图片**」（带品牌水印），适合发群。

> 🛠️ **手动检测**：若你已有一段响应、不想自动发请求，可切到「手动检测」视图，直接粘贴响应 JSON 做特征识别 —— 等价于一个内置特征识别的迷你 Apifox。

---

## ❓ 常见问题

<details>
<summary><b>右上角圆点显示「后端未连接」？</b></summary>

`api/` 目录未上传，或 PHP 未安装 `curl` 扩展。先单独访问 `api/probe.php?action=ping`，正常应返回 `{"service":"ai-detector","ok":true,...}`；或访问 `api/probe.php?action=diag` 查看诊断。
</details>

<details>
<summary><b>某检测项报「目标地址连接失败」？</b></summary>

目标中转站可能拒绝服务器代理、地址写错、或超时。更换地址重试。
</details>

<details>
<summary><b>AI 总结提示未配置？</b></summary>

`api/_common.php` 里 `GLM_KEY` 还是 `sk-xxx`，填上真实的智谱 GLM key 即可。
</details>

<details>
<summary><b>分享提示「静态链接」？</b></summary>

`data/` 目录不可写。按部署步骤给 755 权限即可；不改也能用，只是分享网址较长（报告被压进了 URL hash）。
</details>

<details>
<summary><b>我的 API Key 安全吗？</b></summary>

Key 只在你本地浏览器与转发代理之间使用，<b>不写入任何数据库</b>。代理仅做一次性转发以绕过浏览器跨域限制。介意的话也可以用「手动检测」：完全不发请求，只分析你贴进来的响应。
</details>

<details>
<summary><b>智商 / 推理题能新增吗？</b></summary>

题库由站点统一维护、写死在代码里（不开放用户自行添加，以防被针对性「刷题」绕过）。但**非常欢迎反馈题目建议**，请到开源仓库提 Issue。
</details>

---

## 🔒 透明度声明

- 本站特征判定逻辑**全部前端开源、本地运行**，**不保存你的 Key 与检测数据**。
- 后端 PHP 仅做一次性请求转发（绕过浏览器跨域），**不落库**。
- 仅当你**主动点「分享报告」**时，报告内容才会上传以生成短链。
- 本站为公益项目，**不对检测结论作任何担保**，仅供自查参考。

---

## 🙏 致谢

思路参考并致谢以下开源项目：

- [veridrop](https://github.com/canarybyte/veridrop) —— 探针权重与阈值设计思路。
- [claude-detector](https://github.com/7836246/claude-detector) —— Prompt 缓存、流式顺序、隐藏提示词等探针借鉴。

---

## 🤝 贡献

欢迎提交 Issue 与 Pull Request：题目建议、新探针、新协议支持、UI/文档改进都非常欢迎。

---

## 📄 License

本项目基于 [MIT License](./LICENSE) 开源。
