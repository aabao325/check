/* =====================================================================
 * protocols/openai.js —— OpenAI 协议探针集（Chat Completions / chatcmpl-）
 * 吸收 veridrop openai detectors。核心探针已实现，可端到端跑。
 * ===================================================================== */
import { validateSchema, coefficientOfVariation } from '../core.js?v=9';

const GEMINI_USAGE_MARKERS = ['candidates_token_count', 'prompt_token_count', 'thoughts_token_count', 'cached_content_token_count'];

function choiceText(j) {
  return j?.choices?.[0]?.message?.content || '';
}
function fail(reason, score = 0, severity = '') {
  return { features: [], diffs: [reason], score, verdict: '假', severity, status: 'done' };
}

const basic_request = {
  id: 'basic_request', name: '基础可用', weight: 15, modes: ['Q', 'S', 'F'],
  defaultPayload: (m) => ({ model: m, max_completion_tokens: 96, messages: [{ role: 'user', content: 'Reply only with the single word: pong' }] }),
  analyze(ctx) {
    const j = ctx.json; if (!j) return fail('无响应');
    const text = choiceText(j).toLowerCase();
    const fin = j.choices?.[0]?.finish_reason;
    const features = [`finish_reason: ${fin}`, `回复: "${choiceText(j).slice(0, 40)}"`];
    if (text.includes('pong')) return { features, diffs: [], score: 100, verdict: '真', status: 'done' };
    if (text.trim()) return { features, diffs: ['未回 pong 但有文本'], score: 80, verdict: '真', status: 'done' };
    if (fin === 'length') return { features, diffs: ['推理预算耗尽，无最终文本'], score: 75, verdict: '存疑', status: 'done' };
    return fail('无有效文本');
  },
};

const model_consistency = {
  id: 'model_consistency', name: '模型一致性(防掺假)', weight: 15, modes: ['Q', 'S', 'F'], multi: 3,
  defaultPayload: (m) => ({ model: m, max_completion_tokens: 60, messages: [{ role: 'user', content: 'In one sentence, explain HTTP status 418.' }] }),
  analyze(ctx) {
    const runs = ctx.multiJson || (ctx.json ? [ctx.json] : []);
    if (!runs.length) return fail('无响应');
    const features = [], diffs = [];
    const req = (ctx.model || '').replace(/[._]/g, '-');
    const resp = (runs[0].model || '').replace(/[._]/g, '-');
    const match = req && resp && (req === resp || req.startsWith(resp) || resp.startsWith(req));
    features.push(`请求模型: ${ctx.model}`, `响应模型: ${runs[0].model}`);
    let score = 0;
    if (match) score += 60; else diffs.push('响应 model 与请求不符 → 可能冒充/路由到别的模型');
    const outs = runs.map((r) => r?.usage?.completion_tokens).filter((n) => typeof n === 'number');
    if (outs.length >= 2) {
      const cv = coefficientOfVariation(outs);
      features.push(`completion_tokens: [${outs.join(', ')}], CV=${cv.toFixed(3)}`);
      if (cv < 0.1) score += 40; else if (cv < 0.3) { score += 20; diffs.push('token 波动偏大'); } else diffs.push('token 高度不稳定 → 疑似轮询多模型');
    } else score += 40;
    return { features, diffs, score, verdict: score >= 70 ? '真' : '假', status: 'done' };
  },
};

const protocol = {
  id: 'protocol', name: '协议规范+污染检测', weight: 15, modes: ['Q', 'S', 'F'], passive: true,
  defaultPayload: (m) => ({ model: m, max_completion_tokens: 32, messages: [{ role: 'user', content: 'ping' }] }),
  analyze(ctx) {
    const j = ctx.json; if (!j) return fail('无响应');
    const features = [], diffs = []; let crit = 0, major = 0, minor = 0;
    if (typeof j.id === 'string' && j.id.startsWith('chatcmpl-')) features.push('id 前缀 chatcmpl- ✓'); else { diffs.push(`id 前缀异常: ${j.id}`); crit++; }
    if (j.object === 'chat.completion') features.push('object=chat.completion ✓'); else { diffs.push(`object 异常: ${j.object}`); crit++; }
    if (Array.isArray(j.choices) && j.choices.length) features.push('choices 非空 ✓'); else { diffs.push('choices 缺失'); crit++; }
    // 污染检测（最关键）
    const usage = j.usage || {};
    if (Object.keys(usage).some((k) => k.startsWith('claude_'))) { diffs.push('usage 含 claude_* 字段 → 实为 Claude 套壳!'); crit++; }
    if (GEMINI_USAGE_MARKERS.some((k) => k in usage)) { diffs.push('usage 含 Gemini 计数字段 → 实为 Gemini 套壳!'); crit++; }
    if (usage.usage_source && String(usage.usage_source).toLowerCase() !== 'openai') { diffs.push(`usage_source=${usage.usage_source} ≠ openai`); crit++; }
    if (j.system_fingerprint && !String(j.system_fingerprint).startsWith('fp_')) { diffs.push('system_fingerprint 前缀异常'); minor++; }
    if (!diffs.length) features.unshift('协议规范，无污染信号');
    const score = Math.max(0, 100 - crit * 35 - major * 15 - minor * 5);
    return { features, diffs, score, verdict: score >= 80 && crit === 0 ? '真' : '假', severity: crit ? 'critical' : '', status: 'done' };
  },
};

const function_calling = {
  id: 'function_calling', name: '函数调用', weight: 15, modes: ['S', 'F'],
  defaultPayload: (m) => ({
    model: m, max_completion_tokens: 128,
    tools: [{ type: 'function', function: { name: 'get_current_weather', description: 'Get current weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['celsius', 'fahrenheit'] } }, required: ['city', 'unit'], additionalProperties: false } } }],
    tool_choice: { type: 'function', function: { name: 'get_current_weather' } },
    messages: [{ role: 'user', content: 'Use get_current_weather for Boston, MA in celsius. Do not answer directly.' }],
  }),
  analyze(ctx) {
    const tc = ctx.json?.choices?.[0]?.message?.tool_calls;
    const features = [], diffs = []; let score = 0;
    if (!tc || !tc.length) return fail('未生成 tool_calls → 工具能力可能被剥离');
    const t = tc[0];
    const ck = (c, ok, bad) => { if (c) { score += 20; features.push(ok); } else diffs.push(bad); };
    ck(true, 'tool_calls 存在 ✓');
    ck(typeof t.id === 'string' && t.id.startsWith('call_'), 'id 前缀 call_ ✓', `id 前缀异常: ${t.id}`);
    ck(t.type === 'function', 'type=function ✓', `type 异常: ${t.type}`);
    ck(t.function?.name === 'get_current_weather', 'name 正确 ✓', `name 异常: ${t.function?.name}`);
    let args; try { args = JSON.parse(t.function?.arguments || '{}'); } catch { args = null; }
    ck(args && args.city && ['celsius', 'fahrenheit'].includes(args.unit), `arguments 合法: ${JSON.stringify(args)}`, 'arguments 非法');
    return { features, diffs, score, verdict: score >= 70 ? '真' : '假', status: 'done' };
  },
};

const structured_output = {
  id: 'structured_output', name: '结构化输出', weight: 15, modes: ['S', 'F'],
  defaultPayload: (m) => ({
    model: m, max_completion_tokens: 128,
    response_format: { type: 'json_schema', json_schema: { name: 'detector_result', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' }, nonce: { type: 'string' } }, required: ['ok', 'nonce'], additionalProperties: false } } },
    messages: [{ role: 'user', content: 'Return JSON matching the schema with ok=true and nonce="openai-detector".' }],
  }),
  analyze(ctx) {
    const text = choiceText(ctx.json).trim();
    if (!text) return fail('无输出');
    const features = [], diffs = [];
    if (/```/.test(text)) diffs.push('被 markdown 代码块包裹 → 可能未透传 response_format');
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
  defaultPayload: (m) => ({ model: m, max_completion_tokens: 16, messages: [{ role: 'user', content: 'Reply with exactly: ok' }] }),
  analyze(ctx) {
    const s = ctx.shortJson || ctx.json, l = ctx.longJson;
    if (!s) return fail('无响应');
    const features = [], diffs = []; let score = 0;
    const u = s.usage || {};
    if (typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number') { score += 30; features.push(`prompt/completion: ${u.prompt_tokens}/${u.completion_tokens}`); } else diffs.push('usage 缺失');
    if (typeof u.total_tokens === 'number' && Math.abs(u.total_tokens - (u.prompt_tokens + u.completion_tokens)) <= 1) score += 20; else if (u.total_tokens != null) diffs.push('total ≠ prompt+completion');
    else score += 20;
    if (typeof u.completion_tokens === 'number' && u.completion_tokens <= 12) score += 20; else diffs.push('completion 异常偏大');
    if (l) {
      const d = (l.usage?.prompt_tokens ?? 0) - (u.prompt_tokens ?? 0);
      features.push(`长 prompt 增量: ${d}`);
      if (d >= 45 && d <= 140) score += 30; else diffs.push(`长短 prompt 增量异常(${d})`);
    } else score += 30;
    score = Math.min(score, 100);
    return { features, diffs, score, verdict: score >= 80 ? '真' : (score >= 60 ? '存疑' : '假'), status: 'done' };
  },
};

export const openaiProtocol = {
  id: 'openai', name: 'OpenAI', emoji: '🔵', icon: 'assets/icons/openai.svg', authStyle: 'bearer',
  defaultEndpoint: 'https://api.openai.com/v1/chat/completions',
  defaultModel: 'gpt-5', endpointHint: '形如 https://你的中转站/v1/chat/completions',
  betaHeader: '',
  probes: [basic_request, model_consistency, protocol, function_calling, structured_output, token_billing],
};
