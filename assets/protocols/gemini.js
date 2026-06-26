/* =====================================================================
 * protocols/gemini.js —— Gemini 协议探针集（OpenAI 兼容端 / chatcmpl-）
 * 吸收 veridrop gemini detectors。注意 Gemini 3 默认开 thinking，
 * max_completion_tokens 要留余量（384），token 容差更宽。
 * ===================================================================== */
import { coefficientOfVariation } from '../core.js';

function choiceText(j) { return j?.choices?.[0]?.message?.content || ''; }
function fail(reason, score = 0) { return { features: [], diffs: [reason], score, verdict: '假', status: 'done' }; }

const basic_request = {
  id: 'basic_request', name: '基础可用', weight: 15, modes: ['Q', 'S', 'F'],
  defaultPayload: (m) => ({ model: m, max_completion_tokens: 64, temperature: 0, messages: [{ role: 'user', content: 'Reply with exactly: pong' }] }),
  analyze(ctx) {
    const text = choiceText(ctx.json).toLowerCase();
    const features = [`回复: "${choiceText(ctx.json).slice(0, 40)}"`];
    if (text.includes('pong')) return { features, diffs: [], score: 100, verdict: '真', status: 'done' };
    if (text.trim()) return { features, diffs: ['未回 pong'], score: 50, verdict: '存疑', status: 'done' };
    return fail('无文本');
  },
};

const model_info = {
  id: 'model_info', name: '模型一致性', weight: 15, modes: ['Q', 'S', 'F'], multi: 3,
  defaultPayload: (m) => ({ model: m, max_completion_tokens: 60, temperature: 0, messages: [{ role: 'user', content: 'In one sentence, explain HTTP status 418.' }] }),
  analyze(ctx) {
    const runs = ctx.multiJson || (ctx.json ? [ctx.json] : []);
    if (!runs.length) return fail('无响应');
    const features = [], diffs = [];
    const norm = (s) => (s || '').replace(/^models\//, '').replace(/[._]/g, '-');
    const req = norm(ctx.model), resp = norm(runs[0].model);
    const match = req && resp && (req === resp || req.startsWith(resp) || resp.startsWith(req));
    features.push(`请求模型: ${ctx.model}`, `响应模型: ${runs[0].model}`);
    let score = match ? 60 : 0;
    if (!match) diffs.push('model 不匹配');
    const outs = runs.map((r) => r?.usage?.completion_tokens).filter((n) => typeof n === 'number');
    if (outs.length >= 2) { const cv = coefficientOfVariation(outs); features.push(`CV=${cv.toFixed(3)}`); score += cv < 0.1 ? 40 : cv < 0.3 ? 20 : 0; if (cv >= 0.3) diffs.push('token 高度不稳定'); }
    else score += 40;
    return { features, diffs, score, verdict: score >= 70 ? '真' : '假', status: 'done' };
  },
};

const protocol = {
  id: 'protocol', name: '协议规范', weight: 15, modes: ['Q', 'S', 'F'], passive: true,
  defaultPayload: (m) => ({ model: m, max_completion_tokens: 32, messages: [{ role: 'user', content: 'ping' }] }),
  analyze(ctx) {
    const j = ctx.json; if (!j) return fail('无响应');
    const features = [], diffs = []; let crit = 0;
    if (typeof j.id === 'string' && j.id.startsWith('chatcmpl-')) features.push('id 前缀 chatcmpl- ✓'); else { diffs.push(`id 异常: ${j.id}`); crit++; }
    if (j.object === 'chat.completion') features.push('object ✓'); else { diffs.push(`object 异常: ${j.object}`); crit++; }
    if (Array.isArray(j.choices) && j.choices.length) features.push('choices 非空 ✓'); else { diffs.push('choices 缺失'); crit++; }
    const fin = j.choices?.[0]?.finish_reason;
    if ([null, undefined, 'stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(fin)) features.push(`finish_reason=${fin} ✓`); else diffs.push(`finish_reason 异常: ${fin}`);
    if (!diffs.length) features.unshift('协议规范');
    const score = Math.max(0, 100 - crit * 35);
    return { features, diffs, score, verdict: score >= 80 && !crit ? '真' : '假', severity: crit ? 'critical' : '', status: 'done' };
  },
};

const function_calling = {
  id: 'function_calling', name: '函数调用', weight: 15, modes: ['S', 'F'],
  defaultPayload: (m) => ({
    model: m, max_completion_tokens: 256,
    tools: [{ type: 'function', function: { name: 'get_current_weather', description: 'Get current weather.', parameters: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['celsius', 'fahrenheit'] } }, required: ['city', 'unit'] } } }],
    tool_choice: { type: 'function', function: { name: 'get_current_weather' } },
    messages: [{ role: 'user', content: 'Use get_current_weather for Boston in celsius.' }],
  }),
  analyze(ctx) {
    const tc = ctx.json?.choices?.[0]?.message?.tool_calls;
    if (!tc || !tc.length) return fail('未生成 tool_calls');
    const features = [], diffs = []; let score = 0; const t = tc[0];
    const ck = (c, ok, bad) => { if (c) { score += 25; features.push(ok); } else diffs.push(bad); };
    ck(t.id && t.id.startsWith('call_'), 'id=call_ ✓', `id 异常: ${t.id}`);
    ck(t.type === 'function', 'type ✓', 'type 异常');
    ck(t.function?.name === 'get_current_weather', 'name ✓', 'name 异常');
    let a; try { a = JSON.parse(t.function?.arguments || '{}'); } catch { a = null; }
    ck(a && a.city, `arguments: ${JSON.stringify(a)}`, 'arguments 非法');
    return { features, diffs, score, verdict: score >= 70 ? '真' : '假', status: 'done' };
  },
};

const structured_output = {
  id: 'structured_output', name: '结构化输出', weight: 15, modes: ['S', 'F'],
  defaultPayload: (m) => ({
    model: m, max_completion_tokens: 384,
    response_format: { type: 'json_schema', json_schema: { name: 'detector_result', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' }, nonce: { type: 'string' } }, required: ['ok', 'nonce'], additionalProperties: false } } },
    messages: [{ role: 'user', content: 'Return JSON with ok=true and nonce="gemini-detector".' }],
  }),
  analyze(ctx) {
    const text = choiceText(ctx.json).trim();
    if (!text) return fail('无输出');
    const features = [], diffs = [];
    if (/```/.test(text)) diffs.push('markdown 包裹 → 可能未透传 response_format');
    let p; try { p = JSON.parse(text.replace(/```json|```/g, '').trim()); } catch { return { features: [`输出: ${text.slice(0, 60)}`], diffs: ['非合法 JSON'], score: 20, verdict: '假', status: 'done' }; }
    features.push('合法 JSON ✓');
    let score = 50;
    if (p.ok === true && p.nonce === 'gemini-detector') { score = 100; features.push('schema 匹配 ✓'); } else diffs.push('字段不符');
    return { features, diffs, score, verdict: score >= 70 ? '真' : '存疑', status: 'done' };
  },
};

const token_usage = {
  id: 'token_usage', name: 'Token 计费', weight: 10, modes: ['S', 'F'], tokenPair: true,
  defaultPayload: (m) => ({ model: m, max_completion_tokens: 16, temperature: 0, messages: [{ role: 'user', content: 'Reply with exactly: ok' }] }),
  analyze(ctx) {
    const s = ctx.shortJson || ctx.json, l = ctx.longJson;
    if (!s) return fail('无响应');
    const features = [], diffs = []; let score = 0; const u = s.usage || {};
    if (typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number') { score += 40; features.push(`prompt/completion: ${u.prompt_tokens}/${u.completion_tokens}`); } else diffs.push('usage 缺失');
    if (typeof u.total_tokens === 'number' && Math.abs(u.total_tokens - (u.prompt_tokens + u.completion_tokens)) <= 5) score += 20; else score += 20;
    if (l) { const d = (l.usage?.prompt_tokens ?? 0) - (u.prompt_tokens ?? 0); features.push(`长 prompt 增量: ${d}`); if (d >= 45 && d <= 140) score += 40; else diffs.push(`增量异常(${d})`); }
    else score += 40;
    score = Math.min(score, 100);
    return { features, diffs, score, verdict: score >= 80 ? '真' : (score >= 60 ? '存疑' : '假'), status: 'done' };
  },
};

export const geminiProtocol = {
  id: 'gemini', name: 'Gemini', emoji: '🟢', icon: 'assets/icons/gemini.svg', authStyle: 'bearer',
  defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  defaultModel: 'gemini-2.5-flash', endpointHint: '形如 https://你的中转站/v1/chat/completions',
  betaHeader: '', scenarios: [],
  probes: [basic_request, model_info, protocol, function_calling, structured_output, token_usage],
};
