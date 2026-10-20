/* =====================================================================
 * tests/identity_second_round.test.mjs —— 身份二次确认判定逻辑离线单测
 * 运行：在 check/ 目录下  node --test
 * ===================================================================== */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySecondRoundIdentityCheck } from '../assets/core.js';

const baseTrue = { score: 100, verdict: '真', severity: '', diffs: [] };
const baseCritical = { score: 0, verdict: '假', severity: 'critical', diffs: ['自述含具体竞品后端品牌: gpt-5 → 高度疑似冒充'] };
const baseNa = { score: null, verdict: '不适用', severity: '', diffs: ['官方渠道 + 竞品自述：判为官方模型身份幻觉'] };

test('B 轮未发送（Q 档跳过）→ 原样返回', () => {
  const r = applySecondRoundIdentityCheck(baseTrue, 'X7K-霄现', null);
  assert.deepEqual(r, baseTrue);
});

test('B 轮正确遵从虚构身份 → 分数/verdict/severity 不变，追加正面说明', () => {
  const r = applySecondRoundIdentityCheck(baseTrue, 'X7K-霄现', '我是x7k-霄现，很高兴为你服务');
  assert.equal(r.score, 100);
  assert.equal(r.verdict, '真');
  assert.equal(r.severity, '');
  assert.ok(r.diffs.some((d) => d.includes('已正确遵从')));
});

test('B 轮未遵从 + A 轮非 critical → 降级为存疑/warn，分数不变', () => {
  const r = applySecondRoundIdentityCheck(baseTrue, 'X7K-霄现', '我是claude，由anthropic开发');
  assert.equal(r.score, 100, '分数不封顶');
  assert.equal(r.verdict, '存疑');
  assert.equal(r.severity, 'warn');
  assert.ok(r.diffs.some((d) => d.includes('疑似 system/instructions 提示词被中转层丢弃或篡改')));
});

test('B 轮未遵从 + A 轮已是 critical → 不再降级，只追加说明', () => {
  const r = applySecondRoundIdentityCheck(baseCritical, 'Q3-流萤', '我是gpt-5');
  assert.equal(r.score, 0);
  assert.equal(r.verdict, '假');
  assert.equal(r.severity, 'critical');
  assert.ok(r.diffs.some((d) => d.includes('不进一步降级')));
});

test('B 轮未遵从 + A 轮是「不适用」→ 降级为存疑（因为 severity 不是 critical）', () => {
  const r = applySecondRoundIdentityCheck(baseNa, 'Z9-苇岸', '我是gemini');
  assert.equal(r.score, null);
  assert.equal(r.verdict, '存疑');
  assert.equal(r.severity, 'warn');
});

test('不 mutate 原始 base 对象', () => {
  const original = { score: 100, verdict: '真', severity: '', diffs: ['x'] };
  const snapshot = JSON.parse(JSON.stringify(original));
  applySecondRoundIdentityCheck(original, 'M2-昧光', '我是claude');
  assert.deepEqual(original, snapshot);
});
