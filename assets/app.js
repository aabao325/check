/* =====================================================================
 * app.js —— 主页运行器：串起协议/探针/UI/打分/分享
 * ===================================================================== */
import * as core from './core.js?v=16';
import { anthropicProtocol } from './protocols/anthropic.js?v=16';
import { openaiProtocol } from './protocols/openai.js?v=16';
import { geminiProtocol } from './protocols/gemini.js?v=16';

// 协议显示顺序：OpenAI（左）· Claude（中）· Gemini（右）
const PROTOCOLS = { openai: openaiProtocol, anthropic: anthropicProtocol, gemini: geminiProtocol };
const MODE_LABELS = { Q: '快速', S: '标准', F: '完整' };

// 开源仓库 / 反馈渠道
const REPO_URL = 'https://github.com/aabao325/check';
const ISSUE_URL = REPO_URL + '/issues';

// 每个探针的一句话说明（用于「检测项说明 / FAQ」区，按 id 取；缺省回退到探针 name）
const PROBE_DESC = {
  channel_id: '看响应 id 前缀判定渠道：Claude msg_01=官方/msg_bdrk_=Bedrock/msg_vrtx_=Vertex；OpenAI resp_=官方 Responses、chatcmpl-=疑似套 Chat 壳。若身份回复中自述 “Claude Code / Codex”，则进一步细分为对应工具渠道。',
  identity: '问模型「你是谁/详细身份介绍」，核对自述身份是否与官方一致；暴露竞品身份（如 Claude 协议里自称 GPT、Gemini 里自称 OpenAI）=掺假；自述 Codex/Claude Code 则细分工具渠道。',
  thinking_signature: '验证思考链的加密签名（无法伪造，最强证据）：真思考有长签名 + thinking_tokens>0。',
  message_id: '检查 message id 是否符合官方规范格式。',
  protocol: '校验响应结构是否符合官方 schema（Claude usage 含 cache_creation/service_tier；OpenAI Responses 含 output/usage.input_tokens；Gemini 含 candidates/usageMetadata），并扫描套壳污染字段。',
  consistency: '同一请求多次发送，检查模型名稳定、输出方差合理（防随机换模型）。',
  structured_output: '强制结构化输出，检查能否按 schema 正确返回（OpenAI text.format / Gemini responseSchema / Claude tool_use）。',
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
  token_billing: 'Token 计费核验：检查 Responses 的 usage（input_tokens/output_tokens/total_tokens）字段完整且自洽，长短 prompt 增量合理。',
  model_consistency: '同一请求多次发送，检查响应 model 名稳定、output_tokens 方差合理（防随机换模型）。',
  model_info: '同一请求多次发送，检查响应 modelVersion 稳定、token 方差合理（防随机换模型）。',
  param_check: '参数强验真：发两条固定句（“我的指令是什么”官方恒 input_tokens=10 / “hi”）配 max_output_tokens=16。真官方会在思考阶段精确截断（status=incomplete、reason=max_output_tokens、output_tokens≈16 全为 reasoning_tokens）且 input_tokens 精确——非官/逆向难复现；两句 input_tokens 都偏高=疑似 Codex 注入了系统提示词。',
  param_min: '参数下限验真：发 max_output_tokens=1。真官方上游会报「需 >= 16」(integer_below_min_value)=验真正向信号；正常返回则结合身份——Codex 渠道不识别该字段属合理，否则可能网关忽略/逆向（不报错≠假，记“不适用”）。',
  codex_verdict: '综合研判（信息项）：汇总渠道(resp_)、身份自述、max_output_tokens 精确截断计费、input_tokens 注入信号，给出「纯官方直连 / Codex CLI 渠道 / 非官渠道」明确结论。',
  thinking_probe: '思考能力 + 参数代际验真：发与模型代匹配的思考参数（3 系 thinkingLevel / 2.5 系 thinkingBudget），看 thoughtsTokenCount>0；对 2.5 系额外发新版参数验证官方会拒绝错代参数。',
  error_shape: '弃用参数验真：发 temperature/top_p（最新 Claude 已弃用）。真官方上游会报「不支持/已弃用」=验真正向信号；不报错≠假（网关可能静默忽略），记“不适用”，需自行与渠道商确认。',
  long_context: '长上下文真实性：植入暗号到约 32k/100k token 大文本，检查是否被截断。',
};

const state = {
  protocol: 'anthropic',
  mode: 'S',
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
  fillLinks();
  selectProtocol('anthropic');
  renderHistory();   // 从 localStorage 读出历史并渲染（刷新不丢的兑现点）
  bindHistoryModal();
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
  renderProbeToggles();
  renderProbeDocs();
  renderCards();
  renderConfigStore();   // 切协议 → 刷新该协议下的本地配置库
}

function renderProbeToggles() {
  const p = PROTOCOLS[state.protocol];
  const box = $('#probeToggles');
  box.innerHTML = '';
  for (const probe of p.probes) {
    const on = probe.modes.includes(state.mode);
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" data-id="${probe.id}" ${on ? 'checked' : ''}> ${probe.name} <span class="w">w${probe.weight}${probe.heavy ? ' · 耗费高' : ''}</span>`;
    // 勾选/取消探针后，按新的勾选集合重建卡片（保留手改请求体）并复位结果
    label.querySelector('input').addEventListener('change', () => { state.results = {}; renderCards(); });
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
    // 切换检测深度后，按新档位的探针集合重建卡片并复位结果
    state.results = {};
    renderCards();
  });
  // 改模型名后，未手改的请求体模板用新模型重建（手改过的保留），并复位旧结果
  $('#model').addEventListener('change', () => { state.results = {}; renderCards(); });
  $('#runBtn').onclick = runAll;
  $('#summaryBtn').onclick = doSummary;
  $('#shareBtn').onclick = doShare;
  // 配置库：保存按钮 + 备注框回车保存 + 折叠开关
  $('#cfgSaveBtn').onclick = saveCurrentConfig;
  $('#cfgLabel').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveCurrentConfig(); } });
  $('#cfgToggle').onclick = () => {
    const store = $('#cfgStore');
    const collapsed = store.classList.toggle('collapsed');
    $('#cfgToggle').setAttribute('aria-expanded', String(!collapsed));
  };
}

function cfg() {
  return {
    targetUrl: resolveTargetUrl(),
    apiKey: $('#apiKey').value.trim(),
    authStyle: PROTOCOLS[state.protocol].authStyle,
  };
}

/* 计算最终目标 URL。
 * Gemini 原生路径模型名在 URL 里（…/models/{model}:generateContent），所以以 #model 框为准
 * 自动拼接；其余协议直接用 #endpoint 原值。 */
function resolveTargetUrl() {
  const base = $('#endpoint').value.trim();
  if (state.protocol === 'gemini') return geminiUrl(base, $('#model').value.trim());
  return base;
}

/* 幂等拼接 Gemini 原生 generateContent URL（兼容用户多种填法）：
 * - 已含 :generateContent / :streamGenerateContent 等动作 → 原样用
 * - 以 /models 结尾 → 拼 /{model}:generateContent
 * - 以 /models/{model} 结尾（漏了动作）→ 补 :generateContent
 * - 其它（如填到 .../v1beta）→ 当根基址补全 /models/{model}:generateContent */
function geminiUrl(base, model) {
  base = (base || '').trim().replace(/\/+$/, '');
  if (!base) return base;
  if (/:(generate|streamGenerate|count|embed)\w*content/i.test(base)) return base;
  if (/\/models$/i.test(base)) return `${base}/${model}:generateContent`;
  if (/\/models\/[^/:]+$/i.test(base)) return `${base}:generateContent`;
  return `${base}/models/${model}:generateContent`;
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
  // 重建前保留用户手动改过的请求体（按探针 id 记忆 .touched 的 textarea），
  // 这样切换模型/深度/勾选项重建卡片时，不会冲掉用户的自定义编辑。
  const edited = {};
  $$('#cards .probe-card').forEach((card) => {
    const rb = card.querySelector('.reqBox');
    if (rb && rb.dataset.touched) edited[card.dataset.id] = rb.value;
  });
  box.innerHTML = '';
  // 顶部汇总行（运行后填充）
  const summary = document.createElement('div');
  summary.id = 'resultSummary';
  summary.className = 'result-summary';
  summary.style.display = 'none';
  box.appendChild(summary);
  const probes = selectedProbes();
  for (const probe of probes) {
    const card = buildCard(probe);
    if (edited[probe.id] !== undefined) {
      const rb = card.querySelector('.reqBox');
      rb.value = edited[probe.id];
      rb.dataset.touched = '1';
    }
    box.appendChild(card);
  }
  renderCardsNav();
  updateOverview();
}

/* ---------------- 左侧目录导航（顺序指引 + 一键跳转） ----------------
 * 按当前选中探针顺序列出；点击 → 平滑滚动到对应卡片并自动展开请求/响应。
 * 每项左侧色点随检测进度更新（未运行/运行中/真/存疑/假/严重/不适用）。
 */
function renderCardsNav() {
  const nav = $('#cardsNav');
  if (!nav) return;
  const probes = selectedProbes();
  nav.innerHTML = '<div class="nav-title">检测项目录</div>' + probes.map((p, i) => `
    <button class="nav-item" data-id="${p.id}">
      <span class="nav-dot"></span>
      <span class="nav-idx">${i + 1}</span>
      <span class="nav-name" title="${core.esc(p.name)}">${core.esc(p.name)}</span>
    </button>`).join('');
  nav.querySelectorAll('.nav-item').forEach((it) => { it.onclick = () => focusCard(it.dataset.id); });
  // 回填已有结果的状态点（重建目录时不丢失已跑出的状态）
  for (const [id, r] of Object.entries(state.results)) setNavStatus(id, navClsOf(r.result));
}

/* 结果 → 目录状态类（与卡片徽标配色一致） */
function navClsOf(result) {
  if (!result) return '';
  if (result.status === 'error') return 'warn';
  if (result.status === 'skip') return 'skip';
  if (result.severity === 'critical') return 'crit';
  return core.verdictBadge(result).cls;
}

function setNavStatus(id, cls) {
  const it = $(`#cardsNav .nav-item[data-id="${id}"]`);
  if (!it) return;
  it.classList.remove('running', 'pass', 'warn', 'fail', 'crit', 'na', 'skip');
  if (cls) it.classList.add(cls);
}

/* 跳转到指定探针卡片：展开（去 compact/prerun）+ 打开请求/响应 + 平滑滚动 + 高亮闪一下 */
function focusCard(id) {
  const card = $(`#cards .probe-card[data-id="${id}"]`);
  if (!card) return;
  card.classList.remove('compact', 'prerun');
  const io = card.querySelector('.io-detail');
  if (io) io.open = true;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  card.classList.remove('flash');
  void card.offsetWidth;   // 强制重排以重启动画
  card.classList.add('flash');
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
  // 标记用户是否手动改过请求体：改过的在重建卡片时保留，不被新模型模板冲掉。
  const reqBox = card.querySelector('.reqBox');
  if (reqBox) reqBox.addEventListener('input', () => { reqBox.dataset.touched = '1'; });
  return card;
}

/* ---------------- 运行单个探针 ---------------- */
async function runOne(probe, card) {
  const badge = card.querySelector('.vbadge');
  badge.className = 'vbadge skip'; badge.innerHTML = '<span class="spinner"></span> 运行中';
  setNavStatus(probe.id, 'running');
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
  const base = { model: $('#model').value.trim(), requestPayload: payload, shared: sharedCtx(), httpStatus: 0, headers: {}, body: '', json: null };

  const send = async (pl) => {
    const r = await core.proxyFetch(c, pl, eh);
    const parsed = r.body ? core.parseJsonLoose(r.body) : { ok: false };
    return { raw: r, json: parsed.ok ? parsed.value : null };
  };

  if (probe.multi) {
    const runs = [];
    const rounds = [];
    const n = state.mode === 'Q' ? 1 : probe.multi;
    let last;
    for (let i = 0; i < n; i++) {
      last = await send(payload);
      if (last.json) runs.push(last.json);
      rounds.push({ label: `第 ${i + 1} 轮`, body: last.raw.body, httpStatus: last.raw.httpStatus, id: last.json?.id });
    }
    return { ...base, httpStatus: last.raw.httpStatus, headers: last.raw.headers, body: last.raw.body, json: last.json, multiJson: runs, rounds };
  }
  if (probe.tokenPair) {
    const short = await send(payload);
    const longPayload = JSON.parse(JSON.stringify(payload));
    appendLongText(longPayload);
    const long = state.mode === 'Q' ? null : await send(longPayload);
    // 可选官方 count
    let officialInputTokens = null;
    if (state.protocol === 'anthropic') officialInputTokens = await tryOfficialCount(payload);
    const rounds = [{ label: '短请求', body: short.raw.body, httpStatus: short.raw.httpStatus, id: short.json?.id }];
    if (long) rounds.push({ label: '长请求(追加文本)', body: long.raw.body, httpStatus: long.raw.httpStatus, id: long.json?.id });
    return { ...base, httpStatus: short.raw.httpStatus, headers: short.raw.headers, body: short.raw.body, json: short.json, shortJson: short.json, longJson: long?.json, officialInputTokens, rounds };
  }
  if (probe.dualFixed) {
    // 双固定句对照：发 A=payload（主句）与 B=probe.payloadB（对照句），两条都是固定输入、
    // 不追加长文本（区别于 tokenPair）。用于 max_output_tokens 强验真 + input_tokens 双基线注入检测。
    const a = await send(payload);
    const payloadB = probe.payloadB ? probe.payloadB($('#model').value.trim()) : payload;
    const b = state.mode === 'Q' ? null : await send(payloadB);
    const rounds = [{ label: 'A·主句', body: a.raw.body, httpStatus: a.raw.httpStatus, id: a.json?.id }];
    if (b) rounds.push({ label: 'B·对照句', body: b.raw.body, httpStatus: b.raw.httpStatus, id: b.json?.id });
    return { ...base, httpStatus: a.raw.httpStatus, headers: a.raw.headers, body: a.raw.body, json: a.json, jsonA: a.json, jsonB: b?.json, rounds };
  }
  if (probe.dualStream) {
    const ns = await send(payload);
    const streamPayload = { ...payload, stream: true };
    const st = await send(streamPayload);
    const sse = st.raw.body && /data:/.test(st.raw.body) ? core.parseSSE(st.raw.body) : null;
    const rounds = [
      { label: '非流式', body: ns.raw.body, httpStatus: ns.raw.httpStatus, id: ns.json?.id },
      { label: '流式(SSE)', body: st.raw.body, httpStatus: st.raw.httpStatus, id: sse?.message?.id },
    ];
    return { ...base, httpStatus: ns.raw.httpStatus, headers: ns.raw.headers, body: ns.raw.body, json: ns.json, nonStreamJson: ns.json, streamMessage: sse?.message, rounds };
  }
  // stream 或普通
  const r = await send(payload);
  return { ...base, httpStatus: r.raw.httpStatus, headers: r.raw.headers, body: r.raw.body, json: r.json, requestId: r.raw.requestId };
}

function sharedCtx() {
  // 跨探针共享：渠道判定、注入信号等。stage 串行保证后序探针读到前序写入。
  const ch = state.results.channel_id?.result?._ctx?.shared?.channel;
  const inj = state.results.param_check?.result?._ctx?.shared?.injection;
  return { channel: ch || null, injection: inj || null };
}

function appendLongText(payload) {
  const ref = '\n\nReference text:' + ' apple'.repeat(80);
  // Anthropic / OpenAI 兼容端：messages[last].content 字符串
  const msgs = payload.messages;
  if (Array.isArray(msgs) && msgs.length) {
    const last = msgs[msgs.length - 1];
    if (last && typeof last.content === 'string') { last.content += ref; return; }
  }
  // OpenAI Responses：input[last].content 字符串
  const input = payload.input;
  if (Array.isArray(input) && input.length) {
    const last = input[input.length - 1];
    if (last && typeof last.content === 'string') { last.content += ref; return; }
  }
  // Gemini 原生：contents[last].parts[0].text
  const contents = payload.contents;
  if (Array.isArray(contents) && contents.length) {
    const last = contents[contents.length - 1];
    const part = last?.parts?.[0];
    if (part && typeof part.text === 'string') { part.text += ref; }
  }
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
    const pre = card.querySelector('.respBox');
    pre.classList.remove('muted');
    // 多轮探针（缓存/一致性/Token 计费/流式对照等）：把每一轮请求的响应都展示出来，
    // 而不是只显示最后一轮，便于核对「第一轮创建缓存 → 第二轮命中缓存」这类跨轮证据。
    const rounds = Array.isArray(ctx.rounds) ? ctx.rounds : null;
    if (rounds && rounds.length > 1) {
      meta.innerHTML = `${rounds.length} 轮请求 · ` + rounds.map((r) => {
        const cls = r.httpStatus >= 200 && r.httpStatus < 300 ? 'code-ok' : 'code-bad';
        return `${core.esc(r.label)} <span class="${cls}">${r.httpStatus}</span>`;
      }).join(' · ');
      pre.textContent = rounds.map((r) =>
        `──────── ${r.label}　HTTP ${r.httpStatus}${r.id ? '　id: ' + r.id : ''} ────────\n`
        + (r.body ? core.pretty(r.body) : '(空响应)')
      ).join('\n\n');
    } else {
      meta.innerHTML = `HTTP <span class="${codeCls}">${ctx.httpStatus}</span>` + (ctx.requestId ? ` · request-id: ${core.esc(ctx.requestId)}` : '') + (ctx.json?.id ? ` · id: ${core.esc(ctx.json.id)}` : '');
      pre.textContent = ctx.body ? core.pretty(ctx.body) : '(空响应)';
    }
  }
  const ana = card.querySelector('.pc-analysis');
  ana.style.display = '';
  const fUl = ana.querySelector('.feats ul'), dUl = ana.querySelector('.diffs ul');
  fUl.innerHTML = (result.features || []).map((f) => `<li>${core.esc(f)}</li>`).join('') || '<li class="muted">无</li>';
  dUl.innerHTML = (result.diffs || []).map((d) => `<li>${core.esc(d)}</li>`).join('') || '<li class="muted">无差异</li>';
  // 同步左侧目录的状态色点
  if (probe) setNavStatus(probe.id, navClsOf(result));
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

/* ---------------- 一键全检 ----------------
 * 编排：channel_id（渠道来源识别）必须先跑——它会把判定出的渠道写入
 * ctx.shared.channel，其余探针都依赖它。剩余探针之间彼此独立，
 * 因此并发执行（带并发上限，避免对中转站瞬时打太多并发被限流/误判）。
 */
const RUN_CONCURRENCY = 6;

async function runPool(items, worker, limit) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

async function runAll() {
  if (!cfg().targetUrl) { toast('请先填写接口地址'); return; }
  const btn = $('#runBtn'); btn.disabled = true; btn.textContent = '检测中…';
  state.results = {};
  // 重新检测：用当前「模型 / 检测深度 / 勾选项」从头重建卡片（保留手改的请求体），
  // 既保证请求用的是最新模型名，也让每次检测都从干净状态开始。
  renderCards();
  const cards = $$('#cards .probe-card');
  const probes = selectedProbes();
  const cardOf = (probe) => cards.find((c) => c.dataset.id === probe.id);

  // 阶段化编排：按 probe.stage（缺省 99）升序分组，组内并发、组间串行。
  // 渠道识别(stage 0)→身份识别(stage 1)先跑并把判定写入 ctx.shared.channel，
  // 依赖渠道结果的探针（如 OpenAI param_check, stage 2）随后才跑，避免并发竞态。
  const stages = [...new Set(probes.map((p) => p.stage ?? 99))].sort((a, b) => a - b);
  for (const s of stages) {
    const group = probes.filter((p) => (p.stage ?? 99) === s);
    await runPool(group, async (probe) => {
      const card = cardOf(probe);
      if (card) await runOne(probe, card);
    }, RUN_CONCURRENCY);
  }

  btn.disabled = false; btn.textContent = '🟢 开始检测';
  updateOverview();
  reflowCards();
  saveHistory();   // 整套检测跑完 → 自动存一条历史快照到本地（单项「发送」不触发）
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
  const results = Object.values(state.results).map(({ probe, result }) => {
    const ctx = result._ctx || {};
    // 附带真实请求体/响应体，供报告页「查看请求体/响应体」自查取证（PNG 导出时不展示）。
    // key 走 header 不进 body，请求体本身不含 key，原样存。
    const io = {
      request: ctx.requestPayload ?? null,
      httpStatus: ctx.httpStatus ?? null,
      // 多轮探针（multi/tokenPair/dualStream）按轮存；单次存单个 body。
      rounds: Array.isArray(ctx.rounds) && ctx.rounds.length > 1
        ? ctx.rounds.map((r) => ({ label: r.label, httpStatus: r.httpStatus, body: r.body }))
        : null,
      response: ctx.body ?? null,
    };
    const hasIo = io.request != null || io.response != null || (io.rounds && io.rounds.length);
    return {
      name: probe.name, score: result.score, weight: probe.weight,
      verdict: result.verdict, severity: result.severity, status: result.status,
      features: result.features || [], diffs: result.diffs || [],
      io: hasIo ? io : null,
    };
  });
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
    // 复制给用户的：无后缀干净版（线上伪静态 …/report?id=xxx，更专业）
    try { await navigator.clipboard.writeText(r.url); } catch { /* ignore */ }
    toast(`分享链接已复制（${r.mode === 'short' ? '短链接' : '静态链接'}）：${r.url}`);
    // 我们自己打开预览的：带 .html 后缀版，不依赖伪静态，任何部署都能打开（用户看不到此 URL）
    window.open(openableUrl(r.url), '_blank');
  } else toast('分享失败');
}

/* 把无后缀分享链接转成带 .html 后缀的可直接打开版（仅用于 window.open 预览，不复制给用户）。
 * 兼容两种形态：短链 …/report?id=xxx → …/report.html?id=xxx；退化长链 …/report#data=… → …/report.html#data=… */
function openableUrl(url) {
  try {
    const u = new URL(url);
    if (u.pathname.endsWith('/report')) u.pathname += '.html';
    return u.toString();
  } catch { return url; }
}

/* ---------------- 配置库（本地保存接口/模型/Key/beta，按御三家协议归类） ----------------
 * 全部存于浏览器 localStorage，不经过任何后端；按 state.protocol 分桶，
 * 切到哪个协议只展示哪个协议的配置（御三家接口不同，互不混淆）。
 * 数据形如：{ openai:[{label,endpoint,model,key,beta,ts}], anthropic:[...], gemini:[...] }
 */
const CFG_KEY = 'apicheck.savedConfigs.v1';
const PROTO_NAMES = { openai: 'OpenAI', anthropic: 'Claude', gemini: 'Gemini' };

function loadConfigStore() {
  try {
    const o = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
    return (o && typeof o === 'object') ? o : {};
  } catch { return {}; }
}
function saveConfigStore(store) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(store)); return true; }
  catch { toast('保存失败：本地存储不可用或已满'); return false; }
}
function currentConfigs() {
  const store = loadConfigStore();
  return Array.isArray(store[state.protocol]) ? store[state.protocol] : [];
}

/* 把当前输入区表单存为一条配置（同协议下按备注标签去重覆盖） */
function saveCurrentConfig() {
  const endpoint = $('#endpoint').value.trim();
  const model = $('#model').value.trim();
  const key = $('#apiKey').value.trim();
  const beta = $('#betaHeader').value.trim();
  let label = $('#cfgLabel').value.trim();
  if (!endpoint && !key) { toast('请先填写接口地址或 Key 再保存'); return; }
  if (!label) label = (() => { try { return new URL(endpoint).host; } catch { return '未命名配置'; } })();

  const store = loadConfigStore();
  const list = Array.isArray(store[state.protocol]) ? store[state.protocol] : [];
  const item = { label, endpoint, model, key, beta };
  const i = list.findIndex((x) => x.label === label);
  if (i >= 0) list[i] = item; else list.push(item);
  store[state.protocol] = list;
  if (saveConfigStore(store)) {
    $('#cfgLabel').value = '';
    renderConfigStore();
    toast(i >= 0 ? `已更新「${label}」` : `已保存「${label}」到本地`);
  }
}

/* 点击胶囊 → 把该配置导入当前输入区 */
function loadConfig(idx) {
  const list = currentConfigs();
  const c = list[idx];
  if (!c) return;
  $('#endpoint').value = c.endpoint || '';
  $('#model').value = c.model || '';
  $('#apiKey').value = c.key || '';
  if (state.protocol === 'anthropic') $('#betaHeader').value = c.beta || '';
  // 模型可能变了 → 复位结果并按新模型重建卡片模板
  state.results = {};
  renderCards();
  toast(`已导入「${c.label}」`);
}

function deleteConfig(idx) {
  const store = loadConfigStore();
  const list = Array.isArray(store[state.protocol]) ? store[state.protocol] : [];
  const c = list[idx];
  if (!c) return;
  list.splice(idx, 1);
  store[state.protocol] = list;
  saveConfigStore(store);
  renderConfigStore();
  toast(`已删除「${c.label}」`);
}

/* 渲染当前协议下的配置胶囊列表 */
function renderConfigStore() {
  const nameEl = $('#cfgProtoName');
  if (nameEl) nameEl.textContent = `· 当前 ${PROTO_NAMES[state.protocol] || ''} 配置`;
  const box = $('#cfgSaved');
  if (!box) return;
  const list = currentConfigs();
  if (!list.length) {
    box.innerHTML = `<div class="cfg-empty">暂无已存配置。填好上方接口后，写个备注点「保存当前配置」即可。</div>`;
    return;
  }
  box.innerHTML = list.map((c, i) => {
    // 副标题只显示域名（/v1 之前的 host 部分），更简洁
    const host = (() => { try { return new URL(c.endpoint).host; } catch { return c.endpoint || ''; } })();
    return `<span class="cfg-chip">
        <button class="cfg-chip-load" data-idx="${i}" title="点击导入到当前输入区">
          <span class="cc-label">${core.esc(c.label)}</span>
          ${host ? `<span class="cc-meta">${core.esc(host)}</span>` : ''}
        </button>
        <button class="cfg-chip-edit" data-idx="${i}" title="重命名备注">✎</button>
        <button class="cfg-chip-del" data-idx="${i}" title="删除此配置">✕</button>
      </span>`;
  }).join('');
  box.querySelectorAll('.cfg-chip-load').forEach((b) => { b.onclick = () => loadConfig(+b.dataset.idx); });
  box.querySelectorAll('.cfg-chip-edit').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); startRename(+b.dataset.idx); }; });
  box.querySelectorAll('.cfg-chip-del').forEach((b) => { b.onclick = () => deleteConfig(+b.dataset.idx); });
}

/* 行内重命名备注：把该胶囊的标签文字换成输入框，回车/失焦保存，Esc 取消 */
function startRename(idx) {
  const list = currentConfigs();
  const c = list[idx];
  if (!c) return;
  const chip = $(`#cfgSaved .cfg-chip-load[data-idx="${idx}"]`)?.closest('.cfg-chip');
  const labelEl = chip?.querySelector('.cc-label');
  if (!labelEl) return;
  // 已在编辑中则忽略
  if (chip.querySelector('.cc-edit')) return;

  const input = document.createElement('input');
  input.className = 'cc-edit';
  input.maxLength = 40;
  input.value = c.label;
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    if (commit) {
      const next = input.value.trim();
      if (next && next !== c.label) {
        // 同协议下别名不可与其他配置重名
        if (list.some((x, j) => j !== idx && x.label === next)) {
          toast(`已存在备注「${next}」，换一个吧`);
          renderConfigStore();
          return;
        }
        const store = loadConfigStore();
        const arr = Array.isArray(store[state.protocol]) ? store[state.protocol] : [];
        if (arr[idx]) { arr[idx].label = next; store[state.protocol] = arr; saveConfigStore(store); toast(`已重命名为「${next}」`); }
      }
    }
    renderConfigStore();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

/* ---------------- 检测历史（本地，仅存浏览器 localStorage） ----------------
 * 每跑完一整套检测（runAll）自动存一条快照（复用 buildReportPayload()，
 * 天生不含 API Key、只含域名 host，符合「不保存 Key/数据」承诺）。
 * 切协议/刷新页面都不丢失。点「查看详情」用 iframe 嵌 report.html 复用报告页完整渲染。
 * 数据形如：[{ id, savedAt, protocol, model, targetHost, channel, totalScore, verdict, critical, results[] }, ...]，时间倒序。
 */
const HISTORY_KEY = 'apicheck.history.v1';
const HISTORY_MAX = 30;

function loadHistory() {
  try {
    const a = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
function persistHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); return true; }
  catch { toast('历史保存失败：本地存储不可用或已满'); return false; }
}

/* 生成一个本地唯一 id（仅用于删除定位，不含敏感信息） */
let _histSeq = 0;
function newHistoryId() {
  _histSeq = (_histSeq + 1) % 100000;
  return 'h' + new Date().getTime().toString(36) + _histSeq.toString(36);
}

/* runAll 跑完调用：打快照 → 入队头 → 超 30 条删最旧 → 写回 → 刷新面板 */
function saveHistory() {
  if (!Object.keys(state.results).length) return;   // 空结果不存（保险）
  const snap = buildReportPayload();
  snap.id = newHistoryId();
  snap.savedAt = new Date().toISOString();
  const list = loadHistory();
  list.unshift(snap);
  if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;   // 截断尾部最旧
  if (persistHistory(list)) renderHistory();
}

/* 综合分 → 徽标配色类（与报告页 level 阈值一致：85/70/50） */
function scoreCls(item) {
  if (item.critical) return 'crit';
  const s = item.totalScore || 0;
  if (s >= 70) return 'pass';
  if (s >= 50) return 'warn';
  return 'fail';
}

/* 把 ISO 时间格式化成「MM-DD HH:mm」（本地时区，简洁占位少） */
function fmtTime(iso) {
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return (iso || '').slice(5, 16).replace('T', ' '); }
}

/* 渲染右侧历史面板 */
function renderHistory() {
  const list = loadHistory();
  const countEl = $('#historyCount');
  if (countEl) countEl.textContent = list.length ? ` (${list.length})` : '';
  const clearBtn = $('#historyClearBtn');
  if (clearBtn) clearBtn.style.display = list.length ? '' : 'none';
  const box = $('#historyList');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `<div class="history-empty">暂无检测记录。点「🟢 开始检测」跑完一次后会自动记录在这里，仅存本机浏览器。</div>`;
    return;
  }
  box.innerHTML = list.map((it) => {
    const proto = PROTOCOLS[it.protocol];
    const ico = proto?.icon
      ? `<img class="hi-ico" src="${proto.icon}" alt="${core.esc(proto.name || it.protocol)}">`
      : `<span class="hi-ico">${proto?.emoji || '•'}</span>`;
    const cls = scoreCls(it);
    const score = (it.totalScore != null ? it.totalScore : '--');
    return `<div class="history-item">
        <button class="history-open" data-id="${it.id}" title="查看完整检测报告">
          <span class="hi-top">
            <span class="hi-time">${fmtTime(it.savedAt)}</span>
            <span class="hi-score ${cls}">${score}分</span>
          </span>
          <span class="hi-bot">
            ${ico}
            <span class="hi-model">${core.esc(it.model || it.protocol || '—')}</span>
            <span class="hi-host">${core.esc(it.targetHost || '')}</span>
          </span>
        </button>
        <button class="history-del" data-id="${it.id}" title="删除这条记录">✕</button>
      </div>`;
  }).join('');
  box.querySelectorAll('.history-open').forEach((b) => { b.onclick = () => openHistoryDetail(b.dataset.id); });
  box.querySelectorAll('.history-del').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); deleteHistory(b.dataset.id); }; });
}

function deleteHistory(id) {
  const list = loadHistory().filter((x) => x.id !== id);
  if (persistHistory(list)) renderHistory();
}

function clearHistory() {
  if (!loadHistory().length) return;
  if (!confirm('确定清空全部检测历史吗？此操作不可恢复（仅清除本机浏览器中的记录）。')) return;
  if (persistHistory([])) { renderHistory(); toast('已清空检测历史'); }
}

/* ---------------- 检测历史「查看详情」弹窗（iframe 嵌 report.html#data=） ---------------- */
function bindHistoryModal() {
  const toggle = $('#historyToggle');
  if (toggle) toggle.onclick = () => {
    const store = $('#historyStore');
    const collapsed = store.classList.toggle('collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
  };
  const clearBtn = $('#historyClearBtn');
  if (clearBtn) clearBtn.onclick = clearHistory;

  const overlay = $('#historyModal');
  const closeBtn = $('#historyModalClose');
  if (closeBtn) closeBtn.onclick = closeHistoryDetail;
  // 点遮罩空白处关闭（点弹窗本体不关）
  if (overlay) overlay.onclick = (e) => { if (e.target === overlay) closeHistoryDetail(); };
  // Esc 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && overlay.style.display !== 'none') closeHistoryDetail();
  });
}

function openHistoryDetail(id) {
  const item = loadHistory().find((x) => x.id === id);
  if (!item) { toast('记录不存在'); return; }
  const overlay = $('#historyModal');
  const frame = $('#historyModalFrame');
  const title = $('#historyModalTitle');
  if (!overlay || !frame) return;
  // 与 core.shareReport 的 hash 静态分享同款编码，report.js 的 #data= 分支会原样解码渲染
  const packed = btoa(unescape(encodeURIComponent(JSON.stringify(item))));
  // iframe 内部加载用带后缀的 report.html（用户看不到此 URL，且不依赖服务器伪静态，任何部署都稳）；
  // 用户能看到/复制的对外链接（shareReport 生成的）才去掉 .html 后缀。
  frame.src = `report.html#data=${packed}`;
  if (title) title.textContent = `检测报告 · ${fmtTime(item.savedAt)} · ${item.model || item.protocol || ''}`;
  overlay.style.display = '';
  overlay.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';   // 锁背景滚动
}

function closeHistoryDetail() {
  const overlay = $('#historyModal');
  const frame = $('#historyModalFrame');
  if (!overlay) return;
  overlay.style.display = 'none';
  overlay.setAttribute('aria-hidden', 'true');
  if (frame) frame.src = 'about:blank';   // 卸载 iframe，释放内存
  document.body.style.overflow = '';
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
