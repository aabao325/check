/* =====================================================================
 * protocols/gemini.js —— Gemini 协议探针集（原生路径 / generateContent）
 * 原生 /v1beta/models/{model}:generateContent：模型名在 URL 里（请求体不放 model），
 * key 走 x-goog-api-key 头（authStyle:'gemini'）。请求体 contents/generationConfig，
 * 响应体 candidates[].content.parts[].text、usageMetadata、modelVersion。
 * 默认模型 gemini-3.5-flash（3 系）。
 * 思考参数代际：2.5 系用 thinkingBudget、3 系用 thinkingLevel；错代参数对 2.5 会被官方拒绝，
 * 对 3 系则向后兼容静默接受（验不了真）。
 * ===================================================================== */
import { coefficientOfVariation } from '../core.js?v=26';

/* ---------- 小工具 ---------- */
// 取最终文本：candidates[0].content.parts[].text 拼接；防 SAFETY 拦截时 parts undefined。
function geminiText(j) {
  const parts = j?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.filter((p) => typeof p?.text === 'string' && !p.thought).map((p) => p.text).join('');
}
// 是否含思考 part（includeThoughts 时官方会标 thought:true）
function hasThoughtPart(j) {
  const parts = j?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) && parts.some((p) => p && p.thought === true);
}
function finishReason(j) { return j?.candidates?.[0]?.finishReason; }
function fail(reason, score = 0, severity = '') { return { features: [], diffs: [reason], score, verdict: '假', severity, status: 'done' }; }
// 模型代际：'2.5' 含 "2.5"/"2-5"/"2.0" 等旧版；其余（3+）按新版处理
function isLegacyGen(model) {
  const m = (model || '').toLowerCase();
  return /(^|[^0-9])(1\.|1-|2\.|2-)/.test(m) || /gemini-(1|2)[.\-]/.test(m);
}

/* ===================================================================== */
/* 探针定义                                                              */
/* ===================================================================== */

// 竞品/外部品牌词（身份探针）——Gemini 应自称 Google，出现这些即掺假
const RIVAL_WORDS = ['openai', 'chatgpt', 'gpt-3', 'gpt-4', 'gpt-5', 'claude', 'anthropic',
  'deepseek', 'qwen', '通义', 'tongyi', '文心', 'wenxin', '豆包', 'doubao', 'llama', 'mistral', 'grok'];

const identity = {
  id: 'identity', name: '身份识别', weight: 5, modes: ['Q', 'S', 'F'], stage: 1,
  defaultPayload: () => ({
    contents: [{ parts: [{ text: '请做你的详细身份介绍：你是谁？模型名称与版本？由哪家公司训练和开发？请简洁如实回答。' }] }],
    generationConfig: { maxOutputTokens: 2000 },
  }),
  analyze(ctx) {
    const text = (geminiText(ctx.json) || '').toLowerCase();
    if (!text) {
      if (finishReason(ctx.json) === 'SAFETY') return { features: ['响应被安全策略拦截(SAFETY)'], diffs: ['未拿到身份自述'], score: 50, verdict: '存疑', severity: '', status: 'done' };
      return fail('无文本回复');
    }
    const features = [];
    const hasGemini = /\bgemini\b/.test(text);
    const hasGoogle = /\bgoogle\b/.test(text) || /deepmind/.test(text);
    const rivals = RIVAL_WORDS.filter((w) => text.includes(w));
    features.push(`含 "gemini": ${hasGemini ? '是' : '否'}`, `含 "google": ${hasGoogle ? '是' : '否'}`);

    const diffs = [];
    let score, severity = '';
    // 注意：Gemini 身份探针【故意不设】anthropic.js 那样的「官方 id 守卫」。
    // Claude 官方渠道容忍偶发竞品幻觉（记不适用），但 Gemini 自述竞品身份一律按【冒充掺假】判 critical。
    // 切勿把 Claude 的容忍逻辑复制到此处（御三家中仅 Claude 容忍）。
    if (rivals.length && !hasGemini && !hasGoogle) {
      diffs.push(`自称竞品身份: ${rivals.join(', ')}，且未提 Gemini/Google → 冒充掺假`);
      score = 0; severity = 'critical';
    } else if (rivals.length) {
      diffs.push(`回复中混入竞品关键词: ${rivals.join(', ')} → 疑似掺假`);
      score = 30; severity = 'critical';
    } else if (hasGemini && hasGoogle) {
      score = 100;
    } else if (hasGemini || hasGoogle) {
      score = 60; diffs.push('仅提到 Gemini/Google 之一');
    } else {
      score = 0; diffs.push('完全未提及 Gemini / Google');
    }
    return { features, diffs, score, verdict: score >= 70 ? '真' : (score >= 40 ? '存疑' : '假'), severity, status: 'done' };
  },
};

const basic_request = {
  id: 'basic_request', name: '基础可用', weight: 15, modes: ['Q', 'S', 'F'],
  defaultPayload: () => ({ contents: [{ parts: [{ text: 'Reply with exactly: pong' }] }], generationConfig: { maxOutputTokens: 2000 } }),
  analyze(ctx) {
    const j = ctx.json; if (!j) return fail('无响应');
    const text = geminiText(j).toLowerCase();
    const features = [`回复: "${geminiText(j).slice(0, 40)}"`, `finishReason: ${finishReason(j)}`];
    if (text.includes('pong')) return { features, diffs: [], score: 100, verdict: '真', status: 'done' };
    if (text.trim()) return { features, diffs: ['未回 pong 但有文本'], score: 80, verdict: '真', status: 'done' };
    if (finishReason(j) === 'MAX_TOKENS') return { features, diffs: ['思考预算耗尽，无最终文本'], score: 75, verdict: '存疑', status: 'done' };
    return fail('无文本');
  },
};

const model_info = {
  id: 'model_info', name: '模型一致性', weight: 15, modes: ['Q', 'S', 'F'], multi: 3,
  defaultPayload: () => ({ contents: [{ parts: [{ text: 'In one sentence, explain HTTP status 418.' }] }], generationConfig: { maxOutputTokens: 2000 } }),
  analyze(ctx) {
    const runs = ctx.multiJson || (ctx.json ? [ctx.json] : []);
    if (!runs.length) return fail('无响应');
    const features = [], diffs = [];
    const norm = (s) => (s || '').replace(/^models\//, '').replace(/[._]/g, '-');
    const req = norm(ctx.model), resp = norm(runs[0].modelVersion);
    const match = req && resp && (req === resp || req.startsWith(resp) || resp.startsWith(req));
    features.push(`请求模型: ${ctx.model}`, `响应 modelVersion: ${runs[0].modelVersion || '(无)'}`);
    let score = match ? 60 : 0;
    if (!match) diffs.push('请求模型与响应 modelVersion 不匹配 → 可能路由到别的模型');
    const outs = runs.map((r) => r?.usageMetadata?.candidatesTokenCount).filter((n) => typeof n === 'number');
    if (outs.length >= 2) { const cv = coefficientOfVariation(outs); features.push(`candidatesTokenCount CV=${cv.toFixed(3)}`); score += cv < 0.1 ? 40 : cv < 0.3 ? 20 : 0; if (cv >= 0.3) diffs.push('token 高度不稳定 → 疑似轮询多模型'); }
    else score += 40;
    return { features, diffs, score, verdict: score >= 70 ? '真' : '假', status: 'done' };
  },
};

const protocol = {
  id: 'protocol', name: '协议规范+污染检测', weight: 15, modes: ['Q', 'S', 'F'], passive: true,
  defaultPayload: () => ({ contents: [{ parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 2000 } }),
  analyze(ctx) {
    const j = ctx.json; if (!j) return fail('无响应');
    const features = [], diffs = []; let crit = 0, minor = 0;
    if (Array.isArray(j.candidates) && j.candidates.length) features.push('candidates 非空 ✓'); else { diffs.push('candidates 缺失/空'); crit++; }
    const um = j.usageMetadata || {};
    if (typeof um.promptTokenCount === 'number' && typeof um.candidatesTokenCount === 'number') features.push('usageMetadata 含 promptTokenCount/candidatesTokenCount ✓'); else { diffs.push('usageMetadata 缺失（原生应有）'); minor++; }
    if (j.modelVersion) features.push(`modelVersion=${j.modelVersion} ✓`); else { diffs.push('缺 modelVersion'); minor++; }
    const fr = finishReason(j);
    const VALID_FR = ['STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'OTHER', 'LANGUAGE', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL', undefined, null];
    if (VALID_FR.includes(fr)) features.push(`finishReason=${fr} ✓`); else diffs.push(`finishReason 异常: ${fr}`);
    // 污染检测：原生 Gemini 响应不该出现 OpenAI 兼容端的 id/usage 形态
    if (typeof j.id === 'string' && j.id.startsWith('chatcmpl-')) { diffs.push('出现 chatcmpl- id → 实为 OpenAI 兼容端套壳冒充原生!'); crit++; }
    if (j.usage && (('completion_tokens' in j.usage) || ('prompt_tokens' in j.usage))) { diffs.push('出现 OpenAI 风格 usage 字段 → 疑似套壳!'); crit++; }
    if (!diffs.length) features.unshift('协议规范，无污染信号');
    const score = Math.max(0, 100 - crit * 35 - minor * 10);
    return { features, diffs, score, verdict: score >= 80 && !crit ? '真' : '假', severity: crit ? 'critical' : '', status: 'done' };
  },
};

const thinking_probe = {
  // 思考能力 + 参数代际验真（自适应）：
  // - 3 系（默认 gemini-3.5-flash）：发匹配的 thinkingLevel:HIGH + includeThoughts，验 thoughtsTokenCount>0（套壳难伪造真实思考计费）。
  // - 2.5 系：发错代的 thinkingLevel（2.5 不支持），期望官方 400「thinking_level not supported」=验真。
  // 「没报错」对 3 系不能验真（向后兼容静默接受）；故 3 系仅靠正向 thoughts 计费判断。
  id: 'thinking_probe', name: '思考参数验真', weight: 15, modes: ['S', 'F'], errorProbe: true,
  defaultPayload: (m) => {
    // 2.5 系：故意发新版 thinkingLevel（应被官方拒绝，验真）；3 系：发原生支持的 thinkingLevel + includeThoughts（正向能力测）。
    // 两代发的都是 thinkingLevel，分析时按 ctx.model 的代际判读不同含义。
    return {
      contents: [{ parts: [{ text: '请一步一步解答：如果 x^2 + 5x + 6 = 0，求 x 的值。' }] }],
      generationConfig: { maxOutputTokens: 2000, thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } },
    };
  },
  analyze(ctx) {
    const j = ctx.json;
    const legacy = isLegacyGen(ctx.model);
    const err = j && j.error;
    const msg = (err && (err.message || '')) || '';
    const errored = (ctx.httpStatus >= 400) || !!err;
    const features = [`HTTP 状态码: ${ctx.httpStatus}`, `模型代际: ${legacy ? '2.5 及更早' : '3 系及以上'}`], diffs = [];

    if (legacy) {
      // 2.5 系：发了新版 thinkingLevel，期望官方 400 拒绝错代参数
      const officialReject = errored && /thinking[_\s]?level/i.test(msg) && /(not\s*support|unsupported|invalid|INVALID_ARGUMENT)/i.test(msg);
      if (officialReject) {
        features.push('对 2.5 系发新版 thinkingLevel，官方报「thinking_level not supported」→ 真实官方上游 ✓');
        return { features, diffs, score: 100, verdict: '真', severity: '', status: 'done' };
      }
      if (errored) {
        features.push(`返回错误但非「thinking_level 不支持」：${(msg || ctx.body || '').slice(0, 90)}`);
        diffs.push('未拿到预期的错代参数拒绝，无法据此验真。');
        return { features, diffs, score: null, verdict: '不适用', severity: '', status: 'done' };
      }
      // 2.5 系却接受了新版参数、正常返回 → 真实上游不会这样
      features.push('2.5 系模型却接受了新版 thinkingLevel 并正常返回');
      diffs.push('真实 Gemini 2.5 会拒绝 thinkingLevel；此处未拒绝 → 疑似吞参/逆向网关。');
      return { features, diffs, score: 0, verdict: '假', severity: 'critical', status: 'done' };
    }

    // 3 系：正向能力测 —— 看是否真的产生了思考计费
    if (errored) {
      features.push(`3 系发原生 thinkingLevel 却报错：${(msg || ctx.body || '').slice(0, 90)}`);
      diffs.push('3 系应原生支持 thinkingLevel，报错 → 上游可能不支持或被改写。');
      return { features, diffs, score: 30, verdict: '假', severity: '', status: 'done' };
    }
    const thoughts = j?.usageMetadata?.thoughtsTokenCount;
    const hasThought = hasThoughtPart(j);
    features.push(`thoughtsTokenCount: ${thoughts ?? '(无)'}`, `含思考 part: ${hasThought ? '是' : '否'}`);
    if (typeof thoughts === 'number' && thoughts > 0) {
      return { features, diffs: [], score: 100, verdict: '真', severity: '', status: 'done' };
    }
    if (hasThought) {
      diffs.push('有思考 part 但 thoughtsTokenCount 缺失/为 0 → 思考计费可疑');
      return { features, diffs, score: 60, verdict: '存疑', severity: '', status: 'done' };
    }
    diffs.push('未产生思考计费（thoughtsTokenCount=0/缺失）→ 思考能力可疑或被降级');
    diffs.push('注：3 系对旧版 thinkingBudget 会向后兼容静默接受、不报错，故无法用「错代参数」验真，本项仅看思考计费。');
    return { features, diffs, score: 40, verdict: '存疑', severity: '', status: 'done' };
  },
};

const function_calling = {
  id: 'function_calling', name: '函数调用', weight: 15, modes: ['S', 'F'],
  defaultPayload: () => ({
    contents: [{ parts: [{ text: 'Use get_current_weather for Boston in celsius.' }] }],
    tools: [{ functionDeclarations: [{ name: 'get_current_weather', description: 'Get current weather.', parameters: { type: 'OBJECT', properties: { city: { type: 'STRING' }, unit: { type: 'STRING', enum: ['celsius', 'fahrenheit'] } }, required: ['city', 'unit'] } }] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    generationConfig: { maxOutputTokens: 2000 },
  }),
  analyze(ctx) {
    const parts = ctx.json?.candidates?.[0]?.content?.parts;
    const fc = Array.isArray(parts) ? parts.map((p) => p?.functionCall).find(Boolean) : null;
    if (!fc) return fail('未生成 functionCall → 工具能力可能被剥离');
    const features = [], diffs = []; let score = 0;
    const ck = (c, ok, bad) => { if (c) { score += 33; features.push(ok); } else diffs.push(bad); };
    ck(fc.name === 'get_current_weather', 'name 正确 ✓', `name 异常: ${fc.name}`);
    // Gemini 的 args 是对象（不是 JSON 字符串）
    ck(fc.args && typeof fc.args === 'object' && fc.args.city, `args 合法: ${JSON.stringify(fc.args)}`, 'args 非法/非对象');
    ck(fc.args && ['celsius', 'fahrenheit'].includes(fc.args.unit), 'unit 枚举合法 ✓', 'unit 不在枚举');
    return { features, diffs, score: Math.min(score, 100), verdict: score >= 66 ? '真' : '假', status: 'done' };
  },
};

const structured_output = {
  id: 'structured_output', name: '结构化输出', weight: 15, modes: ['S', 'F'],
  defaultPayload: () => ({
    contents: [{ parts: [{ text: 'Return JSON with ok=true and nonce="gemini-detector".' }] }],
    generationConfig: {
      maxOutputTokens: 2000,
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' }, nonce: { type: 'STRING' } }, required: ['ok', 'nonce'] },
    },
  }),
  analyze(ctx) {
    const text = geminiText(ctx.json).trim();
    if (!text) return fail('无输出');
    const features = [], diffs = [];
    if (/```/.test(text)) diffs.push('markdown 包裹 → 可能未透传 responseMimeType');
    let p; try { p = JSON.parse(text.replace(/```json|```/g, '').trim()); } catch { return { features: [`输出: ${text.slice(0, 60)}`], diffs: ['非合法 JSON'], score: 20, verdict: '假', status: 'done' }; }
    features.push('合法 JSON ✓');
    let score = 50;
    if (p.ok === true && p.nonce === 'gemini-detector') { score = 100; features.push('schema 匹配 ✓'); } else diffs.push('字段不符 (期望 ok=true, nonce=gemini-detector)');
    return { features, diffs, score, verdict: score >= 70 ? '真' : '存疑', status: 'done' };
  },
};

const token_usage = {
  id: 'token_usage', name: 'Token 计费', weight: 10, modes: ['S', 'F'], tokenPair: true,
  defaultPayload: () => ({ contents: [{ parts: [{ text: 'Reply with exactly: ok' }] }], generationConfig: { maxOutputTokens: 2000 } }),
  analyze(ctx) {
    const s = ctx.shortJson || ctx.json, l = ctx.longJson;
    if (!s) return fail('无响应');
    const features = [], diffs = []; let score = 0; const u = s.usageMetadata || {};
    if (typeof u.promptTokenCount === 'number' && typeof u.candidatesTokenCount === 'number') { score += 40; features.push(`prompt/candidates: ${u.promptTokenCount}/${u.candidatesTokenCount}`); } else diffs.push('usageMetadata 缺失');
    if (typeof u.totalTokenCount === 'number') { score += 20; features.push(`total: ${u.totalTokenCount}`); } else score += 20;
    if (l) { const d = (l.usageMetadata?.promptTokenCount ?? 0) - (u.promptTokenCount ?? 0); features.push(`长 prompt 增量: ${d}`); if (d >= 45 && d <= 140) score += 40; else diffs.push(`增量异常(${d})`); }
    else score += 40;
    score = Math.min(score, 100);
    return { features, diffs, score, verdict: score >= 80 ? '真' : (score >= 60 ? '存疑' : '假'), status: 'done' };
  },
};

export const geminiProtocol = {
  id: 'gemini', name: 'Gemini', emoji: '🟢', icon: 'assets/icons/gemini.svg', authStyle: 'gemini',
  defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
  defaultModel: 'gemini-3.5-flash', endpointHint: '填到 .../v1beta/models 即可，模型按 #model 自动拼接',
  betaHeader: '',
  probes: [identity, basic_request, model_info, protocol, thinking_probe, function_calling, structured_output, token_usage],
};
