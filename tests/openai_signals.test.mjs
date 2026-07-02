/* =====================================================================
 * tests/openai_signals.test.mjs —— openai_signals.js 纯函数离线单测
 * 运行：在 check/ 目录下  node --test
 * ===================================================================== */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanAzureContentFilter,
  scanResponseHeaders,
  classifyOrg,
  decideConclusion,
} from '../assets/protocols/openai_signals.js';

/* ---------- 样本 ---------- */

// 用户提供的真实 Azure Responses 风格 content_filters（全 safe、blocked=false）
const azureResponsesBody = {
  id: 'resp_abc',
  object: 'response',
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
  content_filters: [
    {
      blocked: false,
      source_type: 'prompt',
      content_filter_raw: [],
      content_filter_results: {
        hate: { filtered: false, severity: 'safe' },
        sexual: { filtered: false, severity: 'safe' },
        violence: { filtered: false, severity: 'safe' },
        self_harm: { filtered: false, severity: 'safe' },
        jailbreak: { detected: false, filtered: false },
      },
      content_filter_offsets: { start_offset: 0, end_offset: 837, check_offset: 0 },
    },
  ],
};

// Azure chat 风格 prompt_filter_results（命中 hate=high）
const azureChatBlocked = {
  id: 'chatcmpl-x',
  prompt_filter_results: [
    {
      prompt_index: 0,
      content_filter_results: {
        hate: { filtered: true, severity: 'high' },
        violence: { filtered: false, severity: 'safe' },
      },
    },
  ],
};

// 纯官方 OpenAI Responses（无任何过滤字段）
const pureOpenAIBody = {
  id: 'resp_pure',
  object: 'response',
  status: 'completed',
  system_fingerprint: 'fp_44709d6fcb',
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }],
  usage: { input_tokens: 10, output_tokens: 5 },
};

/* ---------- 响应头样本 ---------- */

// 用户提供的真实 Azure 响应头
const azureHeaders = {
  'apim-request-id': '11fe3e94-37d6-49b9-87a5-a677be8fa624',
  'azureai-fe-is-streaming': 'False',
  'azureml-model-session': 'd20260620024045-7010d398',
  'x-ms-region': 'East US 2',
};
// OpenAI 官方直连典型头
const openaiHeaders = {
  'openai-organization': 'org-abc123',
  'openai-processing-ms': '812',
  'openai-version': '2020-10-01',
  'x-request-id': 'req_8f3a1b2c4d5e6f70',
};
// 你的真实案例：one-api/new-api 中转，透传 openai-* + 自带 x-oneapi-request-id + cf-*
const oneapiPassthroughHeaders = {
  'openai-organization': '-58570',
  'openai-processing-ms': '2051',
  'openai-version': '2020-10-01',
  'openai-project': 'proj_ZIPDFx4ctF0fVBqo3jjbBJi4',
  'cf-ray': 'a13c2f09eb3e00a3-KIX',
  'cf-cache-status': 'DYNAMIC',
  'server': 'cloudflare',
  'x-oneapi-request-id': '202606300935569034892008268d9d6mK4wyqRP',
  'x-request-id': '202606300935569034892008268d9d6mK4wyqRP',
};
// 逆向中转：既无官方头也无 Azure 头，且带代理头
const proxyHeaders = { 'server': 'nginx', 'via': '1.1 vegur', 'x-proxy-id': 'abc' };
// 仅有通用 x-request-id（短 UUID 形态），无任何 openai-*/azure 专属头
const bareReqIdHeaders = { 'content-type': 'application/json', 'x-request-id': 'abc-123', 'date': 'x' };

/* ---------- scanAzureContentFilter ---------- */

test('Azure Responses content_filters（全 safe）应判 detected、anyBlocked=false', () => {
  const r = scanAzureContentFilter([{ json: azureResponsesBody }]);
  assert.equal(r.detected, true);
  assert.equal(r.anyBlocked, false);
  assert.ok(r.categories.includes('self_harm'));
  assert.ok(r.categories.includes('jailbreak'));
});

test('Azure chat prompt_filter_results 命中 high 应 anyBlocked=true', () => {
  const r = scanAzureContentFilter([{ json: azureChatBlocked }]);
  assert.equal(r.detected, true);
  assert.equal(r.anyBlocked, true);
});

test('纯官方响应体不应误报 Azure', () => {
  const r = scanAzureContentFilter([{ json: pureOpenAIBody }]);
  assert.equal(r.detected, false);
  assert.deepEqual(r.categories, []);
});

/* ---------- classifyOrg ---------- */

test('classifyOrg 归类', () => {
  assert.equal(classifyOrg('Microsoft Corporation').kind, 'azure');
  assert.equal(classifyOrg('OpenAI, LLC').kind, 'openai');
  assert.equal(classifyOrg('Cloudflare, Inc.').kind, 'cdn');
  assert.equal(classifyOrg({ as: 'AS16509 Amazon.com, Inc.' }).kind, 'cloud');
  assert.equal(classifyOrg('').kind, 'unknown');
});

/* ---------- scanResponseHeaders：响应头指纹 ---------- */

test('Azure 头 → verdict=azure，命中全部 Azure 专属头', () => {
  const r = scanResponseHeaders([{ headers: azureHeaders }]);
  assert.equal(r.verdict, 'azure');
  assert.equal(r.hasAnyAzure, true);
  assert.equal(r.azure.length, 4);
  assert.equal(r.facts.azureRegion, 'East US 2');
});

test('OpenAI 官方头 → verdict=openai；x-request-id 不算 OpenAI 信号', () => {
  const r = scanResponseHeaders([{ headers: openaiHeaders }]);
  assert.equal(r.verdict, 'openai');
  assert.equal(r.hasAnyOpenAI, true);
  // openai 集合里只应有 openai-* 前缀头，x-request-id 不在其中
  assert.ok(r.openai.every((s) => s.startsWith('openai-')));
});

test('仅有通用 x-request-id（无 openai-* 头）→ 不判 openai（verdict=relay/unknown）', () => {
  const r = scanResponseHeaders([{ headers: bareReqIdHeaders }]);
  assert.notEqual(r.verdict, 'openai');
  assert.equal(r.hasAnyOpenAI, false);
});

test('你的真实案例：one-api 透传 → verdict=relay-software，relaySoftware=one-api/new-api', () => {
  const r = scanResponseHeaders([{ headers: oneapiPassthroughHeaders }]);
  assert.equal(r.verdict, 'relay-software');
  assert.equal(r.relaySoftware, 'one-api/new-api');
  assert.equal(r.hasAnyOpenAI, true);          // 透传了 openai-*
  assert.ok(r.cloudflare.length >= 1);          // 命中 cf-*
  assert.equal(r.facts.openaiProject, 'proj_ZIPDFx4ctF0fVBqo3jjbBJi4');
});

test('无官方/Azure 头但有代理头 → verdict=relay', () => {
  const r = scanResponseHeaders([{ headers: proxyHeaders }]);
  assert.equal(r.verdict, 'relay');
  assert.equal(r.hasAnyProxy, true);
});

/* ---------- decideConclusion：核心判定 ---------- */

// A. relay-software 透传判别（你的真实案例）
test('你的真实案例：one-api 透传 openai-* + 出口微软云 + UA自报OpenAI → 中转软件→上游OpenAI官方', () => {
  const c = decideConclusion({
    channelCode: 'openai', truncOk: true,
    headers: scanResponseHeaders([{ headers: oneapiPassthroughHeaders }]),
    upstream: { kind: 'azure', org: 'Microsoft Corporation', uaSawOpenAI: true },
  });
  assert.ok(c.conclusion.includes('中转软件'));
  assert.ok(c.conclusion.includes('OpenAI 官方'));
  assert.equal(c.verdict, '真');
});

test('relay-software 透传纯 Azure 头（无 openai-organization）→ 中转软件→上游 Azure', () => {
  // 中转软件标记 + Azure 专属头，但不含 openai-organization 铁证头（真 Azure 不会有）
  const headers = scanResponseHeaders([{ headers: { 'x-oneapi-request-id': 'abc', ...azureHeaders } }]);
  const c = decideConclusion({ channelCode: 'openai', truncOk: true, headers });
  assert.ok(c.conclusion.includes('中转软件'));
  assert.ok(c.conclusion.includes('Azure'));
});

test('relay-software 同时透传 openai-organization 铁证头 + Azure 头 → 判 OpenAI（铁证优先）', () => {
  const headers = scanResponseHeaders([{ headers: { ...oneapiPassthroughHeaders, ...azureHeaders } }]);
  const c = decideConclusion({ channelCode: 'openai', truncOk: true, headers });
  assert.ok(c.conclusion.includes('中转软件'));
  assert.ok(c.conclusion.includes('OpenAI'));
});

// B. Azure 坐实
test('Azure 坐实：仅凭 Azure 响应头', () => {
  const c = decideConclusion({ channelCode: 'openai', truncOk: true, headers: scanResponseHeaders([{ headers: azureHeaders }]) });
  assert.equal(c.conclusion, 'Azure（OpenAI on Azure）');
  assert.equal(c.verdict, '真');
});

test('Azure 坐实：响应体审核签名，优先于 codex 身份', () => {
  const c = decideConclusion({
    channelCode: 'codex', truncOk: true, identityCodex: true,
    azure: scanAzureContentFilter([{ json: azureResponsesBody }]),
    headers: scanResponseHeaders([{ headers: {} }]),
  });
  assert.equal(c.conclusion, 'Azure（OpenAI on Azure）');
});

test('Azure 存疑：响应头像 Azure 但出口 IP 在第三方', () => {
  const c = decideConclusion({
    channelCode: 'openai', truncOk: true,
    headers: scanResponseHeaders([{ headers: azureHeaders }]),
    upstream: { kind: 'cloud', org: 'DigitalOcean' },
  });
  assert.ok(c.conclusion.includes('存疑'));
  assert.equal(c.verdict, '存疑');
});

// C. OpenAI 官方：需直接证据
test('OpenAI 高可信：响应头 openai-* + 出口 UA 自报 OpenAI', () => {
  const c = decideConclusion({
    channelCode: 'openai', truncOk: true,
    headers: scanResponseHeaders([{ headers: openaiHeaders }]),
    upstream: { kind: 'azure', org: 'Microsoft', uaSawOpenAI: true },
  });
  assert.equal(c.conclusion, 'OpenAI 官方（高可信）');
});

// 关键回归（你的截图案例）：openai-organization 铁证头 + 出口微软云 + 无 Azure 头 → 必须判 OpenAI 官方，
// 不能因「出口 IP 在微软云」误判 Azure（OpenAI 官方推理本就跑在 Azure 上）。
test('回归：openai-organization 铁证头 + 出口微软云 → OpenAI 官方（非 Azure）', () => {
  const c = decideConclusion({
    channelCode: 'openai', truncOk: true,
    headers: scanResponseHeaders([{ headers: { 'openai-organization': 'org-x', 'openai-processing-ms': '900', 'openai-version': '2020-10-01' } }]),
    upstream: { kind: 'azure', org: 'Microsoft Azure Cloud (westus)' },
  });
  assert.equal(c.conclusion, 'OpenAI 官方（高可信）');
  assert.equal(c.verdict, '真');
});

test('OpenAI 中等可信：仅响应头 openai-*，未捕获出口 IP', () => {
  const c = decideConclusion({ channelCode: 'openai', truncOk: true, headers: scanResponseHeaders([{ headers: openaiHeaders }]) });
  assert.ok(c.conclusion.includes('倾向 OpenAI'));
  assert.equal(c.verdict, '真');
});

test('OpenAI 存疑：响应头像官方但出口 IP 在第三方 → 疑透传中转', () => {
  const c = decideConclusion({
    channelCode: 'openai', truncOk: true,
    headers: scanResponseHeaders([{ headers: openaiHeaders }]),
    upstream: { kind: 'cloud', org: 'Hetzner' },
  });
  assert.ok(c.conclusion.includes('存疑'));
  assert.equal(c.verdict, '存疑');
});

// D. 回源微软云但无响应头指纹 → 基本官方
test('基本官方：无响应头指纹但回源出口 IP=微软云', () => {
  const c = decideConclusion({
    channelCode: 'openai', truncOk: true,
    headers: scanResponseHeaders([{ headers: bareReqIdHeaders }]),
    upstream: { kind: 'azure', org: 'Microsoft Corporation' },
  });
  assert.ok(c.conclusion.includes('基本官方'));
  assert.equal(c.verdict, '真');
});

// E. 核心原则：无响应头指纹 + 无回链 → 不断言纯官，给存疑
test('无响应头指纹 + 无回链证据 → 无法确定上游归属（存疑）', () => {
  const c = decideConclusion({ channelCode: 'openai', truncOk: true, headers: scanResponseHeaders([{ headers: bareReqIdHeaders }]) });
  assert.ok(c.conclusion.includes('无法确定'));
  assert.equal(c.verdict, '存疑');
});

test('无响应头指纹 + 无回链 + 无任何头 → 同样不武断（存疑）', () => {
  const c = decideConclusion({ channelCode: 'openai', truncOk: true });
  assert.ok(c.conclusion.includes('无法确定'));
  assert.equal(c.verdict, '存疑');
});

// F. Codex 可断言
test('Codex 断言：身份自述 codex', () => {
  const c = decideConclusion({ channelCode: 'codex', truncOk: true, identityCodex: true, headers: scanResponseHeaders([{ headers: {} }]) });
  assert.equal(c.conclusion, 'Codex CLI 渠道');
  assert.equal(c.verdict, '真');
});

// G. 非官渠道
test('非官渠道：chatcmpl- 套壳 → critical', () => {
  const c = decideConclusion({ channelCode: 'chat_shape' });
  assert.equal(c.severity, 'critical');
  assert.equal(c.verdict, '假');
});

test('逆向中转：响应头 relay（代理头、无官方头）→ critical', () => {
  const c = decideConclusion({ channelCode: 'openai', truncOk: true, headers: scanResponseHeaders([{ headers: proxyHeaders }]) });
  assert.ok(c.conclusion.includes('逆向') || c.conclusion.includes('非官'));
  assert.equal(c.severity, 'critical');
});

// H. 疑注入
test('疑注入：仅 input_tokens 偏高、无头指纹、问不出 codex', () => {
  const c = decideConclusion({ channelCode: 'openai', truncOk: true, injSuspected: true, headers: scanResponseHeaders([{ headers: bareReqIdHeaders }]) });
  assert.equal(c.conclusion, '官方上游·疑提示词注入（待核实）');
  assert.equal(c.verdict, '存疑');
});
