/* =====================================================================
 * assets/admin.js —— 指纹采集台
 * ---------------------------------------------------------------------
 *   ① 采集：跑 36 条固定套件（浏览器直连），结果可存为档案
 *   ② 档案：中转站基准水平的横向对比（服务端存档，只存数字不存 Key）
 *   ③ 指纹库：把「官方直连」档案并入参考库，浏览器内重建并导出 unified_bank.json
 *
 * 后端只有 api/admin.php，全是秒级短请求；模型请求一律不经后端。
 * 会话令牌放 sessionStorage：关掉标签页即失效，不跨标签页、不落 localStorage。
 * ===================================================================== */
import { fingerprintSuite, ENVIRONMENTS } from './engine/challenges.js?v=13';
import { runCollection } from './engine/runner.js?v=13';
import { analyzeOutputs, classifyVerdict, matchModel } from './engine/fingerprint.js?v=13';
import { FORMATS, PATH_OPTIONS, PATH_TO_FORMAT, resolveTarget, splitEndpoint } from './engine/transport.js?v=13';
import { renderVerdict, renderOverlay, renderCompass, VERDICT, familyColor, short, pct, esc } from './viz.js?v=13';
/* 配置库直接复用检测界面那一份（同一个 localStorage key：mt.savedConfigs.v1）。
 *
 * ⚠️ 为什么直接 import 而不是再存一份：admin.html 与 index.html 同在 /modeltrace/ 下、
 *    同源，localStorage 天然共享；而 store.js 是纯 ES module、顶层不碰任何 DOM，
 *    import 它不会因为缺元素而报错。两处各存一份的话，用户在检测页存的配置在采集台
 *    看不到，改了一边另一边还是旧的 —— 早晚会对不上。
 *
 * ⚠️ 这里会读到配置里的 API Key（明文，只在本机浏览器）。采集台本就是管理员页，
 *    且 Key 只用于填输入框，不上传、不落档案（后端档案白名单里没有 key 字段）。 */
import { loadConfigs, saveConfig, deleteConfig, renameConfig, hostOf } from './store.js?v=13';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const API = './api/admin.php';
const SUITE = fingerprintSuite();
const TOKEN_KEY = 'mt.admin.token';
const ss = {
  get() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } },
  set(v) { try { v ? sessionStorage.setItem(TOKEN_KEY, v) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

let bank = null;          // 当前仓库里的指纹库
let archives = [];        // 档案摘要列表
let collected = null;     // 最近一次采集结果（未保存前）
let controller = null;

/* ---------- 后端调用 ---------- */
async function api(action, body = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ss.get() ? { Authorization: `Bearer ${ss.get()}` } : {}) },
    body: JSON.stringify({ action, ...body }),
  });
  let j;
  try { j = await res.json(); } catch { j = { ok: false, error: `后端返回异常（HTTP ${res.status}）——确认服务器已启用 PHP` }; }
  if (res.status === 401 && j.relogin) { ss.set(''); showLogin('登录已过期，请重新登录'); }
  if (!j.ok) throw Object.assign(new Error(j.error || `HTTP ${res.status}`), { status: res.status });
  return j;
}

function notice(host, kind, html) {
  host.innerHTML = html ? `<div class="notice ${kind}"><span class="ico">${{ bad: '⛔', warn: '⚠', info: 'ℹ', ok: '✓' }[kind] || ''}</span><div>${html}</div></div>` : '';
}

/* ---------- 配置库（右侧悬浮栏，与检测界面共用同一份 localStorage） ----------
 *
 * 读写的都是 store.js 的 `mt.savedConfigs.v1` —— 与检测页**完全相同的一份数据**，
 * 不是复制品。这边存了什么检测页立刻能看到，反过来也一样。
 *
 * ⚠️ 这块的 HTML 写在 admin.html 的右侧 .side-rail 悬浮栏里，结构与检测页**逐字相同**
 *    （cfgStore / cfgToggle / cfgBody / cfgSaved / cfgLabel / cfgSaveBtn），
 *    样式直接复用 styles.css 的 .cfg-store / .cfg-chip 系列（admin.html 已加载那份）。
 *    窄屏时由 styles.css 的 @media 规则降级成正文内联卡片，与检测页行为一致。
 *
 * ⚠️ 为什么不做成采集表单里的一个下拉：采集表单是「一次性填法」，配置库是「长期资产」。
 *    把长期资产塞进表单，会让人以为它跟着这次采集用完就丢，也看不到自己一共有哪几条。
 *    常驻的悬浮栏才是它该待的地方。 */

function renderConfigs() {
  const box = $('#cfgSaved');
  if (!box) return;
  const list = loadConfigs();
  if (!list.length) {
    box.innerHTML = '<div class="cfg-empty">暂无已存配置。填好采集表单后写个备注，点「保存当前」即可复用。</div>';
    return;
  }
  box.innerHTML = list.map((c, i) => `<span class="cfg-chip">
      <button class="cfg-chip-load" data-idx="${i}" title="点击导入到采集表单">
        <span class="cc-label">${esc(c.label)}</span>
        <span class="cc-meta">${esc(hostOf(c.baseUrl))}</span>
      </button>
      <button class="cfg-chip-edit" data-idx="${i}" title="重命名备注">✎</button>
      <button class="cfg-chip-del" data-idx="${i}" title="删除此配置">✕</button>
    </span>`).join('');
  box.querySelectorAll('.cfg-chip-load').forEach((b) => { b.onclick = () => applyConfig(+b.dataset.idx); });
  box.querySelectorAll('.cfg-chip-edit').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); startRename(+b.dataset.idx); }; });
  box.querySelectorAll('.cfg-chip-del').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); dropConfig(+b.dataset.idx); }; });
}

/* 配置库这一块的反馈统一走 notice() 面板，不用 toast ——
 * 采集台本来就没有 toast（那是检测页才有的浮动提示），而这个页面每处操作旁边
 * 都有现成的提示容器（#collectMsg / #archiveTable），就地显示比飘一层浮层更清楚。
 * 下拉里的错误也在同一处说，用户不用去别处找。 */
function cfgNotice(kind, html) {
  const host = $('#cfgMsg') || $('#collectMsg');
  if (!host) return;
  notice(host, kind, html);
}

/** 把配置库某一条导入采集表单。**Key 也一起填** —— 采集必须用它，但只留在输入框里，
 *  不落档案（后端档案白名单里没有 key 字段，这是页面上对用户的承诺）。 */
function applyConfig(i) {
  const c = loadConfigs()[i];
  if (!c) return;
  $('#cBase').value = c.baseUrl || '';
  $('#cKey').value = c.key || '';
  $('#cModel').value = c.model || '';
  // 路径一并回填：同一家中转站的 chat 与 responses 是两个不同的接口，建档路径必须对得上
  $('#cPath').value = c.protocol || 'auto';
  $('#cCustomPath').value = c.customPath || '';
  syncCollectorPathUI();
  // 档案名默认用配置备注，比空着让用户自己编更省事（保存时若仍为空还会自动兜底）
  $('#cLabel').value = c.label || '';
  cfgNotice('info', `已从配置库导入「${esc(c.label || hostOf(c.baseUrl))}」。`);
}

/** 把当前采集表单存成一条配置。同名视为覆盖（store.saveConfig 的语义），不堆重复行。 */
function saveCurrent() {
  const baseUrl = $('#cBase').value.trim();
  const apiKey = $('#cKey').value.trim();
  const model = $('#cModel').value.trim();
  if (!baseUrl && !apiKey) { cfgNotice('warn', '请先填写 Base URL 或 Key 再保存。'); return; }
  let label = ($('#cfgLabel')?.value || '').trim();
  if (!label) label = $('#cLabel').value.trim() || hostOf(baseUrl) || '未命名配置';
  const { protocol, customPath } = readCollectorPath();
  const r = saveConfig({ label, baseUrl, model, key: apiKey, protocol, customPath });
  if (!r.ok) { cfgNotice('bad', '保存失败：本地存储不可用或已满。'); return; }
  $('#cfgLabel').value = '';
  renderConfigs();
  cfgNotice('ok', r.replaced ? `已更新配置「${esc(label)}」。` : `已保存配置「${esc(label)}」。此配置与检测界面共用，那边也看得到。`);
}

function dropConfig(i) {
  const c = loadConfigs()[i];
  if (!c) return;
  if (!confirm(`从配置库删除「${c.label || hostOf(c.baseUrl)}」？\n注意：配置库与检测界面共用，删掉之后检测页里也没有了。`)) return;
  const r = deleteConfig(i);
  if (!r.ok) return;
  renderConfigs();
  cfgNotice('ok', `已删除配置「${esc(r.label || '')}」。`);
}

/** 行内重命名：把标签文字换成输入框，回车/失焦保存，Esc 取消。
 *  与检测页同一套交互（那边实现在 app.js，两处独立写、行为保持一致）。 */
function startRename(i) {
  const c = loadConfigs()[i];
  if (!c) return;
  const chip = $$('#cfgSaved .cfg-chip-load')[i]?.closest('.cfg-chip');
  const labelEl = chip?.querySelector('.cc-label');
  if (!labelEl || chip.querySelector('.cc-edit')) return;
  const input = document.createElement('input');
  input.className = 'cc-edit';
  input.maxLength = 40;
  input.value = c.label;
  labelEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      const next = input.value.trim();
      if (next && next !== c.label) {
        const list = loadConfigs();
        if (list.some((x, j) => j !== i && x.label === next)) { cfgNotice('warn', `已存在备注「${esc(next)}」，换一个吧。`); renderConfigs(); return; }
        const r = renameConfig(i, next);
        if (r.ok) cfgNotice('ok', `已重命名为「${esc(next)}」。`);
      }
    }
    renderConfigs();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

/* ---------- 登录 ---------- */
function showLogin(msg = '') {
  $('#loginView').hidden = false;
  $('#appView').hidden = true;
  $('#logoutBtn').hidden = true;
  notice($('#loginMsg'), msg ? 'warn' : '', msg ? esc(msg) : '');
  setTimeout(() => $('#pwd').focus(), 50);
}
async function enterApp() {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  $('#logoutBtn').hidden = false;
  renderConfigs();   // 配置库与检测界面共用，登录后拉一次（纯 localStorage，不请求后端）
  await Promise.all([loadArchives(), ensureBank()]);
}
async function login() {
  const pwd = $('#pwd').value;
  if (!pwd) return;
  $('#loginBtn').disabled = true;
  try {
    const j = await api('login', { password: pwd });
    ss.set(j.token);
    $('#pwd').value = '';
    await enterApp();
  } catch (e) {
    notice($('#loginMsg'), e.status === 429 ? 'warn' : 'bad', esc(e.message));
  } finally {
    $('#loginBtn').disabled = false;
  }
}

/* ---------- 标签页 ---------- */
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
  $$('.tabpane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
  if (name === 'bank') renderBankTab();
}

async function ensureBank() {
  if (bank) return bank;
  const r = await fetch('./data/bank/unified_bank.json', { cache: 'no-cache' });
  bank = await r.json();
  return bank;
}

/* ---------- ① 采集：网格 ---------- */
const cells = new Map();
function buildGrid() {
  const grid = $('#envGrid');
  grid.innerHTML = '';
  cells.clear();
  ENVIRONMENTS.forEach((env, e) => {
    const cond = `environment-${String(e + 1).padStart(2, '0')}`;
    const items = SUITE.filter((x) => x.condition === cond);
    const box = document.createElement('div');
    box.className = 'env';
    box.innerHTML = `<div class="env-name">${esc(env.label)}<span>${cond.replace('environment-', 'E')}</span></div><div class="env-cells"></div>`;
    for (const it of items) {
      const c = document.createElement('div');
      c.className = 'cell';
      c.innerHTML = `<span>${it.challenge_id.replace('query-', 'Q')} · ${it.expected_count}</span><span class="st">等待</span><span class="bar"><i></i></span>`;
      c.title = it.prompt.slice(0, 300);
      box.querySelector('.env-cells').appendChild(c);
      cells.set(it.challenge_id, c);
    }
    grid.appendChild(box);
  });
}
function setCell(id, cls, st, bar = null, title = null) {
  const c = cells.get(id);
  if (!c) return;
  c.className = `cell ${cls}`;
  $('.st', c).textContent = st;
  if (bar != null) $('.bar i', c).style.width = `${Math.min(100, bar)}%`;
  if (title) c.title = title;
}
/* ---------- ① 采集：运行 ---------- */
function kindValue() { return $('#cKind .on')?.dataset.v || 'relay'; }

/* 接口路径选择 —— 与检测界面同一套语义（见 index.html 那边的注释）。
 *
 * ⚠️ 建档时这条更要紧：指纹必须与**前台检测时用的路径**一致才可比。
 *    同一个模型经 /v1/chat/completions 与经 /v1/responses 拿到的数字偏好不一定相同，
 *    混着采会把路径差异算成模型差异。 */
function renderCollectorPath() {
  $('#cPath').innerHTML = PATH_OPTIONS.map((o) => `<option value="${o.id}">${o.label}</option>`).join('');
}

function readCollectorPath() {
  const v = $('#cPath').value || 'auto';
  return { protocol: v, customPath: v === 'custom' ? $('#cCustomPath').value.trim() : '' };
}

function syncCollectorPathUI() {
  const { protocol, customPath } = readCollectorPath();
  const base = $('#cBase').value.trim();
  const isCustom = protocol === 'custom';
  $('#cCustomPathRow').hidden = !isCustom;
  const el = $('#cPathHint');
  if (isCustom) {
    if (!customPath) { el.textContent = '「自定义」模式：请填完整路径（如 /v1/xxx）或完整地址。'; return; }
    const { proto, url } = resolveTarget(base, 'custom', customPath);
    el.innerHTML = `实际请求 <b>${esc(url)}</b> · 按 <b>${esc(FORMATS[proto].name)}</b> 格式采集`;
    return;
  }
  if (!base) { el.textContent = protocol === 'auto' ? '自动识别：按 Base URL 推断；识别不出时从 Chat Completions 试起。' : '请先填 Base URL。'; return; }
  const { proto, url } = resolveTarget(base, protocol);
  el.innerHTML = `实际请求 <b>${esc(url)}</b> · 按 <b>${esc(FORMATS[proto].name)}</b> 格式采集`
    + (protocol === 'auto' ? ' · 失败会自动换其它路径' : ' · 已固定此路径，不会自动换');
}

/* Base URL 里粘了完整接口地址时，把路径剥到下拉里（只在下拉仍是 auto 时动一次）。 */
function absorbCollectorPath() {
  if ($('#cPath').value !== 'auto') return;
  const { path, proto } = splitEndpoint($('#cBase').value);
  if (!path) return;
  $('#cPath').value = proto === 'anthropic' ? 'messages' : proto === 'responses' ? 'responses' : 'chat';
  syncCollectorPathUI();
}

const cstat = { done: 0, failed: 0, started: 0, format: null };

/* 并发上限。
 *
 * ⚠️ 早先这里是写死的 `Math.min(6, …)`，而输入框写的是 max="6" —— 用户填 10 会被**静默**
 *    夹成 6：输入框照收、值也读出来了，界面上一句提示都没有，看起来就是「设了没用」。
 *    这个上限的来历已不可考，且它没有依据 —— 真正的约束是目标接口的限流，
 *    而那由用户自己判断（他们通常比我们清楚自己买的是什么档）。
 *    现在只保留一个防手滑的宽上限，并在被夹时**明说**。
 * ⚠️ 上限同时写在这里和 admin.html 的 max 属性上；改一处别忘了另一处。 */
const MAX_CONCURRENCY = 32;
function concurrencyValue() {
  const raw = Number($('#cConc').value) || 2;
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(raw)));
}
/** 输入框里填了超过上限的数时给出的提示（没超就不提示）。 */
function concurrencyNote() {
  const raw = Math.floor(Number($('#cConc').value) || 0);
  if (raw <= MAX_CONCURRENCY || raw <= 0) return '';
  return `并发已按上限 ${MAX_CONCURRENCY} 生效（你填的是 ${raw}）。`;
}

function renderCStats(total) {
  const secs = cstat.started ? Math.round((Date.now() - cstat.started) / 1000) : 0;
  const rate = cstat.done ? secs / cstat.done : 0;
  // 除数用**实际生效**的并发，不是输入框原值 —— 早先填 10 被夹成 6 时这里仍按 10 算，
  // 预计时间偏乐观近一倍。
  const conc = concurrencyValue();
  const eta = cstat.done && total > cstat.done ? Math.round(rate * (total - cstat.done) / conc * 1.0) : 0;
  $('#cStats').innerHTML = `<span>有效 <b>${cstat.done}/${total}</b></span><span>失败 <b>${cstat.failed}</b></span>
    <span>接口路径 <b>${cstat.format ? esc(FORMATS[cstat.format].name) : '按地址判定中…'}</b></span><span>并发 <b>${conc}</b></span><span>用时 <b>${secs}s</b></span>${eta ? `<span>预计还要 <b>${Math.ceil(eta / 60)} 分钟</b></span>` : ''}`;
}

async function collect(onlyMissing = false) {
  if (controller) return;
  const baseUrl = $('#cBase').value.trim(), apiKey = $('#cKey').value.trim(), model = $('#cModel').value.trim();
  if (!/^https?:\/\//i.test(baseUrl)) return notice($('#collectMsg'), 'bad', 'Base URL 要以 http(s):// 开头');
  if (!apiKey || !model) return notice($('#collectMsg'), 'bad', 'API Key 和模型名都要填');
  if (!$('#cLabel').value.trim()) $('#cLabel').value = `${new URL(baseUrl).host} · ${model}`;
  notice($('#collectMsg'), '', '');
  // 并发被夹到上限时说一声（没超标就不提示）—— 静默夹取是上一版最伤的地方
  const concNote = concurrencyNote();
  if (concNote) notice($('#collectMsg'), 'info', esc(concNote));

  const keep = onlyMissing && collected ? collected.rows : [];
  const have = new Set(keep.map((r) => r.challenge_id));
  const todo = SUITE.filter((x) => !have.has(x.challenge_id));
  if (!todo.length) return notice($('#collectMsg'), 'ok', '36 条已经齐全，无需补采');

  controller = new AbortController();
  $('#collectBtn').disabled = true;
  $('#collectRetry').hidden = true;
  $('#collectStop').hidden = false;
  $('#gridPanel').hidden = false;
  if (!onlyMissing) { buildGrid(); $('#collectResult').hidden = true; }
  for (const r of keep) setCell(r.challenge_id, 'done', `✓ ${r.numbers.length}`);
  Object.assign(cstat, { done: keep.length, failed: 0, started: Date.now(), format: onlyMissing ? collected?.format : null });
  const ticker = setInterval(() => renderCStats(SUITE.length), 1000);
  renderCStats(SUITE.length);

  // 只补采失败条目时沿用上一轮定下的协议（`cstat.format` 已经是协议名，runCollection 里
  // knownFormat 优先级最高），否则按用户当前在下拉里的选择走。
  const { protocol, customPath } = readCollectorPath();
  const res = await runCollection({
    baseUrl, apiKey, model, challenges: todo, format: cstat.format, signal: controller.signal,
    protocol, customPath,
    concurrency: concurrencyValue(),
    onEvent: (e) => {
      if (e.type === 'start') setCell(e.challenge_id, 'running', e.attempt ? '重试中' : '请求中', 4);
      else if (e.type === 'progress') setCell(e.challenge_id, 'running', `${e.parsed}/${e.expected}`, (e.parsed / e.expected) * 100);
      else if (e.type === 'format') cstat.format = e.format;
      else if (e.type === 'done') { cstat.done += 1; setCell(e.challenge_id, 'done', `✓ ${e.parsed}`, null, `${e.parsed} 个数字 · ${(e.ms / 1000).toFixed(1)}s`); }
      else if (e.type === 'failed' && e.final) { cstat.failed += 1; setCell(e.challenge_id, 'failed', '✕ 失败', null, e.reason); }
      else if (e.type === 'failed') setCell(e.challenge_id, 'failed', '重试…', null, e.reason);
      else if (e.type === 'fatal') setCell(e.challenge_id, 'fatal', '⛔ 停止', null, e.error.message);
      renderCStats(SUITE.length);
    },
  });
  clearInterval(ticker);
  controller = null;
  $('#collectBtn').disabled = false;
  $('#collectStop').hidden = true;
  renderCStats(SUITE.length);

  const rows = [...keep, ...res.rows].sort((a, b) => a.challenge_id.localeCompare(b.challenge_id));
  collected = { rows, errors: [...(onlyMissing ? collected?.errors || [] : []), ...res.errors], format: res.format || cstat.format, baseUrl, model, kind: kindValue() };
  const missing = SUITE.length - rows.length;
  $('#collectRetry').hidden = missing === 0;
  if (res.fatal) notice($('#collectMsg'), 'bad', `<b>已停止：</b>${esc(res.fatal.message)}${rows.length ? `<br>已采到的 ${rows.length} 条仍可保存。` : ''}`);
  else if (res.aborted) notice($('#collectMsg'), 'info', `已手动停止，采到 ${rows.length}/36 条。`);
  else if (missing) notice($('#collectMsg'), 'warn', `有 ${missing} 条没采到（见网格里的黄色格子，悬停看原因），可点「补采失败的条目」。<b>作为官方基线并入指纹库必须 36 条齐全</b>，中转站档案则不要求。`);
  else notice($('#collectMsg'), 'ok', '36 条全部采到。');
  if (rows.length) showCollected();
}

/* 档案分析：全部回答合并做总体归因；再按环境（每环境 3 条）分别归因，作为罗盘的 12 根指针。 */
export function analyzeArchive(rows, claimedName) {
  const outputs = rows.map((r) => ({ text: r.numbers.join(','), expected_count: 0 }));
  const overall = analyzeOutputs(outputs, bank);
  const ids = bank.models.map((m) => m.id);
  const envs = [...new Set(rows.map((r) => r.condition_id))].sort();
  const labels = [];
  const responses = envs.map((env) => {
    const sel = rows.filter((r) => r.condition_id === env);
    const a = analyzeOutputs(sel.map((r) => ({ text: r.numbers.join(','), expected_count: 0 })), bank);
    const byId = Object.fromEntries(a.results.map((x) => [x.model, x]));
    const idx = Number(env.slice(-2)) - 1;
    labels.push(ENVIRONMENTS[idx]?.label || env);
    return { top: a.prediction, probability: a.probability, parsed: sel.reduce((s, r) => s + r.numbers.length, 0),
      scores: ids.map((id) => byId[id].score), probabilities: ids.map((id) => byId[id].probability) };
  });
  const result = { ...overall, responses };
  const match = matchModel(claimedName, bank);
  const claimed = match.model ? match.model.id : null;
  const verdict = claimed ? classifyVerdict(result, claimed) : { code: 'unknown', top: result.results[0] };
  return { result, verdict, claimed, labels, match };
}

function summaryOf(a) {
  const c = a.claimed ? a.result.results.find((x) => x.model === a.claimed) : null;
  return {
    prediction: a.result.prediction, probability: a.result.probability,
    claimed_probability: c ? c.probability : null, claimed_similarity: c ? c.profile_similarity : null,
    verdict: a.verdict.code, agree: a.result.responses.filter((x) => x.top === (a.claimed || a.result.prediction)).length,
    used: a.result.used_outputs, bank_built_at: bank.built_at,
    top: a.result.results.slice(0, 8).map((x) => ({ model: x.model, probability: x.probability, similarity: x.profile_similarity })),
  };
}

function renderAnalysis(a, hosts) {
  const claimed = a.claimed || a.result.prediction;
  const view = { result: a.result, verdict: a.claimed ? a.verdict : { code: 'inconclusive' }, claimed, bank, labels: a.labels, unit: '环境', partial: a.result.used_outputs < SUITE.length };
  renderVerdict(hosts.verdict, hosts.foot, view);
  if (!a.claimed) {
    hosts.foot.insertAdjacentHTML('afterbegin', `<div>注：请求用的模型名「${esc(a.match?.reason === 'empty' ? '' : hosts.modelName || '')}」不在指纹库里，下面改为与最像的库内模型 ${esc(short(claimed))} 对比——这只说明「它最像谁」，不代表它就是那个模型。</div>`);
  }
  renderOverlay(hosts.overlay, view);
  renderCompass(hosts.compass, view);
}

function showCollected() {
  const a = analyzeArchive(collected.rows, collected.model);
  collected.analysis = summaryOf(a);
  $('#collectResult').hidden = false;
  const nums = collected.rows.reduce((s, r) => s + r.numbers.length, 0);
  $('#saveSummary').textContent = `· ${collected.rows.length}/36 条 · ${nums.toLocaleString()} 个数字 · ${collected.format ? FORMATS[collected.format].name : ''}`;
  renderAnalysis(a, { verdict: $('#cVerdict'), foot: $('#cVerdictFoot'), overlay: $('#cOverlay'), compass: $('#cCompass'), modelName: collected.model });
}

async function saveCollected() {
  if (!collected) return;
  $('#saveBtn').disabled = true;
  try {
    const j = await api('save', { id: collected.id || undefined, archive: {
      label: $('#cLabel').value.trim(), note: $('#cNote').value.trim(), base_url: collected.baseUrl, model: collected.model,
      format: collected.format, kind: collected.kind, rows: collected.rows, errors: collected.errors.slice(0, 40), analysis: collected.analysis,
    } });
    collected.id = j.id;
    $('#saveBtn').textContent = '💾 已保存（再点覆盖）';
    notice($('#collectMsg'), 'ok', `已保存为档案 <span class="mono">${esc(j.id)}</span>，可在「② 档案」里查看与对比。`);
    await loadArchives();
  } catch (e) {
    notice($('#collectMsg'), 'bad', `保存失败：${esc(e.message)}`);
  } finally {
    $('#saveBtn').disabled = false;
  }
}

function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
/* ---------- ② 档案 ---------- */
async function loadArchives() {
  try {
    const j = await api('list');
    archives = j.archives || [];
    $('#archiveCount').textContent = archives.length;
    $('#archiveMeta').textContent = `共 ${archives.length} 份档案（上限 ${j.limits?.max_archives ?? '—'}）。同一模型的各家中转站排在一起，按「声称模型概率」从高到低。`;
    renderArchiveTable();
  } catch (e) {
    notice($('#archiveTable'), 'bad', `读取档案失败：${esc(e.message)}`);
  }
}

function canonicalOf(a) {
  const m = bank ? matchModel(a.model, bank).model : null;
  return m ? m.id : `~${String(a.model).toLowerCase()}`;
}

function renderArchiveTable() {
  const q = $('#archiveFilter').value.trim().toLowerCase();
  const list = archives.filter((a) => !q || `${a.label} ${a.host} ${a.model}`.toLowerCase().includes(q));
  if (!list.length) { $('#archiveTable').innerHTML = `<p class="muted" style="padding:14px 0">${archives.length ? '没有匹配的档案' : '还没有档案——去「① 采集」跑一次并保存。'}</p>`; return; }
  const groups = new Map();
  for (const a of list) { const k = canonicalOf(a); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
  const color = bank ? familyColor(bank) : () => '#8b8678';
  const fam = (id) => bank?.models.find((m) => m.id === id)?.family;
  let html = '<div class="table-wrap"><table class="atable"><thead><tr><th>档案</th><th>类型</th><th>回答</th><th>声称模型概率</th><th>分布贴合度</th><th>实测最像</th><th>结论</th><th>更新</th><th></th></tr></thead><tbody>';
  for (const [k, items] of [...groups.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    items.sort((x, y) => (y.analysis?.claimed_probability ?? -1) - (x.analysis?.claimed_probability ?? -1));
    html += `<tr><td colspan="9" style="background:var(--paper-2);font-weight:700;font-size:12.5px"><span class="mono">${esc(k.startsWith('~') ? `${k.slice(1)}（库外）` : k)}</span> <span class="sub">· ${items.length} 份</span></td></tr>`;
    for (const a of items) {
      const an = a.analysis || {};
      const v = an.verdict || 'unknown';
      const stale = an.bank_built_at && bank && an.bank_built_at !== bank.built_at;
      const cp = an.claimed_probability;
      html += `<tr data-id="${esc(a.id)}">
        <td><div>${esc(a.label)}</div><div class="sub mono">${esc(a.host)} · ${esc(a.model)}</div></td>
        <td><span class="kind ${a.kind}">${a.kind === 'official' ? '官方直连' : '中转站'}</span></td>
        <td class="mono">${a.rows}/36</td>
        <td>${cp == null ? '<span class="sub">—</span>' : `<span class="minibar"><i style="width:${Math.max(cp * 100, 1)}%;background:${v === 'match' ? 'var(--ok)' : v === 'mismatch' ? 'var(--bad)' : 'var(--warn)'}"></i></span><span class="mono">${pct(cp)}</span>`}</td>
        <td class="mono">${an.claimed_similarity == null ? '—' : (an.claimed_similarity * 100).toFixed(1)}</td>
        <td><span class="mono" style="color:${color(fam(an.prediction))}">${esc(short(an.prediction || '—'))}</span> <span class="sub">${an.probability != null ? pct(an.probability) : ''}</span></td>
        <td><span class="vtag ${v}">${esc(v === 'unknown' ? '库外' : VERDICT[v]?.t.replace('与声称模型', '').replace('疑似被换成其他模型', '疑似替换').replace('三份回答指向不同模型', '环境分歧').replace('证据不足，无法下结论', '存疑') || v)}</span>${stale ? '<div class="sub" title="归因摘要是用旧版指纹库算的，点「查看」用当前库重算">旧库结果</div>' : ''}</td>
        <td class="sub">${new Date(a.updated_at * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
        <td><div class="row-actions"><button class="btn btn-ghost btn-sm" data-act="view">查看</button><button class="btn btn-ghost btn-sm" data-act="bank" title="把这份档案并入指纹库（浏览器内重建后导出文件提交）">🧬 导入指纹库</button><button class="btn btn-ghost btn-sm" data-act="del">删除</button></div></td></tr>`;
    }
  }
  $('#archiveTable').innerHTML = `${html}</tbody></table></div>`;
}

async function viewArchive(id) {
  const box = $('#archiveDetail');
  box.hidden = false;
  box.innerHTML = '<div class="panel" style="margin-top:14px"><span class="spinner"></span> 读取中…</div>';
  try {
    await ensureBank();
    const { archive: a } = await api('get', { id });
    const an = analyzeArchive(a.rows, a.model);
    box.innerHTML = `<div class="panel save-bar"><div><b>${esc(a.label)}</b> <span class="muted mono">${esc(a.base_url)} · ${esc(a.model)} · ${a.format ? esc(FORMATS[a.format]?.name || a.format) : ''} · ${a.rows.length}/36 条</span>${a.note ? `<div class="muted">${esc(a.note)}</div>` : ''}</div>
      <div class="run-row" style="margin:0"><button class="btn btn-ghost btn-sm" data-act="load">载入到采集区（补采 / 重测）</button><button class="btn btn-ghost btn-sm" data-act="bank">🧬 导入指纹库</button><button class="btn btn-ghost btn-sm" data-act="export">导出原始数据</button><button class="btn btn-ghost btn-sm" data-act="close">✕ 关闭</button></div></div>
      <div class="verdict" style="margin-top:14px"></div><div class="v-foot"></div><div class="viz"></div><div class="viz"></div>
      ${a.errors?.length ? `<details class="models" style="margin-top:14px"><summary><span>采集时的失败记录 <span class="muted">${a.errors.length} 条</span></span><span class="caret">▾</span></summary><div class="models-body"><ul class="muted" style="padding-left:18px">${a.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div></details>` : ''}`;
    const vizs = $$('.viz', box);
    renderAnalysis(an, { verdict: $('.verdict', box), foot: $('.v-foot', box), overlay: vizs[0], compass: vizs[1], modelName: a.model });
    box.querySelector('[data-act="close"]').addEventListener('click', () => { box.hidden = true; box.innerHTML = ''; });
    box.querySelector('[data-act="export"]').addEventListener('click', () => download(`modeltrace-${a.id}.json`, a));
    box.querySelector('[data-act="load"]').addEventListener('click', () => loadIntoCollector(a));
    box.querySelector('[data-act="bank"]').addEventListener('click', () => addToBank(a.id));
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    notice(box, 'bad', `读取失败：${esc(e.message)}`);
  }
}

/* 把档案放回采集区：填好表单、恢复网格；补 Key 后可「补采失败的条目」，保存会覆盖原档案。 */
function loadIntoCollector(a) {
  $('#cBase').value = a.base_url; $('#cModel').value = a.model; $('#cLabel').value = a.label; $('#cNote').value = a.note || '';
  $$('#cKind button').forEach((b) => b.classList.toggle('on', b.dataset.v === a.kind));
  collected = { id: a.id, rows: a.rows, errors: a.errors || [], format: a.format || null, baseUrl: a.base_url, model: a.model, kind: a.kind };
  buildGrid();
  $('#gridPanel').hidden = false;
  for (const r of a.rows) setCell(r.challenge_id, 'done', `✓ ${r.numbers.length}`);
  Object.assign(cstat, { done: a.rows.length, failed: 0, started: 0, format: a.format || null });
  renderCStats(SUITE.length);
  $('#collectRetry').hidden = a.rows.length >= SUITE.length;
  $('#saveBtn').textContent = '💾 保存（覆盖原档案）';
  showCollected();
  notice($('#collectMsg'), 'info', `已载入档案「${esc(a.label)}」。填入 API Key 后可补采缺失条目，保存会覆盖原档案。`);
  switchTab('collect');
  $('#cKey').focus();
}

async function deleteArchive(id) {
  const a = archives.find((x) => x.id === id);
  if (!confirm(`删除档案「${a?.label || id}」？此操作不可恢复。`)) return;
  try { await api('delete', { id }); if (collected?.id === id) collected.id = null; await loadArchives(); $('#archiveDetail').hidden = true; }
  catch (e) { alert(`删除失败：${e.message}`); }
}
/* ---------- ③ 指纹库 ---------- */
let referenceRows = null;   // 当前库的原始参考回答（data/bank/reference.json），重建时要和新档案合并
let builtBank = null;
/* 待并入的档案（点「导入指纹库」攒着，重建时一起算）：archiveId → { id, fid, fname, … } */
const pendingImports = new Map();
/* 要从库里移除的模型 id。**只影响本次重建的产出**，源数据仍在 reference.json 里 ——
   所以「删错了」刷新页面重新导入就能回来，不存在不可逆。 */
const removedModels = new Set();

/** 把一个档案加进待并入列表（档案页点「导入指纹库」时调）。重复点同一份视为更新，不叠加。 */
function addToBank(archiveId) {
  const a = archives.find((x) => x.id === archiveId);
  if (!a) return;
  if (a.rows < SUITE.length) {
    // 提示写在**始终可见**的位置：按钮在列表行和详情面板都有，而列表行场景下详情区可能是隐藏的
    const msg = `档案「${esc(a.label)}」只有 ${a.rows}/36 条，不足 36 条不能并入指纹库（指纹按整轮采集训练）。可在「① 采集」里补采后再来。`;
    if (!$('#archiveDetail').hidden) notice($('#archiveDetail'), 'warn', msg);
    else notice($('#archiveTable'), 'warn', msg);
    return;
  }
  const guess = guessFamily(a.model);
  pendingImports.set(a.id, { id: a.model, fid: guess.id, fname: guess.name, label: a.label, host: a.host, kind: a.kind });
  switchTab('bank');
  notice($('#bankImportMsg'), a.kind === 'relay' ? 'warn' : 'info',
    a.kind === 'relay'
      ? `已加入待并入：<b>${esc(a.label)}</b>。注意这是<b>中转站</b>采的数据 —— 中转可能改写系统提示、走缓存或代理到别的模型，用它当基线会把这家的特征当成「模型本身」的特征。确认你了解来源后再重建。`
      : `已加入待并入：<b>${esc(a.label)}</b>。`);
}

async function renderBankTab() {
  await ensureBank();
  const color = familyColor(bank);
  const fams = [...new Set(bank.models.map((m) => m.family || 'models'))];
  const cv = bank.calibration || {};
  $('#bankCurrent').innerHTML = `<div class="muted">构建于 ${esc(new Date(bank.built_at).toLocaleString('zh-CN'))} · ${bank.models.length} 个模型 · ${bank.robust.training_rows} 条训练回答 · 交叉验证准确率 1 份 ${fmtCv(cv['1'])} / 2 份 ${fmtCv(cv['2'])} / 3 份 ${fmtCv(cv['3'])}</div>
    ${fams.map((f) => `<div class="fam"><div class="fam-name" style="color:${color(f)}"><i style="background:${color(f)}"></i>${esc(bank.models.find((m) => (m.family || 'models') === f).family_name || f)}</div><div class="bank-models">${bank.models.filter((m) => (m.family || 'models') === f).map((m) => {
      const gone = removedModels.has(m.id);
      return `<span class="chip${gone ? ' chip-off' : ''}" title="${esc(m.source_note || '')}">${esc(m.id)}<small>${m.response_count}</small><button type="button" class="chip-x" data-rm="${esc(m.id)}" title="${gone ? '恢复这个模型' : '从重建结果里移除'}">${gone ? '↺' : '×'}</button></span>`;
    }).join('')}</div></div>`).join('')}`;
  $$('#bankCurrent [data-rm]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.rm;
    if (removedModels.has(id)) removedModels.delete(id); else removedModels.add(id);
    renderBankTab();
  }));

  // 待并入列表
  const pend = [...pendingImports.entries()];
  if (pend.length) {
    $('#bankImportPanel').hidden = false;
    $('#bankImportList').innerHTML = pend.map(([aid, p]) => `<div class="cand cand-import" data-id="${esc(aid)}">
      <span>${esc(p.label)}<div class="sub mono">${esc(p.host)} · ${esc(p.kind === 'relay' ? '中转站' : '官方直连')}</div></span>
      <input type="text" class="mid" value="${esc(p.id)}" maxlength="80" data-f="id">
      <input type="text" class="fid" value="${esc(p.fid)}" maxlength="24" data-f="fid">
      <input type="text" class="fname" value="${esc(p.fname)}" maxlength="24" data-f="fname">
      <button type="button" class="btn btn-ghost btn-sm" data-drop="${esc(aid)}">移除</button></div>`).join('');
    $$('#bankImportList .cand').forEach((el) => {
      const aid = el.dataset.id;
      $$('input', el).forEach((inp) => inp.addEventListener('input', () => {
        const rec = pendingImports.get(aid); if (!rec) return;
        rec[inp.dataset.f] = inp.value.trim();
      }));
      $('[data-drop]', el).addEventListener('click', () => { pendingImports.delete(aid); renderBankTab(); });
    });
  } else {
    $('#bankImportPanel').hidden = true;
    $('#bankImportList').innerHTML = '';
  }

  /* 重建按钮的可用性与文案：勾选的候选 / 待并入列表 / 待移除的模型 —— 三者任一有内容就能点。
   * ⚠️ 别漏掉 removedModels：只移除一个模型也是有效的重建意图。
   *    漏了就会出现「按钮灰着，可用户明明点了个 ✕」，看着像坏的。
   * ⚠️ 这段必须在**所有** return 之前执行 —— 否则「没有可并入档案」时按钮既不更新文案、
   *    也不反映待移除状态，和这条规则自相矛盾。 */
  const syncRebuildBtn = () => {
    const checked = $$('#bankCandidates .pick').some((x) => x.checked);
    const n = (checked ? 1 : 0) + pendingImports.size;
    const rm = removedModels.size;
    $('#rebuildBtn').disabled = !(checked || pendingImports.size || rm);
    // 只报真正发生过的事：并入 0 份时别提「并入」，否则文案像在念参数
    const bits = [];
    if (n) bits.push(`并入 ${n} 份`);
    if (rm) bits.push(`移除 ${rm} 个模型`);
    $('#rebuildBtn').textContent = `重建指纹库${bits.length ? `（${bits.join(' · ')}）` : ''}`;
  };

  const cands = archives.filter((a) => a.kind === 'official' && a.rows >= SUITE.length && !pendingImports.has(a.id));
  if (!cands.length) {
    $('#bankCandidates').innerHTML = archives.length
      ? '<p class="muted" style="padding:6px 0">没有可并入的官方档案了。需要「官方直连」类型、且 36 条齐全；中转站档案可在「② 档案」里点「导入指纹库」并入（有风险，见那里的提示）。</p>'
      : '<p class="muted" style="padding:6px 0">还没有档案 —— 去「① 采集」跑一次并保存，或先用上面的 × 从库里移除模型。</p>';
    syncRebuildBtn();
    return;
  }
  $('#bankCandidates').innerHTML = `<div class="cand muted" style="font-size:11.5px"><span></span><span>档案</span><span>写入库的模型 id</span><span>家族 id</span><span>家族名</span></div>` + cands.map((a) => {
    const guess = guessFamily(a.model);
    const existing = bank.models.some((m) => m.id === a.model);
    return `<label class="cand" data-id="${esc(a.id)}"><input type="checkbox" class="pick"><span>${esc(a.label)}<div class="sub mono">${esc(a.host)}${existing ? ' · <b style="color:var(--warn)">库里已有同名模型，将被替换</b>' : ''}</div></span>
      <input type="text" class="mid" value="${esc(a.model)}" maxlength="80"><input type="text" class="fid" value="${esc(guess.id)}" maxlength="24"><input type="text" class="fname" value="${esc(guess.name)}" maxlength="24"></label>`;
  }).join('');
  $$('#bankCandidates .pick').forEach((x) => x.addEventListener('change', syncRebuildBtn));
  syncRebuildBtn();
}
const fmtCv = (c) => (c?.cv_accuracy == null ? '—' : `${(c.cv_accuracy * 100).toFixed(1)}%`);
function guessFamily(model) {
  const s = String(model).toLowerCase();
  if (s.includes('claude')) return { id: 'claude', name: 'Claude' };
  if (/^(gpt|o\d|chatgpt)/.test(s)) return { id: 'gpt', name: 'GPT' };
  if (s.includes('gemini')) return { id: 'gemini', name: 'Gemini' };
  const head = s.split(/[-_.\d]/)[0] || 'other';
  return { id: head.slice(0, 24), name: head.charAt(0).toUpperCase() + head.slice(1, 24) };
}

async function rebuild() {
  const picks = $$('#bankCandidates .cand[data-id]').filter((el) => $('.pick', el).checked);
  if (!picks.length && !pendingImports.size) return;
  $('#rebuildBtn').disabled = true;
  $('#rebuildResult').innerHTML = '';
  $('#rebuildMsg').textContent = '读取参考数据与档案…';
  try {
    if (!referenceRows) {
      const r = await fetch('./data/bank/reference.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(`参考数据加载失败（HTTP ${r.status}）`);
      referenceRows = (await r.json()).rows;
    }
    const added = [];
    const meta = {};
    /** 校验 + 取回一份档案，把它的 36 条摊成建库行。候选列表与待并入列表共用这一条路径。 */
    const ingest = async (archiveId, id, fid, fname) => {
      id = String(id || '').trim();
      fid = String(fid || '').trim() || 'models';
      fname = String(fname || '').trim() || fid;
      if (!/^[A-Za-z0-9._:/@+-]{1,80}$/.test(id)) throw new Error(`模型 id「${id}」不合法`);
      const { archive: a } = await api('get', { id: archiveId });
      if (a.rows.length < SUITE.length) throw new Error(`档案「${a.label}」不足 36 条`);
      for (const r of a.rows) added.push({ source: id, family_id: fid, family_name: fname, provider: a.host, condition_id: r.condition_id, nuisance_condition_id: r.condition_id, challenge_id: r.challenge_id, numbers: r.numbers });
      meta[id] = { source_note: `${a.kind === 'official' ? '官方直连' : '中转'} · ${a.host} · 采集于 ${new Date(a.updated_at * 1000).toLocaleDateString('zh-CN')}` };
    };
    for (const el of picks) {
      await ingest(el.dataset.id, $('.mid', el).value, $('.fid', el).value, $('.fname', el).value);
    }
    for (const [archiveId, p] of pendingImports) {
      await ingest(archiveId, p.id, p.fid, p.fname);
    }
    const replaced = new Set(Object.keys(meta));
    /* 保持模型顺序：原库顺序在前（被替换的原地替换、被移除的跳过），新模型追加在后。
     * ⚠️ 「移除」是**只改产出、不改源数据**：reference.json 里那些行原样留着，
     *    刷新页面重新导入就能回来，不存在「删了就没了」。 */
    const kept = bank.models.map((m) => m.id).filter((id) => !removedModels.has(id));
    const order = [...kept, ...[...replaced].filter((id) => !bank.models.some((m) => m.id === id))];
    const pool = [...referenceRows.filter((r) => !replaced.has(r.source) && !removedModels.has(r.source)), ...added];
    const rows = order.flatMap((id) => pool.filter((r) => r.source === id));
    for (const m of bank.models) if (!meta[m.id] && m.source_note && !removedModels.has(m.id)) meta[m.id] = { source_note: m.source_note };
    if (!rows.length) throw new Error('并入与移除抵消之后一条训练数据都不剩，放弃重建');

    $('#rebuildBar').hidden = false;
    const t0 = Date.now();
    builtBank = await new Promise((resolve, reject) => {
      const w = new Worker(new URL('./bank-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        if (e.data.type === 'progress') {
          $('#rebuildBar i').style.width = `${(e.data.done / e.data.total) * 100}%`;
          $('#rebuildMsg').textContent = `交叉验证 ${e.data.done}/${e.data.total} 次重建…`;
        } else if (e.data.type === 'done') { w.terminate(); resolve(e.data.bank); }
        else { w.terminate(); reject(new Error(e.data.message)); }
      };
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'Worker 出错')); };
      w.postMessage({ rows, modelMeta: meta });
    });
    $('#rebuildMsg').textContent = `完成，用时 ${Math.round((Date.now() - t0) / 1000)}s`;
    /* 只报「这次真正动过的东西」：并入的、移除的。
     * ⚠️ 别把 Object.keys(meta) 直接丢进来 —— meta 里为了保留 source_note 会把**所有**
     *    老模型都塞进去，于是变更清单列了 18 个模型，看起来像把整个库都改了一遍。 */
    const removed = [...removedModels].filter((id) => !replaced.has(id));
    const changed = [...replaced, ...removed.map((id) => `${id}（已移除）`)];
    renderRebuildResult(rows, changed);
  } catch (e) {
    $('#rebuildMsg').textContent = '';
    notice($('#rebuildResult'), 'bad', `重建失败：${esc(e.message)}`);
  } finally {
    $('#rebuildBtn').disabled = false;
  }
}

function renderRebuildResult(rows, changed) {
  const old = bank.calibration || {}, neo = builtBank.calibration;
  const tr = (k) => `<tr><td>${k} 份回答</td><td class="mono">${fmtCv(old[k])}</td><td class="mono"><b>${fmtCv(neo[k])}</b></td><td class="mono">β ${Number(neo[k].beta).toFixed(2)}</td></tr>`;
  const drop = ['1', '2', '3'].some((k) => old[k]?.cv_accuracy != null && neo[k].cv_accuracy < old[k].cv_accuracy - 0.03);
  $('#rebuildResult').innerHTML = `<div class="notice ${drop ? 'warn' : 'info'}" style="display:block">
    <b>新指纹库：</b>${builtBank.models.length} 个模型（变更：${changed.map((x) => `<span class="mono">${esc(x)}</span>`).join('、')}），${rows.length} 条训练回答。
    <table class="cv-table"><tr><th></th><th>旧库准确率</th><th>新库准确率</th><th></th></tr>${tr('1')}${tr('2')}${tr('3')}</table>
    ${drop ? '<p style="margin-top:8px"><b>准确率明显下降</b>：新模型可能和已有模型太像，或采集数据质量不佳（被注入系统提示、走了缓存等），建议先排查再提交。</p>' : ''}
    <div class="run-row"><button class="btn btn-accent" id="dlBank" type="button">下载 unified_bank.json</button><button class="btn btn-ghost" id="dlRef" type="button">下载 reference.json</button></div>
    <p class="muted" style="margin-top:8px">两个文件都要提交：<code>unified_bank.json</code> 给前台检测用；<code>reference.json</code> 是建库原料，下次再加模型时要从它合并。覆盖到 <code>modeltrace/data/bank/</code> 后提交推送即生效。</p></div>`;
  $('#dlBank').addEventListener('click', () => download('unified_bank.json', builtBank));
  $('#dlRef').addEventListener('click', () => download('reference.json', {
    schema: 'modeltrace-reference-rows',
    note: 'Reference responses. Initial rows from xqy2006/ModelTrace data/*_reference.jsonl (MIT); later rows enrolled via modeltrace/admin.html.',
    rows: rows.map(({ source, family_id, family_name, provider, condition_id, nuisance_condition_id, challenge_id, numbers }) => ({ source, family_id, family_name, provider, condition_id, nuisance_condition_id, challenge_id, numbers })),
  }));
}

/* ---------- 启动 ---------- */
function boot() {
  // 接口路径下拉：渲染 + 与输入框联动（地址里粘了完整路径就自动剥到下拉里）
  renderCollectorPath();
  syncCollectorPathUI();
  $('#cPath').addEventListener('change', syncCollectorPathUI);
  $('#cCustomPath').addEventListener('input', syncCollectorPathUI);
  $('#cBase').addEventListener('input', syncCollectorPathUI);
  $('#cBase').addEventListener('change', absorbCollectorPath);

  $('#loginBtn').addEventListener('click', login);
  $('#pwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  $('#logoutBtn').addEventListener('click', async () => { try { await api('logout'); } catch { /* ignore */ } ss.set(''); showLogin(); });
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $$('#cKind button').forEach((b) => b.addEventListener('click', () => { $$('#cKind button').forEach((x) => x.classList.toggle('on', x === b)); if (collected) collected.kind = b.dataset.v; }));
  // 右侧悬浮配置库（与检测界面同一套 markup 与数据，见 renderConfigs 的注释）
  $('#cfgSaveBtn').addEventListener('click', saveCurrent);
  $('#cfgLabel').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveCurrent(); } });
  $('#cfgToggle').addEventListener('click', () => {
    const box = $('#cfgStore');
    const on = box.classList.toggle('collapsed');
    $('#cfgToggle').setAttribute('aria-expanded', on ? 'false' : 'true');
  });
  $('#collectBtn').addEventListener('click', () => { if (collected?.id) { collected = null; $('#saveBtn').textContent = '💾 保存为档案'; } collect(false); });
  $('#collectRetry').addEventListener('click', () => collect(true));
  $('#collectStop').addEventListener('click', () => controller?.abort());
  $('#saveBtn').addEventListener('click', saveCollected);
  $('#exportRowsBtn').addEventListener('click', () => collected && download(`modeltrace-collect-${Date.now()}.json`, { ...collected, label: $('#cLabel').value.trim() }));
  $('#archiveRefresh').addEventListener('click', loadArchives);
  $('#archiveFilter').addEventListener('input', renderArchiveTable);
  $('#archiveTable').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    const id = e.target.closest('tr[data-id]')?.dataset.id;
    if (!btn || !id) return;
    if (btn.dataset.act === 'view') viewArchive(id);
    else if (btn.dataset.act === 'bank') addToBank(id);
    else if (btn.dataset.act === 'del') deleteArchive(id);
  });
  $('#rebuildBtn').addEventListener('click', rebuild);
  window.addEventListener('beforeunload', (e) => { if (controller || (collected && !collected.id && collected.rows.length)) { e.preventDefault(); e.returnValue = ''; } });

  if (!ss.get()) return showLogin();
  api('ping').then(enterApp).catch(() => showLogin());
}
boot();
