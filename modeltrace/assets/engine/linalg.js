/* =====================================================================
 * engine/linalg.js —— 建库与可视化用到的最小线性代数
 * ---------------------------------------------------------------------
 * 只需要两件事：
 *   1. 小对称矩阵的全部特征值/特征向量（Jacobi 旋转，n ≤ 几十，稳定且无依赖）
 *   2. 「行少列多」矩阵（如 12 个环境 × 355 维）的前 k 个右奇异向量
 *      —— 用 Gram 矩阵 A·Aᵀ（12×12）的特征分解换算：v = Aᵀu / σ，
 *      避开在 355×355 上做分解。
 * 奇异向量的正负号与 numpy 可能相反，但下游只用它做投影 (x·v)v，符号不影响结果。
 * ===================================================================== */

/* Jacobi 特征分解。返回按特征值降序排列的 { values, vectors }，vectors[k] 为第 k 个特征向量。 */
export function symmetricEigen(input, { tolerance = 1e-15, maxSweeps = 100 } = {}) {
  const n = input.length;
  const a = input.map((row) => row.slice());
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let off = 0;
    for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) off += a[i][j] * a[i][j];
    if (off < tolerance) break;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k += 1) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => a[y][y] - a[x][x]);
  return {
    values: order.map((i) => a[i][i]),
    vectors: order.map((i) => v.map((row) => row[i])),
  };
}

/* 行少列多矩阵 rows(m×d) 的奇异值（降序）与对应右奇异向量（每个长 d、单位长度）。 */
export function rightSingular(rows) {
  const m = rows.length;
  const d = rows[0]?.length || 0;
  const gram = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => {
    let s = 0;
    for (let k = 0; k < d; k += 1) s += rows[i][k] * rows[j][k];
    return s;
  }));
  const { values, vectors } = symmetricEigen(gram);
  const singular = values.map((x) => Math.sqrt(Math.max(x, 0)));
  const right = vectors.map((u, idx) => {
    const sigma = singular[idx];
    const vec = Array(d).fill(0);
    if (sigma > 0) {
      for (let i = 0; i < m; i += 1) {
        const w = u[i] / sigma;
        if (w) for (let k = 0; k < d; k += 1) vec[k] += w * rows[i][k];
      }
    }
    return vec;
  });
  return { singular, right };
}

/* 列均值与总体标准差（numpy std 默认 ddof=0）。 */
export function columnMean(rows) {
  const d = rows[0].length;
  const out = Array(d).fill(0);
  for (const r of rows) for (let k = 0; k < d; k += 1) out[k] += r[k];
  return out.map((x) => x / rows.length);
}

export function columnStd(rows, center = columnMean(rows)) {
  const d = rows[0].length;
  const out = Array(d).fill(0);
  for (const r of rows) for (let k = 0; k < d; k += 1) out[k] += (r[k] - center[k]) ** 2;
  return out.map((x) => Math.sqrt(x / rows.length));
}
