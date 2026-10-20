/* challenges.test.mjs —— 探针生成
 *
 * 建档套件必须与 ModelTrace 采集参考库时用的提示词【逐字一致】，否则新采的数据和库里
 * 已有模型不在同一个「环境」里，环境方向估错，整个库被悄悄污染。
 * suite_hashes.json 是原作者 data/gpt_reference.jsonl 里 36 条提示词的 sha256 前 16 位。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fingerprintSuite, generateChallenges, ENVIRONMENTS } from '../assets/engine/challenges.js?v=13';
import { minimumNumbers } from '../assets/engine/fingerprint.js?v=13';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const hashes = JSON.parse(fs.readFileSync(here('./fixtures/suite_hashes.json'), 'utf8'));
const h = (s) => crypto.createHash('sha256').update(s || '').digest('hex').slice(0, 16);

test('建档套件 36 条，与原作者参考库的提示词逐字一致', () => {
  const suite = fingerprintSuite();
  assert.equal(suite.length, 36);
  assert.equal(ENVIRONMENTS.length, 12);
  for (const ref of hashes) {
    const item = suite.find((x) => x.challenge_id === ref.challenge_id);
    assert.ok(item, ref.challenge_id);
    assert.equal(item.condition, ref.condition, `${ref.challenge_id} condition`);
    assert.equal(item.expected_count, ref.expected_count, `${ref.challenge_id} count`);
    assert.equal(item.transport, ref.transport, `${ref.challenge_id} transport`);
    assert.equal(h(item.prompt), ref.prompt, `${ref.challenge_id} prompt`);
    assert.equal(h(item.base_prompt), ref.base_prompt, `${ref.challenge_id} base_prompt`);
    assert.equal(h(item.system), ref.system, `${ref.challenge_id} system`);
    assert.equal(h(item.user_prefix), ref.user_prefix, `${ref.challenge_id} user_prefix`);
  }
});

test('前台探针：长度互不相同且在 292..332，提示词每次随机', () => {
  for (let round = 0; round < 50; round++) {
    const list = generateChallenges(6);
    const lens = list.map((c) => c.expected_count);
    assert.equal(new Set(lens).size, 6);
    for (const n of lens) assert.ok(n >= 292 && n <= 332);
    for (const c of list) {
      assert.ok(c.prompt.includes(`${c.expected_count} 个 1 到 355`));
      assert.equal(c.system, '');
    }
  }
  const prompts = new Set(Array.from({ length: 30 }, () => generateChallenges(1)[0].prompt));
  assert.ok(prompts.size > 20, '提示词应当随机变化');
});

test('前台探针：可注入确定性随机源', () => {
  const zero = () => 0;
  const [a] = generateChallenges(1, zero);
  assert.equal(a.expected_count, 292);
  assert.ok(a.prompt.startsWith('这是一次独立的数值选择记录。为各个位置分别凭第一反应选择 292 个'));
});

test('有效门槛：≥80 且 ≥ 请求量 55%', () => {
  assert.equal(minimumNumbers(300), 165);
  assert.equal(minimumNumbers(100), 80);
  assert.equal(minimumNumbers(0), 80);
});
