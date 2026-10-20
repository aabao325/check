/* =====================================================================
 * engine/bank-builder.js —— 在浏览器里重建指纹库（管理员采集台用）
 * ---------------------------------------------------------------------
 * 移植自 xqy2006/ModelTrace（MIT）scripts/bank_builder.py，数值逻辑逐行对齐：
 *   1. 每条回答 → 355 维 Hellinger 特征 + 74 维有序块特征
 *   2. 按维度标准化 → 估「环境偏移」→ SVD 取前 2 个主方向 → 投影掉（去环境干扰）
 *   3. 每个模型取均值并归一 → 质心
 *   4. 分组留出交叉验证（每个环境里任取 k 条留出、其余重建）→ 网格搜索 softmax 温度 β
 *
 * 唯一的实现差异：SVD 用「Gram 矩阵 + Jacobi」代替 LAPACK（linalg.js）。奇异向量的正负号
 * 可能与 numpy 相反，但下游只做投影 (x·v)v，符号不影响任何结果。
 * tests/bank_builder.test.mjs 拿原作者全部 648 条参考回答重建，与其发布的
 * unified_bank.json 对拍质心与 β。
 *
 * rows: [{ source, condition_id, challenge_id, text|numbers, family_id?, family_name?, provider? }]
 * ===================================================================== */
import {
  ALPHA, DIMENSION, ORDERED_BLOCK_WEIGHT, parseNumbers, countNumbers, hellingerFeature,
  orderedBlockFeature, scoreNumbers, dot, norm,
} from './fingerprint.js?v=13';
import { rightSingular, columnMean, columnStd } from './linalg.js?v=13';

export const BANK_SCHEMA = 'robust-number-fingerprint-bank';
const NUISANCE_RANK = 2;

function standardizeRows(features) {
  const mean = columnMean(features);
  const scale = columnStd(features, mean).map((s) => (s < 1e-12 ? 1 : s));
  return { mean, scale, rows: features.map((r) => r.map((v, k) => (v - mean[k]) / scale[k])) };
}

function rowsMean(rows) {
  return columnMean(rows);
}

function unit(v) {
  const n = Math.max(norm(v), 1e-12);
  return v.map((x) => x / n);
}

/* 环境偏移的前 rank 个主方向。与 numpy 一致：去中心后 SVD，按 singular > s0·1e-8 截秩，上限 2。 */
function nuisanceBasis(standardized, envOf, environments, dim) {
  const means = environments.map((env) => rowsMean(standardized.filter((_, i) => envOf[i] === env)));
  if (means.length <= 1) return [];
  const center = columnMean(means);
  const offsets = means.map((m) => m.map((v, k) => v - center[k]));
  const { singular, right } = rightSingular(offsets);
  if (!singular[0]) return [];
  const rank = Math.min(NUISANCE_RANK, singular.filter((s) => s > singular[0] * 1e-8).length);
  return right.slice(0, rank).map((v) => v.slice(0, dim));
}

function project(rows, basis) {
  if (!basis.length) return rows;
  return rows.map((r) => {
    const out = r.slice();
    // (x @ B.T) @ B：投影系数都按原始 x 计算（B 行正交，与逐个减等价，这里照 numpy 写法一次算完）
    const coeffs = basis.map((b) => dot(r, b));
    basis.forEach((b, j) => { for (let k = 0; k < out.length; k += 1) out[k] -= coeffs[j] * b[k]; });
    return out;
  });
}

function centroidsOf(rows, labels, modelIds) {
  return modelIds.map((id) => unit(rowsMean(rows.filter((_, i) => labels[i] === id))));
}

export function fitRobustArtifacts(rows, modelIds) {
  const environments = [...new Set(rows.map((r) => r.condition_id))].sort();
  const complete = environments.filter((env) => {
    const sources = new Set(rows.filter((r) => r.condition_id === env).map((r) => r.source));
    return sources.size === modelIds.length && modelIds.every((id) => sources.has(id));
  });
  const robustRows = complete.length ? rows.filter((r) => complete.includes(r.condition_id)) : rows;
  const labels = robustRows.map((r) => r.source);
  const envOf = robustRows.map((r) => r.nuisance_condition_id || r.condition_id);
  const nuisanceEnvs = [...new Set(envOf)].sort();

  // Hellinger（边际分布）
  const h = standardizeRows(robustRows.map((r) => hellingerFeature(r.counts)));
  const hBasis = nuisanceBasis(h.rows, envOf, nuisanceEnvs, DIMENSION);
  const hProjected = project(h.rows, hBasis);
  const hCentroids = centroidsOf(hProjected, labels, modelIds);

  // 有序块
  const o = standardizeRows(robustRows.map((r) => orderedBlockFeature(r.numbers)));
  const oDim = o.rows[0].length;
  const oBasis = nuisanceBasis(o.rows, envOf, nuisanceEnvs, oDim);
  const oProjected = project(o.rows, oBasis);
  const oCentroids = centroidsOf(oProjected, labels, modelIds);
  const templateEnvs = complete.length ? complete : [null];
  const envCentroids = templateEnvs.map((env) => modelIds.map((id) => unit(rowsMean(
    o.rows.filter((_, i) => (env === null || robustRows[i].condition_id === env) && labels[i] === id),
  ))));

  return {
    model_order: modelIds,
    robust_ready: complete.length > 0,
    training_rows: robustRows.length,
    complete_environments: complete,
    hellinger: {
      feature_mean: h.mean, feature_scale: h.scale, nuisance_rank: hBasis.length,
      nuisance_environments: nuisanceEnvs, nuisance_basis: hBasis, centroids: hCentroids,
    },
    ordered_blocks: {
      weight: ORDERED_BLOCK_WEIGHT,
      feature: 'four position blocks x 16 value bins plus final-digit distribution',
      feature_mean: o.mean, feature_scale: o.scale, nuisance_rank: oBasis.length,
      nuisance_basis: oBasis, centroids: oCentroids, environment_centroids: envCentroids,
    },
  };
}
/* ---------- 交叉验证 + 温度校准 ---------- */

/* 每个环境内任取 k 条 challenge 留出 → 用其余数据重建 → 对每个模型的这 k 条回答打分。
 * 只取「所有模型都答过」的 challenge，保证每次留出对每个模型公平。 */
function* combinations(list, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i < list.length; i += 1) { acc.push(list[i]); yield* combinations(list, k, i + 1, acc); acc.pop(); }
}

export function calibrationRecords(rows, modelIds, k, onFold) {
  const records = [];
  const conditions = [...new Set(rows.map((r) => r.condition_id))].sort();
  for (const condition of conditions) {
    const ids = [...new Set(rows.filter((r) => r.condition_id === condition).map((r) => r.challenge_id))].sort()
      .filter((cid) => modelIds.every((m) => rows.some((r) => r.source === m && r.challenge_id === cid)));
    if (ids.length < k) continue;
    for (const held of combinations(ids, k)) {
      const heldSet = new Set(held);
      const robust = fitRobustArtifacts(rows.filter((r) => !heldSet.has(r.challenge_id)), modelIds);
      modelIds.forEach((id, truth) => {
        const heldRows = rows.filter((r) => r.source === id && heldSet.has(r.challenge_id));
        if (heldRows.length !== k) return;
        const scores = heldRows.map((r) => scoreNumbers(r.numbers, robust));
        records.push([modelIds.map((_, m) => scores.reduce((s, x) => s + x[m], 0) / k), truth]);
      });
      onFold?.();
    }
  }
  return records;
}

/* 对数网格 801 点（0.05..12）搜索使交叉熵最小的 β，与原版完全一致。 */
export function fitBeta(records) {
  let bestBeta = 1, bestLoss = Infinity;
  for (let step = 0; step <= 800; step += 1) {
    const beta = Math.exp(Math.log(0.05) + (step * (Math.log(12) - Math.log(0.05))) / 800);
    let loss = 0;
    for (const [scores, truth] of records) {
      const scaled = scores.map((v) => beta * v);
      const max = Math.max(...scaled);
      loss += max + Math.log(scaled.reduce((s, v) => s + Math.exp(v - max), 0)) - scaled[truth];
    }
    loss /= records.length;
    if (loss < bestLoss) { bestBeta = beta; bestLoss = loss; }
  }
  return { beta: bestBeta, nll: bestLoss };
}

/* 原始行 → 带 numbers/counts 的行。text 与 numbers 二选一（参考库为省体积只存 numbers）。 */
export function prepareRows(rows) {
  return rows.map((r) => {
    const numbers = Array.isArray(r.numbers) ? r.numbers : parseNumbers(r.text || '');
    return { ...r, numbers, counts: countNumbers(numbers) };
  });
}

/* 预估交叉验证需要重建多少次，用于进度条。 */
export function foldCount(rows, modelIds) {
  const C = (n, k) => { let v = 1; for (let i = 0; i < k; i += 1) v = (v * (n - i)) / (i + 1); return v; };
  let total = 0;
  const conditions = [...new Set(rows.map((r) => r.condition_id))];
  for (const k of [1, 2, 3]) {
    for (const c of conditions) {
      const n = new Set(rows.filter((r) => r.condition_id === c && modelIds.every((m) => rows.some((x) => x.source === m && x.challenge_id === r.challenge_id))).map((r) => r.challenge_id)).size;
      if (n >= k) total += C(n, k);
    }
  }
  return total;
}

/* 建库主入口。options.onProgress(done, total) 报告交叉验证进度；
 * options.modelMeta[id] 可补 display_name / aliases / source_note（前台展示用）。 */
export function buildBank(rawRows, options = {}) {
  const rows = prepareRows(rawRows);
  const modelIds = [...new Set(rows.map((r) => r.source))];
  const meta = options.modelMeta || {};
  const models = modelIds.map((id) => {
    const sel = rows.filter((r) => r.source === id);
    const counts = Array.from({ length: DIMENSION }, (_, i) => sel.reduce((s, r) => s + r.counts[i], 0));
    const conditions = {};
    for (const r of sel) conditions[r.condition_id] = (conditions[r.condition_id] || 0) + 1;
    return {
      id,
      display_name: meta[id]?.display_name || id,
      family: sel[0].family_id ?? null,
      family_name: sel[0].family_name ?? null,
      ...(meta[id]?.aliases?.length ? { aliases: meta[id].aliases } : {}),
      ...(meta[id]?.source_note ? { source_note: meta[id].source_note } : {}),
      response_count: sel.length,
      valid_number_count: sel.reduce((s, r) => s + r.numbers.length, 0),
      conditions,
      counts,
    };
  });

  const robust = fitRobustArtifacts(rows, modelIds);
  const total = foldCount(rows, modelIds);
  let done = 0;
  const tick = () => { done += 1; options.onProgress?.(done, total); };
  const calibration = {};
  for (const k of [1, 2, 3]) {
    const records = calibrationRecords(rows, modelIds, k, tick);
    if (records.length) {
      const { beta, nll } = fitBeta(records);
      const correct = records.filter(([s, t]) => s.indexOf(Math.max(...s)) === t).length;
      calibration[String(k)] = { beta, cv_accuracy: correct / records.length, cv_correct: correct, cv_samples: records.length, cv_nll: nll, fallback: false };
    } else {
      calibration[String(k)] = { beta: 1, cv_accuracy: null, cv_correct: 0, cv_samples: 0, cv_nll: null, fallback: true };
    }
  }

  return {
    schema: BANK_SCHEMA,
    built_at: new Date().toISOString(),
    method: {
      name: 'Ordered-block + nuisance-Hellinger',
      range: [1, 355],
      alpha: ALPHA,
      ordered_block_weight: robust.ordered_blocks.weight,
      parser: 'longest digit run; alphabetic separators split runs; retain values 1..355',
      response_score: 'shared nuisance-Hellinger and ordered-block environment/nuisance fusion',
      aggregation: 'mean of response-wise fused class z-scores',
      probability: 'uniform-prior softmax with fusion-specific grouped cross-validation temperature scaling',
    },
    recommended_queries: 3,
    minimum_valid_numbers: 80,
    source_scope: 'Reference outputs enrolled for the listed model labels.',
    providers: [...new Set(rows.map((r) => r.provider).filter(Boolean))].sort(),
    models,
    robust,
    calibration,
  };
}
