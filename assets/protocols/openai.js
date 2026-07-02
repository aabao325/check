/* =====================================================================
 * protocols/openai.js —— OpenAI 协议探针集（Responses API / /v1/responses）
 * 原生路径 /v1/responses：请求体用 input/max_output_tokens/text.format，
 * 响应体 id 前缀 resp_、output 数组（reasoning + message[output_text]）、
 * usage.input_tokens/output_tokens。默认模型 gpt-5.5。
 * 探针顺序：渠道识别(0)→身份识别(1)→…→参数检测(2)，身份判定的渠道（如 Codex CLI）
 * 写入 ctx.shared.channel 供 param_check 读取。
 * ===================================================================== */
import { coefficientOfVariation } from '../core.js?v=25';
import { scanAzureContentFilter, scanResponseHeaders, decideConclusion } from './openai_signals.js?v=25';

// 回链探测：请求体里图片 URL 的哨兵占位符。后端 trace.php?action=start 会把它替换成
// 本站公网可达的回链地址——这样「前端构造并展示请求体」的约定不变，真实 URL 由后端注入。
const TRACE_IMG_PLACEHOLDER = '__TRACE_IMG_URL__';
function fmtDelta(d) { return d == null ? '?' : (d >= 0 ? '+' : '') + d; }

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
// 判断 text 中 idx 位置的词是否处于「否定语境」（如「我不是 Codex」「not the Codex…」）。
// 取该词前一小段窗口找否定标记，避免把模型的澄清/否认当成正面自述。text 已 toLowerCase。
function isNegatedNearby(text, idx) {
  if (typeof idx !== 'number' || idx < 0) return false;
  const window = text.slice(Math.max(0, idx - 14), idx);
  // 中文否定：不是/不属于/并非/并不是/而非/绝非/不算/没有；英文：not / n't / never / isn't…（n't 已被 't 覆盖）
  return /不是|不属于|不算|并非|并不|而非|绝非|没有|\bnot\b|n['’]t|\bnever\b/.test(window);
}
function isResponsesError(j) {
  return j && j.error && typeof j.error === 'object';
}

/* ---------- max_output_tokens 强验真辅助 ---------- */
// 「我的指令是什么」纯官方恒为 input_tokens=10；不同分词器留 2 容错。
const BASE_A = 12; // 主句 input_tokens 容错上限
const BASE_B = 10; // 对照句 "hi" input_tokens 容错上限（官方约 8）
// 判断响应是否「在 max_output_tokens 处被精确截断」：
// status=incomplete 且 incomplete_details.reason=max_output_tokens。
function truncatedByMaxTokens(j) {
  if (!j) return false;
  const inc = j.status === 'incomplete';
  const reason = j.incomplete_details && j.incomplete_details.reason;
  return inc && reason === 'max_output_tokens';
}
// 取 usage.input_tokens（数字或 null）
function inputTokensOf(j) {
  const n = j?.usage?.input_tokens;
  return typeof n === 'number' ? n : null;
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
    model: m, max_output_tokens: 2048,
    // 中性提问：不主动提及 Codex/任何渠道，避免把关键词喂给模型后又拿它来判定（自我污染）。
    // 预算给足 2048：推理模型(如 gpt-5-nano)会先花大量 token 思考，预算太小会只产 reasoning 无文本。
    input: [{ role: 'user', content: '你究竟是谁？你的模型名称和版本是什么？由哪家公司开发？请简洁回答。' }],
  }),
  analyze(ctx) {
    const text = (outputText(ctx.json) || '').toLowerCase();
    if (!text || text.startsWith('[refusal]')) {
      // 预算耗尽（只产 reasoning 无最终文本）→ 记「不适用」不计分，避免推理模型被误杀为假。
      if (reasoningOnly(ctx.json)) return { features: ['仅产出 reasoning、无最终文本（max_output_tokens 预算耗尽）'], diffs: ['未拿到身份自述（预算耗尽，本项不计分；可调大 max_output_tokens 重试）'], score: null, verdict: '不适用', severity: '', status: 'done' };
      return fail('无文本回复');
    }
    const features = [];
    const hasOpenAI = /\bopenai\b/.test(text);
    const hasGpt = /\bgpt[\s\-]?[0-9]/.test(text) || /\bchatgpt\b/.test(text);
    // "codex"：仅当模型【自发肯定】自己是 Codex 时才算渠道信号。
    // 否定语境（如「我不是 Codex」「并非 Codex」「not the Codex assistant」）不计——
    // 否则模型澄清「我不是 Codex」反而被误判成 Codex 渠道（自我污染的典型坑）。
    const codexMatch = text.match(/\bcodex\b/);
    const hasCodexWord = !!codexMatch;
    const codexAffirmed = hasCodexWord && !isNegatedNearby(text, codexMatch.index);
    const rivals = RIVAL_WORDS.filter((w) => text.includes(w));
    features.push(`含 "openai": ${hasOpenAI ? '是' : '否'}`, `含 "gpt/chatgpt": ${hasGpt ? '是' : '否'}`,
      `自述为 codex: ${hasCodexWord ? (codexAffirmed ? '是' : '否（否定语境，已忽略）') : '否'}`);

    const diffs = [];
    let score, severity = '';
    // 注意：OpenAI 身份探针【故意不设】anthropic.js 那样的「官方 id 守卫」。
    // Claude 官方渠道容忍偶发竞品幻觉（记不适用），但 OpenAI 自述竞品身份一律按【冒充】判 critical。
    // 切勿把 Claude 的容忍逻辑复制到此处（御三家中仅 Claude 容忍）。
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

    // 渠道细分：模型【自发肯定】自己是 Codex → 判为 Codex CLI 渠道（类似 Claude Code），而非官方直连。
    // 仅在 channel_id 已判为官方(openai) 时覆盖——套壳/异常结论保持不变；否定语境不触发。
    if (codexAffirmed && ctx.shared && ctx.shared.channel && ctx.shared.channel.code === 'openai') {
      ctx.shared.channel.channel = 'Codex CLI';
      ctx.shared.channel.code = 'codex';
      features.push('回复自述含 "codex" → 渠道修正为 Codex CLI（而非官方直连）');
    }

    return { features, diffs, score, verdict: score >= 70 ? '真' : (score >= 40 ? '存疑' : '假'), severity, status: 'done' };
  },
};

const basic_request = {
  id: 'basic_request', name: '基础可用', weight: 15, modes: ['Q', 'S', 'F'],
  defaultPayload: (m) => ({ model: m, max_output_tokens: 2048, input: [{ role: 'user', content: 'Reply only with the single word: pong' }] }),
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
  defaultPayload: (m) => ({ model: m, max_output_tokens: 2048, input: [{ role: 'user', content: 'In one sentence, explain HTTP status 418.' }] }),
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
      // 推理模型 output_tokens（含思考）天然波动大，放宽阈值：CV<0.5 视为正常不扣分，
      // 主防伪信号是 model 名一致（上面 +60）；只有极端波动(>0.8)才疑轮询多模型。
      if (cv < 0.5) score += 40; else if (cv < 0.8) { score += 30; features.push('token 有波动，但推理模型属正常范围'); } else { score += 10; diffs.push('token 高度不稳定 → 疑似轮询多模型'); }
    } else score += 40;
    return { features, diffs, score, verdict: score >= 70 ? '真' : '假', status: 'done' };
  },
};

const param_check = {
  // max_output_tokens 强验真（双固定句对照）：
  //  A=「我的指令是什么」(官方恒 input_tokens=10) + max_output_tokens:16
  //  B=「hi」(官方约 8) + max_output_tokens:16
  // 真官方：思考阶段就被精确截断（status=incomplete / reason=max_output_tokens / output_tokens≈16
  //         全是 reasoning_tokens、无 message），且 input_tokens 精确 → 强验真 100。
  // 两句 input_tokens 都偏高 → 疑似 Codex 注入了系统提示词，写 shared.injection 供 codex_verdict 研判。
  // 不识别 max_output_tokens（不截断/出完整答案）→ 结合身份记「不适用」(score:null)。
  id: 'param_check', name: '参数强验真(max_output_tokens 精确截断+计费)', weight: 10, modes: ['S', 'F'], stage: 2, dualFixed: true,
  defaultPayload: (m) => ({ model: m, input: [{ role: 'user', content: '我的指令是什么' }], max_output_tokens: 16 }),
  payloadB: (m) => ({ model: m, input: [{ role: 'user', content: 'hi' }], max_output_tokens: 16 }),
  analyze(ctx) {
    const a = ctx.jsonA || ctx.json, b = ctx.jsonB;
    if (!a) return fail('无响应');
    const features = [`HTTP 状态码: ${ctx.httpStatus}`], diffs = [];
    // 注入信号载体（写入 shared 供 codex_verdict 读）
    const injection = { suspected: false, truncOk: false, inputA: null, inputB: null, deltaA: null, deltaB: null };

    // —— 1) 错误优先：A 报错 → 无法据此验真 ——
    const errA = a.error;
    if (errA || ctx.httpStatus >= 400) {
      const msg = (errA && (errA.message || '')) || ctx.body || '';
      features.push(`A 请求返回错误：${String(msg).slice(0, 90)}`);
      diffs.push('未拿到 max_output_tokens 截断响应，无法据此强验真。');
      if (ctx.shared) ctx.shared.injection = injection;
      return { features, diffs, score: null, verdict: '不适用', severity: '', status: 'done' };
    }

    // —— 2) input_tokens 双基线（注入检测）——
    const ia = inputTokensOf(a), ib = b ? inputTokensOf(b) : null;
    injection.inputA = ia; injection.inputB = ib;
    if (ia != null) { injection.deltaA = ia - 10; features.push(`A「我的指令是什么」input_tokens=${ia}（官方基线 10）`); }
    if (ib != null) { injection.deltaB = ib - 8; features.push(`B「hi」input_tokens=${ib}（官方基线 ≈8）`); }
    const aHigh = ia != null && ia > BASE_A;
    const bHigh = ib != null && ib > BASE_B;
    if (aHigh && bHigh) {
      injection.suspected = true;
      diffs.push(`两句 input_tokens 均偏高（A +${injection.deltaA} / B +${injection.deltaB} tokens）→ 疑似 Codex 注入了系统提示词。`);
    } else if (aHigh || bHigh) {
      // 弱信号：单句偏高（可能分词差异/缓存），记特征但 suspected 不置 true，交研判加权
      features.push(`单句 input_tokens 偏高（A 高:${aHigh} / B 高:${bHigh}）→ 弱注入信号，交综合研判。`);
    } else if (ia != null) {
      features.push('input_tokens 与官方基线一致 → 无注入迹象 ✓');
    }

    // —— 3) max_output_tokens 精确截断 + 计费（以 A 为准强验真）——
    const trunc = truncatedByMaxTokens(a);
    const ua = a.usage || {};
    const outTok = typeof ua.output_tokens === 'number' ? ua.output_tokens : null;
    const reasonTok = ua.output_tokens_details && ua.output_tokens_details.reasoning_tokens;
    const noMessage = !Array.isArray(a.output) || !a.output.some((o) => o && o.type === 'message');
    const outOk = outTok != null && outTok <= 16 + 2; // 截断在 16，留少量容错
    const reasonOk = typeof reasonTok === 'number' && reasonTok > 0;

    if (trunc && noMessage && outOk) {
      injection.truncOk = true;
      features.push(`A 在 max_output_tokens 处精确截断（status=incomplete, reason=max_output_tokens, output_tokens=${outTok}${reasonOk ? `, reasoning_tokens=${reasonTok}` : ''}, 无 message）→ 真实官方截断+计费行为 ✓`);
      if (ctx.shared) ctx.shared.injection = injection;
      // 截断验真成立：若同时检出注入 → 仍给高分但提示（最终归类交 codex_verdict）
      if (injection.suspected) diffs.push('截断+计费已验真，但 input_tokens 偏高 → 疑为 Codex 渠道（详见综合研判）。');
      return { features, diffs, score: 100, verdict: '真', severity: '', status: 'done' };
    }

    // —— 4) 未精确截断 → 结合身份记「不适用」——
    if (ctx.shared) ctx.shared.injection = injection;
    const ch = ctx.shared && ctx.shared.channel;
    if (!trunc) {
      features.push(`未在 max_output_tokens 处截断（status=${a.status}, output_tokens=${outTok}）`);
      if (ch && ch.code === 'codex') diffs.push('身份已判为 Codex CLI：可能不严格执行 max_output_tokens，本项不构成异常（不计分）。');
      else diffs.push('上游未精确执行 max_output_tokens：可能网关忽略该参数或存在逆向行为，请自行核实（不报错≠假）。');
    } else {
      // 截断了但形态不全（如有 message / output_tokens 异常）
      features.push(`截断状态命中但计费形态不完整（output_tokens=${outTok}, hasMessage=${!noMessage}）`);
      diffs.push('截断行为与官方不完全一致，无法据此强验真。');
    }
    return { features, diffs, score: null, verdict: '不适用', severity: '', status: 'done' };
  },
};

const param_min = {
  // 下限报错验真（辅助佐证 param_check）：发 max_output_tokens=1。
  // 官方报「需 >= 16」(integer_below_min_value) → 强验真 100；
  // 报别的错/不报错 → 不适用(score:null)，结合身份给提示。「不报错≠假」。
  id: 'param_min', name: '参数下限验真(max_output_tokens=1 报错)', weight: 10, modes: ['S', 'F'], errorProbe: true, stage: 2,
  defaultPayload: (m) => ({ model: m, max_output_tokens: 1, input: [{ role: 'user', content: 'hi' }] }),
  analyze(ctx) {
    const j = ctx.json;
    const err = j && j.error;
    const msg = (err && (err.message || '')) || '';
    const features = [`HTTP 状态码: ${ctx.httpStatus}`], diffs = [];
    const matchOfficial = !!err && (
      (err.param === 'max_output_tokens' && err.code === 'integer_below_min_value') ||
      (/max_output_tokens/i.test(msg) && /(>=\s*16|minimum|below minimum|at least 16)/i.test(msg))
    );
    if (matchOfficial) {
      features.push('官方对 max_output_tokens=1 报「需 >= 16」→ 真实官方上游行为 ✓');
      features.push(`错误结构: type=${err.type || '-'}, code=${err.code || '-'}`);
      return { features, diffs, score: 100, verdict: '真', severity: '', status: 'done' };
    }
    const errored = (ctx.httpStatus >= 400) || !!err;
    if (errored) {
      features.push(`返回错误但非 max_output_tokens 下限报错：${(msg || ctx.body || '').slice(0, 90)}`);
      diffs.push('未拿到官方「需 >= 16」报错，无法据此验真。');
      return { features, diffs, score: null, verdict: '不适用', severity: '', status: 'done' };
    }
    const ch = ctx.shared && ctx.shared.channel;
    if (ch && ch.code === 'codex') {
      features.push('未报错，但身份已判为 Codex CLI 渠道 → 不严格校验该字段下限属合理');
      diffs.push('Codex CLI 渠道下本项不构成异常（不计分）。');
    } else {
      features.push(`未报错（HTTP ${ctx.httpStatus}）：未拒绝非法的 max_output_tokens=1`);
      diffs.push('可能上游网关忽略了该参数，或存在逆向行为，请自行核实（不报错≠假）。');
    }
    return { features, diffs, score: null, verdict: '不适用', severity: '', status: 'done' };
  },
};

const function_calling = {
  id: 'function_calling', name: '函数调用', weight: 15, modes: ['S', 'F'],
  defaultPayload: (m) => ({
    model: m, max_output_tokens: 2048,
    tools: [{ type: 'function', name: 'get_current_weather', description: 'Get current weather for a city.', strict: true, parameters: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['celsius', 'fahrenheit'] } }, required: ['city', 'unit'], additionalProperties: false } }],
    tool_choice: { type: 'function', name: 'get_current_weather' },
    input: [{ role: 'user', content: 'Use get_current_weather for Boston, MA in celsius. Do not answer directly.' }],
  }),
  analyze(ctx) {
    const out = ctx.json?.output;
    const features = [], diffs = []; let score = 0;
    const fc = Array.isArray(out) ? out.find((o) => o && o.type === 'function_call') : null;
    if (!fc) {
      // 预算耗尽（只产 reasoning、无 function_call 也无 message）→ 不适用不计分，而非判工具被剥离。
      if (reasoningOnly(ctx.json) || ctx.json?.status === 'incomplete') {
        return { features: ['未产出 function_call，且 status=incomplete（max_output_tokens 预算耗尽）'], diffs: ['预算耗尽，无法判断函数调用能力（本项不计分；可调大 max_output_tokens 重试）'], score: null, verdict: '不适用', severity: '', status: 'done' };
      }
      return fail('output 中无 function_call → 工具能力可能被剥离');
    }
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
    model: m, max_output_tokens: 2048,
    text: { format: { type: 'json_schema', name: 'detector_result', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' }, nonce: { type: 'string' } }, required: ['ok', 'nonce'], additionalProperties: false } } },
    input: [{ role: 'user', content: 'Return JSON matching the schema with ok=true and nonce="openai-detector".' }],
  }),
  analyze(ctx) {
    const text = outputText(ctx.json).trim();
    if (!text || text.startsWith('[refusal]')) {
      // 预算耗尽（只产 reasoning、无最终 JSON 文本）→ 不适用不计分，而非判结构化失败。
      if (reasoningOnly(ctx.json) || ctx.json?.status === 'incomplete') {
        return { features: ['未产出最终文本，status=incomplete（max_output_tokens 预算耗尽）'], diffs: ['预算耗尽，无法判断结构化输出能力（本项不计分；可调大 max_output_tokens 重试）'], score: null, verdict: '不适用', severity: '', status: 'done' };
      }
      return fail('无输出');
    }
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
  defaultPayload: (m) => ({ model: m, max_output_tokens: 2048, input: [{ role: 'user', content: 'Reply with exactly: ok' }] }),
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

const upstream_trace = {
  // 末端上游研判（信息项，不计分）：响应头指纹 + 回链探测，双管齐下判「上游到底是谁」。
  //  · 响应头指纹：扫 openai-* / x-ms-*·apim-*·azureml-* / one-api·new-api 专属头 → 直连对象与透传上游。
  //  · 回链探测：发视觉请求，图片 URL 指向本站回链端点；中转通常只转发不下图，真正下图的是【最末端
  //    官方上游】，它来抓图暴露出口 IP/UA → 归类 Azure(微软云)/OpenAI/第三方。出于隐私【不展示 IP，只给归属结论】。
  // 边界：① 仅能看到真正下图的节点（中转自己下图会变成它）；② 需上游接受 URL 形式图片（Azure 部分部署
  //       只认 base64 则无命中）；③ 本站须公网可达（本地跑不通）；④ UA/响应头可被中转透传或伪造，故多维交叉。
  id: 'upstream_trace', name: '末端上游研判（响应头指纹 + 回链探测）', weight: 0, modes: ['S', 'F'], info: true, stage: 2, trace: true,
  defaultPayload: (m) => ({
    model: m, max_output_tokens: 300,
    input: [{ role: 'user', content: [
      { type: 'input_text', text: 'What number is shown in this image? Reply with just the number.' },
      { type: 'input_image', image_url: TRACE_IMG_PLACEHOLDER, detail: 'low' },
    ] }],
  }),
  analyze(ctx) {
    const features = [], diffs = [];

    // —— 1) 响应头指纹（扫 evidence：前序所有探针的响应头）——
    const evidence = Array.isArray(ctx.evidence) ? ctx.evidence : [];
    const hdr = scanResponseHeaders(evidence);
    if (ctx.shared) ctx.shared.headers = hdr;   // 供综合研判复用，避免重复扫
    features.push(`📋 响应头研判：${hdr.label}（置信度 ${hdr.confidence}）`);
    hdr.signals.forEach((s) => features.push('· ' + s));
    const f = hdr.facts || {};
    const factParts = [];
    if (f.azureServedModel) factParts.push(`Azure实际模型=${f.azureServedModel}`);
    if (f.azureRegion) factParts.push(`Azure区域=${f.azureRegion}`);
    if (f.azureGroup) factParts.push(`路由组=${f.azureGroup}`);
    if (f.openaiVersion) factParts.push(`openai-version=${f.openaiVersion}`);
    if (f.openaiProject) factParts.push(`project=${f.openaiProject}`);
    if (f.openaiProcessingMs) factParts.push(`处理耗时=${f.openaiProcessingMs}ms`);
    if (factParts.length) features.push('附加事实：' + factParts.join(' | '));

    // —— 2) 回链探测出口归属 ——
    if (ctx.traceImgUrl) features.push(`🔗 回链图片 URL：${ctx.traceImgUrl}`);
    let upstream = { kind: 'none', uaSawOpenAI: false, uaSawAzure: false };
    if (ctx.traceError) {
      diffs.push('回链探测未能发起：' + ctx.traceError + '（需后端 trace.php 且本站公网可达）');
      upstream = { kind: 'error', uaSawOpenAI: false, uaSawAzure: false };
    } else {
      const hits = Array.isArray(ctx.traceHits) ? ctx.traceHits : [];
      if (!hits.length) {
        features.push('🔗 回链：无节点下图（上游只认 base64 不 fetch URL / 本站非公网可达 / 该渠道无视觉能力）');
      } else {
        // 取首个可识别的公网节点为主判定；展示真实出口 IP + 来源头（你自测工具，IP 是核心信息）。
        let primary = null;
        for (const h of hits) {
          const place = [h.city, h.region, h.country].filter(Boolean).join(', ');
          features.push(`🔗 下图节点：${h.ip || '?'}${h.ipSource ? '（来源 ' + h.ipSource + '）' : ''} · ${h.label || h.org || '未知归属'}${h.as ? '（' + h.as + '）' : ''}${place ? ' · ' + place : ''}${h.uaKind ? ' · 出口UA自报' + h.uaKind : ''}`);
          if (h.ua) features.push(`　└ 出口 UA：${h.ua}`);
          if (h.uaKind === 'openai') upstream.uaSawOpenAI = true;
          if (h.uaKind === 'azure') upstream.uaSawAzure = true;
          if (!primary && h.kind && h.kind !== 'unknown') primary = h;
        }
        primary = primary || hits[0];
        upstream.kind = primary.kind || 'other';
        upstream.org = primary.org || '';
        upstream.label = primary.label || '';
      }
    }
    if (ctx.shared) ctx.shared.upstream = upstream;

    // —— 3) 本项结论（信息项，最终归属以综合研判为准）——
    const concl = decideConclusion({
      channelCode: (ctx.shared && ctx.shared.channel && ctx.shared.channel.code) || 'unknown',
      truncOk: ctx.shared && ctx.shared.injection ? !!ctx.shared.injection.truncOk : null,
      azure: scanAzureContentFilter(evidence), headers: hdr, upstream,
    });
    features.unshift(`🌐 末端上游：${concl.conclusion}`);
    const score = concl.verdict === '真' ? 100 : (concl.verdict === '存疑' ? 50 : null);
    return { features, diffs, score, verdict: concl.verdict === '假' ? '存疑' : concl.verdict, severity: '', status: 'done' };
  },
};

const codex_verdict = {
  // 综合研判（信息项，不计入总分）：【零请求】纯本地合成——复用前序各探针已有的判定结果与响应体，
  // 不再单独发请求（synthesize:true，app.js executeProbe 跳过网络调用并注入 ctx.evidence）。
  // 汇总各路信号 → 上游归属结论。判定逻辑全部抽到 openai_signals.decideConclusion（纯函数、可单测）。
  //   ① channel_id+identity 的渠道码（resp_/chatcmpl-/codex）；
  //   ② param_check 的注入/截断信号 injection；
  //   ③ 响应头指纹 headers（优先复用 upstream_trace 扫好的 shared.headers）；
  //   ④ evidence 响应体的 Azure 审核签名；⑤ upstream_trace 回链出口归属 + 出口 UA。
  // 原则：无响应头指纹/无回链出口证据时，不武断下「纯官/Azure」定论，只给存疑并讲清原因。stage 3 串行。
  id: 'codex_verdict', name: '综合研判（上游归属）', weight: 0, modes: ['Q', 'S', 'F'], info: true, stage: 3, synthesize: true,
  analyze(ctx) {
    const ch = (ctx.shared && ctx.shared.channel) || null;
    const inj = (ctx.shared && ctx.shared.injection) || null;
    const upstream = (ctx.shared && ctx.shared.upstream) || null;
    const evidence = Array.isArray(ctx.evidence) ? ctx.evidence : [];
    const azure = scanAzureContentFilter(evidence);
    // 复用 upstream_trace 扫好的响应头指纹；若未跑（Q 档无 upstream_trace）则就地扫一次。
    const headers = (ctx.shared && ctx.shared.headers) || scanResponseHeaders(evidence);
    const features = [], diffs = [];

    const code = ch ? ch.code : 'unknown';
    const identityCodex = code === 'codex';
    const truncOk = inj ? !!inj.truncOk : null;
    const injSuspected = !!(inj && inj.suspected);

    // —— 证据来源清单：每条依据标注【来自哪个探针/哪个信号】，可追溯 ——
    features.push('—— 证据来源 ——');
    // ① 渠道（来自 channel_id / identity）
    features.push(`【渠道识别·channel_id/identity】响应 id 前缀判定：${ch ? ch.channel : '未知'}（code=${code}）`);
    // ② 参数行为（来自 param_check）
    if (inj && inj.inputA != null) {
      features.push(`【参数强验真·param_check】max_output_tokens 截断${truncOk ? '精确成立 ✓' : '未成立'}；input_tokens A=${inj.inputA}(Δ${fmtDelta(inj.deltaA)}) / B=${inj.inputB != null ? inj.inputB + '(Δ' + fmtDelta(inj.deltaB) + ')' : 'N/A'}${injSuspected ? '，两句偏高=疑注入' : ''}`);
    } else {
      features.push('【参数强验真·param_check】未取得（快测档或未跑）');
    }
    // ③ 响应头指纹（来自 upstream_trace 扫描的响应头）
    features.push(`【响应头指纹·upstream_trace】${headers.label}（置信度 ${headers.confidence}）`);
    if (headers.openai.length) features.push(`　└ OpenAI 官方头：${headers.openai.join('；')}`);
    if (headers.azure.length) features.push(`　└ Azure 专属头：${headers.azure.join('；')}`);
    if (headers.relaySoftware) features.push(`　└ 中转软件特征：${headers.relaySoftware}`);
    // ④ 响应体审核签名（来自 evidence 深扫）
    if (azure.detected) { azure.signals.forEach((s) => features.push(`【响应体审核签名·evidence】${s}`)); }
    else features.push('【响应体审核签名·evidence】未见 Azure 内容过滤字段');
    // ⑤ 回链出口（来自 upstream_trace 回链）
    if (upstream && upstream.kind && !['none', 'error'].includes(upstream.kind)) {
      features.push(`【回链出口·upstream_trace】归属 ${upstream.label || upstream.org || upstream.kind}${upstream.uaSawOpenAI ? '；出口UA自报OpenAI' : ''}${upstream.uaSawAzure ? '；出口UA自报Azure' : ''}`);
    } else if (upstream && upstream.kind === 'none') {
      features.push('【回链出口·upstream_trace】已发起但无节点下图（未捕获）');
    } else if (upstream && upstream.kind === 'error') {
      features.push('【回链出口·upstream_trace】未能发起（后端不可用/未部署）');
    } else {
      features.push('【回链出口·upstream_trace】未跑（快测档或未勾选）');
    }

    // —— 结论 + 推理依据（decideConclusion 的每条 reason 已含来源描述）——
    const dec = decideConclusion({ channelCode: code, truncOk, injSuspected, identityCodex, azure, headers, upstream });
    features.push('—— 研判推理 ——');
    dec.reasons.forEach((r) => { if (dec.verdict === '真') features.push('• ' + r); else diffs.push('• ' + r); });
    features.unshift(`🏁 研判结论：${dec.conclusion}`);
    return { features, diffs, score: dec.score, verdict: dec.verdict, severity: dec.severity, status: 'done', conclusion: dec.conclusion };
  },
};

export const openaiProtocol = {
  id: 'openai', name: 'OpenAI', emoji: '🔵', icon: 'assets/icons/openai.svg', authStyle: 'bearer',
  defaultEndpoint: 'https://api.openai.com/v1/responses',
  defaultModel: 'gpt-5.5', endpointHint: '形如 https://你的中转站/v1/responses',
  betaHeader: '',
  probes: [channel_id, identity, basic_request, model_consistency, protocol, param_check, param_min, function_calling, structured_output, token_billing, upstream_trace, codex_verdict],
};
