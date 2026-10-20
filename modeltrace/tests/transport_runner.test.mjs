/* transport_runner.test.mjs —— 请求层与编排层（假 fetch，不发真实网络请求） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  completionUrl, formatOrder, buildPayload, buildHeaders, streamDelta, classifyHttpError,
  requestCompletion, detectAndRequest, ProbeError, PROXY_URL,
  resolveTarget, maxTokensFieldFallback,
} from '../assets/engine/transport.js?v=13';
import { runDetection, runCollection } from '../assets/engine/runner.js?v=13';
import { generateChallenges, fingerprintSuite } from '../assets/engine/challenges.js?v=13';

const enc = new TextEncoder();
function sse(events, contentType = 'text/event-stream') {
  const body = new ReadableStream({
    start(c) { for (const e of events) c.enqueue(enc.encode(typeof e === 'string' ? e : `data: ${JSON.stringify(e)}\n\n`)); c.close(); },
  });
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const numbers = (n) => Array.from({ length: n }, (_, i) => ((i * 37) % 355) + 1).join(', ');
const openaiStream = (text, finish = 'stop') => sse([
  ...text.match(/.{1,40}/gs).map((t) => ({ choices: [{ delta: { content: t } }] })),
  { choices: [{ delta: {}, finish_reason: finish }] }, 'data: [DONE]\n\n',
]);
const anthropicStream = (text, stop = 'end_turn') => sse([
  { type: 'message_start', message: { id: 'msg_1', model: 'x' } },
  ...text.match(/.{1,40}/gs).map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
  { type: 'message_delta', delta: { stop_reason: stop } }, { type: 'message_stop' },
]);

test('URL 归一：根地址 / 带 v1 / 已是完整接口地址', () => {
  assert.equal(completionUrl('https://a.com', 'openai'), 'https://a.com/v1/chat/completions');
  assert.equal(completionUrl('https://a.com/v1/', 'anthropic'), 'https://a.com/v1/messages');
  assert.equal(completionUrl('https://a.com/v1/chat/completions', 'anthropic'), 'https://a.com/v1/messages');
  assert.equal(completionUrl('https://a.com/api/v2', 'openai'), 'https://a.com/api/v2/chat/completions');
  /* ⚠️ 两条回归：base 结尾已带 /v1 时不能再叠一层；base 带的是别的版本号时以用户填的为准
   *（改成 v1 反而错得更远 —— 自建网关的版本号就是有意填的）。两条都踩过。 */
  assert.equal(completionUrl('https://a.com/v1', 'anthropic'), 'https://a.com/v1/messages');
  assert.equal(completionUrl('https://a.com/api/v2', 'responses'), 'https://a.com/api/v2/responses');
  assert.deepEqual(formatOrder('https://a.com/v1/messages'), ['anthropic', 'openai', 'responses']);
  assert.deepEqual(formatOrder('https://a.com'), ['openai', 'responses', 'anthropic']);
  assert.deepEqual(formatOrder('https://a.com/v1/responses'), ['responses', 'openai', 'anthropic']);
});

test('路径选择：显式选中即锁定，自定义支持完整地址与纯路径两种填法', () => {
  // 显式选了 /v1/responses → 就该打这个地址、用 responses 协议，不会被 auto 的推断覆盖
  assert.deepEqual(resolveTarget('https://a.com', 'responses'), { proto: 'responses', url: 'https://a.com/v1/responses' });
  assert.deepEqual(resolveTarget('https://a.com/v1', 'messages'), { proto: 'anthropic', url: 'https://a.com/v1/messages' });
  // 协议名也能当 format 传（runner 内部流转用的就是协议名，不是界面的路径 id）
  assert.deepEqual(resolveTarget('https://a.com', 'anthropic'), { proto: 'anthropic', url: 'https://a.com/v1/messages' });
  // 自定义：完整地址原样用；纯路径接在 Base URL 后面
  assert.deepEqual(resolveTarget('https://a.com', 'custom', 'https://o.com/v9/zz'), { proto: 'openai', url: 'https://o.com/v9/zz' });
  assert.deepEqual(resolveTarget('https://a.com', 'custom', '/v1/foo/bar'), { proto: 'openai', url: 'https://a.com/v1/foo/bar' });
});

test('请求体：三条路径各自的字段名与结构', () => {
  // Chat Completions：messages[] / max_tokens，system 进 messages
  const c = buildPayload('openai', 'gpt-4o', 'p', 'sys');
  assert.equal(c.messages[0].role, 'system');
  assert.equal(c.max_tokens, 4096);
  assert.equal('temperature' in c, false);
  // Responses：input / max_output_tokens，system 走顶层 instructions
  const r = buildPayload('responses', 'gpt-5.5', 'p', 'sys');
  assert.equal(r.input, 'p');
  assert.equal(r.instructions, 'sys');
  assert.equal(r.max_output_tokens, 4096);
  assert.equal('messages' in r, false);
  assert.equal('max_tokens' in r, false);
  // Anthropic Messages：顶层 system / max_tokens
  const a = buildPayload('anthropic', 'claude-opus-5', 'p', 'sys');
  assert.equal(a.system, 'sys');
  assert.equal(a.stream, true);
  assert.equal(a.max_tokens, 4096);
  assert.equal(buildHeaders('anthropic', 'k')['x-api-key'], 'k');
  assert.equal(buildHeaders('openai', 'k').Authorization, 'Bearer k');
  assert.equal(buildHeaders('responses', 'k').Authorization, 'Bearer k');
});

test('输出上限字段名：新模型默认 max_completion_tokens，老的用 max_tokens', () => {
  assert.equal(buildPayload('openai', 'gpt-5.5', 'p').max_completion_tokens, 4096);
  assert.equal(buildPayload('openai', 'o3-mini', 'p').max_completion_tokens, 4096);
  assert.equal(buildPayload('openai', 'gpt-4o', 'p').max_tokens, 4096);
  // 显式指定优先于按名字猜
  assert.equal(buildPayload('openai', 'gpt-4o', 'p', '', 'max_completion_tokens').max_completion_tokens, 4096);

  // 上游拒绝时的字段名切换：只认官方那段原话，别的错一概不换（换＝白烧一次额度）
  assert.equal(maxTokensFieldFallback("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", 'max_tokens'), 'max_completion_tokens');
  assert.equal(maxTokensFieldFallback('该模型不支持 max_completion_tokens，请使用 max_tokens', 'max_completion_tokens'), 'max_tokens');
  assert.equal(maxTokensFieldFallback('model gpt-x does not exist', 'max_tokens'), null);
  assert.equal(maxTokensFieldFallback('invalid api key', 'max_tokens'), null);
});

test('增量解析：三条路径的正文与结束原因', () => {
  assert.deepEqual(streamDelta('openai', { choices: [{ delta: { content: '12,' } }] }), { text: '12,', finish: null });
  assert.equal(streamDelta('openai', { choices: [{ delta: {}, finish_reason: 'length' }] }).finish, 'length');
  assert.equal(streamDelta('anthropic', { type: 'content_block_delta', delta: { type: 'text_delta', text: '7' } }).text, '7');
  assert.equal(streamDelta('anthropic', { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '8' } }).text, '');
  assert.equal(streamDelta('anthropic', { type: 'message_delta', delta: { stop_reason: 'refusal' } }).finish, 'refusal');
  // Responses：正文走 response.output_text.delta，结束原因走 status/incomplete_details
  assert.equal(streamDelta('responses', { type: 'response.output_text.delta', delta: '42,' }).text, '42,');
  assert.equal(streamDelta('responses', { type: 'response.completed', response: { status: 'completed' } }).finish, 'stop');
  assert.equal(streamDelta('responses', { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }).finish, 'length');
  // Responses 的事件名与 Chat 的不重合：拿 Chat 的解析器读它会一个字都读不到（→ 判路径选错）
  assert.equal(streamDelta('responses', { choices: [{ delta: { content: 'x' } }] }).text, '');
});

test('错误归类：鉴权 / 模型名 / 路径 / 限流 / WAF', () => {
  assert.equal(classifyHttpError(401, '{"error":{"message":"invalid key"}}').kind, 'auth');
  assert.equal(classifyHttpError(400, '{"error":{"message":"model gpt-x does not exist"}}').kind, 'model');
  assert.equal(classifyHttpError(503, '{"error":{"message":"当前分组 default 下对于模型 x 无可用渠道"}}').kind, 'model');
  assert.equal(classifyHttpError(404, 'not found').kind, 'format');
  assert.equal(classifyHttpError(429, 'slow down').kind, 'quota');
  assert.equal(classifyHttpError(403, '<html>Just a moment... cloudflare</html>').kind, 'network');
});

test('直连流式：拼出完整正文', async () => {
  const text = numbers(300);
  const r = await requestCompletion({ baseUrl: 'https://a.com', apiKey: 'k', model: 'm', format: 'openai', prompt: 'p', fetchImpl: async () => openaiStream(text) });
  assert.equal(r.text, text);
  assert.equal(r.viaProxy, false);
});

test('直连被 CORS 拦 → 改走 iq-proxy 中转，并识别中转里的 HTTP 错误', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url !== PROXY_URL) throw new TypeError('Failed to fetch');
    const body = JSON.parse(init.body);
    assert.equal(body.authStyle, 'x-api-key');
    assert.equal(body.extraHeaders['anthropic-version'], '2023-06-01');
    return sse([': iq-proxy stream open\n\n', { __iq_error: '目标返回 HTTP 401：{"error":{"message":"bad key"}}' }, 'data: [DONE]\n\n']);
  };
  await assert.rejects(
    requestCompletion({ baseUrl: 'https://a.com', apiKey: 'k', model: 'm', format: 'anthropic', prompt: 'p', fetchImpl }),
    (e) => e instanceof ProbeError && e.kind === 'auth' && e.viaProxy === true,
  );
  assert.deepEqual(calls, ['https://a.com/v1/messages', PROXY_URL]);
});

test('中转返回整包 JSON（目标忽略了 stream）也能解析', async () => {
  const msg = { type: 'message', content: [{ type: 'text', text: numbers(200) }], stop_reason: 'end_turn' };
  const b64 = Buffer.from(JSON.stringify(msg), 'utf8').toString('base64');
  const fetchImpl = async (url) => { if (url !== PROXY_URL) throw new TypeError('cors'); return sse([{ __iq_json: b64 }]); };
  const r = await requestCompletion({ baseUrl: 'https://a.com', apiKey: 'k', model: 'm', format: 'anthropic', prompt: 'p', fetchImpl });
  assert.equal(r.text, numbers(200));
  assert.equal(r.viaProxy, true);
});

test('截断与拒答：不计入，但标记格式可用', async () => {
  await assert.rejects(
    requestCompletion({ baseUrl: 'https://a.com', apiKey: 'k', model: 'm', format: 'openai', prompt: 'p', fetchImpl: async () => openaiStream(numbers(50), 'length') }),
    (e) => e.kind === 'rejected' && e.formatOk === true,
  );
});

test('自动探测：OpenAI 路径 404 → 换 Anthropic 成功', async () => {
  const fetchImpl = async (url) => (url.endsWith('/chat/completions') ? json({ error: 'not found' }, 404) : anthropicStream(numbers(300)));
  const r = await detectAndRequest({ baseUrl: 'https://a.com', apiKey: 'k', model: 'm', prompt: 'p', request: (o) => requestCompletion({ ...o, fetchImpl }) });
  assert.equal(r.format, 'anthropic');
});

test('自动探测：OpenAI 路径返回 Anthropic 风格的流 → 判格式不对，换格式', async () => {
  const fetchImpl = async (url) => (url.endsWith('/chat/completions') ? anthropicStream(numbers(300)) : anthropicStream(numbers(300)));
  const r = await detectAndRequest({ baseUrl: 'https://a.com', apiKey: 'k', model: 'm', prompt: 'p', request: (o) => requestCompletion({ ...o, fetchImpl }) });
  assert.equal(r.format, 'anthropic');
});

test('自动探测：鉴权失败不换格式，直接抛（换格式也没用）', async () => {
  let n = 0;
  const fetchImpl = async () => { n += 1; return json({ error: { message: 'invalid api key' } }, 401); };
  await assert.rejects(detectAndRequest({ baseUrl: 'https://a.com', apiKey: 'k', model: 'm', prompt: 'p', request: (o) => requestCompletion({ ...o, fetchImpl }) }), (e) => e.kind === 'auth');
  assert.equal(n, 1);
});

/* 并行后的编排：worker0/1/2 分别认领 index 0/1/2，谁作废谁就接着认领 index 3/4/5，
 * 因此假 fetch 的调用顺序 = 各 worker 取探针的顺序。断言看调用次数与 attempts 的分组统计。
 *
 * ⚠️ 三条踩过的坑，别退回：
 * ① 应答不能按「调用次数」发：并发下三条同时起飞，完成顺序不确定，按次数发会把应答错位。
 *    早先第一条探针还要走 detectAndRequest 试格式，失败时换格式会**重发同一条提示词**，
 *    按次数发就更容易错。
 * ② 也不能按「提示词内容」当 key：generateChallenges 的 6 条探针句式是随机拼的，可能撞车
 *    （早先版本就这么错了 —— 三条并行探针拿到同一条 40 数字的应答，全作废，跑满 6 条）。
 * ③ 判断「这条探针要多少数字」不要去正则解析提示词（模板会变），直接固定探针表，
 *    用它自己的 expected_count 当 key 和应答长度。测的是编排，不是探针生成器。 */
function fixedChallenges(counts) {
  return counts.map((n, i) => ({
    id: `probe-${i + 1}`,
    expected_count: n,
    system: '',
    prompt: `FIXED-${i + 1}-长度-${n}：请给 ${n} 个 1 到 355 的整数。`,
  }));
}

/* 按 expected_count 分派的假 fetch。badFor 里列出的 expected_count 会被要求返回不足的数字。
 * 同一个 expected_count 可能在一次运行里被多条探针用到（固定表里长度不重复，所以不会）。 */
function makeFetch({ counts, bad = new Set(), failAt = new Map(), seen }) {
  return async (_url, init) => {
    const prompt = JSON.parse(init.body).messages.at(-1).content;
    if (seen) seen.push(prompt);
    const n = Number(/长度-(\d+)/.exec(prompt)[1]);
    if (bad.has(n)) return openaiStream(numbers(40));
    if (failAt.has(n)) return json({ error: { message: 'bad request' } }, 400);
    return openaiStream(numbers(n));
  };
}

test('编排：三条探针同时起飞，凑满 3 份即停（不做协议探测）', async () => {
  const counts = [300, 305, 310, 315, 320, 325];
  const seen = [];
  const events = [];
  const r = await runDetection({
    baseUrl: 'https://a.com', apiKey: 'k', model: 'm',
    request: (o) => requestCompletion({ ...o, fetchImpl: makeFetch({ counts, seen }) }),
    onEvent: (e) => events.push(e.type),
    challenges: fixedChallenges(counts),
  });
  assert.equal(r.complete, true);
  assert.equal(r.outputs.length, 3);
  assert.equal(r.format, 'openai');
  // 三条一次并发就拿满 3 份 → 整轮恰好 3 次请求。
  // 早先是「探针 0 单跑探协议 + 2 路并发补」，同样结果要 4 次 —— 白等一次往返。
  assert.equal(r.attempts.length, 3, `三条并发应恰好 3 次请求，实际 ${r.attempts.length} 次`);
  assert.equal(seen.length, 3, `每条探针只发一次，实际发了 ${seen.length} 次`);
  assert.equal(new Set(seen).size, seen.length, '同一条探针的提示词不该被重复发送');
  assert.ok(events.includes('progress'), '流式解析过程要抛 progress 事件');
  // 协议是猜定后一次广播的：整轮只报一次 format，且不含任何探测往返
  assert.equal(events.filter((e) => e === 'format').length, 1, '协议只广播一次');
  assert.equal(events.filter((e) => e === 'attempt').length, 3);
});

test('编排：凑满 3 份有效回答即停，数字不足的那份跳过', async () => {
  // 探针长度互不相同；其中一条只给 40 个数字 → 作废，空闲 worker 补 index 3
  const counts = [300, 305, 310, 315, 320, 325];
  const r = await runDetection({
    baseUrl: 'https://a.com', apiKey: 'k', model: 'm',
    request: (o) => requestCompletion({ ...o, fetchImpl: makeFetch({ counts, bad: new Set([counts[1]]) }) }),
    challenges: fixedChallenges(counts),
  });
  assert.equal(r.complete, true);
  assert.equal(r.outputs.length, 3);
  assert.equal(r.format, 'openai');
  assert.equal(r.attempts.length, 4, '3 条并发 + 补 1 条作废的，共 4 条探针');
  assert.equal(r.attempts.filter((a) => a.status === 'accepted').length, 3);
  assert.equal(r.attempts.filter((a) => a.status === 'rejected').length, 1);
});

test('编排：猜的路径不对（整轮 400）→ 依次换其它路径重跑，不空手而归', async () => {
  // 站点只认 Anthropic：chat 与 responses 两条路径一律 400，第三轮才轮到 messages。
  // 这同时验证了「responses 也进了兜底队列」—— 只有两条时这条会直接失败。
  const counts = [300, 305, 310, 315, 320, 325];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.endsWith('/chat/completions') || url.endsWith('/responses')) return json({ error: { message: 'unknown endpoint' } }, 400);
    return anthropicStream(numbers(Number(/长度-(\d+)/.exec(JSON.parse(init.body).messages.at(-1).content)[1])));
  };
  const events = [];
  const r = await runDetection({
    baseUrl: 'https://a.com', apiKey: 'k', model: 'm',
    request: (o) => requestCompletion({ ...o, fetchImpl }),
    onEvent: (e) => events.push(e.type),
    challenges: fixedChallenges(counts),
  });
  assert.equal(r.format, 'anthropic');
  assert.equal(r.complete, true);
  assert.equal(r.outputs.length, 3);
  // 第一轮 chat：3 条并发、每条一报 format 错就补下一条 → 6 条探针耗尽。
  // 第二轮 responses 同理 6 条。第三轮 messages 3 条一次拿满。
  assert.equal(calls.filter((u) => u.endsWith('/chat/completions')).length, 6);
  assert.equal(calls.filter((u) => u.endsWith('/responses')).length, 6);
  assert.equal(calls.filter((u) => u.endsWith('/messages')).length, 3);
  // 每次换路径都要广播，界面上的「接口路径」跟着更新（换两次 = 3 次广播）
  assert.equal(events.filter((e) => e === 'format').length, 3);
  // 前两轮的失败记录要清掉（那些等于白跑），只留第三轮的 3 条
  assert.equal(r.attempts.length, 3);
  assert.ok(r.attempts.every((a) => a.status === 'accepted'));
});

test('编排：用户显式选了路径 → 绝不自动换（翻了只会给出误导性的报错）', async () => {
  const counts = [300, 305, 310];
  const calls = [];
  // 三条路径都能通，但用户明确指定了 chat；这里让它 404 逼出「会不会自己换路径」
  const fetchImpl = async (url) => {
    calls.push(url);
    return json({ error: { message: 'not found' } }, 404);
  };
  const r = await runDetection({
    baseUrl: 'https://a.com', apiKey: 'k', model: 'm', protocol: 'openai',
    request: (o) => requestCompletion({ ...o, fetchImpl }),
    challenges: fixedChallenges(counts),
  });
  // 只打了 chat 一条路径，没有偷偷去试 responses / messages
  assert.ok(calls.every((u) => u.endsWith('/chat/completions')), `只该打用户选的那条路径，实际 ${calls[0]}`);
  assert.equal(r.outputs.length, 0);
});

test('编排：max_tokens 被上游拒绝 → 自动换成 max_completion_tokens 重发，不惊动用户', async () => {
  const counts = [300, 305, 310];
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    // 模拟新模型：只认 max_completion_tokens，见到 max_tokens 就 400 让你改
    if ('max_tokens' in body) {
      return json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: 'invalid_request_error', param: 'max_tokens', code: 'unsupported_parameter' } }, 400);
    }
    return openaiStream(numbers(330));
  };
  const r = await runDetection({
    baseUrl: 'https://a.com', apiKey: 'k', model: 'gpt-4o',   // 旧名字，故意让它先发 max_tokens
    request: (o) => requestCompletion({ ...o, fetchImpl }),
    challenges: fixedChallenges(counts),
  });
  assert.equal(r.outputs.length, 3, '换过字段名之后三份都该拿到');
  assert.equal(r.error, null, '这个错误应当被就地消化，不该冒出来当致命错误');
  // 前 3 次是 max_tokens 被拒，后 3 次换成 max_completion_tokens
  assert.equal(sent.filter((b) => 'max_tokens' in b).length, 3);
  assert.equal(sent.filter((b) => 'max_completion_tokens' in b).length, 3);
});

test('编排：失败里有非格式错误 → 不换协议重跑（换了也没用，省钱）', async () => {
  // OpenAI 路径 400（格式类）+ 503（上游类）混合：换协议救不了，不该重跑
  const counts = [300, 305, 310, 315, 320, 325];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    const n = Number(/长度-(\d+)/.exec(JSON.parse(init.body).messages.at(-1).content)[1]);
    if (n === counts[0]) return json({ error: { message: 'unknown endpoint' } }, 400);
    if (n === counts[1]) return json({ error: { message: 'upstream boom' } }, 503);
    return openaiStream(numbers(n));
  };
  const r = await runDetection({
    baseUrl: 'https://a.com', apiKey: 'k', model: 'm',
    request: (o) => requestCompletion({ ...o, fetchImpl }),
    challenges: fixedChallenges(counts),
  });
  // counts[2] 那条成功 → 已有 1 份，凑不满 3 就继续领 3/4/5 补位
  assert.equal(r.outputs.length, 3);
  assert.equal(calls.filter((u) => u.endsWith('/messages')).length, 0, '有非格式错误时不换协议');
});


test('编排：模型名不认 → 立即终止，不再烧额度', async () => {
  let n = 0;
  const fatalEvents = [];
  const fetchImpl = async () => { n += 1; return json({ error: { message: 'model not found' } }, 400); };
  const r = await runDetection({
    baseUrl: 'https://a.com', apiKey: 'k', model: 'm',
    request: (o) => requestCompletion({ ...o, fetchImpl }),
    onEvent: (e) => { if (e.type === 'fatal') fatalEvents.push(e); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'model');
  // 并行下 3 条会同时起飞（这是并行的代价），但终止后不再补第 4 条
  assert.ok(n <= 3, `初次并发最多 3 次请求，实际发了 ${n} 次`);
  assert.ok(r.attempts.every((a) => a.status === 'fatal'));
  // ⚠️ fatal 事件必须带 index：界面每个探针一个槽位，靠 index 把挂掉的那格标红。
  // 早先只传 error，界面拿 Undefined 去索引槽位就直接 return，那格永远停在「请求中」转圈。
  assert.equal(fatalEvents.length, 1, '只广播第一次 fatal，界面不该被后来的错误覆盖');
  assert.equal(typeof fatalEvents[0].index, 'number', 'fatal 事件要带上是第几条探针挂的');
});

test('编排：格式探测成功后，个别探针的 400 只作废这一份', async () => {
  // index 2 那条探针回 400，其余都是好回答 → 作废一条、补一条（index 3），仍凑满 3 份
  const counts = [300, 305, 310, 315, 320, 325];
  const r = await runDetection({
    baseUrl: 'https://a.com', apiKey: 'k', model: 'm',
    request: (o) => requestCompletion({ ...o, fetchImpl: makeFetch({ counts, failAt: new Set([counts[2]]) }) }),
    challenges: fixedChallenges(counts),
  });
  assert.equal(r.complete, true);
  assert.equal(r.outputs.length, 3);
  assert.equal(r.error, null, '个别探针 400 不该升级成全局终止');
  assert.equal(r.attempts.filter((a) => a.status === 'accepted').length, 3);
  assert.equal(r.attempts.filter((a) => a.status === 'rejected').length, 1);
});

test('建档：36 条全部采到，系统提示与用户前缀按环境正确下发', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ system: body.messages[0].role === 'system' ? body.messages[0].content : '', user: body.messages.at(-1).content });
    return openaiStream(numbers(300));
  };
  const r = await runCollection({ baseUrl: 'https://a.com', apiKey: 'k', model: 'm', challenges: fingerprintSuite(), concurrency: 3, request: (o) => requestCompletion({ ...o, fetchImpl }) });
  assert.equal(r.rows.length, 36);
  assert.equal(r.format, 'openai');
  assert.equal(new Set(r.rows.map((x) => x.condition_id)).size, 12);
  assert.equal(seen.filter((x) => x.system).length, 12, '4 个 system 环境（固定提示 + 96/512/2048 词）× 3 条');
  assert.equal(seen.filter((x) => x.user.includes('Final task:')).length, 9, '3 个 user 前缀环境 × 3 条');
});

test('建档：单条失败重试一次；鉴权失败立即全部停止', async () => {
  let n = 0;
  const flaky = async () => (n++ === 1 ? openaiStream(numbers(30)) : openaiStream(numbers(300)));
  const suite = fingerprintSuite().slice(0, 4);
  const r = await runCollection({ baseUrl: 'https://a.com', apiKey: 'k', model: 'm', challenges: suite, concurrency: 1, request: (o) => requestCompletion({ ...o, fetchImpl: flaky }) });
  assert.equal(r.rows.length, 4, '数字不足的那条重试后补上');
  assert.equal(n, 5);

  /* 鉴权失败必须立即停、不再烧额度。
   *
   * ⚠️ 这里断言的是「停得住」，不是「只发 1 条」。改成开跑前就按地址猜定格式之后，
   *    首条不再单跑探路，所以并发 N 路会**同时**起飞 —— 前 N 条都已经在飞，
   *    它们各自都会撞上同一个 401，这是并发的固有代价，不是 bug。
   *    早先断言 m === 1 是因为那时首条单跑，停了就只有 1 条。
   *    要守住的底线：总量远小于套件长度（不会跑满 36 条），且 fatal 正确归类。 */
  const suiteFull = fingerprintSuite();
  let m = 0;
  const bad = async () => { m += 1; return json({ error: { message: 'invalid key' } }, 401); };
  const r2 = await runCollection({ baseUrl: 'https://a.com', apiKey: 'k', model: 'm', challenges: suiteFull, concurrency: 2, request: (o) => requestCompletion({ ...o, fetchImpl: bad }) });
  assert.equal(r2.fatal.kind, 'auth');
  assert.ok(m <= 2, `并发 2 时最多只该发出 2 条请求，实际 ${m}`);
  assert.ok(m < suiteFull.length / 2, `鉴权失败后不该继续并发烧额度，实际发了 ${m}/${suiteFull.length} 条`);
  assert.equal(r2.rows.length, 0);
});

/* 开跑前按 Base URL 猜定格式：猜对了不花任何探路请求；猜错了就地翻一次格式重发。 */
test('建档：按地址猜定格式直接并发，猜错时原地翻一次格式重发', async () => {
  // ① 猜对：Base URL 没线索 → 默认 openai。36 条应当**全部一次成功**，没有额外探测请求。
  let calls = 0;
  const okFetch = async () => { calls += 1; return openaiStream(numbers(300)); };
  const suite = fingerprintSuite().slice(0, 4);
  const r1 = await runCollection({ baseUrl: 'https://a.com', apiKey: 'k', model: 'm', challenges: suite, concurrency: 2, request: (o) => requestCompletion({ ...o, fetchImpl: okFetch }) });
  assert.equal(r1.format, 'openai');
  assert.equal(r1.rows.length, 4);
  assert.equal(calls, 4, '猜对时恰好 4 条请求，没有额外的探路请求');

  // ①b 贴了 /messages 结尾 → 直接猜 anthropic，且不花探路请求
  const seenPath = [];
  const okAnth = async (url) => { seenPath.push(String(url)); return anthropicStream(numbers(300)); };
  const r1b = await runCollection({ baseUrl: 'https://a.com/v1/messages', apiKey: 'k', model: 'm', challenges: suite, concurrency: 2, request: (o) => requestCompletion({ ...o, fetchImpl: okAnth }) });
  assert.equal(r1b.format, 'anthropic', '贴了 /messages 结尾就直接按 anthropic 跑，不先探一次');
  assert.equal(r1b.rows.length, 4);
  assert.ok(seenPath.every((u) => u.endsWith('/v1/messages')), `每条都应打到 /v1/messages，实际 ${seenPath[0]}`);

  // ② 猜错：chat 与 responses 全被拒（404 → kind=format），应当依次翻路径、最后落到 messages
  const kind = { seen: [] };
  const flipFetch = async (url) => {
    const u = String(url);
    kind.seen.push(u);
    return u.endsWith('/chat/completions') || u.endsWith('/responses')
      ? json({ error: { message: 'not found' } }, 404)
      : anthropicStream(numbers(300));
  };
  const r2 = await runCollection({ baseUrl: 'https://a.com', apiKey: 'k', model: 'm', challenges: suite, concurrency: 2, request: (o) => requestCompletion({ ...o, fetchImpl: flipFetch }) });
  assert.equal(r2.format, 'anthropic', '两条 OpenAI 路径都不通时应翻到 messages');
  assert.equal(r2.rows.length, 4, '翻路径之后 4 条都该采到');
  /* 猜错时会被「试错」掉几条请求 —— 每条路径的试错数等于**同时起飞的那一批**，不是 1。
   * 并发 2 时前两条一起打 chat，各自撞上 404，然后全局闸门翻成 responses：
   * 第一条翻完原地重发、第二条也跟着重发（它自己还没翻过），其余两条直接走 responses；
   * 到 responses 又全体 404，再翻一次落到 messages 才通。
   * 要守住的底线：每条被废掉的路径试错次数**不超过并发数**，不随套件规模增长。 */
  const hits = (suffix) => kind.seen.filter((u) => u.endsWith(suffix)).length;
  assert.ok(hits('/chat/completions') <= 2, `chat 的试错次数不该超过并发数，实际 ${hits('/chat/completions')}`);
  assert.ok(hits('/responses') <= 4, `responses 的试错次数不该超过并发数×2，实际 ${hits('/responses')}`);
  assert.equal(hits('/v1/messages'), 4, '最终落到 messages 后每条各一次');
});
