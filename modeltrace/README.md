# 大模型归因检测（modeltrace）

填 Base URL、API Key、模型名，判断中转站背后到底是不是你买的那个模型。

- 前台：[index.html](index.html)——任何人可用，纯前端计算，请求由浏览器直连目标接口
- 采集台：[admin.html](admin.html)——管理员用，密码保护；给中转站建档、给新模型建指纹

## 原理

让模型「凭第一反应」写约 300 个 1~355 的整数。模型不是真随机源：它偏爱哪些数字、在序列哪个位置偏大偏小，由权重决定、稳定可复现，而且各模型偏法不同——这串数字就是指纹。

| 步骤 | 做法 |
| --- | --- |
| 特征 | 355 维 Hellinger 特征（分布形状，权重 0.75）+ 74 维有序块特征（4 段 × 16 桶 + 末位数字，排列顺序，权重 0.25） |
| 去干扰 | 建库时用 12 种「环境」（中 / 英 / JSON 问法 × 0/96/512/2048 词的系统提示或用户前缀）估出环境偏移，SVD 取前 2 个主方向投影掉 |
| 归因 | 与每个模型的质心比相似度 → z 分 → 按有效回答数选交叉验证拟合的温度 β → softmax 得闭集概率 |
| 结论 | `match` 一致 / `mismatch` 疑似替换（第一候选 ≥0.8、声称 ≤0.15、差 ≥0.65）/ `split` 回答分歧 / `inconclusive` 存疑 |

**`split`（回答分歧）是本站加的**：3 份回答的 β≈12，合并概率会被放大到近乎 one-hot，哪怕三份各指一个模型也可能显示 99.9%。这正是多模型轮询 / 混合路由的典型表现，所以多数回答不指向同一模型时，结论降级。

前台流程：生成 6 条随机探针 → **前 3 条同时起飞**，从共享队列领任务 → 凑满 3 份有效回答（≥80 个数字且 ≥ 请求量 55%）即停，作废一条就补下一条（最多用到 6 条）。鉴权 / 模型名 / 网络 / 限流错误立即停止，不白烧额度。

协议怎么定（不再单跑一条探路）：按 Base URL 猜一个默认值（结尾是 `/messages` 用 Anthropic，其余用 OpenAI），三条探针共用它直接开跑 —— 绝大多数中转站两种协议都提供，为「不确定用哪种」先花一整次请求探测纯属白等一次往返（整轮耗时从 2× 变 1×）。
**兜底**：万一整轮一份都没成功、且失败原因**全部**是「格式不对」，说明猜错了 —— 换另一种协议把前几条重跑一遍（那条探针上一轮一个字节正文都没产出，重跑不构成「两份回答重复」）。只要有任意一条成功过就认定猜对，不再回头换；失败里混着鉴权 / 模型名 / 超时这类错误时不重跑（换了也救不了，只是白烧额度）。

前台另有右侧悬浮栏（配置库 + 检测历史，仅存 localStorage）与结果分享：点分享会现场问一次「中转站地址要不要公开」，然后把快照传给 `api/share.php` 换一个短链（`/s/xxxxxxxxx`，整条约 40 字符），由 `report.html` 按 id 读回来渲染。
分享链接**同一份报告复用同一个**：后端在落盘文档里存一个内容哈希 `_h`，再次分享时先按它扫一遍已有报告，命中就返回原来那条的 id（接口返回 `reused:true`），不会堆出内容相同的副本，也不刷新 mtime（免得旧报告永远轮不到被回收）。前端还会在 localStorage 里记一份「本地记录 id → 短链」，命中就不必再往返服务器。
报告页与站内弹窗都带「导出 PNG」，截的就是分享链接打开时看到的那一块（含两张分布图与二维码）。两条路径的**构图边界必须在同一处**：二维码块原先挂在站内弹窗的分享面板里（在截图边界之外），于是站内导出的图片底部永远没有二维码、而分享页那条有 —— 转贴出去就断了「看图 → 扫码看报告」的路。现在二维码块属于两条路径共有的截图内容，未生成分享链时指向检测站首页（「扫码自己测一测」），生成后换成这份报告的链接。
导出时容器会**临时补 28px 内边距**（`png.js` 的 `EXPORT_PADDING`）：留白原本做在容器外面（分享页是 `.share-wrap` 的 24px、弹窗是 `.detail-body` 的 16px），而 html2canvas 只截元素自身，元素外的留白一律不进图 —— 表现是页面正常、导出的图片四角贴边。留白只在导出那一刻加、截完立刻还原，不写进样式表（否则页面上会凭空多出一圈空隙）。

分享页会连**两个分布图**（指纹叠印 / 指纹罗盘）一起展示 —— 它们比结论卡更能说明问题。图不是在分享时算好存下来的，而是报告页**用快照里的原始数字 + 它自己 fetch 到的指纹库现算**：随分享走的只有每份回答那 300 个数字（约 3KB），18 个模型的基准分布（约 150KB）复用仓库里的 `data/bank/unified_bank.json`。代价是指纹库更新后旧分享重算出的曲线会与当初略有差异，所以图旁标了基准库版本。

**归因概率榜单全页只出现一次**，在报告卡里（标题就叫「归因概率」）：它原本被两张图的侧栏各复制了一份，加上报告卡一共三处，既重复又把两张图挤窄。现在两张图的侧栏各自只讲自己独有的东西 —— 叠加图说分布贴合度，罗盘说投票矩阵。分享页宽度也与站内正文对齐（`--maxw` 1120px），不再另给一个窄值。

**分享是本站唯一会写服务器的环节**：检测请求一律浏览器直连（CORS 拦路时走 `iq-proxy.php` 流式转发、不落盘），检测历史只在本机。只有你点「生成并复制链接」并确认后，这份归因快照才会存到站点根 `data/modeltrace/shares/<id>.json`。

为什么不像原来那样把快照塞进 URL：整份快照 base64 后约 1100~1300 字符，微信 / QQ 里会被折叠或直接截断，二维码也密到扫不动（原先只能退化成「扫码去首页」）。短链是分享能传播的前提，代价就是上面那一次落盘。

**URL 口径由分享者当场决定**，默认只留域名：报告页会被陌生人打开，而 Base URL 是「你从哪家买的」这类身份信息。选「完整地址」才会把 path 一起存下来（报告页的「检测站点」一栏随之显示完整地址）。服务端不信客户端传来的口径 —— 声称 host 时它自己从 URL 里重新解析出 host 覆盖掉，绕过前端直接 POST 也存不进 path 与查询串。

## 目录

```
modeltrace/
├── index.html / admin.html
├── assets/
│   ├── engine/              纯逻辑，无 DOM，可 node --test
│   │   ├── fingerprint.js   评分 / 归因 / 模型名匹配 / 结论分级
│   │   ├── bank-builder.js  浏览器内建库（含交叉验证与 β 拟合）
│   │   ├── challenges.js    前台随机探针 + 36 条固定建档套件
│   │   ├── transport.js     两种格式的请求、流式解析、错误归类、CORS 兜底
│   │   ├── runner.js        前台「凑 3 份」编排 + 建档并发采集
│   │   └── linalg.js        Jacobi 特征分解 / SVD
│   ├── viz.js               结论卡 + 指纹叠印 + 指纹罗盘（含投票矩阵）
│   ├── app.js / admin.js / bank-worker.js
│   └── styles.css / admin.css
├── api/
│   ├── admin.php            采集台后端（登录 / 档案），需密码
│   └── share.php            分享报告存/读，**匿名可写** —— 四件套闸门见下
├── data/bank/               ← 指纹库，随仓库提交
│   ├── unified_bank.json    当前指纹库（前台读这个）
│   ├── reference.json       建库原料：每个模型 36 条回答的数字序列
│   └── LICENSE-ModelTrace.txt
├── data/runtime/            运行时数据（默认位置，生产建议迁到站点根 data/modeltrace）
│   ├── archives/            中转站档案    sessions/  管理员会话
│   ├── attempts.json        登录失败计数  rate.json  限流计数
│   └── shares/              分享出去的归因报告（<id>.json，含每份回答的原始数字）
└── tests/
```

## 指纹库与来源

初始库与参考数据来自 [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace)（MIT，见 [LICENSE-ModelTrace.txt](data/bank/LICENSE-ModelTrace.txt)）：18 个模型，**GPT 采集自官方 Codex 订阅，Claude 采集自第三方中转 OAIPro**（非官方直连，可能混入该中转的特征）。

### 加一个新模型

1. 采集台「① 采集」：接口类型选**官方直连**，跑满 36 条，保存档案
2. 「③ 指纹库」：勾选该档案，填模型 id / 家族，点「重建指纹库」（浏览器 Worker 内跑完整交叉验证）
3. 对比新旧库的交叉验证准确率；下载 `unified_bank.json` 与 `reference.json`，覆盖 `data/bank/` 后提交

指纹库**不**经后端发布：它决定所有访客看到的结论，走仓库提交才可审查、可回滚，管理员密码泄露也改不了线上结论。

`bank-builder.js` 用原作者全部 648 条参考回答重建，与其 numpy 建出的 `unified_bank.json` 对拍（质心误差 <1e-8、β 与交叉验证命中数完全一致），见 `tests/bank_builder.test.mjs`。

## 部署

1. 前台是纯静态的，传上去即可用。CORS 兜底复用 [../iq/iq-proxy.php](../iq/iq-proxy.php)（流式转发，不撞 Cloudflare 100s 超时），需同站部署 `iq/`。
2. 采集台需要 PHP 7.4+：复制 `api/config.example.php` 为 `api/config.php`，填密码哈希：
   ```bash
   php -r "echo password_hash('你的密码', PASSWORD_DEFAULT), PHP_EOL;"
   ```
3. **nginx 必须挡住运行时数据**（档案里含中转站 Base URL、会话令牌哈希在运行时目录里，nginx 命中静态文件时根本不经过 PHP）。采集台的默认目录是 `modeltrace/data/runtime/`；放在仓库里部署时，直接用根目录 [`nginx-伪静态.conf`](../nginx-伪静态.conf) 的第 1 节（按 `/<项目>/data/` 匹配，三站共用一条）：
   ```nginx
   location ~ ^/(check|iq|modeltrace)/data/ { deny all; return 404; }
   location ~ ^/(check|iq|modeltrace)/tests/ { deny all; return 404; }
   ```
   ⚠ 旧规则 `^/(data|tests)/` 只在「把 `check/` 当站点根」时有效；三站并入同一仓库后匹配不到 `/modeltrace/data/`。
   更稳的做法是把 `MT_DATA_DIR` 指到网站根目录之外 —— 那样连 nginx 规则都不依赖。
4. 后端闸门（`api/_common.php`，可用同名环境变量覆盖）：请求体 512KB、单档案 400KB、档案上限 300、每 IP 每分钟 60 次、连续输错 5 次锁 15 分钟（先查锁再比哈希）。档案字段白名单里没有 API Key。
5. 分享端点（`api/share.php`）是本站**唯一无需登录的写入端点**，四件套闸门都在：请求体 512KB（`mt_read_json`）、单档 128KB（`MT_MAX_SHARE_BYTES`）、总数 1000（`MT_MAX_SHARES`）、按 IP 限流（`mt_rate_limit('share')`）。超量时**删最旧的**而不是拒绝新写入 —— 匿名端点上拒绝惩罚的是正常分享者。归档 id 形如 `a<9位 base36 随机码>`（共 10 字符）。**为什么是随机的而不是内容哈希**：id 每一位都直接顶到读者眼前（链接要发进微信群），28 位的哈希 id 让整条链接到 70 字符；缩短后「同一份报告复用同一个链接」改由文档里的 `_h`（清洗后文档的 sha256）显式查重实现，效果一样，链接短一半。回收排序按文档里的 `_c`（毫秒创建时间），不靠文件 mtime —— `stat` 只有秒级精度，同一秒内的多份会退化成按随机码排序。旧的「27 位哈希」「时间戳 + hex」形状仍在 id 白名单里，线上老链接不失效。
6. **分享短链需要一条 nginx 重写**（`/modeltrace/s/<id>` → `report.html`，规则见仓库根 [`nginx-伪静态.conf`](../nginx-伪静态.conf) 第 3 节），漏配的表现是「新分享的链接 404」，而报告数据本身完好 —— 别去查数据。`report.html` 头部那段内联脚本负责按当前路径写 `<base>`：`/modeltrace/s/<id>` 这一层的目录深度与 `report.html` 不同，不给基准路径的话页面里的 `./assets/...` 会解析到 `/modeltrace/s/assets/...`（全站白屏）。同一原因，`store.js` 的后端地址用 `new URL('../api/share.php', import.meta.url)` 而非相对字符串。

## 改前端代码时：版本串必须一起改

`assets/` 下的模块 import 都带版本串（`from './viz.js?v=8'`），HTML 入口也同样（`app.js?v=8`）。这不是装饰，是同站 `check/` 一直在用的规范，理由是浏览器按**完整 URL** 缓存 ES 模块：

- 入口升了版本、被 import 的模块没升 → 浏览器拿**旧的模块**配上**新的入口**，报出来的是
  `The requested module './viz.js' does not provide an export named 'renderSnapshotCard'`。
  一个纯粹的缓存错配被报成「导出缺失」，从报错本身完全看不出原因。
- 更隐蔽的一种：**同一个模块被加载成两个实例**。`runner.js` 里是 `transport.js?v=5`、
  测试里是 `transport.js`，于是出现两个 `class ProbeError`，`e instanceof ProbeError`
  对不上，`kind` 变成 null —— 报错点离原因很远。
- 还有一种是**同一份代码里新旧版本混用**：`viz.js` 引 `fingerprint?v=5`、`app.js` 引
  `?v=6`，`fingerprint.js` 就被解析成两个实例，跨实例传的对象/类判断全部失效。
  **所以规矩是「全站同一版本号」，不是「每个文件各自计数」。**

**改完怎么升**：把所有 `?v=N` 一把改成同一个更大的数（含 `tests/*.mjs`、`index.html` /
`report.html` / `admin.html` 的入口与 `assets/vendor/` 下的脚本）：

```bash
# 全站一把升到 v=9。注意替换用 sed 而不是带捕获组的写法 ——
# `\1` 后紧跟数字会被正则引擎当成组号 `\18`，静默错位、一处都改不动（踩过）。
cd modeltrace
grep -rl '?v=[0-9]' assets tests index.html report.html admin.html \
  | xargs sed -i -E 's/(\.(js|css))\?v=[0-9]+/\1?v=9/g'
# 顺手核一遍是不是只剩一个版本号
grep -rho '?v=[0-9]*' assets tests index.html report.html admin.html | sort -u
```

（本轮统一为 `?v=8`。）

## 测试

```bash
node --test modeltrace/tests/*.test.mjs       # 引擎对拍、探针套件、请求层、编排、建库（约 2s）
php modeltrace/tests/admin_api.test.php        # 起内置服务器测登录锁定 / 会话 / 档案闸门 / 限流
php modeltrace/tests/share_api.test.php        # 分享端点：URL 口径、字段白名单、体封顶、回收、限流
```

> 测试文件里的 import 也必须带同一个版本串，否则测试与待测模块会各加载一份，
> 类身份分裂、断言莫名为假（上面那个 `ProbeError` 的例子就是这么来的）。

## 局限

- 闭集：库外模型会被归到最像的库内模型，所以前台直接拒绝库外模型名
- 系统提示词会推偏分布：12 种环境只能削弱、不能消除；不要在 Claude Code / Cursor 这类自带长系统提示的客户端里测
- 交叉验证准确率是在建库环境内评估的，真实中转环境会更低
- 探针可被针对：前台每次随机句式与长度，但没法保证中转站识别不出
