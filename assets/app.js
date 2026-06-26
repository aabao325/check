/* =====================================================================
 * app.js —— 主页运行器：串起协议/探针/UI/打分/分享
 * ===================================================================== */
import * as core from './core.js';
import { anthropicProtocol } from './protocols/anthropic.js';
import { openaiProtocol } from './protocols/openai.js';
import { geminiProtocol } from './protocols/gemini.js';

// 协议显示顺序：OpenAI（左）· Claude（中）· Gemini（右）
const PROTOCOLS = { openai: openaiProtocol, anthropic: anthropicProtocol, gemini: geminiProtocol };
const MODE_LABELS = { Q: '快速', S: '标准', F: '完整' };

// 开源仓库 / 反馈渠道占位地址（部署时替换为真实仓库）
const REPO_URL = 'https://github.com/your-org/ai-detector';
const ISSUE_URL = REPO_URL + '/issues';

// 每个探针的一句话说明（用于「检测项说明 / FAQ」区，按 id 取；缺省回退到探针 name）
const PROBE_DESC = {
  channel_id: '看响应 id 前缀判定渠道：msg_01=官方直连 / msg_bdrk_=Bedrock / msg_vrtx_=Vertex / chatcmpl-=疑似 OpenAI 套壳。',
  identity: '问模型「你是谁」，检查是否暴露竞品身份（GPT/Gemini 等）或被换成弱模型。',
  thinking_signature: '验证思考链的加密签名（无法伪造，最强证据）：真思考有长签名 + thinking_tokens>0。',
  message_id: '检查 message id 是否符合官方规范格式。',
  protocol: '校验响应结构是否符合官方 schema（usage 含 cache_creation/service_tier 等新结构）。',
  consistency: '同一请求多次发送，检查模型名稳定、输出方差合理（防随机换模型）。',
  structured_output: '强制工具调用（tool_use），检查能否正确返回结构化结果与 toolu_ 格式 id。',
  json_schema: '要求按复杂 JSON Schema 输出，校验字段合规性。',
  tool_schema_stream: '工具调用 + 复杂 Schema + 流式三合一，检查 stream 是否真透传。',
  streaming_order: '校验 SSE 流式事件顺序：message_start 起、message_stop 止、block_start 早于 delta。',
  behavioral: '行为指纹：检查模型在特定提问下的典型表现是否与官方一致。',
  reasoning_iq: '12 道中文推理/智商题（含逻辑陷阱），区分真旗舰与便宜小模型蒙混。',
  knowledge: '知识准确度：Anthropic CEO/总部/Constitutional AI 等事实题。',
  system_prompt: '系统提示词遵从：要求以指定前缀开头，检查 system 是否被中转层吞掉。',
  system_prompt_leak: '故意不发 system，让模型自爆——若泄露「你是 ChatGPT/翻译所有」等即中转偷偷注入了提示词（高危）。',
  multi_turn: '多轮对话记忆：第 3 轮要能复述第 1 轮埋的暗号，验证历史确实透传。',
  web_search: '联网搜索能力：检查是否返回官方 server_tool_use + citations 结构（信息项）。',
  vision_pdf: '多模态：发 PDF/图片魔法串，检查是否真能识别（区分渠道限制与不具备多模态）。',
  integrity: '流式/非流式一致性：同请求两种方式结果应一致。',
  cache_behavior: 'Prompt 缓存行为：两轮同请求应「创建→命中」缓存（cache_creation/cache_read），套壳常无此能力。',
  token_usage: 'Token 计费核验：用官方 count_tokens 对比响应 usage，识别虚报/降级。',
  error_shape: '错误参数报错：发多种非法参数，检查错误对象是否符合官方 schema。',
  long_context: '长上下文真实性：植入暗号到约 32k/100k token 大文本，检查是否被截断。',
};

const state = {
  protocol: 'anthropic',
  mode: 'S',
  scenario: 'official',
  results: {},      // probeId -> result
  brand: null,
  lastSummary: '',
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------------- 初始化 ---------------- */
async function init() {
  renderProtoTabs();
  bindControls();
  bindViewSwitch();
  fillLinks();
  selectProtocol('anthropic');
  // 静默 ping 后端拿品牌信息（不再显示"后端连接状态"，避免小白误以为有云端存储）
  const ping = await core.pingBackend();
  if (ping) {
    state.brand = ping.brand;
    if (ping.brand?.name) { const f = $('#brandFoot'); if (f) f.textContent = '· ' + ping.brand.name; }
  }
}

/* 填充开源 / 反馈占位链接 */
function fillLinks() {
  const set = (sel, href, text) => { const el = $(sel); if (el) { el.href = href; if (text) el.textContent = text; } };
  set('#repoLink', REPO_URL);
  set('#issueLink', ISSUE_URL);
  set('#faqIssueLink', ISSUE_URL);
}

/* 视图切换：自动检测 / 手动检测 */
function bindViewSwitch() {
  $$('#viewSwitch button').forEach((b) => b.onclick = () => {
    const v = b.dataset.view;
    $$('#viewSwitch button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.view').forEach((sec) => sec.classList.toggle('active', sec.id === 'view-' + v));
    // 手动检测时隐藏「检测深度」和「自定义检测项」（不需要跑自动探针）
    const isManual = v === 'offline';
    $('#modeRow').style.display = isManual ? 'none' : '';
    $('#probeToggleRow').style.display = isManual ? 'none' : '';
  });
}

function renderProtoTabs() {
  const box = $('#protoTabs');
  box.innerHTML = '';
  for (const p of Object.values(PROTOCOLS)) {
    const el = document.createElement('div');
    el.className = `proto-tab ${p.id}`;
    el.dataset.id = p.id;
    const logo = p.icon ? `<img class="proto-ico" src="${p.icon}" alt="${core.esc(p.name)}">` : `<span class="emoji">${p.emoji}</span>`;
    el.innerHTML = `${logo}${p.name}<span class="hint">${p.id === 'anthropic' ? p.probes.length + ' 项专业检测' : '核心检测'}</span>`;
    el.onclick = () => selectProtocol(p.id);
    box.appendChild(el);
  }
}

function selectProtocol(id) {
  state.protocol = id;
  state.results = {};
  const p = PROTOCOLS[id];
  $$('.proto-tab').forEach((t) => t.classList.toggle('active', t.dataset.id === id));
  $('#endpoint').value = p.defaultEndpoint;
  $('#endpoint').placeholder = p.endpointHint;
  $('#model').value = p.defaultModel;
  $('#betaHeader').value = p.betaHeader || '';
  $('#betaRow').style.display = p.betaHeader ? '' : 'none';
  // 「完整（含长上下文）」档仅 Claude 有意义；OpenAI/Gemini 无此检测，隐藏该档
  const fBtn = $('#modeBtns .mode-btn[data-mode="F"]');
  const allowF = id === 'anthropic';
  if (fBtn) {
    fBtn.style.display = allowF ? '' : 'none';
    if (!allowF && state.mode === 'F') {
      state.mode = 'S';
      $$('#modeBtns .mode-btn').forEach((x) => x.classList.toggle('active', x.dataset.mode === 'S'));
    }
  }
  // 场景预设
  const sc = $('#scenarioBtns');
  sc.innerHTML = '';
  if (p.scenarios.length) {
    sc.style.display = '';
    for (const s of p.scenarios) {
      const b = document.createElement('button');
      b.className = 'mode-btn preset' + (s.id === state.scenario ? ' active' : '');
      b.textContent = s.name; b.onclick = () => { state.scenario = s.id; $$('#scenarioBtns .mode-btn').forEach((x) => x.classList.toggle('active', x === b)); };
      sc.appendChild(b);
    }
  } else { sc.style.display = 'none'; }
  renderProbeToggles();
  renderProbeDocs();
  renderCards();
  // 自由请求预填模板（用户常用那套）
  const freeReq = $('#freeReq');
  if (freeReq && !freeReq.dataset.touched) {
    freeReq.value = core.pretty(p.probes[1].defaultPayload(p.defaultModel));
    freeReq.addEventListener('input', () => { freeReq.dataset.touched = '1'; }, { once: true });
  }
}

function renderProbeToggles() {
  const p = PROTOCOLS[state.protocol];
  const box = $('#probeToggles');
  box.innerHTML = '';
  for (const probe of p.probes) {
    const on = probe.modes.includes(state.mode);
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" data-id="${probe.id}" ${on ? 'checked' : ''}> ${probe.name} <span class="w">w${probe.weight}${probe.heavy ? ' · 耗费高' : ''}</span>`;
    box.appendChild(label);
  }
}

/* 动态生成「检测项说明」列表（第4条 FAQ）：从当前协议探针读取，零维护 */
function renderProbeDocs() {
  const p = PROTOCOLS[state.protocol];
  const box = $('#probeDocs');
  if (!box) return;
  const modeLabel = (m) => m.map((x) => MODE_LABELS[x]).join('/');
  box.innerHTML = p.probes.map((pr, idx) => {
    const desc = PROBE_DESC[pr.id] || pr.name;
    return `<div class="probe-doc">
      <div class="pd-head"><span class="pd-num">${idx + 1}</span><span class="pd-name">${core.esc(pr.name)}</span>
        <span class="pd-w">权重 ${pr.weight}${pr.info ? ' · 信息项' : ''} · 档位 ${modeLabel(pr.modes)}${pr.heavy ? ' · 耗费高' : ''}</span></div>
      <div class="pd-desc">${core.esc(desc)}</div>
    </div>`;
  }).join('');
  // 更新 summary 里的数量提示
  const countEl = $('#probeCount');
  if (countEl) countEl.textContent = `（共 ${p.probes.length} 项，点击展开）`;
}

function selectedProbes() {
  const p = PROTOCOLS[state.protocol];
  const checked = new Set($$('#probeToggles input:checked').map((i) => i.dataset.id));
  return p.probes.filter((pr) => checked.has(pr.id));
}

/* ---------------- 控件绑定 ---------------- */
function bindControls() {
  $$('#modeBtns .mode-btn').forEach((b) => b.onclick = () => {
    state.mode = b.dataset.mode;
    $$('#modeBtns .mode-btn').forEach((x) => x.classList.toggle('active', x === b));
    renderProbeToggles();
  });
  $('#runBtn').onclick = runAll;
  $('#summaryBtn').onclick = doSummary;
  $('#shareBtn').onclick = doShare;
  $('#freeSend').onclick = freeSend;
  $('#freeAnalyze').onclick = freeAnalyze;
}

function cfg() {
  return {
    targetUrl: $('#endpoint').value.trim(),
    apiKey: $('#apiKey').value.trim(),
    authStyle: PROTOCOLS[state.protocol].authStyle,
  };
}
function extraHeaders() {
  const h = {};
  const beta = $('#betaHeader').value.trim();
  if (beta && state.protocol === 'anthropic') h['anthropic-beta'] = beta;
  return h;
}

/* ---------------- 渲染探针卡片 ----------------
 * 每个探针始终构建完整卡片（含请求/响应/分析 DOM，runOne 依赖之）。
 * 通过 .compact 类把卡片收成一行紧凑条目；运行后：异常项展开置顶、
 * 正常项保持紧凑（点击行首可就地展开）。
 */
function renderCards() {
  const box = $('#cards');
  box.innerHTML = '';
  // 顶部汇总行（运行后填充）
  const summary = document.createElement('div');
  summary.id = 'resultSummary';
  summary.className = 'result-summary';
  summary.style.display = 'none';
  box.appendChild(summary);
  const probes = selectedProbes();
  for (const probe of probes) {
    box.appendChild(buildCard(probe));
  }
  updateOverview();
}

function buildCard(probe) {
  const model = $('#model').value.trim() || PROTOCOLS[state.protocol].defaultModel;
  const tmpl = core.pretty(probe.defaultPayload(model));
  const card = document.createElement('div');
  card.className = 'card probe-card compact prerun';   // 初始紧凑且隐藏（未运行不展示）
  card.dataset.id = probe.id;
  card.innerHTML = `
    <div class="pc-head">
      <span class="row-caret">▸</span>
      <span class="name">${probe.name}</span>
      <span class="weight">权重 ${probe.weight}</span>
      ${probe.info ? '<span class="weight">信息项</span>' : ''}
      <span class="vbadge skip">⏳ 未运行</span>
    </div>
    <div class="pc-body">
      <details class="io-detail">
        <summary>📄 查看 / 编辑请求体与响应体</summary>
        <div class="pc-io">
          <div class="col">
            <label>📤 请求体（可编辑）<button class="btn btn-ghost btn-sm sendOne">发送</button></label>
            <textarea class="reqBox" spellcheck="false">${core.esc(tmpl)}</textarea>
          </div>
          <div class="col">
            <label>📥 响应体</label>
            <div class="resp-meta"></div>
            <pre class="respBox muted">（尚未发送）</pre>
          </div>
        </div>
      </details>
      <div class="pc-analysis" style="display:none">
        <div class="feats"><div class="feat-title">🔍 特征提取</div><ul></ul></div>
        <div class="diffs"><div class="feat-title">⚠️ 与官方标准的差异</div><ul></ul></div>
      </div>
    </div>`;
  // 点击行首（紧凑态）就地展开/收起；运行按钮不触发 toggle
  card.querySelector('.pc-head').onclick = (e) => {
    if (e.target.closest('.sendOne')) return;
    card.classList.toggle('compact');
  };
  card.querySelector('.sendOne').onclick = (e) => { e.stopPropagation(); runOne(probe, card); };
  return card;
}

/* ---------------- 运行单个探针 ---------------- */
async function runOne(probe, card) {
  const badge = card.querySelector('.vbadge');
  badge.className = 'vbadge skip'; badge.innerHTML = '<span class="spinner"></span> 运行中';
  const reqBox = card.querySelector('.reqBox');
  const parsed = core.parseJsonLoose(reqBox.value);
  if (!parsed.ok) { setResult(card, { status: 'error', diffs: ['请求体不是合法 JSON: ' + parsed.error] }, probe); return; }

  try {
    const ctx = await executeProbe(probe, parsed.value);
    const result = probe.analyze(ctx);
    result._ctx = ctx;
    state.results[probe.id] = { probe, result };
    setResult(card, result, probe, ctx);
  } catch (e) {
    setResult(card, { status: 'error', diffs: ['执行异常: ' + e.message] }, probe);
  }
  updateOverview();
  reflowCards();
}

/**
 * 根据探针的特殊标记编排请求：
 * - multi: 跑 N 次 → ctx.multiJson
 * - tokenPair: 跑短+长 → ctx.shortJson/longJson
 * - dualStream: 跑非流+流 → ctx.nonStreamJson/streamMessage
 * - stream: 单次流式 → ctx.body 为 SSE 文本
 * - 普通: 单次 → ctx.json
 */
async function executeProbe(probe, payload) {
  const c = cfg(), eh = extraHeaders();
  const base = { model: $('#model').value.trim(), scenario: state.scenario, requestPayload: payload, shared: sharedCtx(), httpStatus: 0, headers: {}, body: '', json: null };

  const send = async (pl) => {
    const r = await core.proxyFetch(c, pl, eh);
    const parsed = r.body ? core.parseJsonLoose(r.body) : { ok: false };
    return { raw: r, json: parsed.ok ? parsed.value : null };
  };

  if (probe.multi) {
    const runs = [];
    const n = state.mode === 'Q' ? 1 : probe.multi;
    let last;
    for (let i = 0; i < n; i++) { last = await send(payload); if (last.json) runs.push(last.json); }
    return { ...base, httpStatus: last.raw.httpStatus, headers: last.raw.headers, body: last.raw.body, json: last.json, multiJson: runs };
  }
  if (probe.tokenPair) {
    const short = await send(payload);
    const longPayload = JSON.parse(JSON.stringify(payload));
    appendLongText(longPayload);
    const long = state.mode === 'Q' ? null : await send(longPayload);
    // 可选官方 count
    let officialInputTokens = null;
    if (state.protocol === 'anthropic') officialInputTokens = await tryOfficialCount(payload);
    return { ...base, httpStatus: short.raw.httpStatus, headers: short.raw.headers, body: short.raw.body, json: short.json, shortJson: short.json, longJson: long?.json, officialInputTokens };
  }
  if (probe.dualStream) {
    const ns = await send(payload);
    const streamPayload = { ...payload, stream: true };
    const st = await send(streamPayload);
    const sse = st.raw.body && /data:/.test(st.raw.body) ? core.parseSSE(st.raw.body) : null;
    return { ...base, httpStatus: ns.raw.httpStatus, headers: ns.raw.headers, body: ns.raw.body, json: ns.json, nonStreamJson: ns.json, streamMessage: sse?.message };
  }
  // stream 或普通
  const r = await send(payload);
  return { ...base, httpStatus: r.raw.httpStatus, headers: r.raw.headers, body: r.raw.body, json: r.json, requestId: r.raw.requestId };
}

function sharedCtx() {
  // 跨探针共享：渠道判定等
  const ch = state.results.channel_id?.result?._ctx?.shared?.channel;
  return { channel: ch || null };
}

function appendLongText(payload) {
  const ref = '\n\nReference text:' + ' apple'.repeat(80);
  const msgs = payload.messages || [];
  const last = msgs[msgs.length - 1];
  if (last && typeof last.content === 'string') last.content += ref;
}

async function tryOfficialCount(payload) {
  try {
    const r = await fetch(`${core.PROXY.base}/count.php`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: payload.model, messages: payload.messages, system: payload.system }),
    });
    const j = await r.json();
    return j.ok ? j.input_tokens : null;
  } catch { return null; }
}

/* ---------------- 写结果到卡片 ---------------- */
function setResult(card, result, probe, ctx) {
  const badge = card.querySelector('.vbadge');
  const b = core.verdictBadge(result);
  badge.className = 'vbadge ' + b.cls; badge.textContent = b.text;
  const verdictCls = result.severity === 'critical' ? 'crit' : b.cls;
  card.className = 'card probe-card ' + verdictCls;   // 注意：清掉 compact，下面按结果重新决定
  card.dataset.verdict = verdictCls;

  // 异常项（严重/失败/出错）→ 展开成大卡片并自动展开请求/响应；
  // 正常项（真/不适用/跳过）→ 收成紧凑行（点击行首可再展开）。
  const abnormal = verdictCls === 'crit' || verdictCls === 'fail' || verdictCls === 'warn' || result.status === 'error';
  card.classList.toggle('compact', !abnormal);

  const io = card.querySelector('.io-detail');
  if (io) io.open = result.severity === 'critical' || b.cls === 'fail' || result.status === 'error';

  if (ctx) {
    const meta = card.querySelector('.resp-meta');
    const codeCls = ctx.httpStatus >= 200 && ctx.httpStatus < 300 ? 'code-ok' : 'code-bad';
    meta.innerHTML = `HTTP <span class="${codeCls}">${ctx.httpStatus}</span>` + (ctx.requestId ? ` · request-id: ${core.esc(ctx.requestId)}` : '') + (ctx.json?.id ? ` · id: ${core.esc(ctx.json.id)}` : '');
    const pre = card.querySelector('.respBox');
    pre.classList.remove('muted');
    pre.textContent = ctx.body ? core.pretty(ctx.body) : '(空响应)';
  }
  const ana = card.querySelector('.pc-analysis');
  ana.style.display = '';
  const fUl = ana.querySelector('.feats ul'), dUl = ana.querySelector('.diffs ul');
  fUl.innerHTML = (result.features || []).map((f) => `<li>${core.esc(f)}</li>`).join('') || '<li class="muted">无</li>';
  dUl.innerHTML = (result.diffs || []).map((d) => `<li>${core.esc(d)}</li>`).join('') || '<li class="muted">无差异</li>';
}

/* 运行后整理卡片：异常项置顶 + 顶部汇总（正常项保持紧凑折叠） */
function reflowCards() {
  const box = $('#cards');
  const summary = $('#resultSummary');
  const cards = $$('#cards .probe-card');
  const rank = (c) => ({ crit: 0, fail: 1, warn: 2 }[c.dataset.verdict] ?? 9);
  // 异常项排前（按严重度），其余维持原顺序
  const sorted = [...cards].sort((a, b) => rank(a) - rank(b));
  sorted.forEach((c) => box.appendChild(c));   // appendChild 会移动节点，summary 仍在最前

  const abnormal = cards.filter((c) => rank(c) < 9).length;
  const done = cards.filter((c) => c.dataset.verdict).length;
  if (done) {
    summary.style.display = '';
    const normal = done - abnormal;
    summary.innerHTML = `共 <b>${done}</b> 项 · <span class="rs-bad">${abnormal}</span> 项异常已展开 · <span class="rs-ok">${normal}</span> 项正常已折叠（点击行首查看）`;
  } else {
    summary.style.display = 'none';
  }
}

/* ---------------- 一键全检 ---------------- */
async function runAll() {
  if (!cfg().targetUrl) { toast('请先填写接口地址'); return; }
  const btn = $('#runBtn'); btn.disabled = true; btn.textContent = '检测中…';
  state.results = {};
  const cards = $$('#cards .probe-card');
  // channel_id 先跑（别的探针依赖它的渠道判定）
  const probes = selectedProbes();
  const ordered = [...probes].sort((a, b) => (a.id === 'channel_id' ? -1 : 0));
  for (const probe of ordered) {
    const card = cards.find((c) => c.dataset.id === probe.id);
    if (card) await runOne(probe, card);
  }
  btn.disabled = false; btn.textContent = '🟢 一键全检';
  updateOverview();
  reflowCards();
  toast('检测完成');
}

/* ---------------- 总览 ---------------- */
function updateOverview() {
  const items = Object.values(state.results).map(({ probe, result }) => ({
    name: probe.name, weight: probe.weight, score: result.score, verdict: result.verdict,
    severity: result.severity, status: result.status, info: probe.info,
  }));
  const scored = items.filter((i) => !i.info); // 信息项不计入总分主体
  const { total, level, verdict, hasCritical } = core.scoreTotal(scored.length ? scored : items);
  const ov = $('#overview');
  if (!items.length) { ov.style.display = 'none'; return; }
  ov.style.display = '';

  const ch = sharedCtx().channel || { channel: '未知', code: 'unknown' };
  const colors = { excellent: 'var(--pass)', pass: 'var(--pass)', marginal: 'var(--warn)', fail: 'var(--fail)' };
  $('#ring').style.setProperty('--val', total);
  $('#ring').style.setProperty('--col', colors[level]);
  $('#ringScore').textContent = total;
  $('#ovVerdict').textContent = verdict;
  $('#ovChannel').className = 'badge ' + ch.code;
  $('#ovChannel').textContent = ch.channel;
  $('#critBanner').style.display = hasCritical ? '' : 'none';

  state._overview = { total, verdict, channel: ch.channel, hasCritical };
}

/* ---------------- GLM 总结 ---------------- */
async function doSummary() {
  if (!Object.keys(state.results).length) { toast('请先运行检测'); return; }
  const btn = $('#summaryBtn'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 生成中';
  const payload = buildReportPayload();
  const r = await core.generateSummary(payload);
  const box = $('#summaryBox');
  box.style.display = '';
  if (r.ok) { state.lastSummary = r.summary; box.textContent = r.summary; }
  else { box.textContent = localSummary(payload) + '\n\n（注：GLM 未配置或调用失败，以上为本地规则总结。）'; state.lastSummary = box.textContent; }
  btn.disabled = false; btn.textContent = '🤖 生成 AI 总结';
}

function localSummary(p) {
  const lines = [`综合得分 ${p.totalScore}/100，初步判定：${p.verdict}。`, `渠道来源：${p.channel}。`];
  const bad = p.results.filter((r) => r.severity === 'critical' || (r.score != null && r.score < 50));
  if (bad.length) lines.push('主要风险项：' + bad.map((r) => r.name).join('、') + '。');
  else lines.push('各检测项表现正常。');
  return lines.join('\n');
}

function buildReportPayload() {
  const results = Object.values(state.results).map(({ probe, result }) => ({
    name: probe.name, score: result.score, weight: probe.weight,
    verdict: result.verdict, severity: result.severity, status: result.status,
    features: result.features || [], diffs: result.diffs || [],
  }));
  const ov = state._overview || {};
  return {
    protocol: state.protocol, model: $('#model').value.trim(),
    targetHost: (() => { try { return new URL($('#endpoint').value).host; } catch { return ''; } })(),
    channel: ov.channel || '', totalScore: ov.total || 0, verdict: ov.verdict || '',
    critical: ov.hasCritical || false, summary: state.lastSummary || '', results,
  };
}

/* ---------------- 分享 ---------------- */
async function doShare() {
  if (!Object.keys(state.results).length) { toast('请先运行检测'); return; }
  const payload = buildReportPayload();
  const r = await core.shareReport(payload);
  if (r.ok) {
    try { await navigator.clipboard.writeText(r.url); } catch { /* ignore */ }
    toast(`分享链接已复制（${r.mode === 'short' ? '短链接' : '静态链接'}）：${r.url}`);
    window.open(r.url, '_blank');
  } else toast('分享失败');
}

/* ---------------- 自由请求 / 手动核对 ---------------- */
async function freeSend() {
  const reqBox = $('#freeReq');
  const parsed = core.parseJsonLoose(reqBox.value);
  if (!parsed.ok) { toast('请求体不是合法 JSON: ' + parsed.error); return; }
  if (!cfg().targetUrl) { toast('请先填写接口地址'); return; }
  $('#freeSend').innerHTML = '<span class="spinner"></span>';
  try {
    const r = await core.proxyFetch(cfg(), parsed.value, extraHeaders());
    $('#freeResp').value = r.body ? core.pretty(r.body) : ('(无响应) ' + (r.error || ''));
    freeAnalyze();
  } catch (e) { toast('请求失败: ' + e.message); }
  $('#freeSend').textContent = '发送';
}

function freeAnalyze() {
  const txt = $('#freeResp').value;
  const parsed = core.parseJsonLoose(txt);
  const ana = $('#freeAnalysis');
  ana.style.display = '';
  const fUl = ana.querySelector('.feats ul'), dUl = ana.querySelector('.diffs ul');
  if (!parsed.ok) { fUl.innerHTML = '<li class="muted">响应不是合法 JSON</li>'; dUl.innerHTML = ''; return; }
  const j = parsed.value;
  const features = [], diffs = [];
  // 渠道
  const ch = core.detectChannelById(j.id);
  features.push(`响应 id: ${j.id || '(无)'} → ${ch.channel}`);
  if (ch.critical) diffs.push('id 前缀非官方格式 → 疑似套壳');
  // 思考签名
  const tb = (j.content || []).filter((c) => c.type === 'thinking' || c.type === 'redacted_thinking');
  if (tb.length) {
    const sl = (tb[0].signature || '').length;
    features.push(`thinking 块 ${tb.length} 个，signature 长度 ${sl}`);
    if (sl < 50) diffs.push('签名缺失/过短 → 思考链可疑');
  }
  // usage 官方结构
  if (j.usage?.cache_creation) features.push('含 cache_creation 嵌套结构 ✓');
  if (j.usage?.service_tier) features.push(`service_tier=${j.usage.service_tier}`);
  if ('inference_geo' in (j.usage || {})) features.push(`inference_geo=${j.usage.inference_geo}`);
  if (j.context_management) features.push('含 context_management ✓');
  // 联网
  if ((j.content || []).some((c) => c.type === 'web_search_tool_result')) features.push('含官方联网结构 ✓');
  // OpenAI 兼容
  if (j.object === 'chat.completion') {
    features.push('OpenAI 兼容响应 (chat.completion)');
    const u = j.usage || {};
    if (Object.keys(u).some((k) => k.startsWith('claude_'))) diffs.push('usage 含 claude_* → Claude 套壳');
  }
  fUl.innerHTML = features.map((f) => `<li>${core.esc(f)}</li>`).join('') || '<li class="muted">无</li>';
  dUl.innerHTML = diffs.map((d) => `<li>${core.esc(d)}</li>`).join('') || '<li class="muted">无差异</li>';
}

/* ---------------- toast ---------------- */
let toastTimer;
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.style.display = '';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.style.display = 'none', 4000);
}

init();
