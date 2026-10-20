/* =====================================================================
 * engine/fingerprint.js —— 模型归因 · 数字指纹评分核心
 * ---------------------------------------------------------------------
 * 原理：让模型「凭第一反应」写约 300 个 1..355 的整数。模型不是真随机源，
 * 它的偏好由权重决定、稳定可复现，且各模型偏法不同 —— 这串数字就是指纹。
 *
 *   每份回答的分数 = 0.75 × 去环境方向后的 Hellinger 质心相似度（355 维，看分布形状）
 *                  + 0.25 × 有序块特征（4 段 × 16 桶 + 末位数字，74 维，看排列顺序）
 *   多份回答取 z 分均值 → 按回答数选校准温度 β → softmax 得闭集概率。
 *
 * 算法移植自 xqy2006/ModelTrace（MIT License, Copyright (c) 2026 xqy2006）的
 * static/fingerprint-core.js，数值逻辑逐行对齐；改动只在：拆出单份回答评分供可视化用、
 * 补充中文注释。改算法前先跑 tests/engine_parity.test.mjs —— 它会拿原作者 numpy
 * 建出来的库做对照，任何一位小数漂移都会被抓到。
 *
 * 纯函数、不碰 DOM、不 import 带 ?v= 的模块 → 可被 node --test 直接单测。
 * ===================================================================== */

export const VALUE_MIN = 1;
export const VALUE_MAX = 355;
export const DIMENSION = VALUE_MAX - VALUE_MIN + 1;
export const ALPHA = 0.5;
export const ORDERED_BLOCK_WEIGHT = 0.25;

/* 有效回答门槛：至少 80 个数字，且不少于请求量的 55%。
 * 低于门槛的回答（拒答、截断、混了大段解释）不计入，宁缺毋滥。 */
export function minimumNumbers(expected) {
  const n = Number(expected) || 0;
  return n ? Math.max(80, Math.ceil(n * 0.55)) : 80;
}

/* 解析：取「最长的一段数字串」。数字之间一旦夹了字母（\p{L} 含中文）就切断成新段，
 * 防止「这里有 300 个数字」里的 300 混进序列。超出 1..355 的值直接丢弃但不切段。 */
export function parseNumbers(text) {
  const source = String(text ?? '');
  const runs = [];
  let current = [];
  let previousEnd = 0;
  for (const match of source.matchAll(/\d+/g)) {
    const separator = source.slice(previousEnd, match.index);
    const value = Number(match[0]);
    if (current.length && /\p{L}/u.test(separator)) {
      runs.push(current);
      current = [];
    }
    if (value >= VALUE_MIN && value <= VALUE_MAX) current.push(value);
    previousEnd = match.index + match[0].length;
  }
  if (current.length) runs.push(current);
  return runs.reduce((best, run) => (run.length > best.length ? run : best), []);
}

export function countNumbers(numbers) {
  const counts = Array(DIMENSION).fill(0);
  for (const n of numbers) counts[n - VALUE_MIN] += 1;
  return counts;
}

/* ---------- 向量小工具（与 numpy 语义一致：standardize 用总体方差 /N） ---------- */
export function mean(values) {
  return values.reduce((total, v) => total + v, 0) / values.length;
}

export function standardize(values) {
  const center = mean(values);
  const variance = mean(values.map((v) => (v - center) ** 2));
  const scale = Math.max(Math.sqrt(variance), 1e-12);
  return values.map((v) => (v - center) / scale);
}

export function dot(left, right) {
  let value = 0;
  for (let i = 0; i < left.length; i += 1) value += left[i] * right[i];
  return value;
}

export function norm(values) {
  return Math.sqrt(dot(values, values));
}

export function normalized(values) {
  const scale = Math.max(norm(values), 1e-12);
  return values.map((v) => v / scale);
}

/* 依次减掉在每个基向量上的投影。基向量来自 SVD 的右奇异向量，彼此正交，
 * 所以「逐个减」等价于 numpy 的 (x @ B.T) @ B 一次性减。 */
export function subtractBasis(values, basis) {
  const output = values.slice();
  for (const vector of basis || []) {
    const projection = dot(output, vector);
    for (let i = 0; i < output.length; i += 1) output[i] -= projection * vector[i];
  }
  return output;
}

/* ---------- 特征提取 ---------- */

/* Hellinger 特征：加 0.5 拉普拉斯平滑后开方 → 落在单位球面上的 sqrt(p)。 */
export function hellingerFeature(counts) {
  const total = counts.reduce((sum, v) => sum + v, 0) + ALPHA * DIMENSION;
  return counts.map((v) => Math.sqrt((v + ALPHA) / total));
}

/* 等价于 np.array_split(values, 4)：前 remainder 段各多分 1 个。 */
function splitIntoFour(values) {
  const base = Math.floor(values.length / 4);
  const remainder = values.length % 4;
  const chunks = [];
  let start = 0;
  for (let i = 0; i < 4; i += 1) {
    const size = base + (i < remainder ? 1 : 0);
    chunks.push(values.slice(start, start + size));
    start += size;
  }
  return chunks;
}

/* 有序块特征：序列切 4 段，每段 16 桶直方图；再拼末位数字 0..9 分布。共 74 维。
 * 抓的是「序列哪个位置偏好哪个数值区间」——边际分布看不到的顺序信息。 */
export function orderedBlockFeature(numbers) {
  const pieces = [];
  for (const chunk of splitIntoFour(numbers)) {
    const bins = Array(16).fill(0.5);
    for (const v of chunk) bins[Math.min(15, Math.floor(((v - 1) / 355) * 16))] += 1;
    const total = bins.reduce((sum, v) => sum + v, 0);
    pieces.push(...bins.map((v) => Math.sqrt(v / total)));
  }
  const lastDigits = Array(10).fill(0.5);
  for (const v of numbers) lastDigits[v % 10] += 1;
  const lastTotal = lastDigits.reduce((sum, v) => sum + v, 0);
  pieces.push(...lastDigits.map((v) => Math.sqrt(v / lastTotal)));
  return pieces;
}

/* ---------- 单份回答评分（对每个库内模型给一个 z 分） ---------- */

function marginalScores(counts, robust) {
  const a = robust.hellinger;
  const feature = hellingerFeature(counts);
  let projected = feature.map((v, i) => (v - a.feature_mean[i]) / a.feature_scale[i]);
  projected = normalized(subtractBasis(projected, a.nuisance_basis));
  return standardize(a.centroids.map((c) => dot(projected, c)));
}

/* 有序块内部再五五开：template = 各环境模板里取最像的那个（抗环境），
 * nuisance = 投影掉环境方向后与质心比（抗干扰）。 */
function orderedScores(numbers, robust) {
  const a = robust.ordered_blocks;
  const feature = orderedBlockFeature(numbers);
  const standardized = feature.map((v, i) => (v - a.feature_mean[i]) / a.feature_scale[i]);
  const unit = normalized(standardized);
  const envScores = a.environment_centroids.map((cs) => cs.map((c) => dot(unit, c)));
  const template = standardize(a.centroids.map((_, m) => Math.max(...envScores.map((s) => s[m]))));
  const projected = normalized(subtractBasis(standardized, a.nuisance_basis));
  const nuisance = standardize(a.centroids.map((c) => dot(projected, c)));
  return standardize(template.map((v, i) => 0.5 * v + 0.5 * nuisance[i]));
}

/* 只依赖 bank.robust，方便建库交叉验证时传入「留出后重建」的临时 robust。 */
export function scoreNumbers(numbers, robust) {
  const marginal = marginalScores(countNumbers(numbers), robust);
  const a = robust.ordered_blocks;
  const weight = a ? Number(a.weight || 0) : 0;
  if (!a || weight === 0) return marginal;
  const ordered = orderedScores(numbers, robust);
  return marginal.map((v, i) => (1 - weight) * v + weight * ordered[i]);
}

export function softmax(values) {
  const maximum = Math.max(...values);
  const weights = values.map((v) => Math.exp(v - maximum));
  const total = weights.reduce((sum, v) => sum + v, 0);
  return weights.map((v) => v / total);
}

/* 分布贴合度：合并后的实测计数 vs 某模型的基线计数，1 - sqrt(JS/ln2)，∈[0,1]。
 * 只用于展示「和基准有多像」，不参与归因概率。 */
export function jsSimilarity(left, right) {
  const leftTotal = left.reduce((sum, v) => sum + v, 0);
  const rightTotal = right.reduce((sum, v) => sum + v, 0) + ALPHA * DIMENSION;
  const p = left.map((v) => v / leftTotal);
  const q = right.map((v) => (v + ALPHA) / rightTotal);
  const mid = p.map((v, i) => (v + q[i]) / 2);
  const divergence = (values) => values.reduce((t, v, i) => t + (v ? v * Math.log(v / mid[i]) : 0), 0);
  const js = (divergence(p) + divergence(q)) / 2;
  return 1 - Math.sqrt(js / Math.log(2));
}

/* ---------- 支持模型判定（库外模型不发请求） ----------
 * 指纹归因是闭集：库外模型也会被硬塞给「最像的」库内模型，且概率看着很自信。
 * 所以前台在发请求之前就拦住库外模型，而不是测完再给一个误导性的答案。
 *
 * 归一化只做「明确同一模型的不同写法」：大小写、厂商前缀(anthropic/xxx)、
 * 日期后缀(-20251001)、版本号点/横线(4.8 ↔ 4-8)。思考/推理档位后缀(-thinking 等)
 * 能匹配到基础模型，但会带 variant 提示——档位会改变输出偏好，结果要打折看。 */
const VARIANT_SUFFIX = /[-_:](thinking|think|reasoning|high|medium|low|minimal|xhigh|max)$/;

export function canonicalModelName(name) {
  let s = String(name ?? '').trim().toLowerCase();
  if (s.includes('/')) s = s.slice(s.lastIndexOf('/') + 1);
  s = s.replace(/[-_@]\d{8}$/, '');
  s = s.replace(/(\d)\.(\d)/g, '$1-$2');
  return s;
}

export function matchModel(name, bank) {
  const raw = String(name ?? '').trim();
  if (!raw) return { model: null, reason: 'empty' };
  const table = new Map();
  for (const m of bank.models) {
    for (const key of [m.id, m.display_name, ...(m.aliases || [])]) {
      if (key) table.set(canonicalModelName(key), m);
    }
  }
  let key = canonicalModelName(raw);
  if (table.has(key)) return { model: table.get(key), variant: null };
  let variant = null;
  while (VARIANT_SUFFIX.test(key)) {
    variant = variant || key.match(VARIANT_SUFFIX)[1];
    key = key.replace(VARIANT_SUFFIX, '');
    if (table.has(key)) return { model: table.get(key), variant };
  }
  return { model: null, reason: 'unsupported' };
}

/* ---------- 结论分级（相对于用户声称的模型） ----------
 * 阈值沿用 ModelTrace Codex 插件 classifySample 的保守口径：
 * 「不一致」要同时满足 第一候选 ≥0.8、声称模型 ≤0.15、两者相差 ≥0.65 —— 宁可报「存疑」也不冤枉。 */
export function classifyVerdict(result, claimedId) {
  const top = result.results[0];
  const claimed = result.results.find((r) => r.model === claimedId) || null;
  if (!claimed) return { code: 'unknown', claimed: null, top };
  // 分歧闸门：3 份回答的校准温度 β≈12，合并后概率会被放大到近乎 one-hot ——
  // 哪怕三份回答各指一个模型，合并结果也可能显示 99.9%。这恰恰是「多模型轮询 /
  // 混合路由」的典型表现，必须单独拎出来，而不是给一个虚高的自信结论。
  const responses = result.responses || [];
  const agree = responses.filter((r) => r.top === top.model).length;
  if (responses.length >= 2 && agree / responses.length < 0.5) {
    return { code: 'split', claimed, top, agree, total: responses.length };
  }
  if (top.model === claimedId && top.probability >= 0.5) return { code: 'match', claimed, top };
  if (top.probability >= 0.8 && claimed.probability <= 0.15 && top.probability - claimed.probability >= 0.65) {
    return { code: 'mismatch', claimed, top, sameFamily: top.family === claimed.family };
  }
  return { code: 'inconclusive', claimed, top };
}

/* ---------- 汇总归因 ----------
 * outputs: [{ text, expected_count }]
 * 返回结构与 ModelTrace analyzeGlobalOutputs 对齐，另加：
 *   responses[]   每份有效回答的单独概率（看三份是否指向同一模型 → 稳定性）
 *   pooled_counts 合并后的 355 维实测计数（可视化与基线叠图用） */
export function analyzeOutputs(outputs, bank) {
  const modelIds = bank.models.map((m) => m.id);
  const valid = [];
  const diagnostics = [];
  outputs.forEach((item, index) => {
    const numbers = parseNumbers(item.text || '');
    const minimum = minimumNumbers(item.expected_count);
    const accepted = numbers.length >= minimum;
    diagnostics.push({ index, parsed_numbers: numbers.length, minimum_numbers: minimum, accepted });
    if (accepted) valid.push({ index, numbers, counts: countNumbers(numbers), scores: scoreNumbers(numbers, bank.robust) });
  });
  if (!valid.length) throw new Error('没有可用回答：拒答、截断或数字不足的回答不会计入。');

  const combined = modelIds.map((_, m) => mean(valid.map((v) => v.scores[m])));
  const key = String(Math.min(valid.length, 3));
  const cal = bank.calibration[key];
  const beta = Number(cal.beta);
  const probabilities = softmax(combined.map((v) => beta * v));
  const pooled = Array.from({ length: DIMENSION }, (_, i) => valid.reduce((s, v) => s + v.counts[i], 0));

  const entries = Object.fromEntries(bank.models.map((m) => [m.id, m]));
  const familyOf = (id) => entries[id].family || 'models';
  const familyOrder = [...new Set(bank.models.map((m) => m.family || 'models'))];
  const familyNames = Object.fromEntries(familyOrder.map((f) => [
    f, bank.models.find((m) => (m.family || 'models') === f)?.family_name || f,
  ]));
  const results = modelIds.map((id, i) => ({
    model: id,
    display_name: entries[id].display_name,
    probability: probabilities[i],
    profile_similarity: jsSimilarity(pooled, entries[id].counts),
    score: combined[i],
    family: familyOf(id),
    family_name: familyNames[familyOf(id)],
  })).sort((a, b) => b.probability - a.probability);
  const familyProb = Object.fromEntries(familyOrder.map((f) => [
    f, results.filter((r) => r.family === f).reduce((s, r) => s + r.probability, 0),
  ]));
  for (const r of results) r.conditional_probability = r.probability / familyProb[r.family];
  const winner = familyOrder.reduce((best, f) => (familyProb[f] > familyProb[best] ? f : best));

  // 单份回答各自归因（用 1 份回答的校准温度），用于展示三份是否「异口同声」
  const beta1 = Number(bank.calibration['1'].beta);
  const responses = valid.map((v) => {
    const p = softmax(v.scores.map((s) => beta1 * s));
    const best = p.indexOf(Math.max(...p));
    // 带上 numbers 原文：分享页要靠它 + 指纹库把两个分布图重算出来（见 store.buildSnapshot 的 rn）。
    // 不带的后果不是报错，而是分享出去的图悄悄画不出来 —— 这类「少一个字段就少一块功能」
    // 的联动最容易在重构时断掉，所以在这里写明它的下游。
    return { index: v.index, numbers: v.numbers, parsed: v.numbers.length, top: modelIds[best], probability: p[best], probabilities: p, scores: v.scores };
  });

  return {
    prediction: results[0].model,
    prediction_name: results[0].display_name,
    probability: results[0].probability,
    used_outputs: valid.length,
    results,
    responses,
    pooled_counts: pooled,
    diagnostics,
    // 建库时间：分享的图表是报告页用**当时的库**重算的，标明库版本，
    // 库更新后旧分享的图形与当初略有差异时，读者能看出这是基准版本不同而非检测被改过
    bank_built_at: bank.built_at || '',
    calibration: { queries: key, beta, cv_accuracy: cal.cv_accuracy },
    family_prediction: winner,
    family_prediction_name: familyNames[winner],
    family_probability: familyProb[winner],
    family_probabilities: familyOrder.map((f) => ({ family: f, display_name: familyNames[f], probability: familyProb[f] })),
  };
}
