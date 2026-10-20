/* =====================================================================
 * assets/viz.js —— 归因结果可视化（结论卡 / A 指纹叠印 / B 指纹罗盘 + 投票矩阵）
 * ---------------------------------------------------------------------
 * 方案定稿自 mockups/modeltrace-visuals.html（A 主图 + B 罗盘，D 的投票矩阵并入 B 侧栏）。
 * 输入统一是 engine/fingerprint.js 的 analyzeOutputs() 结果 + classifyVerdict() 结论。
 * ===================================================================== */
/* ⚠️ 这里给依赖加了版本串：浏览器按**完整 URL** 缓存模块，入口 app.js?v=13 换了新版本、
   而它 import 的 './viz.js' 不带版本时，浏览器会拿旧的 viz.js 配上新的 app.js ——
   表现是「The requested module './viz.js' does not provide an export named 'renderSnapshotCard'」，
   一个纯粹的缓存错配却被报成导出缺失，极难从报错本身看出原因。
   同站 check/ 的模块 import 一直带版本串（见 check/assets/app.js），这里跟上同一套规范：
   **只要改了这个文件，就要把它被引用处的版本串一起 +1**。 */
import { symmetricEigen } from './engine/linalg.js?v=13';
import { dot } from './engine/fingerprint.js?v=13';

const NS = 'http://www.w3.org/2000/svg';
const FAMILY_COLORS = { gpt: '#10a37f', claude: '#d97757', gemini: '#4285f4' };
const FALLBACK_COLORS = ['#9b72cb', '#c98a12', '#5d7a99', '#e0607e', '#3f8f9e'];

export const short = (id) => String(id).replace(/-20\d{6}$/, '');
const tiny = (id) => short(id).replace(/^claude-/, '');
export const pct = (p) => (p >= 0.9995 ? '>99.9%' : p < 0.001 ? '<0.1%' : `${(p * 100).toFixed(1)}%`);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function familyColor(bank) {
  const fams = [...new Set(bank.models.map((m) => m.family || 'models'))];
  let k = 0;
  const map = {};
  for (const f of fams) map[f] = FAMILY_COLORS[f] || FALLBACK_COLORS[k++ % FALLBACK_COLORS.length];
  return (f) => map[f || 'models'] || '#8b8678';
}

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

let tipEl = null;
/* 悬停提示 + 悬停高亮。
 * hoverIn/hoverOut 由调用方给出：SVG 里光有条 tooltip 不够 —— 鼠标扫过时图形本身几乎没反应，
 * 用户看不出「现在指着的是哪一个」。所以每个可悬停元素都要有一个明确的选中态反馈。 */
function bindTip(node, html, { onIn, onOut, into } = {}) {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; document.body.appendChild(tipEl); }
  (into || node).addEventListener('mousemove', (e) => {
    tipEl.innerHTML = html; tipEl.classList.add('on');
    const x = Math.min(e.clientX + 14, window.innerWidth - tipEl.offsetWidth - 8);
    tipEl.style.left = `${x}px`;
    tipEl.style.top = `${e.clientY + 14}px`;
  });
  node.addEventListener('mouseenter', () => { tipEl.classList.add('on'); onIn?.(); });
  node.addEventListener('mouseleave', () => { tipEl.classList.remove('on'); onOut?.(); });
}

/* 计数 → 频率 → 高斯平滑（单份回答只有 ~300 个数，不平滑全是毛刺） */
function smooth(counts, sigma = 7) {
  const tot = counts.reduce((a, b) => a + b, 0) || 1;
  const p = counts.map((c) => c / tot);
  const h = Math.ceil(sigma * 3);
  const kern = Array.from({ length: 2 * h + 1 }, (_, k) => Math.exp(-((k - h) ** 2) / (2 * sigma * sigma)));
  return p.map((_, i) => {
    let s = 0, n = 0;
    for (let k = -h; k <= h; k++) { const j = i + k; if (j >= 0 && j < p.length) { s += p[j] * kern[k + h]; n += kern[k + h]; } }
    return s / n;
  });
}
function bucket(counts, size) {
  const out = [];
  for (let i = 0; i < counts.length; i += size) out.push(counts.slice(i, i + size).reduce((a, b) => a + b, 0));
  const tot = out.reduce((a, b) => a + b, 0) || 1;
  return out.map((v) => v / tot);
}
function curve(points) {
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] || p2;
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  }
  return d;
}
function arc(cx, cy, r, a0, a1) {
  const [x0, y0] = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
  const [x1, y1] = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
  return `M${x0},${y0} A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1},${y1}`;
}

/* ---------- 结论 ---------- */
const ICON = {
  match: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 20 5.6v5.8c0 5-3.4 8.8-8 10.6-4.6-1.8-8-5.6-8-10.6V5.6Z"/><path d="m8.4 12.2 2.6 2.6 4.8-5.2"/></svg>',
  mismatch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h11l-3-3M17 17H6l3 3"/></svg>',
  split: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v7M12 10 5 18M12 10l7 8"/><circle cx="12" cy="3" r="1.2"/><circle cx="5" cy="19" r="1.2"/><circle cx="19" cy="19" r="1.2"/></svg>',
  inconclusive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 1 1 3.6 2.4c-.7.3-1.1.9-1.1 1.6v.4M12 17h.01"/></svg>',
};
export const VERDICT = {
  match: { c: 'var(--ok)', s: 'var(--ok-soft)', t: '与声称模型一致' },
  mismatch: { c: 'var(--bad)', s: 'var(--bad-soft)', t: '疑似被换成其他模型' },
  split: { c: 'var(--warn)', s: 'var(--warn-soft)', t: '三份回答指向不同模型' },
  inconclusive: { c: 'var(--warn)', s: 'var(--warn-soft)', t: '证据不足，无法下结论' },
};

/* view = { result, verdict, claimed, bank, partial } —— partial=true 表示没凑满 3 份 */
export function renderVerdict(box, footEl, view) {
  const { result: r, verdict: v, claimed } = view;
  const meta = VERDICT[v.code] || VERDICT.inconclusive;
  box.style.setProperty('--vc', meta.c);
  box.style.setProperty('--vs', meta.s);
  const c = r.results.find((x) => x.model === claimed) || r.results[0];
  const agree = r.responses.filter((x) => x.top === r.prediction).length;
  let sub;
  if (v.code === 'match') sub = `声称 <span class="mono">${esc(short(claimed))}</span>，${agree === r.responses.length ? `${r.responses.length} 份回答全部指向它` : `${agree}/${r.responses.length} 份回答指向它`}，归因概率 ${pct(r.probability)}`;
  else if (v.code === 'mismatch') sub = `声称 <span class="mono">${esc(short(claimed))}</span>，实测最像 <span class="mono">${esc(short(r.prediction))}</span>（${v.sameFamily ? '同家族内的另一个型号' : '跨家族替换'}）`;
  else if (v.code === 'split') sub = `声称 <span class="mono">${esc(short(claimed))}</span>，各份回答分别像 ${r.responses.map((x) => `<span class="mono">${esc(short(x.top))}</span>`).join(' / ')}`;
  else sub = `声称 <span class="mono">${esc(short(claimed))}</span>，最像 <span class="mono">${esc(short(r.prediction))}</span>（${pct(r.probability)}），声称模型 ${pct(c.probability)}，差距不足以判定`;
  box.innerHTML = `<div class="v-seal">${ICON[v.code] || ICON.inconclusive}</div>
    <div><div class="v-title">${meta.t}</div><div class="v-sub">${sub}</div></div>
    <div class="v-stats">
      <div class="v-stat"><div class="k">声称模型概率</div><div class="v" style="color:${v.code === 'match' ? 'var(--ok)' : v.code === 'mismatch' ? 'var(--bad)' : 'var(--ink)'}">${pct(c.probability)}</div></div>
      <div class="v-stat"><div class="k">分布贴合度</div><div class="v">${(c.profile_similarity * 100).toFixed(1)}</div></div>
      <div class="v-stat"><div class="k">回答一致</div><div class="v">${agree}/${r.responses.length}</div></div>
    </div>`;
  const notes = [];
  if (v.code === 'split') notes.push('合并后的归因概率看起来很高（多份回答的校准温度会放大差距），但各份回答各指一方——这通常意味着多模型轮询或混合路由，所以结论降级为「分歧」。');
  if (view.partial) notes.push(`只拿到 ${r.used_outputs} 份有效回答（目标 3 份），结论的可靠性低于完整检测，建议稍后重测。`);
  if (view.variant) notes.push(`模型名带「${esc(view.variant)}」档位后缀，按基础模型 ${esc(short(claimed))} 比对；推理档位会改变输出偏好，结论仅供参考。`);
  notes.push(`归因概率由 ${r.results.length} 个候选模型的指纹 z 分经校准 softmax 得出（${r.calibration.queries} 份回答的交叉验证准确率 ${r.calibration.cv_accuracy == null ? '—' : `${(r.calibration.cv_accuracy * 100).toFixed(1)}%`}）。分布贴合度 = 1 − √(JS 散度/ln2)，衡量数字分布与基准的相似程度。`);
  footEl.innerHTML = notes.map((n) => `<div>注：${n}</div>`).join('');
}

/* ---------- A 指纹叠印：实测分布（上） vs 官方基准（下，镜像） ---------- */
export function renderOverlay(host, view) {
  const { result: r, verdict: v, claimed, bank } = view;
  const meta = VERDICT[v.code] || VERDICT.inconclusive;
  const models = Object.fromEntries(bank.models.map((m) => [m.id, m]));
  const base = models[claimed];
  const best = models[r.prediction];
  const showBest = r.prediction !== claimed;
  const total = r.pooled_counts.reduce((a, b) => a + b, 0);
  host.innerHTML = `<div class="viz-head"><div class="viz-title">指纹叠印 · 实测分布 vs 官方基准</div>
      <div class="viz-desc">1..355 每个数字被选中的频率：上半是实测，下半镜像是声称模型的基准（上半的灰色虚线是同一条基准）。形状越贴合越可信；中间色带标出实测相对基准「偏多 / 偏少」的数字区间，悬停可看具体数值。纵轴去掉了公共底座，只放大起伏。</div></div>
    <div class="viz-body"><div><div class="legend">
        <span><i style="background:${meta.c}"></i>实测（${r.used_outputs} 份合并 · ${total} 个数字）</span>
        <span><i style="background:var(--base)"></i>基准 · ${esc(short(claimed))}（${base.valid_number_count.toLocaleString()} 个数字）</span>
        ${showBest ? `<span><i style="background:transparent;border:2px dashed var(--bad)"></i>最像 · ${esc(short(best.id))} 的基准</span>` : ''}</div>
      <svg viewBox="0 0 760 360" role="img" aria-label="实测分布与基准分布对比"></svg></div>
      <aside><div class="side-title">分布贴合度（越高越像）</div><div class="sims"></div></aside></div>`;
  const svg = host.querySelector('svg');
  const X0 = 44, W = 700, MID = 178, AMP = 138;
  const m = smooth(r.pooled_counts), b = smooth(base.counts), t = showBest ? smooth(best.counts) : null;
  const all = [...m, ...b, ...(t || [])];
  const lo = Math.min(...all) * 0.92, span = Math.max(...all) - lo || 1;
  const xs = (i) => X0 + (i / 354) * W;
  const up = (p) => MID - 8 - ((p - lo) / span) * AMP;
  const dn = (p) => MID + 8 + ((p - lo) / span) * AMP;
  const vc = getComputedStyle(host).getPropertyValue(meta.c.slice(4, -1)).trim() || '#2f9e5f';
  const defs = el('defs', {}, svg);
  const gid = `g${Math.random().toString(36).slice(2, 8)}`;
  const g1 = el('linearGradient', { id: `${gid}a`, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el('stop', { offset: '0%', 'stop-color': vc, 'stop-opacity': 0.55 }, g1);
  el('stop', { offset: '100%', 'stop-color': vc, 'stop-opacity': 0.06 }, g1);
  const g2 = el('linearGradient', { id: `${gid}b`, x1: 0, y1: 1, x2: 0, y2: 0 }, defs);
  el('stop', { offset: '0%', 'stop-color': '#8b8678', 'stop-opacity': 0.45 }, g2);
  el('stop', { offset: '100%', 'stop-color': '#8b8678', 'stop-opacity': 0.05 }, g2);
  for (const n of [1, 50, 100, 150, 200, 250, 300, 355]) {
    el('line', { x1: xs(n - 1), x2: xs(n - 1), y1: 26, y2: 330, stroke: '#efece3' }, svg);
    el('text', { x: xs(n - 1), y: 350, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#8b8678' }, svg).textContent = n;
  }
  const upPts = m.map((p, i) => [xs(i), up(p)]);
  const dnPts = b.map((p, i) => [xs(i), dn(p)]);
  el('path', { d: `${curve(upPts)} L${xs(354)},${MID - 8} L${X0},${MID - 8} Z`, fill: `url(#${gid}a)` }, svg);
  el('path', { d: curve(upPts), fill: 'none', stroke: vc, 'stroke-width': 1.8 }, svg);
  el('path', { d: `${curve(dnPts)} L${xs(354)},${MID + 8} L${X0},${MID + 8} Z`, fill: `url(#${gid}b)` }, svg);
  el('path', { d: curve(dnPts), fill: 'none', stroke: '#8b8678', 'stroke-width': 1.5 }, svg);
  el('path', { d: curve(b.map((p, i) => [xs(i), up(p)])), fill: 'none', stroke: '#8b8678', 'stroke-width': 1, 'stroke-dasharray': '2 3', opacity: 0.8 }, svg);
  if (t) el('path', { d: curve(t.map((p, i) => [xs(i), up(p)])), fill: 'none', stroke: 'var(--bad)', 'stroke-width': 1.6, 'stroke-dasharray': '5 4' }, svg);

  const mb = bucket(r.pooled_counts, 5), bb = bucket(base.counts, 5);
  const dmax = Math.max(...mb.map((x, i) => Math.abs(x - bb[i]))) || 1;
  const bw = W / mb.length;
  const bands = [];
  // 悬停层：整列一条竖直高亮带。之前只有中间那条 10px 高的色块变描边，
  // 鼠标在曲线上方移动时几乎看不出反馈，所以改成「整个数字区间列」一起亮起来。
  const hoverLayer = el('g', { class: 'band-hover-layer' }, svg);
  const hlFill = el('rect', { x: 0, y: 24, width: Math.max(bw - 1, 2), height: 310, rx: 4, fill: vc, opacity: 0, 'pointer-events': 'none' }, hoverLayer);
  const hlEdge = el('path', { d: '', fill: 'none', stroke: vc, 'stroke-width': 2.4, 'stroke-linecap': 'round', opacity: 0, 'pointer-events': 'none' }, hoverLayer);
  const hlLabel = el('g', { opacity: 0, 'pointer-events': 'none' }, hoverLayer);
  const hlLabelBg = el('rect', { x: 0, y: 0, width: 78, height: 17, rx: 5, fill: '#14110c', opacity: 0.88 }, hlLabel);
  const hlLabelTx = el('text', { x: 0, y: 12.2, 'text-anchor': 'middle', 'font-size': 10.5, 'font-weight': 700, fill: '#faf9f5' }, hlLabel);

  mb.forEach((x, i) => {
    const diff = x - bb[i];
    const rect = el('rect', { x: X0 + i * bw, y: MID - 5, width: bw - 1, height: 10, rx: 1.5, fill: diff >= 0 ? vc : '#5d7a99', opacity: (0.12 + (0.88 * Math.abs(diff)) / dmax).toFixed(3) }, svg);
    const cx = X0 + i * bw + (bw - 1) / 2;
    // 命中区覆盖整列（从顶部标签到底部轴），鼠标只要在这个数字区间上方就能触发
    const hit = el('rect', { x: X0 + i * bw, y: 24, width: bw, height: 310, fill: 'transparent', class: 'band-hit' }, svg);
    bands.push({ rect, hit });
    bindTip(hit, `<b>${i * 5 + 1}–${Math.min(i * 5 + 5, 355)}</b><br>实测 ${(x * 100).toFixed(2)}% · 基准 ${(bb[i] * 100).toFixed(2)}%<br>${diff >= 0 ? '偏多' : '偏少'} ${(Math.abs(diff) * 100).toFixed(2)} 个百分点`, {
      onIn: () => {
        // 其它带淡化，只留当前这一列亮着 —— 一眼看出「现在指着哪一段」
        for (const b of bands) { b.rect.style.opacity = '0.1'; b.hit.style.cursor = 'crosshair'; }
        rect.style.opacity = '1';
        hlFill.setAttribute('x', X0 + i * bw);
        hlFill.setAttribute('opacity', 0.1);
        hlEdge.setAttribute('d', curve(upPts.slice(i * 5, i * 5 + 5)));
        hlEdge.setAttribute('opacity', 1);
        hlLabel.setAttribute('opacity', 1);
        const lx = Math.max(Math.min(cx, X0 + W - 40), X0 + 40);
        hlLabelBg.setAttribute('x', lx - 39);
        hlLabelTx.setAttribute('x', lx);
        hlLabelTx.textContent = `${(x * 100).toFixed(2)}%`;
      },
      onOut: () => {
        for (const b of bands) { b.rect.style.opacity = ''; b.hit.style.cursor = ''; }
        hlFill.setAttribute('opacity', 0);
        hlEdge.setAttribute('opacity', 0);
        hlLabel.setAttribute('opacity', 0);
      },
    });
  });
  const peaks = (arr) => {
    const c = arr.map((p, i) => [p, i]).filter(([p, i]) => p >= (arr[i - 1] ?? 0) && p >= (arr[i + 1] ?? 0)).sort((a, z) => z[0] - a[0]);
    const out = [];
    for (const x of c) { if (out.every((y) => Math.abs(y[1] - x[1]) >= 30)) out.push(x); if (out.length === 3) break; }
    return out;
  };
  for (const [p, i] of peaks(m)) el('text', { x: Math.max(xs(i), X0 + 40), y: Math.max(up(p) - 6, 32), 'text-anchor': 'middle', 'font-size': 10.5, 'font-weight': 700, fill: vc }, svg).textContent = i + 1;
  for (const [p, i] of peaks(b)) el('text', { x: xs(i), y: dn(p) + 14, 'text-anchor': 'middle', 'font-size': 10.5, 'font-weight': 700, fill: '#5b564c' }, svg).textContent = i + 1;
  el('text', { x: X0, y: 18, 'font-size': 11, fill: vc, 'font-weight': 600 }, svg).textContent = '▲ 实测';
  el('text', { x: X0, y: 327, 'font-size': 11, fill: '#5b564c', 'font-weight': 600 }, svg).textContent = '▼ 官方基准';

  const simRows = [r.results.find((x) => x.model === claimed), ...(showBest ? [r.results[0]] : [])];
  host.querySelector('.sims').innerHTML = simRows.map((x) => `<div class="sim-row"><span class="mono">${esc(short(x.model))} <small style="color:var(--ink-faint)">${x.model === claimed ? '声称' : '最像'}</small></span><span class="big" style="color:${x.model === r.prediction ? meta.c : 'var(--ink)'}">${(x.profile_similarity * 100).toFixed(1)}</span></div>`).join('')
    + '<p class="side-note">贴合度只看分布形状，模型之间常常只差几个点；上方报告卡里的归因概率还计入了顺序特征并扣除了环境干扰，区分力强得多。</p>';
}
/* ---------- B 指纹罗盘 ----------
 * 实测居中，库内模型围成一圈：半径 = 指纹 z 分排名（越像越近），角度只是排列 ——
 * 同家族相邻成弧，家族内按「质心两两余弦距离做 MDS」后的角度排序，让相似模型挨着。
 * 布局只依赖指纹库，算一次缓存。 */
const layoutCache = new WeakMap();
export function compassLayout(bank) {
  if (layoutCache.has(bank)) return layoutCache.get(bank);
  const C = bank.robust.hellinger.centroids;
  const n = C.length;
  const D2 = C.map((a) => C.map((b) => (1 - dot(a, b)) ** 2));
  const row = D2.map((r) => r.reduce((s, x) => s + x, 0) / n);
  const all = row.reduce((s, x) => s + x, 0) / n;
  const B = D2.map((r, i) => r.map((x, j) => -0.5 * (x - row[i] - row[j] + all)));
  const { values, vectors } = symmetricEigen(B);
  const xy = C.map((_, i) => [0, 1].map((k) => vectors[k][i] * Math.sqrt(Math.max(values[k], 0))));
  const ids = bank.models.map((m) => m.id);
  const cx = xy.reduce((s, p) => s + p[0], 0) / n, cy = xy.reduce((s, p) => s + p[1], 0) / n;
  const ang = Object.fromEntries(ids.map((id, i) => [id, Math.atan2(xy[i][1] - cy, xy[i][0] - cx)]));
  const fams = [...new Set(bank.models.map((m) => m.family || 'models'))];
  const order = [];
  for (const f of fams) {
    order.push(...bank.models.filter((m) => (m.family || 'models') === f).map((m) => m.id).sort((a, b) => ang[a] - ang[b]));
    if (fams.length > 1) order.push(null);   // 家族之间空一格
  }
  const step = (2 * Math.PI) / order.length;
  const angle = {};
  order.forEach((id, k) => { if (id) angle[id] = -Math.PI / 2 + (k + 0.5) * step; });
  // 刻度文字放在最后一个空档（家族之间）上，避免压住模型标签；单家族时放在最后一个模型之后半格
  const gapIdx = order.lastIndexOf(null);
  const gapAngle = -Math.PI / 2 + ((gapIdx >= 0 ? gapIdx : order.length - 1) + 0.5) * step + (gapIdx >= 0 ? 0 : step / 2);
  const out = { angle, step, fams, gapAngle };
  layoutCache.set(bank, out);
  return out;
}

function softmaxBeta(z, beta) {
  const m = Math.max(...z);
  const w = z.map((x) => Math.exp(beta * (x - m)));
  const t = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / t);
}

/* view.labels（可选）：每根指针的名字。采集台按环境聚合时传 12 个环境名，默认「第 N 份」。 */
export function renderCompass(host, view) {
  const { result: r, claimed, bank } = view;
  const label = (i) => view.labels?.[i] || `第 ${i + 1} 份`;
  const unit = view.unit || '份回答';
  const color = familyColor(bank);
  const { angle, step, fams, gapAngle } = compassLayout(bank);
  const famNames = Object.fromEntries(bank.models.map((m) => [m.family || 'models', m.family_name || m.family || '模型']));
  host.innerHTML = `<div class="viz-head"><div class="viz-title">指纹罗盘 · 谁离实测最近</div>
      <div class="viz-desc">实测样本居中，${bank.models.length} 个库内模型围成一圈：<b>越像的模型离圆心越近</b>（半径 = 去环境干扰后的指纹相似度排名）。彩色指针是每${unit === '份回答' ? '份回答' : '个' + unit}各自独立判定的模型——并拢指向声称模型即一致，指向别处即被替换，各指一方即分歧。</div></div>
    <div class="viz-body"><div><div class="legend">${fams.map((f) => `<span><i style="background:${color(f)};border-radius:50%"></i>${esc(famNames[f])}</span>`).join('')}
        <span><i style="background:transparent;border:2px solid #14110c;border-radius:50%"></i>声称模型</span>
        <span><i style="background:var(--ok);height:3px;width:16px;border-radius:2px"></i>指向声称</span>
        <span><i style="background:var(--bad);height:3px;width:16px;border-radius:2px"></i>指向别的模型</span></div>
      <svg class="compass-bg" viewBox="0 0 760 480" role="img" aria-label="指纹罗盘"></svg></div>
      <aside><div class="side-title">投票矩阵 · 每${unit === '份回答' ? '份回答' : '个' + unit}的独立判定</div><div class="votes"></div>
        <p class="side-note">指针只回答「更像谁」，不回答「像到什么程度」—— 程度看左上方的分布贴合度，各模型的归因概率见上方报告卡。</p></aside></div>`;
  const svg = host.querySelector('svg');
  const CX = 380, CY = 240, RIN = 66, ROUT = 190, CORE = 24;
  const z = Object.fromEntries(r.results.map((x) => [x.model, x]));
  const zs = r.results.map((x) => x.score);
  const zmax = Math.max(...zs), zmin = Math.min(...zs);
  const rad = (id) => RIN + ((zmax - z[id].score) / (zmax - zmin || 1)) ** 0.85 * (ROUT - RIN);
  const at = (id, rr = rad(id)) => [CX + rr * Math.cos(angle[id]), CY + rr * Math.sin(angle[id])];

  [0.25, 0.5, 0.75, 1].forEach((t, i) => el('circle', { cx: CX, cy: CY, r: RIN + t * (ROUT - RIN), fill: 'none', stroke: '#e7e3d8', 'stroke-dasharray': i === 3 ? '' : '2 4' }, svg));
  el('circle', { cx: CX, cy: CY, r: RIN, fill: 'none', stroke: '#d9d4c6' }, svg);
  const ring = (rr, txt) => el('text', { x: CX + rr * Math.cos(gapAngle), y: CY + rr * Math.sin(gapAngle) + 3, 'text-anchor': 'middle', 'font-size': 9.5, fill: '#8b8678' }, svg).textContent = txt;
  ring(RIN + 10, '最像');
  ring(ROUT - 10, '更不像');
  for (const f of fams) {
    const ids = bank.models.filter((m) => (m.family || 'models') === f).map((m) => m.id);
    const a0 = Math.min(...ids.map((id) => angle[id])) - step * 0.42, a1 = Math.max(...ids.map((id) => angle[id])) + step * 0.42;
    el('path', { d: arc(CX, CY, ROUT + 8, a0, a1), fill: 'none', stroke: color(f), 'stroke-width': 4, 'stroke-linecap': 'round', opacity: 0.75 }, svg);
  }
  for (const m of bank.models) {
    const [x, y] = at(m.id);
    const isC = m.id === claimed, isP = m.id === r.prediction;
    const a = angle[m.id];
    // 指向该模型的射线：悬停时加粗变色，作为「现在指着这一根」的第一眼线索
    const spoke = el('line', { x1: CX + RIN * Math.cos(a), y1: CY + RIN * Math.sin(a), x2: CX + ROUT * Math.cos(a), y2: CY + ROUT * Math.sin(a), stroke: '#efece3', 'stroke-width': 1 }, svg);
    const g = el('g', {}, svg);
    // 悬停环：默认不可见，hover 时撑开成脉冲圈。SVG 里做不了 CSS :hover 的兄弟选择器动画，
    // 所以圆点本身要有个明显变化的「选中态」，否则鼠标扫过去图上毫无动静。
    const halo = el('circle', { cx: x, cy: y, r: isP ? 13 : 11, fill: color(m.family), opacity: 0, class: 'dot-halo' }, g);
    if (isP) el('circle', { cx: x, cy: y, r: 13, fill: color(m.family), opacity: 0.18 }, g);
    const dot = el('circle', { cx: x, cy: y, r: isP || isC ? 6.5 : 4.5, fill: color(m.family), stroke: '#fff', 'stroke-width': 1.8 }, g);
    if (isC) el('circle', { cx: x, cy: y, r: 10.5, fill: 'none', stroke: '#14110c', 'stroke-width': 1.6 }, g);
    const [lx, ly] = at(m.id, ROUT + 20);
    const c = Math.cos(a);
    const t = el('text', { x: lx, y: ly + 3.5, 'text-anchor': Math.abs(c) < 0.06 ? 'middle' : c > 0 ? 'start' : 'end', 'font-size': isC || isP ? 11 : 10, 'font-weight': isC || isP ? 700 : 400, fill: isC || isP ? '#14110c' : '#8b8678' }, g);
    t.textContent = tiny(m.id) + (isC ? ' · 声称' : '');
    bindTip(g, `<b>${esc(m.id)}</b><br>归因概率 ${pct(z[m.id].probability)} · 分布贴合度 ${(z[m.id].profile_similarity * 100).toFixed(1)}`, {
      onIn: () => {
        halo.setAttribute('r', isP ? 17 : 15);
        halo.setAttribute('opacity', 0.26);
        dot.setAttribute('r', isP || isC ? 8.5 : 7);
        dot.setAttribute('stroke-width', 2.4);
        dot.setAttribute('filter', 'drop-shadow(0 2px 3px rgba(20,17,12,.28))');
        spoke.setAttribute('stroke', color(m.family));
        spoke.setAttribute('stroke-width', 2);
        spoke.setAttribute('opacity', 0.5);
        t.setAttribute('font-size', 12);
        t.setAttribute('font-weight', 700);
        t.setAttribute('fill', '#14110c');
        g.style.cursor = 'pointer';
      },
      onOut: () => {
        halo.setAttribute('r', isP ? 13 : 11);
        halo.setAttribute('opacity', 0);
        dot.setAttribute('r', isP || isC ? 6.5 : 4.5);
        dot.setAttribute('stroke-width', 1.8);
        dot.removeAttribute('filter');
        spoke.setAttribute('stroke', '#efece3');
        spoke.setAttribute('stroke-width', 1);
        spoke.removeAttribute('opacity');
        t.setAttribute('font-size', isC || isP ? 11 : 10);
        t.setAttribute('font-weight', isC || isP ? 700 : 400);
        t.setAttribute('fill', isC || isP ? '#14110c' : '#8b8678');
        g.style.cursor = '';
      },
    });
  }
  // 指针：同一目标的指针在该模型扇区内均匀铺开；超过 4 根（采集台的 12 个环境）合成一根粗指针 + 计数，
  // 不然十几根线叠成一团，反而看不出「全部指向同一个」。
  const groups = new Map();
  r.responses.forEach((resp, i) => { if (!groups.has(resp.top)) groups.set(resp.top, []); groups.get(resp.top).push(i); });
  for (const [top, idxs] of groups) {
    const col = top === claimed ? 'var(--ok)' : 'var(--bad)';
    const len = rad(top) - (idxs.length > 4 ? 22 : 12);   // 粗指针端点更大，多退一点免得盖住模型点
    const tipHtml = idxs.map((i) => `${esc(label(i))} · ${r.responses[i].parsed} 个数字 · ${pct(r.responses[i].probability)}`).join('<br>');
    const draw = (a, txt, width, rr) => {
      const x2 = CX + len * Math.cos(a), y2 = CY + len * Math.sin(a);
      const g = el('g', {}, svg);
      const line = el('line', { x1: CX + CORE * Math.cos(a), y1: CY + CORE * Math.sin(a), x2, y2, stroke: col, 'stroke-width': width, 'stroke-linecap': 'round' }, g);
      const head = el('circle', { cx: x2, cy: y2, r: rr, fill: col, stroke: '#fff', 'stroke-width': 1.5 }, g);
      const badge = el('text', { x: x2, y: y2 + 3.5, 'text-anchor': 'middle', 'font-size': 9.5, 'font-weight': 700, fill: '#fff' }, g);
      badge.textContent = txt;
      // 悬停反馈：指针加粗、端点放大并加投影，一眼看出「这是第几份回答」
      const set = (on) => {
        line.setAttribute('stroke-width', on ? width * 1.9 : width);
        head.setAttribute('r', on ? rr + 3 : rr);
        head.setAttribute('filter', on ? 'drop-shadow(0 2px 4px rgba(20,17,12,.32))' : '');
        g.style.cursor = on ? 'pointer' : '';
      };
      return { g, set };
    };
    if (idxs.length > 4) {
      const { g, set } = draw(angle[top], `×${idxs.length}`, 6, 12);
      bindTip(g, `<b>${idxs.length} 个都判定为 ${esc(top)}</b><br>${tipHtml}`, { onIn: () => set(true), onOut: () => set(false) });
    } else {
      const spread = Math.min(step * 0.7, 0.075 * (idxs.length - 1));
      idxs.forEach((i, k) => {
        const a = angle[top] + (idxs.length > 1 ? (k / (idxs.length - 1) - 0.5) * spread : 0);
        const { g, set } = draw(a, String(i + 1), 3, 8);
        bindTip(g, `<b>第 ${i + 1} 份</b> · ${r.responses[i].parsed} 个数字<br>独立判定：${esc(top)}（${pct(r.responses[i].probability)}）`, { onIn: () => set(true), onOut: () => set(false) });
      });
    }
  }
  el('circle', { cx: CX, cy: CY, r: CORE, fill: '#14110c' }, svg);
  el('text', { x: CX, y: CY - 2, 'text-anchor': 'middle', 'font-size': 10, fill: '#faf9f5', 'font-weight': 700 }, svg).textContent = '实测';
  el('text', { x: CX, y: CY + 11, 'text-anchor': 'middle', 'font-size': 9, fill: '#c9c3b4' }, svg).textContent = `${r.responses.length} ${unit === '份回答' ? '份' : '个'}`;

  // 投票矩阵：行 = 每份回答，列 = Top 候选（声称模型保证在列里）
  //
  // ⚠️ 只取 3 列。原先取 4 列，在 266px 的侧栏里每格被压到 39.7px —— 而「99.8%」
  // 这个字符串在 10.5px 等宽字体下就要 40px，于是每格都溢出、文字被裁成半截
  //（页面上看着是「挤到一块」）。列数由 CSS 侧栏宽度反推：3 列时每格 ≈ 70px，
  // 百分比、表头短名都放得下且留有余量。声称模型若本来不在前三名，
  // 顶上第 3 列（不给第 4 个位置，就是为了保住这个宽度）。
  const cols = r.results.slice(0, 3).map((x) => x.model);
  if (!cols.includes(claimed)) cols[2] = claimed;
  const idx = Object.fromEntries(bank.models.map((m, i) => [m.id, i]));
  const beta1 = Number(bank.calibration['1'].beta);
  // 首列宽度：只有采集台（view.labels = 环境名）需要 92px；前台标签是「第 1 份」，
  // 44px 就够 —— 早先不分场景一律 92px，白占了侧栏三分之一宽度，也是矩阵挤的一个来源。
  // 列标题是模型名，短名放不下时靠 CSS 省略号收尾，绝不允许折行 ——
  // 折一次整个矩阵的表头会变成两层，行高对不齐。
  const tmpl = `${view.labels ? 92 : 44}px repeat(${cols.length}, minmax(0, 1fr))`;
  const famOf = Object.fromEntries(bank.models.map((m) => [m.id, m.family]));
  host.querySelector('.votes').innerHTML = `<div class="votes-row votes-head" style="grid-template-columns:${tmpl}"><span></span>${cols.map((id) => `<span title="${esc(id)}" class="vh-name${id === claimed ? ' claimed' : ''}"><i class="vh-id">${esc(tiny(id))}</i>${id === claimed ? '<em>声称</em>' : ''}</span>`).join('')}</div>`
    + r.responses.map((resp, i) => {
      const p = softmaxBeta(resp.scores, beta1);
      return `<div class="votes-row" style="grid-template-columns:${tmpl}"><span class="votes-label" title="${esc(label(i))}">${esc(label(i))}</span>${cols.map((id) => {
        const pp = p[idx[id]];
        const mix = Math.round((0.05 + 0.95 * Math.sqrt(pp)) * 100);
        return `<span class="votes-cell" title="${pct(pp)}" style="color:${pp > 0.45 ? '#fff' : 'var(--ink-soft)'};background:color-mix(in srgb, ${color(famOf[id])} ${mix}%, #faf9f5)">${pp >= 0.01 ? pct(pp) : '·'}</span>`;
      }).join('')}</div>`;
    }).join('');
}

/* =====================================================================
 * 只读报告卡 —— 历史详情弹窗 / 分享报告共用的渲染
 * ---------------------------------------------------------------------
 * 输入是 store.buildSnapshot() 存下来的快照，不是实时的 analyzeOutputs 结果：
 *   - 弹窗要在**没有指纹库、没有重新请求**的前提下把结论复现出来；
 *   - 快照里只有 Top 候选的概率，没有 355 维分布，所以这里不画叠印图，
 *     只把「结论 + 概率 + 各份回答判定 + 候选排名」摆清楚。原图仍在页面上（如果刚跑完）。
 *
 * opts.shared：这份卡是渲染在**分享出去的**报告页上还是本机弹窗里。
 *   页脚那句「数据仅存在于你自己的浏览器」在分享页上就是假的（那份报告正在服务器上），
 *   所以分享页必须换一句 —— 页脚会跟着导出 PNG 一起传播，不能靠"用户在站内自然理解"糊过去。
 * ===================================================================== */
const VERDICT_META = {
  match: { t: '与声称模型一致', c: 'var(--ok)', s: 'var(--ok-soft)', icon: ICON.match },
  mismatch: { t: '疑似被换成其他模型', c: 'var(--bad)', s: 'var(--bad-soft)', icon: ICON.mismatch },
  split: { t: '三份回答指向不同模型', c: 'var(--warn)', s: 'var(--warn-soft)', icon: ICON.split },
  inconclusive: { t: '证据不足，无法下结论', c: 'var(--warn)', s: 'var(--warn-soft)', icon: ICON.inconclusive },
};
const FAMILY_COLOR_SNAPSHOT = (fam) => FAMILY_COLORS[fam] || FALLBACK_COLORS[0];

export function renderSnapshotCard(snap, opts = {}) {
  const meta = VERDICT_META[snap.verdict?.code] || VERDICT_META.inconclusive;
  const site = opts.site || 'aabao.ai/modeltrace';
  const when = (() => {
    try {
      const d = new Date(snap.savedAt);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch { return String(snap.savedAt || ''); }
  })();
  const claimedShort = short(snap.claimed || snap.model || '');
  const predShort = short(snap.prediction || '');
  const changed = snap.prediction && snap.prediction !== snap.claimed;

  /* 检测站点显示什么：分享者选了「仅域名」就是域名，选了「不显示地址」后端会把地址
   * 落成空串 —— 走这里 `|| '—'` 的兜底链渲染成破折号。旧口径（完整地址）已下线，
   * 但线上早先发出的链接里 u 仍是完整 URL，endpoint 因此仍要认。 */
  const hostText = snap.endpoint || snap.host || '—';

  /* 副标题：一句话说清「声称什么、实测什么」 */
  let sub;
  if (snap.verdict?.code === 'match') sub = `${snap.usedOutputs || 0} 份回答全部指向声称模型，归因概率 ${pct(snap.prob ?? 0)}`;
  else if (snap.verdict?.code === 'mismatch') sub = `声称 ${claimedShort}，实测最像 ${predShort}（${snap.verdict.sameFamily ? '同家族内的另一个型号' : '跨家族替换'}）`;
  else if (snap.verdict?.code === 'split') sub = `各份回答分别像 ${(snap.responses || []).map((x) => short(x.top)).join(' / ')}`;
  else sub = `声称 ${claimedShort}，最像 ${predShort}，差距不足以判定`;

  const responses = (snap.responses || []).map((x) => `
    <div class="rs-row">
      <span class="rs-n">第 ${x.index + 1} 份</span>
      <span class="rs-num">${x.parsed} 个数字</span>
      <span class="rs-top" title="${esc(x.top)}">${esc(short(x.top))}</span>
      <span class="rs-p">${pct(x.probability)}</span>
    </div>`).join('');

  const rankRows = (snap.rank || []).map((x, i) => `
    <div class="rk-row">
      <span class="rk-i">${i + 1}</span>
      <span class="rk-name" title="${esc(x.model)}">${esc(short(x.model))}${x.model === snap.claimed ? '<em>声称</em>' : ''}</span>
      <span class="rk-p">${pct(x.probability)}</span>
      <span class="rk-track"><i style="width:${Math.max(x.probability * 100, 0.6)}%;background:${FAMILY_COLOR_SNAPSHOT(x.family)};opacity:${i === 0 ? 1 : 0.45}"></i></span>
    </div>`).join('');

  return `
  <div class="rc-inner" style="--vc:${meta.c};--vs:${meta.s}">
    <div class="rc-brand">
      <div class="rc-brand-id">
        <svg class="rc-logo" viewBox="0 0 24 24" fill="none" aria-hidden="true"><defs><linearGradient id="rcg" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#4285F4"/><stop offset="33%" stop-color="#9B72CB"/><stop offset="66%" stop-color="#EA4986"/><stop offset="100%" stop-color="#FF8A3D"/></linearGradient></defs><path d="M12 1.6 20.4 4.9V11c0 5.3-3.6 9.4-8.4 11.3C7.2 20.4 3.6 16.3 3.6 11V4.9Z" fill="url(#rcg)"/><path d="M8 12.1l2.7 2.7L16.2 9" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <div>
          <div class="rc-name">大模型归因检测报告</div>
          <div class="rc-slogan">凭第一反应写的 300 个数字，就能认出背后是哪个模型</div>
        </div>
      </div>
      <div class="rc-when">${esc(when)}</div>
    </div>

    <div class="rc-verdict">
      <div class="rc-seal">${meta.icon}</div>
      <div class="rc-vmain">
        <div class="rc-vtitle">${meta.t}</div>
        <div class="rc-vsub">${sub}</div>
      </div>
      <div class="rc-vprob">
        <div class="rc-k">声称模型归因概率</div>
        <div class="rc-v" style="color:${meta.c}">${pct(snap.prob ?? 0)}</div>
      </div>
    </div>

    <div class="rc-grid">
      <div class="rc-cell"><div class="rc-k">检测站点</div><div class="rc-v2 mono">${esc(hostText)}</div></div>
      <div class="rc-cell"><div class="rc-k">检测模型</div><div class="rc-v2 mono">${esc(snap.model || snap.claimed || '—')}${snap.variant ? `<span class="rc-tag">${esc(snap.variant)}</span>` : ''}</div></div>
      <div class="rc-cell"><div class="rc-k">实测最像</div><div class="rc-v2 mono" style="${changed ? `color:${meta.c}` : ''}">${esc(predShort || '—')}</div></div>
      <div class="rc-cell"><div class="rc-k">分布贴合度</div><div class="rc-v2">${snap.similarity == null ? '—' : (snap.similarity * 100).toFixed(1)}</div></div>
    </div>

    <div class="rc-two">
      <div class="rc-block">
        <div class="rc-btitle">各份回答的独立判定</div>
        ${responses || '<p class="rc-muted">无记录</p>'}
      </div>
      <div class="rc-block">
        <!-- 叫「归因概率」而不是「候选模型排名」：这一栏就是本站的原理本身 ——
             每个库内模型拿到多少归因概率，看到它就知道结论怎么来的。
             原先两个分布图的侧栏各复制了一份同样的榜单，三处重复把图挤小又分散注意力，
             现在只留这一处，两张图的侧栏改说各自独有的东西（贴合度 / 投票矩阵）。 -->
        <div class="rc-btitle">归因概率</div>
        <div class="rk-list">${rankRows || '<p class="rc-muted">无记录</p>'}</div>
      </div>
    </div>

    <div class="rc-foot">
      <span>${snap.usedOutputs || 0} 份有效回答 · 共 ${snap.totalNumbers || 0} 个数字 · 接口 ${esc(snap.formatName || '—')}${snap.viaProxy ? ' · 经流式中转' : ''}</span>
      <span>${snap.partial ? '⚠ 未凑满 3 份有效回答，结论可靠性低于完整检测' : ''}</span>
    </div>
    <div class="rc-note">本结果是统计推断，不是证据；受模型版本、服务端参数与样本量影响，不能作为退款或纠纷的依据。检测由 <b>${esc(site)}</b> 生成 · ${opts.shared ? '这份报告由分享者上传，仅含一次归因的结论' : '数据仅存在于你自己的浏览器'}</div>
  </div>`;
}
