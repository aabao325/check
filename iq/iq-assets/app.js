/* =====================================================================
 * iq-assets/app.js —— 大模型智商检测 · 页面逻辑（多任务并发版）
 * ---------------------------------------------------------------------
 * 参考 image/js/models/videoTask.js 的「任务管理器」模式：
 *   - 题库支持多选，每选一题在中间「任务列表」加一张任务卡
 *   - 每个任务的状态/流式缓冲存在 tasks Map（不绑定 DOM），切题不丢正在生成的任务
 *   - 各任务独立并发请求同一模型；每卡自带「开始/重测」按钮，全局「开始检测」批量跑
 *   - 详情区显示当前查看任务的完整对比（标准答案 | 模型输出 + AI 评审）
 * ===================================================================== */
import { QUESTIONS, getQuestion, fullPrompt } from './questions.js?v=2';
import { paintSummary } from './summary-format.js?v=2';

/* ---------- 后端地址（短小内部服务，仍走服务端） ---------- */
const SUMMARY_URL = './iq-summary.php';
const SHARE_URL   = './iq-share.php';
// 兜底中转：仅当浏览器直连因 CORS/网络失败时静默改走它（流式转发，不阻塞，详见 iq-proxy.php）
const PROXY_URL   = './iq-proxy.php';

/* ---------- localStorage 键 ---------- */
const CFG_KEY     = 'iqcheck.savedConfigs.v1';
const HISTORY_KEY = 'iqcheck.history.v1';
const HISTORY_MAX = 40;

/* ---------- DOM 简写 ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ---------- Toast ----------
 *
 * ⚠️ 挂在**屏幕顶部居中**，不是底部。复制链接这件事用户不会盯着页面底部看 ——
 *    提示要在视线自然落点上，才叫「有反馈」；底部提示在长页面上常常压根不在视野里。
 *
 * kind 决定配色与图标（配色见 styles.css 的 .toast）：
 *   'ok' 成功（绿勾）/ 'warn' 需注意（橙）/ 'bad' 失败（红），不给就是中性深色。
 * ⚠️ 三站的 toast **外观与时长统一**为同一套，改这里时另两站一起改。 */
let toastTimer = null;
function toast(msg, kind = '') {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.className = `toast${kind ? ` ${kind}` : ''}`;
  // 重新触发入场动画：先摘类、强制重排、再加回来。不清这一步的话，连续两条提示
  //（比如先「请先运行检测」再「链接已复制」）第二条不会有动画，看着像卡住了。
  el.classList.remove('show');
  void el.offsetWidth;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
}

/* =====================================================================
 * 协议判定 + 思考参数映射（纯逻辑）
 * ===================================================================== */
const THINK_LEVELS = [
  { key: 'adaptive', label: '自适应 / 默认（不显式传）' },
  { key: 'off',      label: '关闭思考' },
  { key: 'low',      label: '低' },
  { key: 'medium',   label: '中' },
  { key: 'high',     label: '高' },
  { key: 'xhigh',    label: '极高' },
];
const ANTHRO_BUDGET = { low: 4000, medium: 8000, high: 16000, xhigh: 24000 };
const PROTO_META = {
  chat:      { name: 'OpenAI Chat Completions', auth: 'Bearer',    thinkField: 'reasoning_effort（输出上限按模型自动选 max_tokens / max_completion_tokens）' },
  responses: { name: 'OpenAI Responses',        auth: 'Bearer',    thinkField: 'reasoning.effort' },
  anthropic: { name: 'Anthropic Messages',      auth: 'x-api-key', thinkField: 'thinking.budget_tokens' },
};

/* 三个可选接口路径（供地址栏下方的按钮切换）。
 * 顺序＝匹配优先级：先长后短，避免 /v1/chat/completions 被 /v1/completions 抢先命中。 */
const PATH_OPTIONS = [
  { proto: 'chat',      path: '/v1/chat/completions', match: ['/v1/chat/completions', '/chat/completions'] },
  { proto: 'responses', path: '/v1/responses',        match: ['/v1/responses', '/responses'] },
  { proto: 'anthropic', path: '/v1/messages',         match: ['/v1/messages', '/messages'] },
];

/* 把用户填的地址拆成「站点前缀 + 已识别的接口路径 + 尾巴(query/hash)」。
 * 识别不出路径时 path 为 ''（base 即原文去尾斜杠），此时按钮全部未选中。
 * 注意用 lastIndexOf：中转站自身可能带 /messages 之类的前缀路径，取最后一次出现的更准。 */
function splitEndpoint(raw) {
  const s0 = (raw || '').trim();
  if (!s0) return { base: '', path: '', tail: '', proto: '' };
  const cut = s0.search(/[?#]/);
  const tail = cut >= 0 ? s0.slice(cut) : '';
  const s = (cut >= 0 ? s0.slice(0, cut) : s0).replace(/\/+$/, '');
  const low = s.toLowerCase();
  for (const o of PATH_OPTIONS) {
    for (const m of o.match) {
      const i = low.lastIndexOf(m);
      if (i >= 0 && i + m.length === low.length) {
        return { base: s.slice(0, i).replace(/\/+$/, ''), path: o.path, tail, proto: o.proto };
      }
    }
  }
  return { base: s, path: '', tail, proto: '' };
}

function detectProtocol(endpoint) {
  // 优先按「路径结尾精确匹配」判定，与地址栏下方按钮的高亮口径完全一致
  const hit = splitEndpoint(endpoint).proto;
  if (hit) return hit;
  // 兜底：路径不规范（多带了后缀等）时退回宽松包含判断
  const u = (endpoint || '').toLowerCase();
  if (u.includes('/messages')) return 'anthropic';
  if (u.includes('/responses')) return 'responses';
  return 'chat';
}

/* Chat Completions 的输出上限字段名：新模型（gpt-5.x / o 系列）只认 max_completion_tokens，
 * 老模型与多数中转站只认 max_tokens，两者互斥。同一个 /v1/chat/completions 路径上新老模型
 * 要求相反，光看路径判不出来，所以先按模型名猜一个，被上游拒了再换另一个重发（见 sendTask）。
 * 猜准能省一次往返；猜不准也只是多一次请求，不会失败。 */
function pickChatTokensField(model, forced) {
  if (forced === 'max_tokens' || forced === 'max_completion_tokens') return forced;
  return /^(gpt-5|o[1-9]|o\d)/i.test(String(model || '').trim()) ? 'max_completion_tokens' : 'max_tokens';
}

/* 上游拒绝了输出上限字段名 → 给出该换的那个名；认不出返回 null（说明是别的错，
 * 例如模型名写错，那种情况重发只是白烧额度）。覆盖中英文两种常见措辞。 */
function maxTokensFieldFallback(bodyText, tried) {
  const s = String(bodyText || '');
  const other = tried === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
  if (!s.includes(other)) return null;
  if (/unsupported_parameter|is not supported with this model|does not support/i.test(s)) return other;
  if (new RegExp(`(${other}[^"']{0,40}(不支持|无效|请(改为|使用)|改用))|((不支持|无效|请(改为|使用)|改用)[^"']{0,40}${other})`, 'i').test(s)) return other;
  return null;
}

function buildRequest({ endpoint, model, prompt, think, maxTokens, chatTokensField }) {
  const protocol = detectProtocol(endpoint);
  const mt = maxTokens || 8192;
  let payload, extraHeaders = {};
  const authStyle = PROTO_META[protocol].auth;
  if (protocol === 'chat') {
    const field = pickChatTokensField(model, chatTokensField);
    payload = { model, messages: [{ role: 'user', content: prompt }], [field]: mt, stream: true };
    if (think !== 'adaptive' && think !== 'off') payload.reasoning_effort = think;
    else if (think === 'off') payload.reasoning_effort = 'minimal';
    return { payload, authStyle, extraHeaders, protocol, chatTokensField: field };
  }
  if (protocol === 'responses') {
    payload = { model, input: prompt, max_output_tokens: mt, stream: true };
    if (think !== 'adaptive' && think !== 'off') payload.reasoning = { effort: think };
    else if (think === 'off') payload.reasoning = { effort: 'minimal' };
  } else { // anthropic
    payload = { model, max_tokens: mt, messages: [{ role: 'user', content: prompt }], stream: true };
    extraHeaders['anthropic-version'] = '2023-06-01';
    if (think === 'off') {
      payload.thinking = { type: 'disabled' };
    } else if (think !== 'adaptive') {
      const budget = Math.min(ANTHRO_BUDGET[think] || 8000, mt - 1024);
      if (budget >= 1024) payload.thinking = { type: 'enabled', budget_tokens: budget };
    }
  }
  return { payload, authStyle, extraHeaders, protocol, chatTokensField: null };
}

// 从单个 SSE 事件对象里按协议取「正文增量」
function streamDelta(protocol, obj) {
  if (!obj || typeof obj !== 'object') return '';
  try {
    if (protocol === 'chat') return obj.choices?.[0]?.delta?.content || '';
    if (protocol === 'responses') {
      if (obj.type === 'response.output_text.delta' && typeof obj.delta === 'string') return obj.delta;
      return '';
    }
    if (protocol === 'anthropic') {
      if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') return obj.delta.text || '';
      return '';
    }
  } catch { return ''; }
  return '';
}

function buildHeaders(authStyle, key, extraHeaders) {
  const h = { 'Content-Type': 'application/json' };
  if (key) {
    if (authStyle === 'x-api-key') {
      h['x-api-key'] = key;
      h['Authorization'] = 'Bearer ' + key;
      h['anthropic-dangerous-direct-browser-access'] = 'true';
    } else {
      h['Authorization'] = 'Bearer ' + key;
    }
  }
  Object.entries(extraHeaders || {}).forEach(([k, v]) => { if (v && !(k in h)) h[k] = v; });
  return h;
}

/* =====================================================================
 * 响应文本提取 + HTML 抠取（纯逻辑）
 * ===================================================================== */
function extractText(protocol, json) {
  if (!json || typeof json !== 'object') return '';
  try {
    if (protocol === 'chat') return json.choices?.[0]?.message?.content ?? '';
    if (protocol === 'responses') {
      if (typeof json.output_text === 'string' && json.output_text) return json.output_text;
      const out = json.output;
      if (Array.isArray(out)) {
        const msg = out.find((o) => o && o.type === 'message');
        const t = msg?.content?.find((c) => c && c.type === 'output_text');
        if (t?.text) return t.text;
      }
      return '';
    }
    if (protocol === 'anthropic') {
      const arr = json.content;
      if (Array.isArray(arr)) return arr.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
      return '';
    }
  } catch { return ''; }
  return '';
}

function extractHtml(text) {
  if (!text) return '';
  const fence = text.match(/```(?:html)?\s*\n([\s\S]*?)```/i);
  if (fence && fence[1] && /<(!doctype|html|svg|body|div)/i.test(fence[1])) return fence[1].trim();
  const doc = text.match(/<!DOCTYPE[\s\S]*<\/html>/i) || text.match(/<html[\s\S]*<\/html>/i) || text.match(/<svg[\s\S]*<\/svg>/i);
  if (doc) return doc[0].trim();
  if (/<(html|svg|body|div)[\s>]/i.test(text)) return text.trim();
  return '';
}

// 找 HTML/SVG 正文起点（跳过前置说明/思考）；-1 表示还没出现
function htmlStartIndex(text) {
  if (!text) return -1;
  const fence = text.search(/```(?:html)?\s*\n/i);
  if (fence >= 0) { const nl = text.indexOf('\n', fence); return nl >= 0 ? nl + 1 : -1; }
  const m = text.match(/<(?:!doctype|html|svg|body|head|div|style|script)[\s>]/i);
  return m ? m.index : -1;
}
const STREAM_TAIL = 4000;   // 固定窗口只渲染尾部这么多字符
/* =====================================================================
 * 截图注入：iframe 内把 SVG 序列化成 PNG，经 postMessage 回传父页
 * ===================================================================== */
/* =====================================================================
 * iframe 内自截图：截【整个文档】而非只截 <svg>
 * ---------------------------------------------------------------------
 * 为什么不能只截 <svg>：模型/基线的 HTML 常把标题(<h1>)、渐变背景(body)、
 * 卡片容器(.container) 放在 SVG 外面。只序列化 <svg> 会丢掉这些，导致
 * ①导出图与实际所见不一致 ②AI 视觉裁判看到的图也不是用户看到的图。
 *
 * 为什么不用 html2canvas：它内部要新建 iframe 并读 contentDocument，在
 * sandbox="allow-scripts"（opaque null origin）里会被浏览器拦死：
 * "Blocked a frame with origin null from accessing a cross-origin frame"。已实测。
 *
 * 做法：把 body 子节点用 XMLSerializer 序列化（保证 XHTML 良构）塞进
 * <foreignObject>，并把页面所有 CSS 规则内联进去；body/html 选择器改写成
 * .iq-root 作用到根 div。再 data-URI → Image → canvas → toDataURL。
 * 失败则退回「只截 SVG + 纯色兜底」，至少不空。
 *
 * 已知限制：静态快照，CSS/SMIL 动画会定格在截图那一刻的状态。
 * ===================================================================== */
const SHOT_SCRIPT = `
<script>(function(){
  function send(u,r){ parent.postMessage({__iq:'shot',dataUrl:u||null,reason:r||''},'*'); }
  function bg(el){ try{ var c=getComputedStyle(el).backgroundColor; return (c&&c!=='rgba(0, 0, 0, 0)'&&c!=='transparent')?c:''; }catch(e){ return ''; } }

  // 兜底：只截 SVG（丢背景/标题，但好过没有）
  function shootSvgOnly(){
    try{
      var svg=document.querySelector('svg');
      if(!svg){ send(null,'no-svg'); return; }
      var vb=(svg.viewBox&&svg.viewBox.baseVal)||null;
      var w=svg.clientWidth||(vb&&vb.width)||480;
      var h=svg.clientHeight||(vb&&vb.height)||360;
      var clone=svg.cloneNode(true);
      clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
      if(!clone.getAttribute('width')) clone.setAttribute('width',w);
      if(!clone.getAttribute('height')) clone.setAttribute('height',h);
      var xml=new XMLSerializer().serializeToString(clone);
      var fill=bg(document.body)||bg(document.documentElement)||'#ffffff';
      var img=new Image();
      img.onload=function(){
        try{
          var scale=Math.min(2, 900/Math.max(1,w));
          var c=document.createElement('canvas'); c.width=Math.round(w*scale); c.height=Math.round(h*scale);
          var ctx=c.getContext('2d'); ctx.fillStyle=fill; ctx.fillRect(0,0,c.width,c.height);
          ctx.drawImage(img,0,0,c.width,c.height);
          send(c.toDataURL('image/png'));
        }catch(e){ send(null,String(e)); }
      };
      img.onerror=function(){ send(null,'img-error'); };
      img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(xml);
    }catch(e){ send(null,String(e)); }
  }

  // 主路径：foreignObject 承载整个 body（含背景/标题/容器）
  function shootFull(){
    try{
      var css='';
      for(var i=0;i<document.styleSheets.length;i++){
        try{ var rs=document.styleSheets[i].cssRules; for(var j=0;j<rs.length;j++) css+=rs[j].cssText+'\\n'; }catch(e){}
      }
      // html/body 选择器改写，使其作用到 foreignObject 内的根 div
      css=css.replace(/(^|[},\\s])(html|body)(?=[\\s,{:])/g,'$1.iq-root');
      var w=document.documentElement.clientWidth||480;
      var h=document.documentElement.clientHeight||360;
      var ser=new XMLSerializer(), inner='';
      for(var k=0;k<document.body.childNodes.length;k++){
        var n=document.body.childNodes[k];
        if(n.nodeType===1 && n.tagName==='SCRIPT') continue;   // 别把注入脚本也搬进去
        try{
          inner += (n.nodeType===3)
            ? (n.nodeValue||'').replace(/[<&]/g,function(c){return c==='<'?'&lt;':'&amp;';})
            : ser.serializeToString(n);
        }catch(e){}
      }
      if(!inner){ shootSvgOnly(); return; }
      var rootBg=bg(document.body)||bg(document.documentElement)||'';
      var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">'
        +'<foreignObject x="0" y="0" width="'+w+'" height="'+h+'">'
        +'<div xmlns="http://www.w3.org/1999/xhtml" class="iq-root" style="width:'+w+'px;height:'+h+'px;overflow:hidden'
        +(rootBg?(';background:'+rootBg):'')+'">'
        +'<style type="text/css">'+css.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</style>'
        +inner+'</div></foreignObject></svg>';
      var img=new Image();
      img.onload=function(){
        try{
          var c=document.createElement('canvas'); c.width=w*2; c.height=h*2;
          var ctx=c.getContext('2d'); ctx.scale(2,2); ctx.drawImage(img,0,0);
          send(c.toDataURL('image/png'));
        }catch(e){ shootSvgOnly(); }
      };
      img.onerror=function(){ shootSvgOnly(); };   // XML 不良构等 → 退兜底
      img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
    }catch(e){ shootSvgOnly(); }
  }
  setTimeout(shootFull, 2200);
})();<\/script>`;

function injectShot(html) {
  if (!html) return html;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, SHOT_SCRIPT + '</body>');
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, SHOT_SCRIPT + '</html>');
  return html + SHOT_SCRIPT;
}

// 父页监听截图回传：按 iframe 归属到对应任务的 shots（frame.__iqTask / __iqSide 标记）
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.__iq !== 'shot') return;
  for (const t of tasks.values()) {
    if (t.frames.baseline && e.source === t.frames.baseline.contentWindow) { t.shots.baseline = d.dataUrl || null; return; }
    if (t.frames.model && e.source === t.frames.model.contentWindow) { t.shots.model = d.dataUrl || null; return; }
  }
});

/* 统一 POST 辅助：识别「返回 HTML 而非 JSON」（后端未部署）的情况 */
async function postJson(url, bodyObj) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj) });
  } catch (e) {
    return { ok: false, error: '网络请求失败：' + String(e) };
  }
  const txt = await res.text();
  const head = txt.trim().slice(0, 1).toLowerCase();
  if (head === '<') {
    const file = url.replace(/^\.\//, '').split('?')[0];
    return { ok: false, notDeployed: true, error: `后端 ${file} 未部署或未被当作 PHP 执行（服务器返回了 HTML 页面，HTTP ${res.status}）。请确认该文件已上传到网站根目录、PHP 正常运行，且伪静态没有把 .php 请求重写走。` };
  }
  try { return { ok: true, data: JSON.parse(txt) }; }
  catch { return { ok: false, error: `后端返回的不是合法 JSON（HTTP ${res.status}）：${txt.slice(0, 160)}` }; }
}

/* 读取 SSE 流：边读边解析各协议增量，累积正文并回调 onProgress(fullText, aborted判断)；返回最终正文。 */
async function readSSEStream(res, protocol, onProgress, shouldAbort, onControl) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '', full = '';
  while (true) {
    if (shouldAbort && shouldAbort()) { try { reader.cancel(); } catch {} break; }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split('\n')) {
        // 以 ':' 开头的是 SSE 注释（中转心跳 `: ping`），忽略
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let obj; try { obj = JSON.parse(data); } catch { continue; }
        // 中转层控制事件（错误 / 非流式整包），不当正文
        if (obj && (obj.__iq_error || obj.__iq_json)) { if (onControl) onControl(obj); continue; }
        const delta = streamDelta(protocol, obj);
        if (delta) { full += delta; onProgress(full); }
      }
    }
  }
  return full;
}
/* =====================================================================
 * 任务管理器（核心）：tasks Map（键=题目 id），activeQid = 当前详情查看的任务
 * 每个 task：{ qid, q, status, startAt, endMs, model/think/endpoint 快照,
 *   raw, html, htmlDone, summary, summarizing, baselineHtml, baselineFilled,
 *   frames{baseline,model}, shots{baseline,model}, abort, typingToken }
 * status: 'idle' | 'running' | 'done' | 'raw' | 'error'
 * ===================================================================== */
const tasks = new Map();
let activeQid = null;
// 分享面板当前归属哪条任务：口径回显的是「这条任务」的域名，切换任务后必须收起，
// 否则面板里会留着上一个中转站的域名，而点下去生成的却是新任务的报告。
let panelOwner = null;

function makeTask(qid) {
  const q = getQuestion(qid);
  return {
    qid, q, status: 'idle', startAt: 0, endMs: 0,
    model: '', think: '', endpoint: '',
    raw: '', html: '', htmlDone: false,
    summary: '', summaryThink: '', verdict: '', summarizing: false, errMsg: '',
    baselineHtml: '', baselineFilled: false,
    frames: { baseline: null, model: null },
    shots: { baseline: null, model: null },
    abort: false, typingToken: 0,
  };
}

// 工具
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtTime(ts) { const d = new Date(ts), p = (n) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
const elapsedStr = (startAt) => '用时 ' + ((Date.now() - startAt) / 1000).toFixed(1) + 's';

/* =====================================================================
 * 基线缓存（纯逻辑，保留）
 * ===================================================================== */
const BASELINE_VER = '3';   // 更新基线文件后须 +1，否则浏览器可能吃旧缓存
const baselineCache = new Map();
async function fetchBaseline(path) {
  if (baselineCache.has(path)) return baselineCache.get(path);
  const r = await fetch(path + '?v=' + BASELINE_VER, { cache: 'default' });
  if (!r.ok) throw new Error('not found');
  const html = await r.text();
  const filled = !!html && !/基线待补充/.test(html);
  const entry = { html, filled };
  baselineCache.set(path, entry);
  return entry;
}
function prefetchBaselines() { QUESTIONS.forEach((q) => { fetchBaseline(q.baseline).catch(() => {}); }); }

// 给任务加载基线（命中缓存秒开；否则异步取回后若仍在当前任务则刷新详情）
function loadTaskBaseline(t) {
  if (baselineCache.has(t.q.baseline)) {
    const { html, filled } = baselineCache.get(t.q.baseline);
    t.baselineHtml = filled ? html : ''; t.baselineFilled = filled;
    if (activeQid === t.qid) renderDetail();
    return;
  }
  fetchBaseline(t.q.baseline).then(({ html, filled }) => {
    t.baselineHtml = filled ? html : ''; t.baselineFilled = filled;
    if (activeQid === t.qid) renderDetail();
  }).catch(() => { t.baselineHtml = ''; t.baselineFilled = false; if (activeQid === t.qid) renderDetail(); });
}
/* =====================================================================
 * 题库多选 UI —— 状态/结论徽章直接显示在题卡上（不再另起任务列表行）
 * ===================================================================== */
// 题卡上的状态徽章：待检测 / 生成中 / 档位结论 / 失败
function cardBadge(t) {
  if (!t) return '';
  if (t.status === 'running') return `<span class="qc-badge run"><span class="spinner"></span>生成中</span>`;
  if (t.status === 'error')   return `<span class="qc-badge bad">失败</span>`;
  if (t.status === 'done' || t.status === 'raw') {
    if (t.verdict) return `<span class="qc-badge ${t.verdictCls || 'ok2'}">${escapeHtml(t.verdict)}</span>`;
    return `<span class="qc-badge ok2">已完成</span>`;
  }
  return `<span class="qc-badge idle">待检测</span>`;
}
function cardRunLabel(t) {
  if (!t) return '';
  if (t.status === 'running') return `<span class="spinner"></span>生成中`;
  if (t.status === 'idle')    return '▶ 开始';
  return '↻ 重测';
}

function renderQuestions() {
  const grid = $('#qGrid');
  grid.innerHTML = QUESTIONS.map((q) => `
    <div class="q-card" data-q="${q.id}">
      <button class="qc-check" type="button" data-check="${q.id}" role="checkbox" aria-checked="false" aria-label="选择 ${escapeHtml(q.title)}"></button>
      <div class="qc-body" data-view="${q.id}">
        <div class="qc-top"><span class="qc-em">${q.emoji}</span>
          <span><div class="qc-name">${escapeHtml(q.title)}</div><div class="qc-diff">${q.difficulty}</div></span></div>
        <div class="qc-focus">${escapeHtml(q.focus)}</div>
      </div>
      <div class="qc-foot" data-foot="${q.id}"></div>
    </div>`).join('');
  // 勾选角标 = 加/移除任务；卡片主体 = 若未选则选中并查看，若已选则设为当前查看
  $$('[data-check]', grid).forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); toggleQuestion(el.dataset.check); }));
  $$('[data-view]', grid).forEach((el) => el.addEventListener('click', () => viewOrSelect(el.dataset.view)));
  refreshCards();
}

// 刷新每张题卡的：选中态、状态徽章、底部（运行按钮）、当前查看高亮
function refreshCards() {
  $$('#qGrid .q-card').forEach((card) => {
    const qid = card.dataset.q;
    const t = tasks.get(qid);
    const on = !!t;
    card.classList.toggle('on', on);
    card.classList.toggle('active', qid === activeQid);
    const chk = card.querySelector('.qc-check');
    if (chk) chk.setAttribute('aria-checked', on ? 'true' : 'false');
    const foot = card.querySelector('.qc-foot');
    if (foot) {
      if (on) {
        foot.style.display = 'flex';
        foot.innerHTML = `${cardBadge(t)}<button class="qc-run" type="button" data-run="${qid}" ${t.status === 'running' ? 'disabled' : ''}>${cardRunLabel(t)}</button>`;
        const runBtn = foot.querySelector('[data-run]');
        if (runBtn) runBtn.addEventListener('click', (e) => { e.stopPropagation(); runTask(qid); });
      } else { foot.style.display = 'none'; foot.innerHTML = ''; }
    }
  });
}

// 点卡片主体：未选→选中并查看；已选→设为当前查看
function viewOrSelect(qid) {
  if (!tasks.has(qid)) {
    const t = makeTask(qid); tasks.set(qid, t); loadTaskBaseline(t);
  }
  activeQid = qid;
  refreshCards(); renderDetail();
  $('#compareSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 勾选角标：加任务 / 取消任务（正在生成先确认）
function toggleQuestion(qid) {
  if (tasks.has(qid)) {
    const t = tasks.get(qid);
    if (t.status === 'running' && !confirm(`「${t.q.title}」正在生成中，确定取消并移除吗？`)) return;
    removeTask(qid);
  } else {
    const t = makeTask(qid); tasks.set(qid, t); loadTaskBaseline(t); activeQid = qid;
  }
  refreshCards(); renderDetail();
}

function removeTask(qid) {
  const t = tasks.get(qid);
  if (t) { t.abort = true; t.typingToken++; }
  tasks.delete(qid);
  if (activeQid === qid) {
    const rest = Array.from(tasks.keys());
    activeQid = rest.length ? rest[rest.length - 1] : null;
  }
}
/* =====================================================================
 * 详情区（中间下方）：当前 activeQid 任务的完整对比
 * ===================================================================== */
function makeFrame(t, side) {
  const iframe = document.createElement('iframe');
  iframe.className = 'stage-frame';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('title', side === 'model' ? '模型输出渲染' : '基线渲染');
  const html = side === 'model' ? t.html : t.baselineHtml;
  iframe.srcdoc = injectShot(html);
  t.frames[side] = iframe;
  return iframe;
}

function renderCodeBlock(host, code, label) {
  if (!code) { host.innerHTML = ''; return; }
  host.innerHTML =
    `<details class="code-toggle"><summary>${escapeHtml(label)}</summary>
       <div class="code-wrap"><button class="code-copy" type="button">复制</button><pre></pre></div>
     </details>`;
  host.querySelector('pre').textContent = code;
  host.querySelector('.code-copy').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    navigator.clipboard.writeText(code).then(() => { btn.classList.add('ok'); btn.textContent = '已复制'; setTimeout(() => { btn.classList.remove('ok'); btn.textContent = '复制'; }, 1500); }).catch(() => toast('复制失败'));
  });
}

// 详情主渲染：根据当前任务状态铺 UI（占位 / 对比舞台）
function renderDetail() {
  const ph = $('#centerPlaceholder'), wrap = $('#compareWrap');
  const t = activeQid ? tasks.get(activeQid) : null;
  if (!t) { ph.style.display = ''; wrap.style.display = 'none'; return; }
  ph.style.display = 'none'; wrap.style.display = 'block';

  $('#compareTitle').innerHTML = `<span class="em">${t.q.emoji}</span>${escapeHtml(t.q.title)}`;
  $('#comparePrompt').textContent = t.q.prompt;
  t.frames.baseline = null; t.frames.model = null;   // 重渲染前解绑旧 iframe 引用

  // 左：基线
  const sl = $('#stageLeft'), cl = $('#codeLeft');
  if (t.baselineFilled) { sl.innerHTML = ''; sl.appendChild(makeFrame(t, 'baseline')); renderCodeBlock(cl, t.baselineHtml, '基线 HTML 源码'); }
  else { sl.innerHTML = `<div class="stage-empty">该题基线待补充<br><span style="font-size:12px">（在 iq-assets/baselines/ 下填入标准答案）</span></div>`; cl.innerHTML = ''; }

  // 右：模型输出（按状态）
  renderModelStage(t);

  // AI 评审卡 + 状态 + 运行按钮
  renderVerdict(t);
  renderRunStatus(t);
  syncRunRow(t);
}

/* 流式三阶段：
 *   thinking —— 还没有任何正文（模型在思考）：显示「思考中·用时」
 *   text     —— 有正文但还没出现 HTML：把这段前言用打字流滚动展示（不再空等）
 *   code     —— 出现 <html>/<svg>/围栏：只滚动代码部分
 * 返回当前应显示的文本（text/code 阶段）与外壳标签。 */
function streamPhase(t) {
  const raw = t.raw || '';
  if (!raw.trim()) return 'thinking';
  return htmlStartIndex(raw) >= 0 ? 'code' : 'text';
}
function streamShownText(t) {
  const raw = t.raw || '';
  const idx = htmlStartIndex(raw);
  const body = idx >= 0 ? raw.slice(idx) : raw;   // code 阶段只取代码；text 阶段取全部前言
  return body.slice(-STREAM_TAIL);
}
// 外壳 HTML（含 badge 文案）——badge 文案随阶段变化
function streamStageHTML(t) {
  const phase = streamPhase(t);
  if (phase === 'thinking') {
    return `<div class="type-stage waiting"><div class="type-wait">
      <div class="tw-title"><span class="spinner"></span> 模型思考中…（尚未输出正文）</div>
      <div class="tw-sub">${elapsedStr(t.startAt)}</div></div></div>`;
  }
  const label = phase === 'code' ? '生成代码中' : '模型输出中';
  return `<div class="type-stage"><div class="type-badge"><span class="dot"></span>${label}<span class="elapsed">${elapsedStr(t.startAt)}</span></div><pre></pre></div>`;
}

// 右侧模型舞台：running(流式)/done(成品)/raw(源码)/error/idle
function renderModelStage(t) {
  const host = $('#stageRight'), codeHost = $('#codeRight');
  if (t.status === 'running') {
    host.innerHTML = streamStageHTML(t);
    const pre = host.querySelector('.type-stage:not(.waiting) pre');
    if (pre) pre.innerHTML = escapeHtml(streamShownText(t)) + '<span class="type-cursor"></span>';
    codeHost.innerHTML = '';
    return;
  }
  if (t.status === 'done' && t.html) {
    host.innerHTML = ''; host.appendChild(makeFrame(t, 'model'));
    renderCodeBlock(codeHost, t.html, '模型输出 HTML 源码');
    return;
  }
  if (t.status === 'raw') {
    host.innerHTML = `<div class="stage-empty">未提取到可渲染 HTML，见下方源码</div>`;
    renderCodeBlock(codeHost, t.raw, '模型原始回复');
    return;
  }
  if (t.status === 'error') { host.innerHTML = `<div class="stage-empty">检测失败，见下方状态提示</div>`; codeHost.innerHTML = ''; return; }
  host.innerHTML = `<div class="stage-empty">点上方「开始检测」或该任务卡的「开始」运行</div>`; codeHost.innerHTML = '';
}

function renderVerdict(t) {
  const box = $('#summaryBox'), vEl = $('#summaryVerdict'), bEl = $('#summaryBody');
  if (t.summarizing) {
    box.className = 'verdict-card show'; vEl.className = 'vc-verdict'; vEl.innerHTML = '';
    bEl.innerHTML = '<div class="sm-loading"><span class="spinner"></span> 🤖 视觉裁判正在对比评审…（首次可能较慢）</div>';
    return;
  }
  if (t.summaryNote) { box.className = 'verdict-card show'; vEl.className = 'vc-verdict'; vEl.innerHTML = ''; bEl.innerHTML = `<div class="sm-loading">${t.summaryNote}</div>`; return; }
  if (t.summary) { box.className = 'verdict-card show'; paintSummary(box, vEl, bEl, t.summary, t.summaryThink); return; }
  box.className = 'verdict-card'; vEl.className = 'vc-verdict'; vEl.innerHTML = ''; bEl.innerHTML = '';
}

function renderRunStatus(t) {
  const el = $('#runStatus');
  if (!t || !t.statusMsg) { el.className = 'run-status'; el.innerHTML = ''; return; }
  el.className = 'run-status show' + (t.statusErr ? ' err' : '');
  el.innerHTML = (t.status === 'running' ? '<span class="spinner"></span>' : '') + `<span>${escapeHtml(t.statusMsg)}</span>`;
}

// 「开始检测 / AI 视觉总结 / 分享」这一排随当前任务状态变化
function syncRunRow(t) {
  const runBtn = $('#runBtn'), sumBtn = $('#summaryBtn'), shareBtn = $('#shareBtn');
  const idle = tasks.size === 0;
  runBtn.disabled = idle;
  const hasResult = t && (t.status === 'done' || t.status === 'raw');
  sumBtn.style.display = hasResult ? '' : 'none';
  shareBtn.style.display = hasResult ? '' : 'none';
  // 分享面板是挂在「当前任务」上的（口径回显的是这条任务的域名）——
  // 结果没了或切到别的任务时把它收起来，免得面板里留着上一个中转站的域名。
  if (!hasResult) closeSharePanel();
  else if (t && panelOwner && panelOwner !== t) closeSharePanel();
  if (t && t.summarizing) { sumBtn.disabled = true; sumBtn.innerHTML = '<span class="spinner"></span> 总结中…'; }
  else { sumBtn.disabled = false; sumBtn.textContent = t && t.summary ? '🤖 重新总结' : '🤖 AI 视觉总结'; }
}
/* =====================================================================
 * 发起检测（按任务，可并发）
 * ===================================================================== */
function readCfg() {
  return {
    endpoint: fullEndpoint(),   // 输入框基础地址 + 下拉选中的路径
    model: $('#model').value.trim(),
    key: $('#apiKey').value.trim(),
    think: $('#think').value,
    maxTokens: parseInt($('#maxTokens').value, 10) || 8192,
  };
}

// 计时器：running 期间每 100ms 刷新当前详情的用时（仅当查看的是该任务）
let tickTimer = null;
function ensureTicker() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    const anyRunning = Array.from(tasks.values()).some((t) => t.status === 'running');
    if (!anyRunning) { clearInterval(tickTimer); tickTimer = null; return; }
    const t = activeQid ? tasks.get(activeQid) : null;
    if (t && t.status === 'running') {
      const badge = $('#stageRight .type-badge .elapsed');
      if (badge) badge.textContent = elapsedStr(t.startAt);
      const sub = $('#stageRight .type-wait .tw-sub');
      if (sub) sub.textContent = elapsedStr(t.startAt);
    }
  }, 100);
}

async function runTask(qid) {
  const t = tasks.get(qid);
  if (!t || t.status === 'running') return;
  const cfg = readCfg();
  if (!cfg.endpoint) { toast('请填写接口地址'); return; }
  if (!cfg.model)    { toast('请填写模型名'); return; }

  // 复位任务态
  t.status = 'running'; t.abort = false; t.startAt = Date.now(); t._phase = null;
  t.raw = ''; t.html = ''; t.htmlDone = false; t.errMsg = '';
  t.summary = ''; t.summaryThink = ''; t.verdict = ''; t.verdictCls = ''; t.summaryNote = ''; t.summarizing = false;
  t.shots.model = null; t.frames.model = null;
  t.model = cfg.model; t.think = cfg.think; t.endpoint = cfg.endpoint;
  t.statusMsg = '正在请求模型…（高思考档位可能较慢）'; t.statusErr = false;
  t.typingToken++;
  refreshCards();
  if (activeQid === qid) renderDetail();
  ensureTicker();

  const tokenInfo = buildRequest({
    endpoint: cfg.endpoint, model: cfg.model, prompt: fullPrompt(t.q), think: cfg.think, maxTokens: cfg.maxTokens,
  });
  const { authStyle, extraHeaders, protocol } = tokenInfo;
  let { payload } = tokenInfo;
  let viaProxy = false;

  try {
    /* 发一次请求（直连失败自动改走本站中转）。
     * ⚠️ 必须是「可重发」的：Chat 路径的 max_tokens / max_completion_tokens 二选一，
     *    猜错时上游直接 400，得换个字段名再发一次（见下面那一段）。 */
    const attempt = async (pl, eh2) => {
      const headers = buildHeaders(authStyle, cfg.key, eh2);
      try {
        const r = await fetch(cfg.endpoint, { method: 'POST', headers, body: JSON.stringify(pl) });
        return { res: r, viaProxy: false };
      } catch (e) {
        // 直连失败（多为目标站未开 CORS）→ 静默改走本站流式中转，不提示用户
        try {
          const r = await fetch(PROXY_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetUrl: cfg.endpoint, apiKey: cfg.key, authStyle, payload: pl, extraHeaders: eh2 }),
          });
          return { res: r, viaProxy: true };
        } catch (e2) {
          return { error: `请求失败：${String(e2)}` };
        }
      }
    };

    let sentField = tokenInfo.chatTokensField;
    let r = await attempt(payload, extraHeaders);
    if (r.error) return failTask(t, r.error);
    let res = r.res;
    viaProxy = r.viaProxy;

    /* 输出上限字段名被拒 → 换名字重发一次。
     * 新模型只认 max_completion_tokens，发 max_tokens 会得到：
     *   Unsupported parameter: 'max_tokens' ... Use 'max_completion_tokens' instead.
     * 只有报文确实指向那个字段时才重发，别的错（模型名写错、Key 无效）照原样报出来。 */
    if (res.status === 400 && sentField) {
      const errText = await res.text();
      const swap = maxTokensFieldFallback(errText, sentField);
      if (swap) {
        payload = buildRequest({
          endpoint: cfg.endpoint, model: cfg.model, prompt: fullPrompt(t.q),
          think: cfg.think, maxTokens: cfg.maxTokens, chatTokensField: swap,
        }).payload;
        sentField = swap;
        r = await attempt(payload, extraHeaders);
        if (r.error) return failTask(t, r.error);
        res = r.res;
        viaProxy = r.viaProxy;
        t.statusMsg = `上游要求改用 ${swap}，已自动切换…`;
      } else {
        return failTask(t, `目标返回 HTTP ${res.status}：${errText.slice(0, 200)}`);
      }
    }

    if (res.status < 200 || res.status >= 300) {
      const errText = await res.text();
      return failTask(t, `目标返回 HTTP ${res.status}：${errText.slice(0, 200)}`);
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const isStream = res.body && (ct.includes('event-stream') || ct.includes('stream'));

    let text = '';
    if (isStream) {
      t.statusMsg = '模型正在实时输出…';
      if (activeQid === qid) renderRunStatus(t);
      let ctl = null;
      text = await readSSEStream(res, protocol, (full) => {
        t.raw = full;
        if (activeQid === qid) updateStreamDom(t);
      }, () => t.abort, (c) => { ctl = c; });
      // 中转层的控制事件：错误 / 目标非流式整包
      if (ctl && ctl.__iq_error) return failTask(t, ctl.__iq_error);
      if (ctl && ctl.__iq_json) {
        let json; try { json = JSON.parse(decodeURIComponent(escape(atob(ctl.__iq_json)))); }
        catch { return failTask(t, '中转返回的整包响应无法解析'); }
        text = extractText(protocol, json);
      }
      t.raw = text;
    } else {
      const bodyText = await res.text();
      let json; try { json = JSON.parse(bodyText); }
      catch { return failTask(t, '响应不是合法 JSON（异常返回）：' + bodyText.slice(0, 160)); }
      text = extractText(protocol, json);
      t.raw = text;
    }
    if (t.abort) return;   // 已被移除/取消
    if (!text) return failTask(t, '模型未返回可解析文本（可能思考预算耗尽或结构异常）。可调大 max_tokens 或换思考档位重试。');

    const html = extractHtml(text);
    t.raw = text; t.html = html; t.htmlDone = true;
    t.endMs = Date.now() - t.startAt;
    const secs = (t.endMs / 1000).toFixed(1);
    if (!html) {
      t.status = 'raw'; t.statusMsg = `完成 · 用时 ${secs}s · 未提取到可渲染 HTML，见源码`; t.statusErr = true;
    } else {
      t.status = 'done'; t.statusMsg = `完成 · 用时 ${secs}s · 协议 ${PROTO_META[protocol].name}`; t.statusErr = false;
    }
    refreshCards();
    if (activeQid === qid) renderDetail();
    saveTaskHistory(t);
    autoSummary(t);   // 检测完成 → 自动评审
  } catch (e) {
    failTask(t, '网络错误：' + String(e));
  }
}

function failTask(t, msg) {
  t.status = 'error'; t.statusMsg = msg; t.statusErr = true; t.htmlDone = false;
  refreshCards();
  if (activeQid === t.qid) { renderModelStage(t); renderRunStatus(t); syncRunRow(t); }
}

// 全局「开始检测」：批量跑所有「待检测(idle)」任务；若都跑过则重跑全部
function runAllPending() {
  if (!tasks.size) { toast('请先在上方选择至少一道题目'); return; }
  const cfg = readCfg();
  if (!cfg.endpoint) { toast('请填写接口地址'); return; }
  if (!cfg.model)    { toast('请填写模型名'); return; }
  let list = Array.from(tasks.values()).filter((t) => t.status === 'idle');
  if (!list.length) list = Array.from(tasks.values()).filter((t) => t.status !== 'running');
  if (!list.length) { toast('所有任务都在生成中'); return; }
  list.forEach((t) => runTask(t.qid));   // 并发
}

/* 实时流式：只更新当前查看任务的右舞台。阶段切换(thinking→text→code)时重铺外壳，否则只更新 <pre>。 */
function updateStreamDom(t) {
  const host = $('#stageRight');
  const phase = streamPhase(t);
  if (t._phase !== phase) { t._phase = phase; renderModelStage(t); return; }
  if (phase === 'thinking') { const sub = host.querySelector('.type-wait .tw-sub'); if (sub) sub.textContent = elapsedStr(t.startAt); return; }
  const pre = host.querySelector('.type-stage:not(.waiting) pre');
  if (!pre) { renderModelStage(t); return; }
  pre.innerHTML = escapeHtml(streamShownText(t)) + '<span class="type-cursor"></span>';
  const badge = host.querySelector('.type-badge .elapsed'); if (badge) badge.textContent = elapsedStr(t.startAt);
}
/* =====================================================================
 * AI 视觉裁判评审（按任务）
 * ===================================================================== */
// iframe 内 2.2s 后自截图（foreignObject 本地渲染，无网络依赖）
async function waitForShots(t, waitMs = 4000) {
  const t0 = Date.now();
  const needBaseline = !!t.baselineHtml;
  while (Date.now() - t0 < waitMs) {
    if (t.abort) return;
    const modelReady = !!t.shots.model;
    const baseReady = !needBaseline || !!t.shots.baseline;
    if (modelReady && baseReady) return;
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function autoSummary(t) {
  if (t.summarizing) return;
  if (!t.html && !t.raw) return;
  t.summaryNote = '<span class="spinner"></span> 检测完成，正在等待渲染截图，随后自动评审…';
  if (activeQid === t.qid) renderVerdict(t);
  await waitForShots(t);
  if (t.abort) return;
  await doSummary(t, false);
}

async function doSummary(t, manual = true) {
  if (!t) return;
  if (!t.html && !t.raw) { if (manual) toast('请先运行检测'); return; }
  if (t.summarizing) return;
  t.summarizing = true; t.summaryNote = '';
  refreshCards();
  if (activeQid === t.qid) { renderVerdict(t); syncRunRow(t); }

  const payload = {
    question: t.q.title, prompt: fullPrompt(t.q),
    baselineImg: t.shots.baseline, modelImg: t.shots.model,
    baselineCode: t.shots.baseline ? '' : (t.baselineHtml || ''),
    modelCode: t.shots.model ? '' : (t.html || t.raw || ''),
  };
  try {
    const r = await postJson(SUMMARY_URL, payload);
    if (t.abort) return;
    if (!r.ok) { t.summaryNote = '❌ ' + escapeHtml(r.error); }
    else {
      const d = r.data;
      if (d.ok) {
        t.summary = d.summary + (d.usedImages ? '' : '\n\n（注：本次未获得渲染截图，以上为基于源码的评估。）');
        t.summaryThink = d.thinking || '';   // 思考型裁判的思维链，单独存、单独渲染
        t.summaryNote = '';
        // 提取档位关键词做任务卡徽章
        const kw = ['完全跑偏', '明显降智', '略有瑕疵', '正常发挥'].find((k) => d.summary.includes(k));
        t.verdict = kw || '';
        t.verdictCls = kw === '正常发挥' ? 'ok' : (kw === '略有瑕疵' ? 'warn' : (kw ? 'bad' : ''));
      } else if (d.needConfig) {
        t.summaryNote = '⚠️ 尚未配置视觉裁判模型。请在服务器 iq-config.php 填写 JUDGE_URL / JUDGE_KEY（需支持读图的多模态模型），即可启用 AI 总结。';
      } else {
        t.summaryNote = '❌ 评审失败：' + escapeHtml(d.error || '未知错误');
      }
    }
  } finally {
    t.summarizing = false;
    refreshCards();
    if (activeQid === t.qid) { renderVerdict(t); syncRunRow(t); }
    saveTaskHistory(t);
  }
}

/* =====================================================================
 * 分享报告（当前任务）
 *
 * 流程：点「分享报告」→ 就地展开口径面板 → 点「生成并复制链接」→ 复制 + 轻提示。
 *
 * ⚠️ 复制后**不** window.open。早先这里会顺手把报告在新标签页打开，但用户要的是
 *    「把链接发给别人」，自己并不需要再看一遍；凭空多一个标签页，还得手动关掉。
 */
async function doShare(t) {
  if (!t || (!t.html && !t.raw)) { toast('请先运行检测'); return; }
  const go = $('#shareGoBtn');
  const old = go ? go.textContent : '';
  if (go) { go.disabled = true; go.textContent = '⏳ 生成中…'; }
  const payload = {
    questionId: t.q.id, questionName: t.q.title, questionEmoji: t.q.emoji, prompt: t.q.prompt,
    model: t.model, think: t.think, protocol: detectProtocol(t.endpoint),
    targetHost: (() => { try { return new URL(t.endpoint).host; } catch { return ''; } })(),
    // 地址口径：'host' 只留域名 / 'none' 完全不出现。后端做白名单收敛。
    // ⚠️ 取原始字符串而不是布尔 —— 布尔只有两态，加第三个口径会被静默折叠成 host
    //    （用户选了不公开，存出去的却是域名，且全程不报错）。
    urlMode: (document.querySelector('input[name="iqUrlMode"]:checked')?.value || 'host'),
    baselineHtml: t.baselineHtml || '', modelHtml: t.html || '',
    modelRaw: t.html ? '' : (t.raw || ''), summary: t.summary || '',
    summaryThink: t.summaryThink || '',
  };
  try {
    const r = await postJson(SHARE_URL, payload);
    if (!r.ok || !r.data || !r.data.ok || !r.data.id) {
      // 不再退化成 2000+ 字符的 #data= 长链：那种链接在微信 / QQ 里会被折叠或截断，
      // 二维码也密到扫不出来，等于没分享。宁可明说失败，让用户重试。
      toast('分享失败：' + (r.data?.error || '服务暂不可用，请稍后再试'));
      return;
    }
    const link = await pickShareUrl(r.data.id);
    let ok = true;
    try { await navigator.clipboard.writeText(link); } catch { ok = false; }
    // 顶部提示 + 按钮就地变绿：复制没有别的可见结果，两处同时给反馈才不会有迟疑
    toast(ok ? '链接已复制 — 直接发给别人就能打开这份报告' : '复制失败，请手动复制链接', ok ? 'ok' : 'bad');
    if (ok) flashCopied(go, old);
    else { if (go) { go.disabled = false; go.textContent = old; } }
    if (ok) closeSharePanel();
  } catch (e) {
    toast('分享失败：' + (e?.message || '服务暂不可用'), 'bad');
    if (go) { go.disabled = false; go.textContent = old; }
  }
}

/** 按钮上的「已复制」反馈：变绿 + 打勾，两秒后自己变回原文案。
 *  顶部提示在屏幕另一头，而用户的眼睛正盯着刚点的那个按钮 —— 两处都有才踏实。
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

/** 展开分享面板，并把当前任务的域名回显到「仅域名」选项上（点之前就看见会公开什么）。 */
function openSharePanel(t) {
  const panel = $('#sharePanel');
  if (!panel) return;
  if (!t || (!t.html && !t.raw)) { toast('请先运行检测'); return; }
  const sub = $('#shareHostSub');
  if (sub) {
    let host = '';
    try { host = new URL(t.endpoint).host; } catch { host = ''; }
    sub.textContent = host || '—';
  }
  panelOwner = t;
  panel.hidden = false;
  panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closeSharePanel() {
  const panel = $('#sharePanel');
  if (panel) panel.hidden = true;
  panelOwner = null;
}

/** 分享短链：`<站点>/iq/s/<id>`（例：https://aabao.ai/iq/s/a1b2c3d4e，约 42 字符）。
 *
 *  ⚠️ 用路径而**不是** `iq-report?id=`：链接要发进微信群 / 短信，后者光前缀就多出
 *     12 个字符，短 id 的意义就是让整条链接短到能单行完整显示。
 *     由 nginx 重写到报告页（规则见仓库根 nginx-伪静态.conf 的「分享短链重写」）。
 *  ⚠️ 用无后缀路径：站点在反代后面时「.html → 无后缀」的 301 会把 https 降成 http。 */
function shareUrl(id) {
  const base = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}s`;
  return `${base}/${encodeURIComponent(id)}`;
}

/** 上一版链接形状：`iq-report?id=<id>`。约 62 字符，只在短链不可达时用。 */
function legacyShareUrl(id) {
  const u = new URL('iq-report', location.href);
  u.searchParams.set('id', id);
  return u.toString();
}

/** 挑一条能打开的链接：先探短链（/iq/s/<id>），它依赖 nginx 重写规则 ——
 *  规则没配或本地开发没起伪静态时会 404，此时退回 ?id= 那条。
 *  宁可链接长一点，也不能发一条打不开的。 */
async function pickShareUrl(id) {
  const short = shareUrl(id);
  try {
    const r = await fetch(short, { method: 'HEAD' });
    if (r.ok) return short;
  } catch { /* 探测失败即视为不可达 */ }
  return legacyShareUrl(id);
}

/* =====================================================================
 * 配置库（纯逻辑，保留）
 * ===================================================================== */
function loadConfigStore() { try { const o = JSON.parse(localStorage.getItem(CFG_KEY) || '[]'); return Array.isArray(o) ? o : []; } catch { return []; } }
function saveConfigStore(list) { try { localStorage.setItem(CFG_KEY, JSON.stringify(list)); return true; } catch { toast('保存失败：本地存储不可用或已满'); return false; } }
function saveCurrentConfig() {
  const endpoint = fullEndpoint(), model = $('#model').value.trim();   // 存完整地址，导入时再拆回「基础地址+下拉」
  const key = $('#apiKey').value.trim(), think = $('#think').value;
  let label = $('#cfgLabel').value.trim();
  if (!endpoint && !key) { toast('请先填接口地址或 Key 再保存'); return; }
  if (!label) { try { label = new URL(endpoint).host; } catch { label = '未命名配置'; } }
  const list = loadConfigStore();
  const item = { label, endpoint, model, key, think };
  const i = list.findIndex((x) => x.label === label);
  if (i >= 0) list[i] = item; else list.push(item);
  if (saveConfigStore(list)) { $('#cfgLabel').value = ''; renderConfigStore(); toast(i >= 0 ? `已更新「${label}」` : `已保存「${label}」`); }
}
function loadConfig(idx) {
  const c = loadConfigStore()[idx]; if (!c) return;
  setEndpointValue(c.endpoint || '');
  $('#model').value = c.model || ''; $('#apiKey').value = c.key || '';
  if (c.think) $('#think').value = c.think;
  toast(`已导入「${c.label}」`);
}
function deleteConfig(idx) { const list = loadConfigStore(); const c = list[idx]; if (!c) return; list.splice(idx, 1); saveConfigStore(list); renderConfigStore(); toast(`已删除「${c.label}」`); }
function renderConfigStore() {
  const box = $('#cfgChips'), list = loadConfigStore();
  if (!list.length) { box.innerHTML = `<div class="cfg-empty">暂无已存配置。填好接口后写个备注点「保存」，方便定期复检一键导入。</div>`; return; }
  box.innerHTML = list.map((c, i) => {
    let host = c.endpoint; try { host = new URL(c.endpoint).host; } catch {}
    const parts = [host && host !== c.label ? host : '', c.model || ''].filter(Boolean);
    const sub = parts.join(' · ');
    const subHtml = sub ? `<span class="ch">${escapeHtml(sub)}</span>` : '';
    return `<div class="cfg-chip"><button class="cn" data-load="${i}" title="点击导入"><span class="cl">${escapeHtml(c.label)}</span>${subHtml}</button><button class="cx" data-del="${i}" title="删除">✕</button></div>`;
  }).join('');
  $$('[data-load]', box).forEach((el) => el.addEventListener('click', () => loadConfig(+el.dataset.load)));
  $$('[data-del]', box).forEach((el) => el.addEventListener('click', () => deleteConfig(+el.dataset.del)));
}
/* =====================================================================
 * 历史记录（按任务存/回看）
 * ===================================================================== */
function loadHistory() { try { const a = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function persistHistory(list) { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); return true; } catch { toast('历史保存失败：本地存储已满'); return false; } }
function saveTaskHistory(t) {
  if (!t || (!t.html && !t.raw)) return;
  const list = loadHistory();
  const rec = {
    ts: Date.now(), qid: t.q.id, qtitle: t.q.title, qemoji: t.q.emoji,
    model: t.model, think: t.think, endpoint: t.endpoint,
    html: t.html, raw: t.html ? '' : (t.raw || ''), summary: t.summary || '',
    summaryThink: t.summaryThink || '',
    verdict: t.verdict || '', verdictCls: t.verdictCls || '',
  };
  if (list[0] && list[0].qid === rec.qid && list[0].model === rec.model && Date.now() - list[0].ts < 5 * 60 * 1000) list[0] = rec;
  else list.unshift(rec);
  if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
  persistHistory(list); renderHistory();
}
// 历史里的结论徽章：优先用存的 verdict，否则从 summary 里现提；无总结显「未评审」
function histVerdict(h) {
  let v = h.verdict, cls = h.verdictCls;
  if (!v && h.summary) { v = ['完全跑偏', '明显降智', '略有瑕疵', '正常发挥'].find((k) => h.summary.includes(k)) || ''; cls = v === '正常发挥' ? 'ok' : (v === '略有瑕疵' ? 'warn' : (v ? 'bad' : '')); }
  if (!v) return `<span class="hi-verdict none">未评审</span>`;
  return `<span class="hi-verdict ${cls || ''}">${escapeHtml(v)}</span>`;
}
function renderHistory() {
  const box = $('#histList'), list = loadHistory();
  if (!list.length) { box.innerHTML = `<div class="hist-empty">还没有检测记录。做一次检测，这里会留存到本机。</div>`; return; }
  box.innerHTML = list.map((h, i) => {
    let host = ''; try { host = new URL(h.endpoint).host; } catch {}
    return `
    <div class="hist-item">
      <button class="hi-open" data-view="${i}">
        <div class="hi-top"><span class="hi-em">${h.qemoji || '🧠'}</span><span class="hi-qt">${escapeHtml(h.qtitle || h.qid)}</span>${histVerdict(h)}</div>
        <div class="hi-bot"><span class="hi-model">${escapeHtml(h.model || '未知模型')}</span><span class="hi-meta">${escapeHtml(h.think || '-')}${host ? ' · ' + escapeHtml(host) : ''}</span></div>
      </button>
      <button class="hi-del" data-del="${i}" title="删除">✕</button>
    </div>`;
  }).join('');
  $$('[data-view]', box).forEach((el) => el.addEventListener('click', () => viewHistory(+el.dataset.view)));
  $$('[data-del]', box).forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); deleteHistory(+el.dataset.del); }));
}
// 回看历史：把该记录灌进（或新建）对应题目的任务并置为当前查看
function viewHistory(idx) {
  const h = loadHistory()[idx]; if (!h) return;
  const q = getQuestion(h.qid); if (!q) { toast('该题目已不在题库'); return; }
  let t = tasks.get(h.qid);
  if (!t) { t = makeTask(h.qid); tasks.set(h.qid, t); loadTaskBaseline(t); }
  t.model = h.model || ''; t.think = h.think || ''; t.endpoint = h.endpoint || '';
  t.html = h.html || ''; t.raw = h.raw || (h.html || ''); t.htmlDone = true;
  t.status = h.html ? 'done' : (h.raw ? 'raw' : 'idle');
  t.summary = h.summary || ''; t.summaryThink = h.summaryThink || ''; t.summaryNote = ''; t.summarizing = false;
  const kw = h.summary ? ['完全跑偏', '明显降智', '略有瑕疵', '正常发挥'].find((k) => h.summary.includes(k)) : '';
  t.verdict = kw || ''; t.verdictCls = kw === '正常发挥' ? 'ok' : (kw === '略有瑕疵' ? 'warn' : (kw ? 'bad' : ''));
  t.statusMsg = `回看历史 · ${h.qtitle} · ${h.model}`; t.statusErr = false;
  activeQid = h.qid;
  refreshCards(); renderDetail();
  $('#compareSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function deleteHistory(idx) { const list = loadHistory(); list.splice(idx, 1); persistHistory(list); renderHistory(); }
function clearHistory() { if (!confirm('确定清空全部检测历史吗？此操作不可恢复（仅清除本机记录）。')) return; if (persistHistory([])) { renderHistory(); toast('已清空历史'); } }

/* =====================================================================
 * 接口地址 = 「基础地址输入框」+「右侧路径下拉」
 * ---------------------------------------------------------------------
 * 用户只填基础地址（不带 /v1/...），路径从下拉里选。
 * 特殊路径的中转站可选「自定义」，此时完全按输入框原文请求，不拼任何后缀。
 * 粘贴完整地址时自动把已知路径剥到下拉里，保持老习惯可用。
 * ===================================================================== */
const CUSTOM_PATH = '';   // 下拉里「自定义」选项的 value

function renderPathSelect() {
  $('#epPath').innerHTML =
    PATH_OPTIONS.map((o) => `<option value="${o.path}">${o.path}</option>`).join('') +
    `<option value="${CUSTOM_PATH}">自定义（地址栏含完整路径）</option>`;
  $('#epPath').value = PATH_OPTIONS[0].path;
}

/* 拼出真正要请求的完整地址：base 自动补 https://，再接下拉选中的路径 */
function fullEndpoint() {
  const raw = $('#endpoint').value.trim();
  if (!raw) return '';
  const path = $('#epPath').value;
  const { base, tail } = splitEndpoint(raw);
  const head = /^https?:\/\//i.test(base) ? base : `https://${base}`;
  return path ? head + path + tail : head + tail;
}

/* 把一个（可能是完整的）地址灌进「输入框 + 下拉」：认得的路径剥到下拉，认不出的整条留在输入框并选「自定义」 */
function setEndpointValue(v) {
  const { base, path, tail } = splitEndpoint(v || '');
  if (path) { $('#endpoint').value = base + tail; $('#epPath').value = path; }
  else { $('#endpoint').value = (v || '').trim(); $('#epPath').value = CUSTOM_PATH; }
  syncEndpointUI();
}

/* 输入时若已粘进已知路径，自动剥离到下拉（只在识别出路径的那一刻动一次，不干扰正常输入） */
function onEndpointInput() {
  const el = $('#endpoint');
  const { base, path, tail } = splitEndpoint(el.value);
  if (path) { el.value = base + tail; $('#epPath').value = path; }
  syncEndpointUI();
}

/* 同步协议提示：显示拼好的完整地址 + 识别到的协议 */
function syncEndpointUI() {
  const el = $('#protoHint');
  const raw = $('#endpoint').value.trim();
  const isCustom = $('#epPath').value === CUSTOM_PATH;
  if (!raw) {
    el.innerHTML = isCustom
      ? '「自定义」模式：请在左侧填入<b>完整</b>接口地址（含 /v1/... 路径）。'
      : '只填基础地址（如 <b>https://你的中转站</b>），右侧选接口路径即可。';
    return;
  }
  const full = fullEndpoint();
  const m = PROTO_META[detectProtocol(full)];
  // 基础地址里还带着路径时提醒一句：分不清那是中转站前缀还是完整路径，交给用户看「实际请求」判断
  let note = '';
  const afterHost = raw.replace(/^https?:\/\//i, '').replace(/[?#].*$/, '');
  if (!isCustom && /\/[^/]/.test(afterHost)) {
    note = `<span class="warn">基础地址含路径，已在其后拼接</span> · `;
  }
  el.innerHTML = `${note}实际请求 <b>${escapeHtml(full)}</b> · ${m.name} · 鉴权 <b>${m.auth}</b> · 思考参数 <b>${m.thinkField}</b>`;
}

/* =====================================================================
 * 初始化
 * ===================================================================== */
function init() {
  $('#think').innerHTML = THINK_LEVELS.map((t) => `<option value="${t.key}">${t.label}</option>`).join('');
  $('#think').value = 'high';
  renderPathSelect();
  renderQuestions();
  renderConfigStore();
  renderHistory();
  refreshCards();
  renderDetail();
  if ('requestIdleCallback' in window) requestIdleCallback(prefetchBaselines);
  else setTimeout(prefetchBaselines, 800);
  $('#runBtn').addEventListener('click', runAllPending);
  $('#saveCfgBtn').addEventListener('click', saveCurrentConfig);
  $('#clearHistBtn').addEventListener('click', clearHistory);
  $('#endpoint').addEventListener('input', onEndpointInput);
  $('#epPath').addEventListener('change', syncEndpointUI);
  $('#cfgLabel').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCurrentConfig(); });
  $('#summaryBtn').addEventListener('click', () => { const t = activeQid ? tasks.get(activeQid) : null; if (t) doSummary(t, true); });
  $('#shareBtn').addEventListener('click', () => { const t = activeQid ? tasks.get(activeQid) : null; if (t) openSharePanel(t); });
  $('#shareGoBtn').addEventListener('click', () => { const t = activeQid ? tasks.get(activeQid) : null; if (t) doShare(t); });
  $('#shareCancelBtn').addEventListener('click', closeSharePanel);
  syncEndpointUI();
}
document.addEventListener('DOMContentLoaded', init);
