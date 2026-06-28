/* =====================================================================
 * protocols/openai.js —— OpenAI 协议探针集（Responses API / /v1/responses）
 * 原生路径 /v1/responses：请求体用 input/max_output_tokens/text.format，
 * 响应体 id 前缀 resp_、output 数组（reasoning + message[output_text]）、
 * usage.input_tokens/output_tokens。默认模型 gpt-5.5。
 * 探针顺序：渠道识别(0)→身份识别(1)→…→参数检测(2)，身份判定的渠道（如 Codex CLI）
 * 写入 ctx.shared.channel 供 param_check 读取。
 * ===================================================================== */
import { coefficientOfVariation } from '../core.js?v=14';

/* ---------- 小工具 ---------- */
// 遍历 output 数组取最终文本：找 type==='message' 项里的 output_text；
// 若是 refusal 单独标注；reasoning 项不含文本。防御 incomplete（无 message）。
function outputText(j) {
  const out = j?.output;
  if (!Array.isArray(out)) return '';
  const msg = out.find((o) => o && o.type === 'message');
  if (!msg || !Array.isArray(msg.content)) return '';
  const t = msg.content.find((c) => c && c.type === 'output_text');
  if (t && typeof t.text === 'string') return t.text;
  const refusal = msg.content.find((c) => c && c.type === 'refusal');
  if (refusal) return '[refusal] ' + (refusal.refusal || '');
  return '';
}
// 是否只产出了 reasoning 而无最终文本（预算耗尽常见）
function reasoningOnly(j) {
  const out = j?.output;
  if (!Array.isArray(out)) return false;
  return out.some((o) => o?.type === 'reasoning') && !out.some((o) => o?.type === 'message');
}
function fail(reason, score = 0, severity = '') {
  return { features: [], diffs: [reason], score, verdict: '假', severity, status: 'done' };
}
function isResponsesError(j) {
  return j && j.error && typeof j.error === 'object';
}

/* ===================================================================== */
/* 探针定义                                                              */
/* ===================================================================== */

const channel_id = {
  id: 'channel_id', name: '渠道来源识别', weight: 5, modes: ['Q', 'S', 'F'], passive: true, stage: 0,
  defaultPayload: (m) => ({ model: m, input: [{ role: 'user', content: '你好，请回复一个字。' }], max_output_tokens: 512 }),
  analyze(ctx) {
    const j = ctx.json; if (!j) return fail('无响应');
    const id = j.id;
    const features = [`响应 id: ${id || '(无)'}`];
    let ch;
    if (typeof id === 'string' && id.startsWith('resp_')) {
      ch = { channel: 'OpenAI 官方(Responses)', code: 'openai', critical: false };
      features.push('id 前缀 resp_ → 官方 Responses 端 ✓');
    } else if (typeof id === 'string' && id.startsWith('chatcmpl-')) {
      ch = { channel: 'Chat 兼容端(疑套壳)', code: 'chat_shape', critical: true };
    } else {
      ch = { channel: '非官方格式(疑套壳)', code: 'foreign', critical: true };
    }
    ctx.shared.channel = ch; // 给别的探针用（identity 可覆盖为 codex）
    if (ch.code === 'openai') return { features, diffs: [], score: 100, verdict: '真', severity: '', status: 'done' };
    return { features, diffs: [`id 前缀非官方 Responses 格式（${id}）→ 疑似逆向/套壳`], score: 0, verdict: '假', severity: 'critical', status: 'done' };
  },
};

// 竞品/外部品牌词（身份探针）
const RIVAL_WORDS = ['claude', 'anthropic', 'gemini', 'bard', 'deepseek', 'qwen', '通义', 'tongyi',
  '文心', 'wenxin', '豆包', 'doubao', 'llama', 'mistral', 'grok'];

const identity = {
  id: 'identity', name: '身份识别', weight: 5, modes: ['Q', 'S', 'F'], stage: 1,
  defaultPayload: (m) => ({
    model: m, max_output_tokens: 600,
    input: [{ role: 'user', content: '你究竟是谁？你的模型名称和版本是什么？由哪家公司开发？是否是某个命令行工具（如 Codex）的内置助手？请简洁回答。' }],
  }),
  analyze(ctx) {
    const text = (outputText(ctx.json) || '').toLowerCase();
    if (!text || text.startsWith('[refusal]')) {
      if (reasoningOnly(ctx.json)) return { features: ['仅产出 reasoning、无最终文本（预算耗尽？）'], diffs: ['未拿到身份自述'], score: 50, verdict: '存疑', severity: '', status: 'done' };
      return fail('无文本回复');
    }
    const features = [];
    const hasOpenAI = /\bopenai\b/.test(text);
    const hasGpt = /\bgpt[\s\-]?[0-9]/.test(text) || /\bchatgpt\b/.test(text);
    // "codex" / "codex cli"：命中即视为 Codex 工具渠道
    const hasCodex = /\bcodex\b/.test(text);
    const rivals = RIVAL_WORDS.filter((w) => text.includes(w));
    features.push(`含 "openai": ${hasOpenAI ? '是' : '否'}`, `含 "gpt/chatgpt": ${hasGpt ? '是' : '否'}`,
      `含 "codex": ${hasCodex ? '是' : '否'}`);

    const diffs = [];
    let score, severity = '';
    if (rivals.length && !hasOpenAI && !hasGpt) {
      diffs.push(`自称竞品身份: ${rivals.join(', ')}，且未提 OpenAI/GPT → 冒充`);
      score = 0; severity = 'critical';
    } else if (rivals.length) {
      diffs.push(`回复中混入竞品关键词: ${rivals.join(', ')}`);
      score = 30;
    } else if (hasOpenAI && hasGpt) {
      score = 100;
    } else if (hasOpenAI || hasGpt) {
      score = 60; diffs.push('仅提到 OpenAI/GPT 之一');
    } else {
      score = 0; diffs.push('完全未提及 OpenAI / GPT');
    }

    // 渠道细分：自述含 "codex" → 判为 Codex CLI 渠道（类似 Claude Code），而非官方直连。
    // 仅在 channel_id 已判为官方(openai) 时覆盖——套壳/异常结论保持不变。
    if (hasCodex && ctx.shared && ctx.shared.channel && ctx.shared.channel.code === 'openai') {
      ctx.shared.channel.channel = 'Codex CLI';
      ctx.shared.channel.code = 'codex';
      features.push('回复自述含 "codex" → 渠道修正为 Codex CLI（而非官方直连）');
    }

    return { features, diffs, score, verdict: score >= 70 ? '真' : (score >= 40 ? '存疑' : '假'), severity, status: 'done' };
  },
};

const basic_request = {
  id: 'basic_request', name: '基础可用', weight: 15, modes: ['Q', 'S', 'F'],
  defaultPayload: (m) => ({ model: m, max_output_tokens: 512, input: [{ role: 'user', content: 'Reply only with the single word: pong' }] }),
  analyze(ctx) {
    const j = ctx.json; if (!j) return fail('无响应');
    const text = outputText(j).toLowerCase();
    const features = [`status: ${j.status}`, `回复: "${outputText(j).slice(0, 40)}"`];
    if (text.includes('pong')) return { features, diffs: [], score: 100, verdict: '真', status: 'done' };
    if (text.trim() && !text.startsWith('[refusal]')) return { features, diffs: ['未回 pong 但有文本'], score: 80, verdict: '真', status: 'done' };
    if (reasoningOnly(j) && j.status === 'incomplete') return { features, diffs: ['推理预算耗尽，无最终文本（status=incomplete）'], score: 75, verdict: '存疑', status: 'done' };
    return fail('无有效文本');
  },
};

const protocol = {
  id: 'protocol', name: '协议规范+污染检测', weight: 15, modes: ['Q', 'S', 'F'], passive: true,
  defaultPayload: (m) => ({ model: m, max_output_tokens: 512, input: [{ role: 'user', content: 'ping' }] }),
  analyze(ctx) {
    const j = ctx.json; if (!j) return fail('无响应');
    const features = [], diffs = []; let crit = 0, minor = 0;
    if (typeof j.id === 'string' && j.id.startsWith('resp_')) features.push('id 前缀 resp_ ✓'); else { diffs.push(`id 前缀异常: ${j.id}`); crit++; }
    if (j.object === 'response') features.push('object=response ✓'); else { diffs.push(`object 异常: ${j.object}`); crit++; }
    if (Array.isArray(j.output)) features.push('output 数组存在 ✓'); else { diffs.push('output 缺失/非数组'); crit++; }
    const usage = j.usage || {};
    if (typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') features.push('usage.input_tokens/output_tokens ✓'); else { diffs.push('usage 缺 input_tokens/output_tokens（Responses 原生应有）'); minor++; }
    // 污染检测：Responses 原生不该出现 Chat 风格 / 竞品计数字段
    if ('prompt_tokens' in usage || 'completion_tokens' in usage) { diffs.push('usage 含 Chat 风格 prompt_tokens/completion_tokens → 疑似 Chat 套壳冒充 Responses!'); crit++; }
    if (Object.keys(usage).some((k) => k.startsWith('claude_'))) { diffs.push('usage 含 claude_* 字段 → 实为 Claude 套壳!'); crit++; }
    if (['candidates_token_count', 'prompt_token_count', 'thoughts_token_count'].some((k) => k in usage)) { diffs.push('usage 含 Gemini 计数字段 → 实为 Gemini 套壳!'); crit++; }
    if (!diffs.length) features.unshift('协议规范，无污染信号');
    const score = Math.max(0, 100 - crit * 35 - minor * 10);
    return { features, diffs, score, verdict: score >= 80 && crit === 0 ? '真' : '假', severity: crit ? 'critical' : '', status: 'done' };
  },
};

const model_consistency = {
  id: 'model_consistency', name: '模型一致性(防掺假)', weight: 15, modes: ['Q', 'S', 'F'], multi: 3,
  defaultPayload: (m) => ({ model: m, max_output_tokens: 512, input: [{ role: 'user', content: 'In one sentence, explain HTTP status 418.' }] }),
  analyze(ctx) {
    const runs = ctx.multiJson || (ctx.json ? [ctx.json] : []);
    if (!runs.length) return fail('无响应');
    const features = [], diffs = [];
    const norm = (s) => (s || '').replace(/[._]/g, '-');
    const req = norm(ctx.model), resp = norm(runs[0].model);
    // 响应 model 含日期后缀（gpt-5.5-2026-04-23），用 startsWith 容错
    const match = req && resp && (req === resp || resp.startsWith(req) || req.startsWith(resp));
    features.push(`请求模型: ${ctx.model}`, `响应模型: ${runs[0].model}`);
    let score = 0;
    if (match) score += 60; else diffs.push('响应 model 与请求不符 → 可能冒充/路由到别的模型');
    const outs = runs.map((r) => r?.usage?.output_tokens).filter((n) => typeof n === 'number');
    if (outs.length >= 2) {
      const cv = coefficientOfVariation(outs);
      features.push(`output_tokens: [${outs.join(', ')}], CV=${cv.toFixed(3)}`);
      if (cv < 0.1) score += 40; else if (cv < 0.3) { score += 20; diffs.push('token 波动偏大'); } else diffs.push('token 高度不稳定 → 疑似轮询多模型');
    } else score += 40;
    return { features, diffs, score, verdict: score >= 70 ? '真' : '假', status: 'done' };
  },
};

const param_check = {
  // 「报错」是正向验真信号；「不报错」不能判假——网关可能静默忽略 max_output_tokens，
  // Codex CLI 也可能不识别该字段。故无官方报错时记「不适用」(score:null)，不计入总分。
  id: 'param_check', name: '参数验真(max_output_tokens 下限)', weight: 10, modes: ['S', 'F'], errorProbe: true, stage: 2,
  defaultPayload: (m) => ({ model: m, max_output_tokens: 1, input: [{ role: 'user', content: 'hi' }] }),
  analyze(ctx) {
    const j = ctx.json;
    const err = j && j.error;
    const msg = (err && (err.message || '')) || '';
    const features = [`HTTP 状态码: ${ctx.httpStatus}`], diffs = [];
    // 官方对 max_output_tokens=1 的标准报错：param=max_output_tokens 且 code=integer_below_min_value，
    // 或消息明确提到 ">= 16"。
    const matchOfficial = !!err && (
      (err.param === 'max_output_tokens' && err.code === 'integer_below_min_value') ||
      /max_output_tokens/i.test(msg) && /(>=\s*16|minimum|below minimum|at least 16)/i.test(msg)
    );
    if (matchOfficial) {
      features.push('官方对 max_output_tokens=1 报「需 >= 16」→ 真实官方上游行为 ✓');
      features.push(`错误结构: type=${err.type || '-'}, code=${err.code || '-'}`);
      return { features, diffs, score: 100, verdict: '真', severity: '', status: 'done' };
    }
    const errored = (ctx.httpStatus >= 400) || !!err;
    if (errored) {
      // 报了别的错 → 无法据此验真
      features.push(`返回错误但非 max_output_tokens 下限报错：${(msg || ctx.body || '').slice(0, 90)}`);
      diffs.push('未拿到官方「需 >= 16」报错，无法据此验真。');
      return { features, diffs, score: null, verdict: '不适用', severity: '', status: 'done' };
    }
    // 200 正常返回（没报错）→ 结合身份渠道判断
    const ch = ctx.shared && ctx.shared.channel;
    if (ch && ch.code === 'codex') {
      features.push('未报错，但身份已判为 Codex CLI 渠道 → Codex CLI 不识别 max_output_tokens 字段，属合理');
      diffs.push('Codex CLI 渠道下本项不构成异常（不计分）。');
    } else {
      features.push(`未报错（HTTP ${ctx.httpStatus}）：未拒绝非法的 max_output_tokens=1`);
      diffs.push('身份无法判断为 Codex：可能是上游网关忽略了该参数，或存在逆向行为，请自行核实。');
    }
    return { features, diffs, score: null, verdict: '不适用', severity: '', status: 'done' };
  },
};

const function_calling = {
  id: 'function_calling', name: '函数调用', weight: 15, modes: ['S', 'F'],
  defaultPayload: (m) => ({
    model: m, max_output_tokens: 512,
    tools: [{ type: 'function', name: 'get_current_weather', description: 'Get current weather for a city.', strict: true, parameters: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['celsius', 'fahrenheit'] } }, required: ['city', 'unit'], additionalProperties: false } }],
    tool_choice: { type: 'function', name: 'get_current_weather' },
    input: [{ role: 'user', content: 'Use get_current_weather for Boston, MA in celsius. Do not answer directly.' }],
  }),
  analyze(ctx) {
    const out = ctx.json?.output;
    const features = [], diffs = []; let score = 0;
    const fc = Array.isArray(out) ? out.find((o) => o && o.type === 'function_call') : null;
    if (!fc) return fail('output 中无 function_call → 工具能力可能被剥离');
    const ck = (c, ok, bad) => { if (c) { score += 25; features.push(ok); } else diffs.push(bad); };
    ck(typeof fc.call_id === 'string' && fc.call_id.startsWith('call_'), `call_id 前缀 call_ ✓`, `call_id 异常: ${fc.call_id}`);
    ck(fc.name === 'get_current_weather', 'name 正确 ✓', `name 异常: ${fc.name}`);
    let args; try { args = JSON.parse(fc.arguments || '{}'); } catch { args = null; }
    ck(args && args.city, `arguments 合法: ${JSON.stringify(args)}`, 'arguments 非法/非 JSON 字符串');
    ck(args && ['celsius', 'fahrenheit'].includes(args.unit), 'unit 枚举合法 ✓', 'unit 不在枚举');
    return { features, diffs, score, verdict: score >= 70 ? '真' : '假', status: 'done' };
  },
};

const structured_output = {
  id: 'structured_output', name: '结构化输出', weight: 15, modes: ['S', 'F'],
  defaultPayload: (m) => ({
    model: m, max_output_tokens: 512,
    text: { format: { type: 'json_schema', name: 'detector_result', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' }, nonce: { type: 'string' } }, required: ['ok', 'nonce'], additionalProperties: false } } },
    input: [{ role: 'user', content: 'Return JSON matching the schema with ok=true and nonce="openai-detector".' }],
  }),
  analyze(ctx) {
    const text = outputText(ctx.json).trim();
    if (!text || text.startsWith('[refusal]')) return fail('无输出');
    const features = [], diffs = [];
    if (/```/.test(text)) diffs.push('被 markdown 代码块包裹 → 可能未透传 text.format');
    let parsed; try { parsed = JSON.parse(text.replace(/```json|```/g, '').trim()); } catch { return { features: [`输出: ${text.slice(0, 60)}`], diffs: ['非合法 JSON'], score: 20, verdict: '假', status: 'done' }; }
    features.push('合法 JSON ✓');
    let score = 50;
    if (parsed.ok === true && parsed.nonce === 'openai-detector') { score = 100; features.push('schema 完全匹配 ✓'); }
    else diffs.push('字段不符 (期望 ok=true, nonce=openai-detector)');
    return { features, diffs, score, verdict: score >= 70 ? '真' : '存疑', status: 'done' };
  },
};

const token_billing = {
  id: 'token_billing', name: 'Token 计费', weight: 10, modes: ['S', 'F'], tokenPair: true,
  defaultPayload: (m) => ({ model: m, max_output_tokens: 512, input: [{ role: 'user', content: 'Reply with exactly: ok' }] }),
  analyze(ctx) {
    const s = ctx.shortJson || ctx.json, l = ctx.longJson;
    if (!s) return fail('无响应');
    const features = [], diffs = []; let score = 0;
    const u = s.usage || {};
    if (typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') { score += 30; features.push(`input/output: ${u.input_tokens}/${u.output_tokens}`); } else diffs.push('usage 缺 input_tokens/output_tokens');
    if (typeof u.total_tokens === 'number' && Math.abs(u.total_tokens - (u.input_tokens + u.output_tokens)) <= 1) score += 20;
    else if (u.total_tokens != null) diffs.push('total ≠ input+output'); else score += 20;
    if (typeof u.output_tokens_details?.reasoning_tokens === 'number') features.push(`reasoning_tokens: ${u.output_tokens_details.reasoning_tokens}`);
    score += 20; // output_tokens 形态合理（含 reasoning，不便用绝对上限判断）
    if (l) {
      const d = (l.usage?.input_tokens ?? 0) - (u.input_tokens ?? 0);
      features.push(`长 prompt 增量: ${d}`);
      if (d >= 45 && d <= 140) score += 30; else diffs.push(`长短 prompt 增量异常(${d})`);
    } else score += 30;
    score = Math.min(score, 100);
    return { features, diffs, score, verdict: score >= 80 ? '真' : (score >= 60 ? '存疑' : '假'), status: 'done' };
  },
};

export const openaiProtocol = {
  id: 'openai', name: 'OpenAI', emoji: '🔵', icon: 'assets/icons/openai.svg', authStyle: 'bearer',
  defaultEndpoint: 'https://api.openai.com/v1/responses',
  defaultModel: 'gpt-5.5', endpointHint: '形如 https://你的中转站/v1/responses',
  betaHeader: '',
  probes: [channel_id, identity, basic_request, model_consistency, protocol, param_check, function_calling, structured_output, token_billing],
};
