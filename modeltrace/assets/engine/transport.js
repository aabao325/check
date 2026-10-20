/* =====================================================================
 * engine/transport.js —— 发请求：接口路径可选 + 请求体按路径适配 + 浏览器直连
 * ---------------------------------------------------------------------
 * 三种接口路径的**请求体与响应体字段几乎不重合**，填错路径或字段名，上游会直接 400：
 *
 *                     /v1/chat/completions      /v1/responses           /v1/messages
 *   指令              messages[0] role=system   instructions（顶层）      system（顶层）
 *   消息              messages[]                input                    messages[]
 *   输出上限          max_tokens /              max_output_tokens        max_tokens
 *                     max_completion_tokens
 *   鉴权              Authorization: Bearer     Bearer                   x-api-key(+Bearer)
 *   流式正文           choices[].delta.content  response.output_text     content_block_delta
 *                                               .delta                   .delta.text
 *   结束原因          finish_reason             status=incomplete        stop_reason
 *  （max_tokens vs max_completion_tokens：新模型（gpt-5.x / o 系列）只认后者，老模型与
 *    多数中转站只认前者。两者**不会同时被接受**，所以这里先发一个，被拒时自动换另一个重发。）
 *
 * 路径由用户明确选择（auto / 三条标准路径 / 自定义），不再靠猜：
 *   auto —— 按 Base URL 的特征推断；仍保留「一条格式失败就翻另一种」的兜底，
 *           因为 auto 本质就是不知道，猜错要能自救。
 *   显式 —— 用户选了就**不再翻**：翻了会给出误导性的错误，还不如直接报「你这个路径不对」。
 *
 * 一律【流式】请求、浏览器直连（站点过 Cloudflare，服务端阻塞转发会撞 100s 超时 → 502）。
 * 直连抛网络异常（多为目标没开 CORS）时，静默改走 ../iq/iq-proxy.php：那是一个逐块
 * 转发 + 心跳保活的流式中转，已有内网地址拦截，这里直接复用，不再另写一个代理。
 *
 * 纯逻辑部分（URL 拼接、请求体、增量解析、错误归类）都是导出的纯函数，可单测；
 * 只有 requestCompletion 碰网络。fetchImpl 可注入，测试用假 fetch。
 * ===================================================================== */

export const PROXY_URL = '../iq/iq-proxy.php';
export const ANTHROPIC_VERSION = '2023-06-01';
/* 300 个三位数 + 分隔符约 1.5k token；给足 4096 防止思考型模型把预算吃光后截断。 */
export const MAX_TOKENS = 4096;

/* 接口路径 → 协议。协议决定「请求体怎么写、响应怎么读」。 */
export const FORMATS = {
  openai: { id: 'openai', name: 'OpenAI Chat Completions', authStyle: 'bearer', path: '/v1/chat/completions' },
  responses: { id: 'responses', name: 'OpenAI Responses', authStyle: 'bearer', path: '/v1/responses' },
  anthropic: { id: 'anthropic', name: 'Anthropic Messages', authStyle: 'x-api-key', path: '/v1/messages' },
};

/* 可选路径下拉的三个标准项（顺序＝界面展示顺序，也是 auto 的尝试顺序）。 */
export const PATH_OPTIONS = [
  { id: 'auto', label: '自动识别（按接口地址）' },
  { id: 'chat', label: '/v1/chat/completions（messages / max_tokens）' },
  { id: 'responses', label: '/v1/responses（input / max_output_tokens）' },
  { id: 'messages', label: '/v1/messages（Anthropic Messages）' },
  { id: 'custom', label: '自定义（下方填完整路径）' },
];

/* 下拉选项 → 协议。'auto' 与 'custom' 不在此表：前者靠推断，后者由调用方直接给出地址。
 * ⚠️ 这是「界面用语」到「协议」的映射；协议名本身（openai / responses / anthropic）
 *    也能直接当 format 传进来 —— 调用方（runner）内部流转用的就是协议名，
 *    两种口径都要接得住，见 resolveTarget。 */
export const PATH_TO_FORMAT = { chat: 'openai', responses: 'responses', messages: 'anthropic' };

/* 已知接口路径（含常见变体），用于从用户粘的完整地址里剥出 Base URL。
 * ⚠️ 顺序＝匹配优先级：先长后短，避免 /v1/chat/completions 被 /completions 抢先命中。 */
const PATH_VARIANTS = [
  { suffix: '/v1/chat/completions', proto: 'openai' },
  { suffix: '/chat/completions', proto: 'openai' },
  { suffix: '/v1/responses', proto: 'responses' },
  { suffix: '/responses', proto: 'responses' },
  { suffix: '/v1/messages', proto: 'anthropic' },
  { suffix: '/messages', proto: 'anthropic' },
];

/* 把用户填的地址拆成「站点前缀 + 已识别的接口路径 + 尾巴(query/hash)」。
 * 用 lastIndexOf：中转站自身可能带 /messages 之类的前缀路径，取最后一次出现的更准。 */
export function splitEndpoint(raw) {
  const s0 = String(raw || '').trim();
  if (!s0) return { base: '', path: '', proto: '', tail: '' };
  const cut = s0.search(/[?#]/);
  const tail = cut >= 0 ? s0.slice(cut) : '';
  const s = (cut >= 0 ? s0.slice(0, cut) : s0).replace(/\/+$/, '');
  const low = s.toLowerCase();
  for (const v of PATH_VARIANTS) {
    const i = low.lastIndexOf(v.suffix);
    if (i >= 0 && i + v.suffix.length === low.length) {
      return { base: s.slice(0, i).replace(/\/+$/, ''), path: v.suffix, proto: v.proto, tail };
    }
  }
  return { base: s, path: '', proto: '', tail };
}

/* 从地址推断协议（auto 用）。识别不出时回落到 chat：多数中转站默认给的是它。 */
export function detectFormat(raw) {
  const hit = splitEndpoint(raw).proto;
  if (hit) return hit;
  const u = String(raw || '').toLowerCase();
  if (/\/responses\b/.test(u)) return 'responses';
  if (/\/messages\b/.test(u)) return 'anthropic';
  return 'openai';
}

/* 用户的下拉选择 → 要用的协议与最终 URL。
 * format 接得住两种口径：界面的路径 id（'auto' / 'chat' / 'responses' / 'messages' / 'custom'）
 * 与内部协议名（'openai' / 'responses' / 'anthropic'）。runner 往下传的是后者 ——
 * 「整轮换协议重跑」要按协议名切换，不可能用界面 id。 */
export function resolveTarget(baseUrl, format = 'auto', customPath = '') {
  if (format === 'custom') {
    const raw = String(customPath || '').trim();
    // 自定义允许两种填法：完整地址（http(s)://…）直接照用；
    // 只填路径（/v1/xxx）则接到 Base URL 后面 —— 用户可以只改路径那一段。
    if (/^https?:\/\//i.test(raw)) return { proto: detectFormat(raw), url: raw };
    if (raw) return { proto: detectFormat(raw), url: joinBase(baseUrl, raw) };
    return { proto: detectFormat(baseUrl), url: '' };
  }
  const proto = PATH_TO_FORMAT[format] || (FORMATS[format] ? format : null);
  if (proto) return { proto, url: joinBase(baseUrl, FORMATS[proto].path) };
  const guessed = detectFormat(baseUrl);
  return { proto: guessed, url: joinBase(baseUrl, FORMATS[guessed].path) };
}

/* Base URL 归一：用户可能填 https://x.com、https://x.com/v1、或者直接贴完整的接口地址。
 * 先剥掉已识别的接口路径，再按需要补版本号，最后接协议路径（路径里的版本号要去掉）。
 *
 * ⚠️ 两处易错，都踩过：
 *   ① base 结尾的 /v1 要保留、不能被路径里的 /v1 又叠一层 —— 写成「base 不以 /v1 结尾才补」
 *      会让 https://x.com/v1 + /v1/messages 拼成 /v1/v1/messages。
 *   ② 版本号冲突时以**用户填的 base** 为准。base 已经是 /api/v2 时不改成 /api/v1：
 *      更怪的版本号一定是用户有意填的（自建网关、非标准前缀），改成 v1 反而错得更远。 */
export function joinBase(baseUrl, path) {
  const { base } = splitEndpoint(baseUrl);
  const u = base.replace(/\/+$/, '');
  const versioned = /\/v\d+$/i.test(u);
  const tail = path.replace(/^\/v\d+/i, '');   // /v1/messages → /messages
  return versioned ? u + tail : u + path;
}

/* 兼容旧签名：completionUrl(base, 'openai' | 'anthropic')。 */
export function completionUrl(baseUrl, format) {
  const f = FORMATS[format] || FORMATS.openai;
  return joinBase(baseUrl, f.path);
}

/* auto 模式的尝试顺序：按地址特征判一个首选，另一个作兜底。
 * 'responses' 也参与兜底 —— 那类中转站只提供 /v1/responses，只试 chat/messages 会全军覆没。 */
export function formatOrder(baseUrl) {
  const first = detectFormat(baseUrl);
  const rest = ['openai', 'responses', 'anthropic'].filter((f) => f !== first);
  return [first, ...rest];
}

/* 输出上限字段名：新模型只认 max_completion_tokens，老的与多数中转站只认 max_tokens。
 * 按模型名先猜一个能少一轮往返，猜错由 maxTokensFieldFallback 兜。 */
export function pickMaxTokensField(model, forced) {
  if (forced === 'max_tokens' || forced === 'max_completion_tokens') return forced;
  return /^(gpt-5|o[1-9]|o\d)/i.test(String(model || '').trim()) ? 'max_completion_tokens' : 'max_tokens';
}

export function buildPayload(format, model, prompt, system = '', maxTokensField) {
  if (format === 'anthropic') {
    const body = { model, max_tokens: MAX_TOKENS, stream: true, messages: [{ role: 'user', content: prompt }] };
    if (system) body.system = system;
    return body;
  }
  if (format === 'responses') {
    // 官方文档：Responses 的 max_output_tokens 下限是 16，比 Chat 端的 1 高。
    // 这里取 MAX(MAX_TOKENS, 16)，跟 Chat 端保持同一个预算口径，免得两条路径的截断判定不一致。
    const body = { model, input: prompt, max_output_tokens: Math.max(MAX_TOKENS, 16), stream: true };
    if (system) body.instructions = system;
    return body;
  }
  const field = pickMaxTokensField(model, maxTokensField);
  return {
    model, [field]: MAX_TOKENS, stream: true,
    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
  };
}

/* 上游拒绝了输出上限字段名 → 给出该换的那个名。认不出就返回 null（说明是别的错，
 * 例如模型名写错，那种情况重发一遍只是白烧额度）。
 *
 * 覆盖两种官方措辞：
 *   ① "Unsupported parameter: 'max_tokens' is not supported with this model.
 *       Use 'max_completion_tokens' instead."            → unsupported_parameter
 *   ② "max_completion_tokens 不被支持，请使用 max_tokens" → 中文站常见，靠字段名同时出现判断 */
export function maxTokensFieldFallback(bodyText, tried) {
  const s = String(bodyText || '');
  const other = tried === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
  // 必须同时出现另一个字段名，且整体在说「不支持/无效/请改用」，才认为是字段名问题
  if (!s.includes(other)) return null;
  const says = new RegExp(`(${other}[^"']{0,40}(不支持|无效|请(改为|使用)|改用))|((不支持|无效|请(改为|使用)|改用)[^"']{0,40}${other})`, 'i');
  if (says.test(s)) return other;
  if (/unsupported_parameter|unsupported value|is not supported with this model/i.test(s)) return other;
  return null;
}

export function buildHeaders(format, apiKey) {
  const h = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (format === 'anthropic') {
    h['x-api-key'] = apiKey;
    h.Authorization = `Bearer ${apiKey}`;   // 不少中转站的 /v1/messages 只认 Bearer
    h['anthropic-version'] = ANTHROPIC_VERSION;
  } else {
    h.Authorization = `Bearer ${apiKey}`;
  }
  return h;
}

/* SSE 单个 data 对象 → { text, finish }。finish 归一成 'stop' | 'length' | 'refusal' | 'filter' | null。 */
export function streamDelta(format, obj) {
  if (!obj || typeof obj !== 'object') return { text: '', finish: null };
  if (format === 'anthropic') {
    if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') return { text: obj.delta.text || '', finish: null };
    if (obj.type === 'message_delta') return { text: '', finish: normFinish(obj.delta?.stop_reason) };
    if (obj.type === 'error') return { text: '', finish: null, error: obj.error?.message || '上游返回错误事件' };
    return { text: '', finish: null };
  }
  if (format === 'responses') {
    if (obj.type === 'response.output_text.delta' && typeof obj.delta === 'string') return { text: obj.delta, finish: null };
    if (obj.type === 'response.refusal.delta' && typeof obj.delta === 'string') return { text: '', finish: null };
    if (obj.type === 'response.failed' || obj.type === 'error') {
      const m = obj.response?.error?.message || obj.error?.message || '上游返回错误事件';
      return { text: '', finish: null, error: m };
    }
    if (obj.type === 'response.completed' || obj.type === 'response.incomplete') return { text: '', finish: responsesFinish(obj.response) };
    return { text: '', finish: null };
  }
  const choice = obj.choices?.[0];
  if (obj.error) return { text: '', finish: null, error: obj.error.message || JSON.stringify(obj.error).slice(0, 200) };
  if (!choice) return { text: '', finish: null };
  let text = choice.delta?.content ?? '';
  if (Array.isArray(text)) text = text.map((p) => p?.text || '').join('');
  return { text: String(text || ''), finish: normFinish(choice.finish_reason) };
}

/* Responses 的结束原因藏在 status + incomplete_details.reason 里（不是 finish_reason）。 */
function responsesFinish(resp) {
  if (!resp || typeof resp !== 'object') return null;
  if (resp.status === 'incomplete') {
    const reason = resp.incomplete_details?.reason;
    if (reason === 'max_output_tokens') return 'length';
    if (reason === 'content_filter') return 'filter';
    return 'length';
  }
  return 'stop';
}

/* 非流式整包（目标忽略了 stream:true）→ { text, finish }。 */
export function wholeMessage(format, json) {
  if (format === 'anthropic') {
    const text = (json?.content || []).filter((b) => b?.type === 'text').map((b) => b.text || '').join('');
    return { text, finish: normFinish(json?.stop_reason) };
  }
  if (format === 'responses') {
    let text = typeof json?.output_text === 'string' ? json.output_text : '';
    if (!text) {
      const items = Array.isArray(json?.output) ? json.output : [];
      for (const it of items) {
        if (it?.type !== 'message') continue;
        for (const c of it.content || []) {
          if (c?.type === 'output_text' && c.text) text += c.text;
        }
      }
    }
    // 只产出 reasoning 没正文（预算被思考吃光）→ 也返回空文本，交给上层判「数字不足」
    return { text, finish: responsesFinish(json) };
  }
  const choice = json?.choices?.[0];
  let text = choice?.message?.content ?? '';
  if (Array.isArray(text)) text = text.map((p) => p?.text || '').join('');
  return { text: String(text || ''), finish: normFinish(choice?.finish_reason) };
}

function normFinish(reason) {
  if (!reason) return null;
  if (reason === 'length' || reason === 'max_tokens' || reason === 'max_output_tokens') return 'length';
  if (reason === 'refusal') return 'refusal';
  if (reason === 'content_filter') return 'filter';
  return 'stop';
}

/* 判断响应结构是否属于该格式 —— 用来区分「格式不对」和「格式对但出错」。 */
export function looksLikeFormat(format, json) {
  if (!json || typeof json !== 'object') return false;
  if (format === 'anthropic') return json.type === 'message' || Array.isArray(json.content);
  if (format === 'responses') {
    return json.object === 'response' || Array.isArray(json.output) || typeof json.output_text === 'string';
  }
  return Array.isArray(json.choices);
}

const WAF = /cloudflare|just a moment|cf-ray|access denied|attention required/i;

/* 把各种失败翻译成人话。kind 决定后续怎么处理：
 *   auth    Key 无效 / 无权限        → 立即停止全部探针（换格式也没用）
 *   model   模型不存在 / 不支持       → 立即停止
 *   format  这个格式/路径不对          → auto 下换另一种格式再试
 *   quota   限流 / 余额不足           → 停止，提示稍后再试
 *   network 连不上 / CORS / 中转失败  → 换格式没用，停止
 *   upstream 5xx 等暂时性错误        → 这一份作废，继续下一份 */
export function classifyHttpError(status, bodyText) {
  const text = String(bodyText || '');
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : '') || text;
  } catch { /* 非 JSON */ }
  msg = String(msg).replace(/\s+/g, ' ').trim().slice(0, 240);
  if (WAF.test(text) && /<html/i.test(text)) return { kind: 'network', message: '被上游网关（Cloudflare/WAF）拦截：请确认 Base URL 指向 API 而不是网页地址' };
  if (status === 401 || status === 403) return { kind: 'auth', message: `鉴权失败（HTTP ${status}）：${msg || 'API Key 无效或无权限'}` };
  if (status === 429) return { kind: 'quota', message: `被限流或额度不足（HTTP 429）：${msg}` };
  if (/model.*(not.*(found|exist|support)|does not exist|invalid)|无效的模型|模型不存在|no available channel|无可用渠道/i.test(msg)) {
    return { kind: 'model', message: `中转站不认识这个模型名：${msg}` };
  }
  if (status === 404 || status === 405) return { kind: 'format', message: `接口路径不支持（HTTP ${status}）` };
  if (status === 400 || status === 415 || status === 422) return { kind: 'format', message: `请求格式不被接受（HTTP ${status}）：${msg}` };
  if (status >= 500) return { kind: 'upstream', message: `上游服务出错（HTTP ${status}）：${msg}` };
  return { kind: 'upstream', message: `HTTP ${status}：${msg}` };
}
/* ---------- 网络部分 ---------- */

export class ProbeError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

/* 读 SSE 流：累积正文、记下结束原因。支持 iq-proxy 的两种控制事件。
 * onText(full) 用于实时进度（显示已解析出多少个数字）。 */
export async function readStream(res, format, { onText, signal } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '', full = '', finish = null, control = null, raw = '';
  const handle = (line) => {
    if (!line.startsWith('data:')) return;           // ':' 开头是心跳注释
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(data); } catch { return; }
    if (obj && (obj.__iq_error || obj.__iq_json)) { control = obj; return; }
    const d = streamDelta(format, obj);
    if (d.error) throw new ProbeError('upstream', d.error);
    if (d.text) { full += d.text; onText?.(full); }
    if (d.finish) finish = d.finish;
  };
  while (true) {
    if (signal?.aborted) { try { await reader.cancel(); } catch { /* ignore */ } throw new ProbeError('aborted', '已取消'); }
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (raw.length < 4000) raw += chunk;
    buffer = (buffer + chunk).replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split('\n')) handle(line);
    }
  }
  for (const line of buffer.split('\n')) handle(line);
  return { text: full, finish, control, raw };
}

function decodeProxyJson(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder('utf-8').decode(bytes));
}

/* 发一次请求并拿到完整文本。失败一律抛 ProbeError（带 kind）。
 * 返回 { text, finish, viaProxy, ms, maxTokensField }。 */
export async function requestCompletion({ baseUrl, apiKey, model, format = 'auto', customPath = '', prompt, system = '', maxTokensField, signal, onText, fetchImpl = fetch, proxyUrl = PROXY_URL }) {
  const { proto, url } = resolveTarget(baseUrl, format, customPath);
  if (!url) throw new ProbeError('format', '接口地址为空');

  const started = Date.now();
  let res, viaProxy = false;
  let usedField = proto === 'anthropic' || proto === 'responses' ? null : pickMaxTokensField(model, maxTokensField);
  let payload = buildPayload(proto, model, prompt, system, usedField);

  const send = async () => {
    const headers = buildHeaders(proto, apiKey);
    try {
      return await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(payload), signal });
    } catch (e) {
      if (signal?.aborted) throw new ProbeError('aborted', '已取消');
      // 直连失败（多为目标未开 CORS）→ 改走流式中转
      viaProxy = true;
      const extraHeaders = proto === 'anthropic' ? { 'anthropic-version': ANTHROPIC_VERSION } : {};
      try {
        return await fetchImpl(proxyUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({ targetUrl: url, apiKey, authStyle: FORMATS[proto].authStyle, payload, extraHeaders }),
        });
      } catch (e2) {
        if (signal?.aborted) throw new ProbeError('aborted', '已取消');
        throw new ProbeError('network', `无法连接接口：浏览器直连被拦（${String(e.message || e)}），本站中转也失败（${String(e2.message || e2)}）`);
      }
    }
  };

  res = await send();

  /* 「输出上限字段名不被这个模型接受」—— 就地换字段名重发一次。
   * 这一步是必需的：用户填了 /v1/chat/completions，上游却回
   *   Unsupported parameter: 'max_tokens' ... Use 'max_completion_tokens' instead.
   * 光看路径判断不出该用哪个名（同一个路径上新老模型要求相反），只能按上游的回话改。
   * 只重发一次；只有错误信息确实指向该字段才重发，避免把模型名写错这类真实错误也重发一遍。 */
  if (res.status === 400 && usedField) {
    const bodyText = await res.text().catch(() => '');
    const swap = maxTokensFieldFallback(bodyText, usedField);
    if (swap) {
      usedField = swap;
      payload = buildPayload(proto, model, prompt, system, usedField);
      res = await send();
    } else {
      const c = classifyHttpError(res.status, bodyText);
      throw new ProbeError(c.kind, c.message, { status: res.status, viaProxy });
    }
  }

  if (res.status < 200 || res.status >= 300) {
    const body = await res.text().catch(() => '');
    const c = classifyHttpError(res.status, body);
    throw new ProbeError(c.kind, c.message, { status: res.status, viaProxy, url });
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  let out;
  if (res.body && ct.includes('stream')) {
    const s = await readStream(res, proto, { onText, signal });
    if (s.control?.__iq_error) {
      const m = /HTTP (\d{3})：([\s\S]*)$/.exec(s.control.__iq_error);
      if (m) { const c = classifyHttpError(Number(m[1]), m[2]); throw new ProbeError(c.kind, c.message, { status: Number(m[1]), viaProxy }); }
      throw new ProbeError('network', `本站中转：${s.control.__iq_error}`, { viaProxy });
    }
    if (s.control?.__iq_json) {
      let json;
      try { json = decodeProxyJson(s.control.__iq_json); } catch { throw new ProbeError('format', '中转返回的整包响应无法解析', { viaProxy }); }
      if (!looksLikeFormat(proto, json)) throw new ProbeError('format', `响应结构不是 ${FORMATS[proto].name}`, { viaProxy });
      out = wholeMessage(proto, json);
    } else {
      // 拿到流但一个增量都没解析出来：多半是路径选错了（例如 Responses 事件发给了 Chat 解析器）
      if (!s.text && !s.finish) {
        throw new ProbeError('format', `流式响应里没有 ${FORMATS[proto].name} 格式的内容`, { viaProxy, raw: s.raw.slice(0, 300) });
      }
      out = { text: s.text, finish: s.finish };
    }
  } else {
    const body = await res.text();
    let json;
    try { json = JSON.parse(body); } catch { throw new ProbeError('format', `响应不是 JSON：${body.slice(0, 160)}`, { viaProxy }); }
    if (json?.error && !looksLikeFormat(proto, json)) {
      const c = classifyHttpError(400, JSON.stringify(json));
      throw new ProbeError(c.kind, c.message, { viaProxy });
    }
    if (!looksLikeFormat(proto, json)) throw new ProbeError('format', `响应结构不是 ${FORMATS[proto].name}`, { viaProxy });
    out = wholeMessage(proto, json);
  }
  // 拒答 / 截断 / 内容过滤：这份回答作废，但路径本身是通的
  if (out.finish === 'refusal') throw new ProbeError('rejected', '模型拒绝生成，本份不计入', { viaProxy, formatOk: true });
  if (out.finish === 'filter') throw new ProbeError('rejected', '回答被内容过滤截断，本份不计入', { viaProxy, formatOk: true });
  if (out.finish === 'length') throw new ProbeError('rejected', `回答因输出上限(${MAX_TOKENS})截断，本份不计入`, { viaProxy, formatOk: true });
  return { text: out.text, finish: out.finish, viaProxy, ms: Date.now() - started, format: proto, url, maxTokensField: usedField };
}

/* 自动探测：按顺序试格式，遇到 format 类错误换下一个；其它错误（鉴权、模型名、网络）直接抛，
 * 因为换格式解决不了。都失败时抛合并后的错误。
 * ⚠️ 用户显式选了路径时不要走这里 —— 翻格式会给出误导性的错误信息。 */
export async function detectAndRequest(opts) {
  const order = opts.formats || formatOrder(opts.baseUrl);
  const errors = [];
  for (const format of order) {
    try {
      const r = await opts.request({ ...opts, format });
      return { ...r, format };
    } catch (e) {
      if (!(e instanceof ProbeError)) throw e;
      if (e.formatOk) { e.format = format; throw e; }
      if (e.kind !== 'format') { e.format = format; throw e; }
      errors.push(`${FORMATS[format].name}：${e.message}`);
    }
  }
  throw new ProbeError('format', `三条接口路径都没跑通 —— ${errors.join('；')}`);
}
