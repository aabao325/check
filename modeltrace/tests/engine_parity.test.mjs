/* engine_parity.test.mjs —— 移植版评分器与 ModelTrace 原版逐位对拍
 *
 * replay_expected.json 由 ModelTrace 原版 static/fingerprint-core.js 对同一批
 * 回放样本跑出（样本取自原作者 data/*_reference.jsonl，每模型 3 条不同环境）。
 * 移植版改了结构（拆出 scoreNumbers / 单份回答归因），但数值必须与原版一致到 1e-10。
 *
 * 运行：node --test modeltrace/tests/ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeOutputs, parseNumbers, matchModel, classifyVerdict, canonicalModelName } from '../assets/engine/fingerprint.js?v=13';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const bank = JSON.parse(fs.readFileSync(here('../data/bank/unified_bank.json'), 'utf8'));
const samples = JSON.parse(fs.readFileSync(here('./fixtures/replay_samples.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(here('./fixtures/replay_expected.json'), 'utf8'));

const bySource = {};
for (const s of samples) (bySource[s.source] ||= []).push({ text: s.text, expected_count: s.requested_count });

test('18 个模型的概率与分布贴合度和原版一致到 1e-10', () => {
  assert.equal(expected.length, 18);
  for (const e of expected) {
    const r = analyzeOutputs(bySource[e.source], bank);
    assert.equal(r.prediction, e.prediction, e.source);
    assert.equal(r.family_prediction, e.family, e.source);
    for (const item of r.results) {
      assert.ok(Math.abs(item.probability - e.probabilities[item.model]) < 1e-10, `${e.source}/${item.model} 概率漂移`);
      assert.ok(Math.abs(item.profile_similarity - e.similarity[item.model]) < 1e-10, `${e.source}/${item.model} 贴合度漂移`);
    }
  }
});

test('单份回答归因：每份都给出合法概率分布', () => {
  const r = analyzeOutputs(bySource['gpt-5.5'], bank);
  assert.equal(r.responses.length, 3);
  for (const resp of r.responses) {
    const sum = resp.probabilities.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  }
  assert.equal(r.pooled_counts.length, 355);
});

test('解析：字母切段、只保留最长段、丢弃超范围值', () => {
  assert.deepEqual(parseNumbers('这里有 300 个数字：12, 45, 400, 7'), [12, 45, 7]);
  assert.deepEqual(parseNumbers('[1,2,3] note 5,6'), [1, 2, 3]);
  assert.deepEqual(parseNumbers(''), []);
});

test('数字不足的回答不计入；全部无效时报错', () => {
  assert.throws(() => analyzeOutputs([{ text: '1, 2, 3', expected_count: 300 }], bank), /没有可用回答/);
});

test('模型名匹配：大小写/厂商前缀/日期后缀/点号版本都能认', () => {
  assert.equal(matchModel('GPT-5.5', bank).model.id, 'gpt-5.5');
  assert.equal(matchModel('anthropic/claude-opus-4.8', bank).model.id, 'claude-opus-4-8');
  assert.equal(matchModel('claude-haiku-4-5', bank).model.id, 'claude-haiku-4-5-20251001');
  assert.equal(canonicalModelName('claude-sonnet-4.6-20260101'), 'claude-sonnet-4-6');
});

test('模型名匹配：思考档位后缀能归到基础模型并带 variant 提示', () => {
  const m = matchModel('claude-opus-5-thinking', bank);
  assert.equal(m.model.id, 'claude-opus-5');
  assert.equal(m.variant, 'thinking');
});

test('模型名匹配：库外模型与空输入被拒绝', () => {
  assert.equal(matchModel('qwen3-max', bank).model, null);
  assert.equal(matchModel('qwen3-max', bank).reason, 'unsupported');
  assert.equal(matchModel('  ', bank).reason, 'empty');
  // 不能因为前缀相似就放行
  assert.equal(matchModel('gpt-5', bank).model, null);
});

test('结论分级：一致 / 不一致 / 存疑', () => {
  const r = analyzeOutputs(bySource['claude-opus-5'], bank);
  assert.equal(classifyVerdict(r, 'claude-opus-5').code, 'match');
  const v = classifyVerdict(r, 'gpt-5.5');
  assert.equal(v.code, 'mismatch');
  assert.equal(v.sameFamily, false);
  assert.equal(classifyVerdict(r, 'no-such-model').code, 'unknown');
});

test('结论分级：三份回答各指一方时判「分歧」，不给虚高结论', () => {
  // 三个不同模型各贡献一份回答：合并概率会虚高，但三份 top 互不相同
  const mixed = [bySource['claude-opus-5-5'][0], bySource['claude-opus-5'][1], bySource['claude-opus-4-8'][2]];
  const r = analyzeOutputs(mixed, bank);
  assert.equal(new Set(r.responses.map((x) => x.top)).size, 3);
  const v = classifyVerdict(r, 'claude-opus-5-5');
  assert.equal(v.code, 'split');
  assert.equal(v.total, 3);
});
