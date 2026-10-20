/* bank_builder.test.mjs —— 浏览器建库 vs 原作者 numpy 建库
 *
 * 拿 reference.json（原作者全部 648 条参考回答）用 JS 重建，与其发布的 unified_bank.json 对拍：
 * 特征均值/尺度、质心、β、交叉验证准确率。完整交叉验证要重建 84 次、约十几秒，
 * 所以 β 那项单独一条测试，默认也跑（采集台就是靠它算 β，不能不测）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fitRobustArtifacts, buildBank, prepareRows, foldCount } from '../assets/engine/bank-builder.js?v=13';
import { analyzeOutputs, dot } from '../assets/engine/fingerprint.js?v=13';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ref = JSON.parse(fs.readFileSync(here('../data/bank/reference.json'), 'utf8')).rows;
const official = JSON.parse(fs.readFileSync(here('../data/bank/unified_bank.json'), 'utf8'));
const maxDiff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

test('参考数据完整：18 模型 × 36 条', () => {
  assert.equal(ref.length, 648);
  assert.equal(new Set(ref.map((r) => r.source)).size, 18);
});

test('robust 产物与原作者一致：均值/尺度/质心/环境模板', () => {
  const rows = prepareRows(ref);
  const ids = official.robust.model_order;
  const r = fitRobustArtifacts(rows, ids);
  const o = official.robust;
  assert.equal(r.training_rows, o.training_rows);
  assert.deepEqual(r.complete_environments, o.complete_environments);
  assert.equal(r.hellinger.nuisance_rank, o.hellinger.nuisance_rank);
  assert.ok(maxDiff(r.hellinger.feature_mean, o.hellinger.feature_mean) < 1e-12);
  assert.ok(maxDiff(r.hellinger.feature_scale, o.hellinger.feature_scale) < 1e-10);
  // 质心：同一组方向投影掉后的结果，与奇异向量符号无关
  r.hellinger.centroids.forEach((c, i) => assert.ok(maxDiff(c, o.hellinger.centroids[i]) < 1e-8, `hellinger centroid ${ids[i]}`));
  r.ordered_blocks.centroids.forEach((c, i) => assert.ok(maxDiff(c, o.ordered_blocks.centroids[i]) < 1e-8, `ordered centroid ${ids[i]}`));
  r.ordered_blocks.environment_centroids.forEach((env, e) => env.forEach((c, i) => assert.ok(maxDiff(c, o.ordered_blocks.environment_centroids[e][i]) < 1e-10)));
  // 环境方向：子空间一致（|cos| ≈ 1），符号可以相反
  r.hellinger.nuisance_basis.forEach((v, k) => assert.ok(Math.abs(Math.abs(dot(v, o.hellinger.nuisance_basis[k])) - 1) < 1e-8));
});

test('完整建库：β 与交叉验证准确率与原作者一致，且建出的库能正确归因', () => {
  const ids = official.robust.model_order;
  const ordered = ids.flatMap((id) => ref.filter((r) => r.source === id));
  assert.equal(foldCount(prepareRows(ordered), ids), 84);
  let last = 0;
  const bank = buildBank(ordered, { onProgress: (d) => { last = d; } });
  assert.equal(last, 84);
  for (const k of ['1', '2', '3']) {
    assert.ok(Math.abs(bank.calibration[k].beta - official.calibration[k].beta) < 1e-9, `beta ${k}`);
    assert.equal(bank.calibration[k].cv_correct, official.calibration[k].cv_correct, `cv ${k}`);
  }
  assert.deepEqual(bank.models.map((m) => m.id), official.models.map((m) => m.id));
  bank.models.forEach((m, i) => assert.deepEqual(m.counts, official.models[i].counts));
  // 用自建的库归因：每个模型拿 3 条回答，概率与用官方库归因一致
  for (const id of ['gpt-5.5', 'claude-opus-5', 'claude-haiku-4-5-20251001']) {
    const outs = ref.filter((r) => r.source === id).slice(0, 3).map((r) => ({ text: r.numbers.join(','), expected_count: 0 }));
    const a = analyzeOutputs(outs, bank), b = analyzeOutputs(outs, official);
    assert.equal(a.prediction, id);
    assert.ok(Math.abs(a.probability - b.probability) < 1e-8);
  }
});

/* 采集台「导入指纹库」的守护：往库里并入第 19 个模型后，所有平行数组必须同步变长。
 *
 * 这是这套结构最脆的地方 —— 质心不是以模型 id 为 key 的对象，而是与
 * `robust.model_order` **按下标对齐**的平行数组；`ordered_blocks.environment_centroids`
 * 还是 12 环境 × N 模型 × 74 维的三层。少同步任何一处，前台打分时就会取到 undefined，
 * 表现为归因结果全空或 NaN，而报错点离原因很远。
 *
 * 造法：把某个模型的 36 条复制一份、换个 source，于是新模型的 12 个环境都齐
 *（与真实「并入一份 36 条齐全的档案」等价）。 */
test('导入新模型：model_order / 质心 / 环境模板按下标同步增长', () => {
  const donor = 'gpt-5.5';
  const clone = ref.filter((r) => r.source === donor).map((r) => ({ ...r, source: 'zz-test-model', family_id: 'zz' }));
  const rows = [...ref, ...clone];
  const ids = [...official.robust.model_order, 'zz-test-model'];
  const bank = buildBank(rows, { onProgress: () => {} });

  assert.deepEqual(bank.robust.model_order, ids, 'model_order 末尾应多出新模型');
  assert.equal(bank.models.length, ids.length);
  assert.equal(bank.models.at(-1).id, 'zz-test-model');

  const H = bank.robust.hellinger.centroids;
  const O = bank.robust.ordered_blocks.centroids;
  const E = bank.robust.ordered_blocks.environment_centroids;
  assert.equal(H.length, ids.length, 'hellinger 质心数应与 model_order 等长');
  assert.equal(O.length, ids.length, '有序块质心数应与 model_order 等长');
  assert.equal(E.length, 12, '环境模板应有 12 个环境');
  E.forEach((env, e) => assert.equal(env.length, ids.length, `环境 ${e} 的模型数应与 model_order 等长`));

  // 形状也要对：每一维都不能是 undefined / NaN
  H.forEach((c, i) => assert.equal(c.length, official.robust.hellinger.centroids[0].length, `hellinger ${ids[i]} 维度`));
  O.forEach((c, i) => assert.equal(c.length, official.robust.ordered_blocks.centroids[0].length, `ordered ${ids[i]} 维度`));
  E.forEach((env, e) => env.forEach((c, i) => assert.ok(c.every(Number.isFinite), `环境 ${e} 模型 ${ids[i]} 不该有非有限值`)));

  // 新模型能被正常打分（不是 NaN），且它最像的应该是数据来源那个模型
  const outs = clone.slice(0, 3).map((r) => ({ text: r.numbers.join(','), expected_count: 0 }));
  const a = analyzeOutputs(outs, bank);
  assert.ok(Number.isFinite(a.probability), '并入后概率不该是 NaN');
  assert.equal(a.prediction, donor, '复制来的数据应当最像它的来源模型');
});
