/* =====================================================================
 * assets/store.js —— 配置库 / 检测历史 / 分享载荷
 * ---------------------------------------------------------------------
 * 与 check 检测站同一套产品口径，但数据结构按归因检测的需要裁剪：
 *   - 配置库：一条 = { label, baseUrl, model, key, protocol, customPath }，按「备注标签」去重覆盖，点击回填输入区。
 *   - 检测历史：一条 = 一次归因的完整快照（结论 + 概率 + 各份回答判定），点开弹窗看完整结果并分享。
 *   - 分享载荷：按需上传后端换短链（/s/xxxxxxxxx，整条约 40 字符）。**只有点「生成并复制」时才上传**，
 *     检测本身与历史记录一律不出浏览器。
 *
 * 为什么不再用 #data=<base64> 承载分享：整份快照压进 URL 约 1100~1300 字符，微信 / QQ 里会被
 * 折叠或直接截断，二维码也密到手机扫不出来（原先只能退化成「扫码去首页」）。短链是传播的前提。
 * 代价是分享的报告会落到本站服务器上 —— 所以 ① URL 口径交给分享者现场选（默认只留域名）
 * ② 弹窗里明说这件事，不靠用户自己推断。
 *
 * ⚠️ Key 只在「配置库」里出现，检测历史与分享载荷都不含 Key —— 这是页面上对用户的承诺。
 * ===================================================================== */

export const CFG_KEY = 'mt.savedConfigs.v1';
export const HISTORY_KEY = 'mt.history.v1';
/** 分享链接记忆：snapshot.id → { host: shortId, full: shortId }。
 *  后端已经按内容哈希做了复用（同一份报告必然算出同一个 id），这一层是**省掉那次请求**：
 *  链接已知就直接复制，不必再往返一次服务器。
 *  放独立 key 而不是塞进历史快照：历史条目是「导出/分享的载荷格式」，
 *  往里加字段会跟着快照一起进 URL / 上传，而链接记忆纯粹是本机便利数据。 */
export const SHARE_LINKS_KEY = 'mt.shareLinks.v1';
export const HISTORY_MAX = 30;

/* 站点地址：页脚与「复制站点地址」指向这里。用绝对地址，手机扫码才认。 */
export const SITE_URL = 'https://aabao.ai/modeltrace';
export const SITE_LABEL = 'aabao.ai/modeltrace';

/* 分享后端。
 *
 * ⚠️ 必须以**模块自身**为基准解析，不能写 './api/share.php'：相对字符串按**页面**地址解析，
 *    而分享链接现在形如 `/modeltrace/s/<id>`，那一层目录下 './api/...' 会变成
 *    `/modeltrace/s/api/...` —— 404，报告直接打不开。以模块 URL 为基准则永远指向
 *    assets/ 的上一层，页面在哪个路径下都成立（同一处理已在 charts.js 的指纹库地址上用过）。 */
const SHARE_API = new URL('../api/share.php', import.meta.url).href;

function read(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    return v == null ? fallback : v;
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }   // 隐私模式 / 配额满
}

/* ---------- 配置库 ---------- */
export function loadConfigs() {
  const a = read(CFG_KEY, []);
  return Array.isArray(a) ? a : [];
}
export function persistConfigs(list) { return write(CFG_KEY, list); }

/* 存一条配置：同标签视为「更新这一条」，而不是又加一条 —— 定期复检时同名站点不会被堆成十几行。
 * protocol / customPath 一并存下：同一家中转站的 chat 与 responses 是两个不同的接口，
 * 复检时路径丢了会打到错的地址上去。老配置没有这两个字段，读出来当 'auto' 处理。 */
export function saveConfig({ label, baseUrl, model, key, protocol = 'auto', customPath = '' }) {
  const list = loadConfigs();
  const item = { label, baseUrl, model, key, protocol, customPath, ts: new Date().toISOString() };
  const i = list.findIndex((x) => x.label === label);
  if (i >= 0) list[i] = item; else list.unshift(item);
  return persistConfigs(list) ? { ok: true, replaced: i >= 0, list } : { ok: false };
}
export function deleteConfig(index) {
  const list = loadConfigs();
  if (index < 0 || index >= list.length) return { ok: false, list };
  const [gone] = list.splice(index, 1);
  return persistConfigs(list) ? { ok: true, label: gone.label, list } : { ok: false, list };
}
export function renameConfig(index, label) {
  const list = loadConfigs();
  if (!list[index]) return { ok: false, list };
  list[index].label = label;
  return persistConfigs(list) ? { ok: true, list } : { ok: false, list };
}

/* ---------- 快照字段名对照 ----------
 * 快照存进 localStorage 又塞进 URL，字段名一律用短名（v/p/pr/rk/rs…），
 * 因为它是二维码的载荷。渲染层不该跟着一起记短名，所以在读取时统一「翻译」成一组长名。
 * 这里是唯一认识短名的地方；viz.js / app.js 只认长名。
 *   t→savedAt  u→baseUrl  m→model  c→claimed  v→variant  vd→verdict
 *   p→prob     pr→prediction  n→usedOutputs  a→attempts  f→formatName
 *   tot→totalNumbers  sim→similarity  rk→rank  rs→responses  pa→partial  px→viaProxy */
export function readSnapshot(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;
  // 已经是长名格式（未来若改回）也放行，避免旧记录直接崩掉。
  // ⚠️ opts.forceRaw 给「从后端读回来的分享报告」用：后端落盘时一定会带上 savedAt /
  // 格式版本号，光靠下面这个哨兵判断会把服务端文档误判成长名格式、整段翻译被跳过 ——
  // 表现是报告页结论空白、只剩「报告内容不完整」。调用方知道数据来源，就别让哨兵去猜。
  if (!opts.forceRaw && (raw.savedAt || raw.verdict)) {
    return {
      ...raw,
      endpoint: raw.endpoint || '',
      host: raw.host || hostOf(raw.baseUrl),
      rank: raw.rank || [],
      responses: raw.responses || [],
      // 走这条分支的是站内历史里的**长名**记录。它同样要能画图，所以图表原料也要有默认值 ——
      // 少了会让「站内历史」和「分享页」行为不一致（同一份报告两处长得不一样）。
      rawNumbers: raw.rawNumbers || [],
      bankBuiltAt: raw.bankBuiltAt || '',
    };
  }
  const url = raw.u || '';
  // endpoint = 完整的 Base URL，**只在分享者选了「完整地址」时才存得下来**：
  // 后端在 host 模式下会把 u 截成纯域名，此时 url 本身就没有路径，endpoint 与其相同、不必单独留。
  // 报告卡用「endpoint 存在且比 host 长」来判断该显示完整地址还是只显示域名。
  const endpoint = url && url !== hostOf(url) ? url : '';
  const idOf = (x) => (Array.isArray(x) ? x[0] : x && x.model);
  const pOf = (x) => (Array.isArray(x) ? x[1] : x && x.probability);
  const famOf = (id) => (String(id).startsWith('claude') ? 'claude' : String(id).startsWith('gpt') ? 'gpt' : String(id).startsWith('gemini') ? 'gemini' : 'models');
  return {
    id: raw.id,
    savedAt: raw.t,
    baseUrl: raw.u || '',
    host: hostOf(raw.u),
    endpoint: endpoint,
    model: raw.m || '',
    claimed: raw.c || raw.m || '',
    variant: raw.v || null,
    verdict: raw.vd || null,
    prob: raw.p,
    prediction: raw.pr,
    predictionName: '',
    usedOutputs: raw.n,
    attempts: raw.a,
    formatName: raw.f || '',
    totalNumbers: raw.tot,
    similarity: raw.sim,
    rank: (raw.rk || []).map((x) => ({ model: idOf(x), name: '', probability: pOf(x), family: famOf(idOf(x)), family_name: '' })),
    responses: (raw.rs || []).map((x) => ({ index: x[0], parsed: x[1], top: x[2], probability: x[3] })),
    // 图表原料原样透传：它不是渲染用的长名字段，而是「重算图表」的输入，
    // 由 report.js 交给引擎（analyzeOutputs）重新算一遍分布。旧分享没有这个字段 → 空数组 → 不画图。
    rawNumbers: (raw.rn || []).map((x) => ({ index: x[0], numbers: x[1] || [] })),
    bankBuiltAt: raw.bb || '',
    partial: !!raw.pa,
    viaProxy: !!raw.px,
  };
}

/* ---------- 检测历史 ---------- */
export function loadHistory() {
  const a = read(HISTORY_KEY, []);
  return Array.isArray(a) ? a : [];
}
export function persistHistory(list) { return write(HISTORY_KEY, list); }

/* 本地唯一 id：只用来定位删除，不含任何敏感信息 */
let seq = 0;
export function newId() {
  seq = (seq + 1) % 100000;
  return 'm' + Date.now().toString(36) + seq.toString(36);
}

/* 把一次归因结果压成一条快照。⚠️ 入参 data 里绝不能带 apiKey —— 由调用方保证。
 *
 * 字段刻意精简，只留「不能从 model id 推导出来」的字段：
 *   - 展示名（display_name / family_name）：由 id 现场推导，报告卡本来就只显示短名
 *   - host：由 baseUrl 推导
 *   - 每个候选的 family：由 id 前缀推导
 * 取舍标准是「它能不能被算出来」。
 *
 * 历史上这份快照还要 base64 进 URL、画成二维码，所以「精简」是硬约束（整条链 ~1965 字符
 * 时二维码就扫不动了）。现在分享走服务端短链，URL 不再承载快照，这个约束只对
 * localStorage 的 30 条历史仍然有效 —— 依旧不该往这里堆字段，但没有当年那么紧了。 */
export function buildSnapshot(data) {
  return {
    id: newId(),
    t: new Date().toISOString(),
    u: data.baseUrl || '',
    m: data.model || '',
    c: data.claimed || data.model || '',
    v: data.variant || null,
    vd: data.verdict,                            // { code, sameFamily }
    p: data.prob,                                // 声称模型被归因到的概率
    pr: data.prediction,
    n: data.usedOutputs,
    a: data.attempts,
    f: data.formatName || '',
    tot: data.totalNumbers,
    sim: data.similarity,                        // 分布贴合度（0~1）
    // 候选排名：只存 [模型 id, 概率]，其余现场推导
    rk: (data.rank || []).slice(0, 6).map((x) => [x.model, Number(x.probability.toFixed(4))]),
    // 每份回答：只存 [序号, 数字个数, 判定到的模型 id, 概率]
    rs: (data.responses || []).map((x) => [x.index, x.parsed, x.top, Number(x.probability.toFixed(4))]),
    // 图表原料：每份回答的**原始数字序列** [序号, [数字…]]。
    // 分享页要画「指纹叠印 / 指纹罗盘」，而那两个图需要的远不止上面的 Top 概率
    // （355 维实测分布、每份的 z 分、18 个模型的基准）。那些都能从原始数字 + 指纹库重算出来，
    // 而指纹库已随仓库提交、报告页自己 fetch —— 所以随分享走的只有这几 KB 原始数字。
    // 为什么存原始数字而不是算好的分布：库会更新（加模型、重建质心），派生数据的下标
    // 与当时的库绑定，用新库渲染就错位；原始数字永远能重算。
    rn: (data.rawNumbers || []).map((x) => [x.index, x.numbers || []]),
    bb: data.bankBuiltAt || '',                   // 建库时间：报告页标注基准版本用
    pa: !!data.partial,
    px: !!data.viaProxy,
  };
}

export function pushHistory(snap) {
  const list = loadHistory();
  list.unshift(snap);
  if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
  return persistHistory(list) ? list : null;
}
export function removeHistory(id) {
  const list = loadHistory().filter((x) => x.id !== id);
  return persistHistory(list) ? list : null;
}
export function clearHistory() { return persistHistory([]) ? [] : null; }
export function getHistory(id) { return readSnapshot(loadHistory().find((x) => x.id === id)); }
/* 原始（短名）快照，给需要拿它当二维码载荷的地方用 —— 见 app.js 的 openDetail。
   分享链必须走这个，不能拿 readSnapshot 翻译过的长名对象去 pack，那样链接会长一倍。 */
export function rawHistory(id) { return loadHistory().find((x) => x.id === id) || null; }

/* ---------- 小工具 ---------- */
export function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url || '').replace(/^https?:\/\//, '').split('/')[0]; }
}

/* ---------- 分享载荷 ----------
 * 提交给后端的是 buildSnapshot() 的**原始短名快照** —— 和历史上塞进 URL 的是同一份，
 * 所以后端白名单（api/share.php 的 mt_clean_snapshot）按短名字段校验。
 * 传长名对象进去会被白名单整条丢掉，报告页就只剩一个结论码。 */

/**
 * 生成短链：把快照交给后端换一个 id，返回可直接分享的地址。
 *
 * @param {object} snap     buildSnapshot() 的原始产物（短名）
 * @param {string} urlMode  'host' = 报告里只留域名；'none' = 完全不显示中转站地址
 * @returns {Promise<{url: string, id: string}>}
 * @throws  后端不可用 / 被限流 / 目录不可写时抛错，调用方要给出可读的失败提示
 *
 * ⚠️ urlMode 是**字符串**而不是布尔 —— 早先只有「完整地址 / 其余」两态时用的是
 *    `fullUrl` 布尔，第三个口径（none）一加就会被静默折叠成 host。
 *    取值范围由后端白名单收敛（非 host/none 一律按 host）。
 */
export async function createShare(snap, urlMode) {
  let res;
  try {
    res = await fetch(SHARE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot: snap, urlMode: urlMode === 'none' ? 'none' : 'host' }),
    });
  } catch {
    // 网络层失败（断网 / 站点没配 PHP / 跨域）—— 与业务错误分开说，用户才知道该找谁
    throw new Error('无法连接分享服务，请检查网络后重试');
  }
  let j = null;
  try { j = await res.json(); } catch { /* 非 JSON 响应（网关错误页等）*/ }
  if (!j || !j.ok || !j.id) {
    throw new Error(j?.error || `分享服务暂不可用（HTTP ${res.status}）`);
  }
  return { id: j.id, url: shareUrl(j.id) };
}

/** 分享短链地址：`<站点>/s/<id>`（例：https://aabao.ai/modeltrace/s/a1wi2z0rr）。
 *
 *  ⚠️ 用路径而**不是** `report?id=`：整条链接要发进微信群 / 短信，
 *     `report?id=` 光自己就多出 9 个字符，而短 id 的意义就是让整条链接短到能单行完整显示。
 *     `/s/<id>` 由 nginx 重写到 report 页（规则见 README 的「分享短链」一节）——
 *     没有那条规则时本链接会 404，部署时别漏。
 *
 *  ⚠️ 用无后缀路径：站点在反代后面时「.html → 无后缀」的 301 会把 https 降成 http。 */
export function shareUrl(id) {
  const base = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}s`;
  return `${base}/${encodeURIComponent(id)}`;
}

/** 从分享链接里取出 id。兼容三种写法：
 *    /s/<id>            新版短链（本函数主要服务的形状）
 *    report?id=<id>     上一版短链；线上已经发出去的链接，以及站内历史记忆里的旧值
 *    report.html?id=xx  带后缀的原始地址（本地直接打开文件时会出现）
 *  取不到就返回 null。 */
export function shareIdFromUrl(href) {
  let url;
  try { url = new URL(href, location.href); } catch { return null; }
  const q = url.searchParams.get('id');
  if (q) return q;
  // 路径末段：/modeltrace/s/<id> → id。用 /s/ 定位而不是「取最后一段」，
  // 是因为站点可能部署在子路径（/modeltrace/），裸取最后一段会把目录名当成 id。
  const m = url.pathname.match(/\/s\/([A-Za-z0-9]+)\/?$/);
  return m ? m[1] : null;
}

/* ---------- 分享链接记忆 ----------
 * 后端已按内容哈希复用（同一份报告 → 同一个 id），这里只是**省掉那次往返**：
 * 链接已知就直接拿出来复制，点分享是瞬时的，也不受网络影响。
 * 记的是「本地 id + 口径」这一对 —— 同一份报告在不同口径下内容不同、id 也不同
 * （后端按清洗后的文档算哈希），所以每个口径各记一条。
 *
 * ⚠️ 口径是**字符串**、直接当 key（'host' / 'none'）。早先这里是
 *    `rec[fullUrl ? 'full' : 'host']`，布尔只有两态，加第三个口径后
 *    「不显示地址」会跟「仅域名」共用同一个槽位 —— 拿到一条**口径错误的旧短链**：
 *    链接能打开，但报告里的地址口径是上一次选的。这种错不报错、只出错。

/** 取这条快照在某个口径下已经生成过的分享短链；没有则返回 null。
 *  @param {string} urlMode 'host' | 'none'（字符串直接当槽位 key，见上方注释） */
export function savedShareUrl(localId, urlMode) {
  if (!localId) return null;
  const map = read(SHARE_LINKS_KEY, {});
  const rec = map && map[localId];
  const id = rec && rec[urlMode === 'none' ? 'none' : 'host'];
  return id ? shareUrl(id) : null;
}

/** 记下这条快照的分享短链。写不进去（隐私模式 / 配额满）不算失败 —— 下次再上传一遍而已。 */
export function rememberShareUrl(localId, urlMode, shareId) {
  if (!localId || !shareId) return;
  const map = read(SHARE_LINKS_KEY, {});
  const next = (map && typeof map === 'object') ? map : {};
  const rec = next[localId] && typeof next[localId] === 'object' ? next[localId] : {};
  rec[urlMode === 'none' ? 'none' : 'host'] = shareId;
  next[localId] = rec;
  // 只留最近 200 条：这是个纯便利缓存，不值得让它无限长大把 localStorage 撑满。
  // 快照的 id 形如 m<base36 时间><序号>，字典序即时间序，所以排序后砍掉最前面的即可。
  const keys = Object.keys(next).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete next[k];
  write(SHARE_LINKS_KEY, next);
}

/** 读回一份分享报告。失败时抛错，由 report 页渲染成「打不开」提示。 */
export async function readShare(id) {
  let res;
  try {
    res = await fetch(`${SHARE_API}?id=${encodeURIComponent(id)}`, { cache: 'no-cache' });
  } catch {
    throw new Error('无法连接分享服务，请检查网络后重试');
  }
  let j = null;
  try { j = await res.json(); } catch { /* 见上 */ }
  // 400 = 编号形状就不合法（链接被编辑过 / 复制漏了字符）。这是**用户看得懂**的说法，
  // 不要把后端的 'bad id' 原样抛给前台 —— 那是给排查问题的人看的，不是给访客看的。
  if (res.status === 400) { throw new Error('这个报告编号不完整，链接可能在复制过程中被截断了。'); }
  if (res.status === 404) { throw new Error('这份报告不存在，链接可能输错了，或者它已被清理。'); }
  if (!j || !j.ok || !j.report) {
    throw new Error(j?.error || `报告读取失败（HTTP ${res.status}）`);
  }
  return j.report;
}

/** 这个失败「再试一次」有没有意义：网络/服务端问题值得重试，编号不对或报告不存在不值得。 */
export function isShareRetryable(message) {
  return !/不存在|不完整|已被清理/.test(String(message || ''));
}

/* 时间格式化成「MM-DD HH:mm」*/
export function fmtTime(iso) {
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return String(iso || '').slice(5, 16).replace('T', ' '); }
}
