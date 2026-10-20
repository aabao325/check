/* =====================================================================
 * assets/app.js —— 大模型归因检测 · 前台
 * ---------------------------------------------------------------------
 * 流程：加载指纹库 → 校验模型名（库外直接拒绝，不发请求）→ runDetection 并行凑 3 份
 *       → analyzeOutputs 归因 → classifyVerdict 定结论 → 结论卡 + A 叠印 + B 罗盘
 *       → 存一条检测历史快照 + 给出分享入口。
 *
 * 指纹库只读仓库里的静态文件 data/bank/unified_bank.json：管理员在采集台建好库导出，
 * 提交进仓库后生效，「支持的模型」列表也随之更新。不走后端，纯静态托管也能用。
 *
 * 本地能力（配置库 / 检测历史 / 分享）全在 assets/store.js，本文件只负责接线与渲染。
 * ===================================================================== */
import { analyzeOutputs, classifyVerdict, matchModel, parseNumbers } from './engine/fingerprint.js?v=13';
import { runDetection, TARGET_VALID, MAX_ATTEMPTS } from './engine/runner.js?v=13';
import { FORMATS, PATH_OPTIONS, PATH_TO_FORMAT, resolveTarget, splitEndpoint } from './engine/transport.js?v=13';
import { renderVerdict, renderOverlay, renderCompass, renderSnapshotCard, familyColor, short, esc, pct } from './viz.js?v=13';
import { renderCharts, chartNote } from './charts.js?v=13';
import { exportPng } from './png.js?v=13';
import * as store from './store.js?v=13';

const $ = (s) => document.querySelector(s);

let bank = null;
let bankInfo = { updated_at: '' };
let controller = null;
let lastSnapshot = null;   // 最近一次检测的快照，分享按钮与「分享报告」弹窗都用它
/** 弹窗里两个分布图的渲染 promise。导出 PNG 前必须 await 它 ——
 *  图要等指纹库 fetch 回来才画得出来，不等就截图会截到空图框。
 *  charts.js 在每条返回路径上都 resolve，所以等下去一定会有结果，不会挂住。 */
let chartsReady = Promise.resolve({ ok: false });

/* ---------- 指纹库 ---------- */
async function loadBank() {
  const r = await fetch('./data/bank/unified_bank.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`指纹库加载失败（HTTP ${r.status}）`);
  const j = await r.json();
  bankInfo = { updated_at: j.built_at };
  return j;
}

function renderModelList() {
  const color = familyColor(bank);
  const fams = [...new Set(bank.models.map((m) => m.family || 'models'))];
  $('#modelCount').textContent = bank.models.length;
  const when = bankInfo.updated_at ? new Date(bankInfo.updated_at).toLocaleDateString('zh-CN') : '';
  $('#bankMeta').textContent = when ? `· 指纹库更新于 ${when}` : '';
  $('#modelsBody').innerHTML = fams.map((f) => {
    const list = bank.models.filter((m) => (m.family || 'models') === f);
    const name = list[0].family_name || f;
    return `<div class="fam"><div class="fam-name" style="color:${color(f)}"><i style="background:${color(f)}"></i>${esc(name)} · ${list.length} 个</div>
      <div class="chips">${list.map((m) => `<button type="button" class="chip" data-model="${esc(m.id)}" title="${esc(m.source_note || `${m.response_count} 份参考回答 · ${m.valid_number_count.toLocaleString()} 个数字`)}">${esc(m.display_name || m.id)}</button>`).join('')}</div></div>`;
  }).join('') + `<p class="models-meta">每个模型的基准由约 36 份回答、1 万个数字建成；3 份回答的交叉验证准确率 ${bank.calibration?.['3']?.cv_accuracy == null ? '—' : `${(bank.calibration['3'].cv_accuracy * 100).toFixed(1)}%`}（在建库环境内评估，真实中转环境会更低）。</p>`;
}

/* ---------- 模型名校验（实时提示 + 运行前拦截） ---------- */
function checkModel(showReject) {
  const name = $('#model').value.trim();
  const hint = $('#modelHint');
  const reject = $('#rejectBox');
  if (!bank) { hint.textContent = ''; return null; }
  const m = matchModel(name, bank);
  $('#model').removeAttribute('aria-invalid');
  if (!name) { hint.className = 'model-hint'; hint.textContent = ''; reject.hidden = true; return null; }
  if (m.model) {
    reject.hidden = true;
    hint.className = m.variant ? 'model-hint warn' : 'model-hint ok';
    const same = m.model.id === name;
    hint.innerHTML = m.variant
      ? `⚠ 按基础模型 <b class="mono">${esc(m.model.id)}</b> 比对；「${esc(m.variant)}」档位会改变输出偏好，结论打折看`
      : `✓ 已收录${same ? '' : `，按 <b class="mono">${esc(m.model.id)}</b> 比对`}`;
    return m;
  }
  hint.className = 'model-hint bad';
  hint.textContent = '✕ 指纹库未收录该模型';
  if (showReject) {
    $('#model').setAttribute('aria-invalid', 'true');
    reject.hidden = false;
    reject.innerHTML = `<div class="notice bad"><span class="ico">🙅</span><div>
      <b>暂不支持检测「${esc(name)}」。</b>模型归因只能在指纹库已收录的模型之间比对——库外模型会被强行归到「最像的」库内模型，给出一个看似自信却毫无意义的结论，所以这里直接拒绝，不会发出任何请求、也不会消耗你的额度。
      <div class="actions"><button type="button" class="btn-link" id="openModels">查看支持的模型（检测说明 › 支持的模型）</button></div></div></div>`;
    $('#openModels').addEventListener('click', () => { $('#modelsBox').open = true; $('#modelsBox').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  }
  return null;
}

/* ---------- 进度 ---------- */
const slots = [];
function initSlots() {
  const host = $('#slots');
  host.innerHTML = '';
  slots.length = 0;
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    const d = document.createElement('div');
    d.className = 'slot';
    d.innerHTML = `<div class="slot-top"><span>#${i + 1}</span><span class="slot-n"></span></div><div class="slot-state">等待</div><div class="slot-detail"></div><div class="slot-bar"><i></i></div>`;
    host.appendChild(d);
    slots.push(d);
  }
}
function setSlot(i, cls, state, detail = '', n = '', bar = null) {
  const s = slots[i];
  if (!s) return;
  s.className = `slot ${cls}`;
  s.querySelector('.slot-state').textContent = state;
  s.querySelector('.slot-detail').textContent = detail;
  s.querySelector('.slot-n').textContent = n;
  if (bar != null) s.querySelector('.slot-bar i').style.width = `${Math.min(100, bar)}%`;
}
/* 这一格是不是还停在「进行中」（请求中 / 接收中）。收尾时用来找出被中断、没有终态事件的槽位。 */
function isSlotRunning(i) {
  const s = slots[i];
  return !!s && s.classList.contains('running');
}
const stats = { accepted: 0, tried: 0, format: null, started: 0, proxy: false };
function renderStats() {
  const secs = stats.started ? ((Date.now() - stats.started) / 1000).toFixed(0) : 0;
  $('#progStats').innerHTML = `<span>有效回答 <b>${stats.accepted}/${TARGET_VALID}</b></span><span>已尝试 <b>${stats.tried}/${MAX_ATTEMPTS}</b></span>
    <span>接口路径 <b>${stats.format ? esc(FORMATS[stats.format].name) : '—'}</b></span><span>用时 <b>${secs}s</b></span>${stats.proxy ? '<span>经本站流式中转</span>' : ''}`;
}

const FATAL_TIPS = {
  auth: '请检查 API Key 是否正确、是否有该模型的权限。',
  model: '中转站不认识这个模型名：请确认填的是中转站实际提供的名字（可在中转站的模型列表里查）。',
  network: '请确认 Base URL 是 API 地址而不是网页地址；如果是 http:// 地址，HTTPS 页面会被浏览器拦截，需给接口配 HTTPS。',
  quota: '稍后再试，或检查余额。',
  format: '接口路径不对：该地址在这个路径上没有可用的接口。请确认 Base URL 正确，并检查「接口路径」是否选对 —— 有的模型上游只提供 /v1/responses，用 /v1/chat/completions 会直接报错。也可以选「自定义」直接填完整地址。',
};
function showFatal(err) {
  const box = $('#fatalBox');
  box.hidden = false;
  box.innerHTML = `<div class="notice bad"><span class="ico">⛔</span><div><b>检测已停止：</b>${esc(err.message)}<br>${esc(FATAL_TIPS[err.kind] || '')}
    <div style="margin-top:4px;font-size:12.5px;opacity:.85">这类错误重试也不会好转，为避免白白消耗额度，剩余探针没有发送。</div></div></div>`;
}

/* ---------- 接口路径选择 ----------
 * 三条标准路径的请求体与字段名不重合（chat 用 messages/max_tokens，
 * responses 用 input/max_output_tokens，messages 用顶层 system），填错上游直接 400。
 * 所以把选择权交给用户，auto 只作为「我懒得管」的默认项保留。
 *
 * 「自定义」用于中转站的非标准路径（如 /v1/xxx/generate）：这时**完全照填的原文请求**，
 * 不拼任何后缀，和 iq 检测站的同款下拉口径一致。 */
const PATH_KEY = 'mt.lastApiPath';
const CUSTOM_KEY = 'mt.lastCustomPath';

function renderPathSelect() {
  $('#apiPath').innerHTML = PATH_OPTIONS.map((o) => `<option value="${o.id}">${o.label}</option>`).join('');
}

/** 当前选择的 { protocol, customPath }。protocol 直接就是协议名或 'auto'。 */
function readPath() {
  const v = $('#apiPath').value || 'auto';
  return { protocol: v, customPath: v === 'custom' ? $('#customPath').value.trim() : '' };
}

/** 同步提示行：显示实际会请求哪个地址、用什么请求体。 */
function syncPathUI() {
  const { protocol, customPath } = readPath();
  const base = $('#baseUrl').value.trim();
  const isCustom = protocol === 'custom';
  $('#customPathRow').hidden = !isCustom;

  const el = $('#pathHint');
  if (isCustom) {
    if (!customPath) { el.textContent = '「自定义」模式：请填完整路径（如 /v1/xxx）或完整地址。'; return; }
    const { proto, url } = resolveTarget(base, 'custom', customPath);
    el.innerHTML = `实际请求 <b>${esc(url)}</b> · 按 <b>${esc(FORMATS[proto].name)}</b> 格式发请求`;
    return;
  }
  if (protocol === 'auto') {
    if (!base) { el.textContent = '自动识别：按 Base URL 里的路径特征判断；识别不出时从 Chat Completions 试起，失败自动换其它路径。'; return; }
    const { proto, url } = resolveTarget(base, 'auto');
    el.innerHTML = `实际请求 <b>${esc(url)}</b> · 按 <b>${esc(FORMATS[proto].name)}</b> 格式发请求 · 失败会自动换其它路径`;
    return;
  }
  if (!base) { el.textContent = '请先填 Base URL。'; return; }
  const { proto, url } = resolveTarget(base, protocol);
  el.innerHTML = `实际请求 <b>${esc(url)}</b> · 按 <b>${esc(FORMATS[proto].name)}</b> 格式发请求 · 已固定此路径，不会自动换`;
}

/* Base URL 里粘了完整接口地址时，把路径剥到下拉里（只在下拉还是 auto 时动一次，
 * 免得覆盖用户已经明确选好的路径）。 */
function absorbPathFromBase() {
  if ($('#apiPath').value !== 'auto') return;
  const { path, proto } = splitEndpoint($('#baseUrl').value);
  if (!path) return;
  const id = proto === 'anthropic' ? 'messages' : proto === 'responses' ? 'responses' : 'chat';
  $('#apiPath').value = id;
  toast(`已从地址里识别出接口路径，改用 ${FORMATS[proto].name}`, '');
}

/* ---------- 主流程 ---------- */
async function run() {
  if (controller) return;
  const baseUrl = $('#baseUrl').value.trim();
  const apiKey = $('#apiKey').value.trim();
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) { $('#baseUrl').focus(); $('#baseUrl').setAttribute('aria-invalid', 'true'); return; }
  $('#baseUrl').removeAttribute('aria-invalid');
  if (!apiKey) { $('#apiKey').focus(); return; }
  const match = checkModel(true);
  if (!match) { $('#model').focus(); return; }
  const { protocol, customPath } = readPath();
  if (protocol === 'custom' && !customPath) { $('#customPath').focus(); toast('「自定义」路径要填完整地址或路径', 'warn'); return; }

  controller = new AbortController();
  $('#shareBtn').disabled = true;
  $('#runBtn').disabled = true;
  $('#runBtn').innerHTML = '<span class="spinner"></span> 检测中';
  $('#stopBtn').hidden = false;
  $('#progSection').hidden = false;
  $('#resultSection').hidden = true;
  $('#fatalBox').hidden = true;
  initSlots();
  Object.assign(stats, { accepted: 0, tried: 0, format: null, started: Date.now(), proxy: false });
  renderStats();
  const ticker = setInterval(renderStats, 1000);
  $('#progSection').scrollIntoView({ behavior: 'smooth', block: 'start' });

  const model = $('#model').value.trim();
  try {
    const res = await runDetection({
      baseUrl, apiKey, model, protocol, customPath, signal: controller.signal,
      onEvent: (e) => {
        if (e.type === 'attempt') { stats.tried = Math.max(stats.tried, e.index + 1); setSlot(e.index, 'running', '请求中', `要求 ${e.challenge.expected_count} 个数字`, '', 3); }
        else if (e.type === 'progress') setSlot(e.index, 'running', '接收中', `已解析 ${e.parsed} / ${e.expected} 个`, '', (e.parsed / e.expected) * 100);
        else if (e.type === 'format') stats.format = e.format;
        else if (e.type === 'accepted') { stats.accepted += 1; setSlot(e.index, 'accepted', '✓ 计入', `${e.parsed} 个数字 · ${(e.ms / 1000).toFixed(1)}s`, ''); }
        else if (e.type === 'rejected') setSlot(e.index, 'rejected', '✕ 不计入', e.reason, '');
        else if (e.type === 'fatal') setSlot(e.index, 'fatal', '⛔ 停止', e.error.message, '');
        renderStats();
      },
    });
    stats.proxy = res.viaProxy;
    // ⚠️ 兜底清理：还在飞的那几条探针不会留下终态事件（程序已经停了），它们的槽位会永远停在
    // 「请求中」转圈。把任何仍处于 running 的槽位收成「中途停止」——
    // 少了这一步，鉴权失败这类场景下用户会看到一格一直转，真正的原因只在下面那个红框里。
    // 必须在下面那轮「填尾部槽位」之前跑：先收掉 running，尾部的才算得准。
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      if (isSlotRunning(i)) setSlot(i, 'unused', '中途停止', res.error ? '' : '未返回结果');
    }
    for (let i = res.attempts.length; i < MAX_ATTEMPTS; i += 1) setSlot(i, 'unused', res.complete ? '无需发送' : '未发送', res.complete ? '已凑满 3 份' : '');
    if (res.error && res.error.kind !== 'aborted') showFatal(res.error);
    if (res.error?.kind === 'aborted') { $('#fatalBox').hidden = false; $('#fatalBox').innerHTML = '<div class="notice info"><span class="ico">⏹</span><div>已停止检测。</div></div>'; }
    if (res.outputs.length) showResult(res, match, { baseUrl, model });
    else if (!res.error) showFatal({ kind: 'upstream', message: `尝试了 ${res.attempts.length} 次，没有一份回答达到有效门槛（数字不足、被截断或拒答）。该模型可能不愿执行这类任务，或中转站对输出做了改写。` });
  } catch (e) {
    showFatal({ kind: 'upstream', message: String(e?.message || e) });
  } finally {
    clearInterval(ticker);
    renderStats();
    controller = null;
    $('#runBtn').disabled = false;
    $('#runBtn').textContent = '重新检测';
    $('#stopBtn').hidden = true;
  }
}

function showResult(res, match, cfg) {
  const result = analyzeOutputs(res.outputs, bank);
  const verdict = classifyVerdict(result, match.model.id);
  const view = { result, verdict, claimed: match.model.id, bank, partial: !res.complete, variant: match.variant };
  $('#resultSection').hidden = false;
  renderVerdict($('#verdict'), $('#verdictFoot'), view);
  renderOverlay($('#vizOverlay'), view);
  renderCompass($('#vizCompass'), view);
  const avg = res.outputs.reduce((s, o) => s + (o.ms || 0), 0) / res.outputs.length;
  const totalNumbers = result.pooled_counts.reduce((a, b) => a + b, 0);
  $('#diag').innerHTML = `<span>接口路径 <b>${esc(res.formatName || '—')}</b></span><span>有效回答 <b>${result.used_outputs}</b> 份 / 尝试 <b>${res.attempts.length}</b> 次</span>
    <span>合计 <b>${totalNumbers}</b> 个数字</span><span>平均每份 <b>${(avg / 1000).toFixed(1)}s</b></span>
    <span>指纹库 <b>${bank.models.length}</b> 个模型</span>${res.viaProxy ? '<span>经本站流式中转</span>' : ''}`;

  // 快照：入历史的、分享用的都是它。⚠️ 不含 Key。
  const claimedRow = result.results.find((x) => x.model === match.model.id) || result.results[0];
  lastSnapshot = store.buildSnapshot({
    baseUrl: cfg.baseUrl, model: cfg.model, claimed: match.model.id, variant: match.variant,
    verdict, prob: claimedRow.probability, prediction: result.prediction, predictionName: result.prediction_name,
    usedOutputs: result.used_outputs, attempts: res.attempts.length, formatName: res.formatName,
    totalNumbers, similarity: claimedRow.profile_similarity,
    rank: result.results.slice(0, 6).map((x) => ({ model: x.model, name: x.display_name, probability: x.probability, family: x.family, family_name: x.family_name })),
    responses: result.responses.map((x) => ({ index: x.index, parsed: x.parsed, top: x.top, probability: x.probability })),
    // 图表原料：原始数字 + 建库时间（分享页据此重算两个分布图，见 store.buildSnapshot 的 rn）
    rawNumbers: result.responses.map((x) => ({ index: x.index, numbers: x.numbers })),
    bankBuiltAt: result.bank_built_at,
    partial: !res.complete, viaProxy: res.viaProxy,
  });
  const saved = store.pushHistory(lastSnapshot);
  renderHistory();
  $('#shareBtn').disabled = false;
  if (!saved) $('#diag').insertAdjacentHTML('beforeend', '<span style="color:var(--warn)">历史保存失败（本地存储不可用或已满）</span>');
  setTimeout(() => $('#resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
}

/* =====================================================================
 * 配置库（右侧悬浮栏）
 * ---------------------------------------------------------------------
 * 存的是「中转站 + Key + 模型」三件套。检测历史里不留 Key，所以复检靠这个面板导入。
 * ===================================================================== */
function renderConfigs() {
  const box = $('#cfgSaved');
  const list = store.loadConfigs();
  if (!list.length) {
    box.innerHTML = '<div class="cfg-empty">暂无已存配置。填好上方接口后，写个备注点「保存当前」即可，方便定期复检。</div>';
    return;
  }
  box.innerHTML = list.map((c, i) => `<span class="cfg-chip">
      <button class="cfg-chip-load" data-idx="${i}" title="点击导入到上方输入区">
        <span class="cc-label">${esc(c.label)}</span>
        <span class="cc-meta">${esc(store.hostOf(c.baseUrl))}${pathBadge(c)}</span>
      </button>
      <button class="cfg-chip-edit" data-idx="${i}" title="重命名备注">✎</button>
      <button class="cfg-chip-del" data-idx="${i}" title="删除此配置">✕</button>
    </span>`).join('');
  box.querySelectorAll('.cfg-chip-load').forEach((b) => { b.onclick = () => applyConfig(+b.dataset.idx); });
  box.querySelectorAll('.cfg-chip-edit').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); startRename(+b.dataset.idx); }; });
  box.querySelectorAll('.cfg-chip-del').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); dropConfig(+b.dataset.idx); }; });
}

/* 配置卡片上的路径小标：只有非 auto 才显示 —— auto 是默认值，每条都挂个「自动」纯属噪音。 */
function pathBadge(c) {
  if (!c.protocol || c.protocol === 'auto') return '';
  if (c.protocol === 'custom') return ` · ${esc(c.customPath || '自定义')}`;
  return ` · ${esc(FORMATS[PATH_TO_FORMAT[c.protocol]]?.path || c.protocol)}`;
}

function saveCurrent() {
  const baseUrl = $('#baseUrl').value.trim();
  const apiKey = $('#apiKey').value.trim();
  const model = $('#model').value.trim();
  if (!baseUrl && !apiKey) { toast('请先填写 Base URL 或 Key 再保存', 'warn'); return; }
  let label = $('#cfgLabel').value.trim();
  if (!label) label = store.hostOf(baseUrl) || '未命名配置';
  const { protocol, customPath } = readPath();
  const r = store.saveConfig({ label, baseUrl, model, key: apiKey, protocol, customPath });
  if (!r.ok) { toast('保存失败：本地存储不可用或已满', 'bad'); return; }
  $('#cfgLabel').value = '';
  renderConfigs();
  toast(r.replaced ? `已更新「${label}」` : `已保存「${label}」到本地`, 'ok');
}

function applyConfig(i) {
  const c = store.loadConfigs()[i];
  if (!c) return;
  $('#baseUrl').value = c.baseUrl || '';
  $('#model').value = c.model || '';
  $('#apiKey').value = c.key || '';
  // 路径一并回填。老配置没存过这两个字段 → 当 auto，行为与升级前一致。
  $('#apiPath').value = c.protocol || 'auto';
  $('#customPath').value = c.customPath || '';
  syncPathUI();
  $('#resultSection').hidden = true;      // 换了目标，旧结果不再对应，先收起
  $('#shareBtn').disabled = true;
  checkModel(false);
  toast(`已导入「${c.label}」`, 'ok');
}

function dropConfig(i) {
  const r = store.deleteConfig(i);
  if (!r.ok) return;
  renderConfigs();
  toast(`已删除「${r.label}」`, 'ok');
}

/* 行内重命名：把标签文字换成输入框，回车/失焦保存，Esc 取消 */
function startRename(i) {
  const c = store.loadConfigs()[i];
  if (!c) return;
  const chip = $(`#cfgSaved .cfg-chip-load[data-idx="${i}"]`)?.closest('.cfg-chip');
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
        const list = store.loadConfigs();
        if (list.some((x, j) => j !== i && x.label === next)) { toast(`已存在备注「${next}」，换一个吧`, 'warn'); renderConfigs(); return; }
        const r = store.renameConfig(i, next);
        if (r.ok) toast(`已重命名为「${next}」`, 'ok');
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

/* =====================================================================
 * 检测历史（右侧悬浮栏）
 * ---------------------------------------------------------------------
 * 每跑完一次归因存一条快照（不含 Key）。点条目打开详情弹窗，
 * 弹窗里直接渲染只读结论卡 + 分享入口，不依赖指纹库、不重新请求。
 * ===================================================================== */
const VERDICT_LABEL = { match: '与声称模型一致', mismatch: '疑似被换成其他模型', split: '三份回答指向不同模型', inconclusive: '证据不足' };
const VERDICT_CLASS = { match: 'pass', mismatch: 'crit', split: 'warn', inconclusive: 'warn' };

function renderHistory() {
  // 历史里存的是短名字段（二维码载荷要省字符），渲染前统一翻译成长名
  const list = store.loadHistory().map((x) => store.readSnapshot(x)).filter(Boolean);
  const countEl = $('#historyCount');
  if (countEl) countEl.textContent = list.length ? ` (${list.length})` : '';
  const clearBtn = $('#historyClearBtn');
  if (clearBtn) clearBtn.style.display = list.length ? '' : 'none';
  const box = $('#historyList');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = '<div class="history-empty">暂无检测记录。点「开始归因」跑完一次后会自动记录在这里，仅存本机浏览器。</div>';
    return;
  }
  box.innerHTML = list.map((it) => {
    const cls = VERDICT_CLASS[it.verdict?.code] || 'warn';
    // 徽标显示「声称模型的归因概率」——一句话概括这次检测的结论强弱
    const score = it.prob == null ? '--' : pct(it.prob);
    const pred = short(it.prediction || '');
    const showPred = it.prediction && it.prediction !== it.claimed;
    return `<div class="history-item">
        <button class="history-open" data-id="${it.id}" title="查看完整归因结果并分享">
          <span class="hi-top">
            <span class="hi-time">${store.fmtTime(it.savedAt)}</span>
            <span class="hi-score ${cls}">${score}</span>
          </span>
          <span class="hi-bot">
            <span class="hi-model">${esc(short(it.model || it.claimed || '—'))}</span>
            <span class="hi-host">${esc(it.host || '')}</span>
          </span>
          ${showPred ? `<span class="hi-note">实测最像 ${esc(pred)}</span>` : ''}
        </button>
        <button class="history-del" data-id="${it.id}" title="删除这条记录">✕</button>
      </div>`;
  }).join('');
  box.querySelectorAll('.history-open').forEach((b) => { b.onclick = () => openDetail(b.dataset.id); });
  box.querySelectorAll('.history-del').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); dropHistory(b.dataset.id); }; });
}

function dropHistory(id) {
  if (store.removeHistory(id)) { renderHistory(); toast('已删除这条记录', 'ok'); }
}
function clearAllHistory() {
  if (!store.loadHistory().length) return;
  if (!confirm('确定清空全部检测历史吗？此操作不可恢复（仅清除本机浏览器中的记录）。')) return;
  if (store.clearHistory()) { renderHistory(); toast('已清空检测历史', 'ok'); }
}

/* ---------- 详情 / 分享弹窗 ---------- */
function openDetail(id) {
  const snap = store.getHistory(id);
  if (!snap) { toast('记录不存在'); return; }
  showModal({
    title: `归因结果 · ${store.fmtTime(snap.savedAt)} · ${snap.model || snap.claimed || ''}`,
    // 传给 showModal 的必须是**短名原始快照**（与后端白名单、buildSnapshot 同一套字段名），
    // 上面那行标题用到的长名字段已经由 getHistory 翻译好了，两者各取所需。
    snap: store.rawHistory(id),
    primary: '🔗 分享这份报告',
  });
}

/** 生成/复检后点「分享报告」：拿当前这次检测的结果开分享面板。 */
function openShare() {
  if (!lastSnapshot) { toast('请先运行一次检测', 'warn'); return; }
  showModal({ title: '分享归因报告', snap: lastSnapshot, shareFirst: true });
}

/** 从历史详情切到分享面板 —— 直接带上弹窗里那条记录的快照。
 *
 * ⚠️ 这里**不能**调 openShare()：它读的是 lastSnapshot，而 lastSnapshot 只在本次会话
 * 「刚跑过检测」时才非空。于是刚打开页面、翻出以前的历史记录点分享，会弹「请先运行一次检测」
 * —— 想分享的正是手上这条记录，却被告知先去跑一次，等于历史记录根本分享不了。
 * 分享的对象永远是弹窗里已经渲染出来的那份快照，所以直接把 snap 传下去。 */
function shareSnapshot(snap) {
  showModal({ title: '分享归因报告', snap, shareFirst: true });
}

/* 弹窗骨架：报告卡（可截图）+ 两个分布图 + 二维码块 + 操作按钮。
 * 同一份 DOM 复用于「历史详情」与「分享」，两种场景只是标题与主按钮不同。
 *
 * ⚠️ 两个调用点传进来的 `snap` 一律是**短名字段**的快照（buildSnapshot 的原始产物），
 * 这是分享链和二维码的载荷格式，必须保持精简 —— 传长名进去会让链接膨胀一倍、二维码扫不出来。
 * 但 renderSnapshotCard 只认长名，所以渲染前统一过一遍 readSnapshot 翻译。
 * 早先的 bug 就在这：openShare 把短名快照直接喂给 renderSnapshotCard，结论/概率/候选全渲染成「—」，
 * 而分享链是对的 —— 对方打开报告页看得见，自己弹窗里却是一片空白，最难发现。
 *
 * ⚠️ 图表（vizOverlay / vizCompass）现在**两种场景都渲染**。早先只在分享面板里没有、
 * 历史详情里也没有 —— 同一份报告在分享页打开有两张分布图、在本机弹窗打开只有一张卡，
 * 用户会以为历史记录丢了东西。图由 charts.js 用快照里的原始数字 + 指纹库现算，
 * 缺料时自动隐藏整块，不会留空图框。 */
function showModal({ title, snap, primary, shareFirst }) {
  const overlay = $('#detailModal');
  $('#detailModalTitle').textContent = title;
  const body = $('#detailModalBody');
  const long = store.readSnapshot(snap);
  // 图表只有拿得到原始数字时才占位；没有原料（旧记录）就连容器都不渲染，
  // 免得留下两个空框。判据与 charts.js 的「缺料就不画」保持一致。
  const hasCharts = !!(long?.rawNumbers || []).length;
  // #detailBodyExport 是**导出 PNG 的截图边界**：包「报告卡 + 分布图 + 二维码」。
  // 分享口径面板排在它外面 —— 那里面是「要不要公开中转站地址」的选项，
  // 属于操作界面而不属于报告本身，不该出现在图片里。
  //
  // ⚠️ 二维码块必须**在边界内**（否则导出的 PNG 底部没有二维码，而这张图的主要用途
  //    恰恰是被转贴到别处，少了二维码就等于断了「看到图 → 打开报告」这条路）。
  //
  // ⚠️⚠️ 二维码块**只在已经有本报告的链接时才渲染**。
  //    早先的做法是一打开就画一个指向检测站首页的「扫码自己测一测」兜底码，等到点分享
  //    再换成报告码 —— 但那个首页码在截图边界内，导出的 PNG 里它看起来跟报告码一模一样，
  //    收到图的人扫出来是首页、根本找不到报告，是实打实的误导。
  //    现在没链接就整块没有：不占位、不留空框。
  //    查的是「当前口径」下已存过的链接；答案影响不了口径本身，所以默认按 host 找一遍，
  //    找到就先把码画上（用户还没点分享也能直接导图带走）。
  const cachedQrUrl = shareFirst ? store.savedShareUrl(snap?.id, 'host') : null;
  body.innerHTML = `<div id="detailBodyExport">
      <div id="detailCard" class="report-card">${renderSnapshotCard(long, { site: store.SITE_LABEL })}</div>
      ${hasCharts ? `<div class="report-charts" id="detailCharts" hidden>
        <div class="viz" id="detailVizOverlay"></div>
        <div class="viz" id="detailVizCompass"></div>
        <div class="chart-note" id="detailChartNote"></div>
      </div>` : ''}
      ${cachedQrUrl ? `<div class="qr-block" id="detailQrBlock">
        <div class="qr-code" id="detailQrCode"></div>
        <div class="qr-text" id="detailQrHint"></div>
      </div>` : ''}
    </div>
    ${shareFirst ? sharePanelHtml(snap) : ''}`;
  if (cachedQrUrl) setQr(cachedQrUrl);

  const acts = $('#detailModalActions');
  if (shareFirst) {
    acts.innerHTML = `<button class="btn btn-accent" id="modalShareBtn">生成并复制链接</button>
      <button class="btn btn-ghost" id="modalPngBtn">📷 导出图片</button>
      <button class="btn btn-ghost" id="modalCloseBtn2">关闭</button>`;
    acts.querySelector('#modalShareBtn').onclick = () => generateShare(snap, acts.querySelector('#modalShareBtn'));
  } else {
    acts.innerHTML = `<button class="btn btn-accent" id="modalShareBtn">${primary || '🔗 分享这份报告'}</button>
      <button class="btn btn-ghost" id="modalPngBtn">📷 导出图片</button>
      <button class="btn btn-ghost" id="modalCopyUrlBtn">📋 复制站点地址</button>
      <button class="btn btn-ghost" id="modalCloseBtn2">关闭</button>`;
    // 历史详情里的主按钮切到分享面板，并带上这条记录自己的快照（见 shareSnapshot 的注释：
    // 走 openShare() 会去读 lastSnapshot，历史记录因此分享不了）
    acts.querySelector('#modalShareBtn').onclick = () => shareSnapshot(snap);
    acts.querySelector('#modalCopyUrlBtn').onclick = async () => {
      const ok = await copyText(store.SITE_URL);
      // 失败时给完整地址（还能手动复制）；成功时只说到域名就够，不必把 https 念一遍
      toast(ok ? `已复制站点地址 ${store.SITE_LABEL}` : `复制失败：${store.SITE_LABEL}`, ok ? 'ok' : 'bad');
    };
  }
  // 导出按钮：两种场景都在（分享面板早先只有「生成并复制链接 + 关闭」，
  // 用户在分享流程里找不到导图入口）。导出的是弹窗里这份完整内容：卡 + 两张图。
  acts.querySelector('#modalPngBtn').onclick = () => exportCardPng(snap, acts.querySelector('#modalPngBtn'));
  acts.querySelector('#modalCloseBtn2').onclick = closeModal;

  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  if (shareFirst) {
    // 分享场景要把口径选择摆到眼前：报告卡很高，而分享面板排在它下面，
    // 不滚一下的话打开弹窗看到的是刚看过的那张卡，选项还在屏幕外。
    // scrollIntoView 会连带滚动祖先容器，所以用 block:'nearest' 让它在已经可见时不乱跳。
    setTimeout(() => {
      acts.querySelector('#modalShareBtn')?.focus();
      body.querySelector('.share-panel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 60);
  }

  // 图表编排：与分享页同一份 charts.js。缺料 / 指纹库拉不到时保持隐藏，不报错。
  if (hasCharts) {
    chartsReady = renderCharts({ snap: long, overlaySel: '#detailVizOverlay', compassSel: '#detailVizCompass' })
      .then((r) => {
        if (!r.ok) return r;
        const note = $('#detailChartNote');
        if (note) note.textContent = chartNote(long.bankBuiltAt);
        const box = $('#detailCharts');
        if (box) box.hidden = false;
        return r;
      });
  } else {
    chartsReady = Promise.resolve({ ok: false, reason: 'no-raw' });
  }
}

/* 分享面板：地址口径单选。
 * 口径必须在这里当面问一次，而不是默默按默认存 —— 报告会被陌生人打开，
 * 「公不公开你的中转站」是分享者自己的决定，不该替他做。
 *
 * 只有「仅域名 / 不显示地址」两项，**没有「完整地址」** ——
 * 端点路径本身可能带账号信息，而这份报告是要发出去的，多公开一段没有收益。
 * 后端仍认得旧的 'full'（线上已发出去的链接照常打开），只是不再产新的。
 *
 * 把域名回显在选项里（而不是让用户自己想象），是因为「仅域名」这一项一旦选了，
 * 报告页上显示的就是这个字符串 —— 让他在点之前就看见，比事后解释清楚。
 *
 * ⚠️ 这份 markup 与 check / iq 两个站点**逐字一致**（那两站是把这一份复制过去用的）。
 *    改文案时三处一起改，否则「统一」的承诺就破了。 */
function sharePanelHtml(snap) {
  const host = store.hostOf(snap?.u || '') || '—';
  return `<div class="share-panel">
    <div class="share-panel-title">报告里要不要带上你的中转站地址？</div>
    <label class="share-opt">
      <input type="radio" name="mtUrlMode" value="host" checked>
      <span class="share-opt-body">
        <b>仅域名</b><span class="share-opt-sub">${esc(host)}</span>
        <span class="share-opt-note">别人只看到你用哪一家，看不到具体端点</span>
      </span>
    </label>
    <label class="share-opt">
      <input type="radio" name="mtUrlMode" value="none">
      <span class="share-opt-body">
        <b>不显示地址</b>
        <span class="share-opt-note">报告里不出现任何中转站地址</span>
      </span>
    </label>
    <div class="share-panel-foot">点下方按钮会把这份报告存到本站服务器，换一个短链。检测过程本身仍不经过服务器。</div>
  </div>`;
}

/** 生成短链 → 复制 → 把二维码补上。
 *
 *  分两步走，先查本地记忆、再问后端：
 *    ① 这条快照在**同一口径**下已经生成过链接 → 直接拿来用，复制即完成，不发任何请求。
 *       这是「同一条检测历史反复分享」的常见路径，也是最该快的一条。
 *    ② 没记过 → 交给后端。后端按内容哈希算 id，同一份报告一律得到同一个链接，
 *       所以即使本机没缓存（换了设备、清了缓存），也不会在服务器上堆出重复副本。
 *  上传成功后把 id 记进本地，下次走 ①。
 *
 *  按钮在过程中禁用，防连点（① 是同步的，快到看不见，仍然统一处理）。 */
async function generateShare(snap, btn) {
  // ⚠️ 取到的是**原始字符串**（'host' / 'none'），不能布尔化 —— 早先这里写的是
  //    `(... === 'full')`，布尔值只有两态，第三个口径一加就会被静默算成 host：
  //    用户选了「不显示地址」，存出去的却是域名，而且全程不报错。
  const urlMode = document.querySelector('input[name="mtUrlMode"]:checked')?.value || 'host';
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ 生成中…';
  try {
    const cached = store.savedShareUrl(snap?.id, urlMode);
    let url = cached;
    if (!url) {
      const r = await store.createShare(snap, urlMode);
      url = r.url;
      store.rememberShareUrl(snap?.id, urlMode, r.id);
    }
    const ok = await copyText(url);
    toast(ok ? '链接已复制 — 直接发给别人就能打开这份报告' : '复制失败，请手动复制下方链接', ok ? 'ok' : 'bad');
    // 就地反馈：面板里的按钮自己也要变一下 —— 顶部提示会消失，而这个按钮
    // 就停在用户点击的位置上，改成「✓ 已复制」比任何浮动提示都直接。
    // 注意别再在 finally 里重置文字（会把这里的 ✓ 立刻抹掉）：按钮的复位交给 flashCopied。
    if (ok) flashCopied(btn, old);
    else { btn.disabled = false; btn.textContent = old; }
    if (ok) mountQrIfNeeded(url); else setQrIfMounted(url);
  } catch (e) {
    // 失败时保留弹窗和已选口径：用户改一下网络或稍后重试即可，不必重新测一遍
    toast(e?.message || '生成分享链接失败', 'bad');
    btn.disabled = false;
    btn.textContent = old;
  }
}

/** 按钮上的「已复制」反馈：变绿 + 打勾，两秒后自己变回原文案。
 *
 *  为什么按钮上也要给：顶部提示在屏幕另一头，而用户的眼睛此刻正盯着自己刚点的
 *  那个按钮。两处同时有反馈，才不会有「我到底点上没有」的迟疑。
 *  期间保持 disabled，防止连点重复生成。 */
function flashCopied(btn, restoreText) {
  if (!btn) return;
  btn.textContent = '✓ 已复制';
  btn.classList.add('copied');
  setTimeout(() => {
    btn.classList.remove('copied');
    btn.textContent = restoreText;
    btn.disabled = false;
  }, 2000);
}
/**
 * 把二维码块挂进截图边界（若还没有），再画上这份报告的链接。
 *
 * 为什么不写成「一开始就渲染好、只是隐藏」：那个块在 `#detailBodyExport` 里，
 * 而隐藏元素照样会被 html2canvas 截成空白/残留边框；更关键的是，只要它在 DOM 里，
 * 就会出现「有码但码是错的」那种半成品状态。干脆**没有链接就不存在这个节点**。
 *
 * @param {string} url 这份报告的分享短链
 */
function mountQrIfNeeded(url) {
  const box = $('#detailBodyExport');
  if (!box) return;
  if (!$('#detailQrBlock')) {
    const block = document.createElement('div');
    block.className = 'qr-block';
    block.id = 'detailQrBlock';
    block.innerHTML = '<div class="qr-code" id="detailQrCode"></div><div class="qr-text" id="detailQrHint"></div>';
    box.appendChild(block);
  }
  setQr(url);
}

/** 只在二维码块已经在 DOM 里时才更新它 —— 用来给「已经有码」的情况换内容。 */
function setQrIfMounted(url) {
  if ($('#detailQrBlock')) setQr(url);
}

/**
 * 在弹窗底部画出这份报告的二维码。
 *
 * @param {string} url 这份报告的分享短链
 *
 * 只有一种用途：编码的就是**这份报告**的地址。早先还有个「指向首页」的兜底版，
 * 已被移除 —— 兜底码和报告码长得一样，扫码的人分不出哪个是哪个，
 * 收到导出图片的人扫出来是首页、找不到报告。现在没有链接就整块不渲染。
 *
 * 文案里的站点名用 SITE_LABEL（不带协议的 `aabao.ai/modeltrace`）——
 * 这里展示的是站点身份，带 `https://` 只会让网址糊成一团，扫不扫码跟它无关。 */
function setQr(url) {
  const code = $('#detailQrCode');
  const hint = $('#detailQrHint');
  if (!code) return;
  drawQr(code, url);
  if (hint) {
    hint.innerHTML = `📱 扫码查看这份归因报告<br><span class="qr-sub">让模型随手写 300 个数字就能认出背后是谁 · ${esc(store.SITE_LABEL)}</span>`;
  }
}

/** 导出弹窗里的内容为 PNG。
 *
 *  截 #detailBodyExport —— 一个包住「报告卡 + 两张分布图」的容器，
 *  与分享页导出的是同一套内容（那边截 #reportHost 整块）。
 *  弹窗头部、底部按钮、分享口径面板都在这个容器之外，天然不会被截进去。
 *
 *  ⚠️ 必须先 await chartsReady：两个分布图是异步画的（要等指纹库），
 *  不等就截图会得到一张缺图的 PNG（图容器此刻还是 hidden，会截成空白）。 */
async function exportCardPng(snap, btn) {
  const box = $('#detailBodyExport');
  if (!box) return;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ 导出中…';
  try {
    await chartsReady;
    const name = `大模型归因报告-${snap.m || snap.c || 'report'}.png`;
    await exportPng(box, name, { background: '#faf9f5', patchRoot: box });
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function closeModal() {
  const overlay = $('#detailModal');
  if (!overlay || overlay.hidden) return;
  // ⚠️ 关闭前先把焦点挪出弹窗：里面那个被点过的按钮此刻还是 document.activeElement，
  // 而祖先马上要变成 hidden —— 浏览器随即报
  // 「Blocked aria-hidden on an element because its descendant retained focus」。
  // 先 blur 再隐藏，那条告警就不会出现（也不能改成 inert，隐藏中的节点上 inert 无意义）。
  const active = document.activeElement;
  if (active && overlay.contains(active)) active.blur();
  overlay.hidden = true;
  document.body.style.overflow = '';
  $('#detailModalBody').innerHTML = '';   // 释放 SVG
  chartsReady = Promise.resolve({ ok: false });
}

function bindModal() {
  const overlay = $('#detailModal');
  if (overlay) overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
  const closeBtn = $('#detailModalClose');
  if (closeBtn) closeBtn.onclick = closeModal;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

/* 二维码：用 check 站同一份 qrcodejs 库，画到 canvas 后转成静态 img。
 * 转 img 是为了截图工具（html2canvas / 系统截图）拿到的一定是画好的图，不受异步时序影响。 */
function drawQr(holder, url) {
  if (!holder) return;
  if (typeof window.QRCode !== 'function') { holder.innerHTML = '<span class="qr-fallback">二维码库未加载</span>'; return; }
  const tmp = document.createElement('div');
  // eslint-disable-next-line no-new
  new window.QRCode(tmp, { text: url, width: 132, height: 132, colorDark: '#14110c', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
  const canvas = tmp.querySelector('canvas');
  let uri = '';
  try { uri = canvas ? canvas.toDataURL('image/png') : (tmp.querySelector('img')?.src || ''); } catch { uri = ''; }
  // 拿不到 dataURL（极少数浏览器 / 隐私模式下 toDataURL 会抛）就什么都不画，
  // 与 assets/report.js 的 drawQr 保持一致 —— 那里也是 `if (uri)` 才输出 <img>。
  // ⚠️ 别在这里补一张兜底图：早先写过 `<img src="./assets/qrcode-fallback.svg">`，
  // 那个文件仓库里从来没有过，真触发时只会渲染一个 404 裂图，比空白更难看。
  holder.innerHTML = uri
    ? `<img src="${uri}" width="132" height="132" alt="扫码查看归因报告">`
    : '';
}

/* ---------- 杂项 ---------- */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
}

let toastTimer;
/* ---------- 轻提示 ----------
 *
 * ⚠️ 挂在**屏幕顶部居中**，不是底部。复制链接这件事用户不会盯着页面底部看 ——
 *    提示要在视线自然落点上，才叫「有反馈」。样式见 styles.css 的 .toast。
 *
 * kind 决定配色与图标：
 *   'ok'    成功（绿）—— 复制成功、生成成功
 *   'warn'  需要注意（橙）
 *   'bad'   失败（红）
 *   其它    中性（深色底）—— 纯信息
 * 图标与配色都在 CSS 里按 class 给，这里只管文字。 */
function toast(msg, kind = '') {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.className = `toast${kind ? ` ${kind}` : ''}`;
  // 重新触发入场动画：先移除类、强制重排、再加回来。
  // 不清这一步的话，连续两次提示（比如先「复制失败」再「已复制」）第二次不会有动画，
  // 看起来像卡住了 —— 这是最容易漏的一处。
  t.classList.remove('show');
  void t.offsetWidth;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3600);
}

/* ---------- 启动 ---------- */
async function boot() {
  // 输入区回填：上次用的中转站与模型名留住（Key 只在「配置库」里，这里不回填）
  $('#baseUrl').value = localStorage.getItem('mt.lastBaseUrl') || '';
  $('#model').value = localStorage.getItem('mt.lastModel') || '';
  renderPathSelect();
  try {
    $('#apiPath').value = localStorage.getItem(PATH_KEY) || 'auto';
    $('#customPath').value = localStorage.getItem(CUSTOM_KEY) || '';
  } catch { /* 隐私模式：用默认值 */ }
  syncPathUI();

  $('#runBtn').addEventListener('click', run);
  $('#stopBtn').addEventListener('click', () => controller?.abort());
  $('#shareBtn').addEventListener('click', openShare);
  $('#apiPath').addEventListener('change', () => {
    syncPathUI();
    try { localStorage.setItem(PATH_KEY, $('#apiPath').value); } catch { /* 隐私模式 */ }
  });
  $('#customPath').addEventListener('input', () => {
    syncPathUI();
    try { localStorage.setItem(CUSTOM_KEY, $('#customPath').value.trim()); } catch { /* 隐私模式 */ }
  });
  // 地址变了就重算提示行：贴着「实际请求 <完整地址>」显示，用户不用猜自己填得对不对
  $('#baseUrl').addEventListener('input', syncPathUI);
  $('#baseUrl').addEventListener('change', absorbPathFromBase);
  $('#model').addEventListener('input', () => checkModel(false));
  $('#model').addEventListener('change', () => checkModel(true));
  $('#modelsBody').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $('#model').value = chip.dataset.model;
    checkModel(true);
    $('#model').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#model').focus();
  });
  for (const id of ['#baseUrl', '#apiKey', '#model']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  for (const id of ['#baseUrl', '#model']) $(id).addEventListener('change', () => {
    try { localStorage.setItem(id === '#baseUrl' ? 'mt.lastBaseUrl' : 'mt.lastModel', $(id).value.trim()); } catch { /* 隐私模式 */ }
  });

  // 右侧悬浮栏
  $('#cfgSaveBtn').addEventListener('click', saveCurrent);
  $('#cfgLabel').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCurrent(); });
  $('#cfgToggle').addEventListener('click', () => toggleStore('cfgStore', 'cfgToggle'));
  $('#historyToggle').addEventListener('click', () => toggleStore('historyStore', 'historyToggle'));
  $('#historyClearBtn').addEventListener('click', clearAllHistory);
  bindModal();
  renderConfigs();
  renderHistory();

  $('#runBtn').disabled = true;
  try {
    bank = await loadBank();
    renderModelList();
    checkModel(false);
    $('#runBtn').disabled = false;
  } catch (e) {
    $('#modelsBody').innerHTML = `<p style="color:var(--bad)">${esc(e.message)}</p>`;
    $('#rejectBox').hidden = false;
    $('#rejectBox').innerHTML = `<div class="notice bad"><span class="ico">⚠</span><div>指纹库没有加载成功，暂时无法检测：${esc(e.message)}</div></div>`;
  }
}

function toggleStore(storeId, btnId) {
  const box = document.getElementById(storeId);
  if (!box) return;
  const collapsed = box.classList.toggle('collapsed');
  document.getElementById(btnId)?.setAttribute('aria-expanded', String(!collapsed));
}

boot();
