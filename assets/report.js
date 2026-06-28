/* =====================================================================
 * report.js —— 分享报告查看页（只读）
 * 支持两种来源：?id=xxx（后端短链）/ #data=base64（静态分享）
 * ===================================================================== */
import * as core from './core.js?v=15';

const $ = (s) => document.querySelector(s);

async function load() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  let report = null, brand = null;

  if (id) {
    // 后端短链
    try {
      const r = await fetch(`./api/share.php?id=${encodeURIComponent(id)}`);
      const j = await r.json();
      if (j.ok) { report = j.report; brand = j.report.brand; }
    } catch { /* fall through */ }
  }
  if (!report && location.hash.startsWith('#data=')) {
    // 静态分享
    try {
      const packed = location.hash.slice(6);
      report = JSON.parse(decodeURIComponent(escape(atob(packed))));
    } catch { /* ignore */ }
  }
  if (!report) {
    document.body.innerHTML = '<div class="wrap"><div class="card">报告不存在或链接已失效。<a href="index">去检测</a></div></div>';
    return;
  }
  render(report, brand);
}

function render(report, brand) {
  // 品牌位（后端注入的最新品牌；静态分享无 brand 时用默认）
  if (brand) {
    $('#brandName').textContent = brand.name || 'AI 检测站';
    $('#brandSlogan').textContent = brand.slogan || '';
    const u = $('#brandUrl');
    u.textContent = brand.url || ''; u.href = brand.url || '#';
    $('#reportFooter').innerHTML = `本报告由 <b>${core.esc(brand.name || 'AI 检测站')}</b> 生成` + (brand.url ? ` · <a href="${core.esc(brand.url)}" target="_blank">${core.esc(brand.url)}</a>` : '');
  } else {
    $('#reportFooter').textContent = '本报告由 AI 检测站生成';
  }

  $('#reportMeta').textContent = `检测报告 · ${(report.savedAt || '').slice(0, 10)}`;

  // 总览
  const total = report.totalScore || 0;
  const level = total >= 85 ? 'excellent' : total >= 70 ? 'pass' : total >= 50 ? 'marginal' : 'fail';
  const colors = { excellent: 'var(--pass)', pass: 'var(--pass)', marginal: 'var(--warn)', fail: 'var(--fail)' };
  $('#ring').style.setProperty('--val', total);
  $('#ring').style.setProperty('--col', colors[level]);
  $('#ringScore').textContent = total;
  $('#ovVerdict').textContent = report.verdict || '—';
  const chCode = channelCode(report.channel);
  $('#ovChannel').className = 'badge ' + chCode;
  $('#ovChannel').textContent = report.channel || '未知';
  $('#ovModel').textContent = `协议 ${report.protocol || ''} · 模型 ${report.model || ''} · ${report.targetHost || ''}`;
  if (report.critical) $('#critBanner').style.display = '';
  if (report.summary) { $('#summaryBox').style.display = ''; $('#summaryBox').textContent = report.summary; }

  // 探针明细：问题项置顶全展开，正常项收成可折叠的一行
  renderResults(report.results || []);

  // 按钮
  $('#pngBtn').onclick = () => core.exportPng($('#reportArea'), `检测报告-${report.model || ''}.png`);

  // 「复制本页链接」统一走 shareReport 重新生成干净短链 .../report?id=xxx：
  // 不复制 location.href（它带不带 .html 取决于当前页 URL，会污染分享链接），
  // 这样无论当前页 URL 长啥样、是否在 iframe 内、历史快照有无后端 id，复制出来永远干净。
  $('#copyBtn').onclick = () => copyShortLink(report);

  // 在 iframe 内（检测历史「查看详情」弹窗）：本来就在检测站内，「去检测」多余 → 隐藏
  if (window.self !== window.top) {
    const goto = $('#gotoCheckBtn');
    if (goto) goto.style.display = 'none';
  }

  // 底部二维码：扫码看这份报告（后端短链）/ 退化时退首页，方便手机端长按识别自测
  buildQrBlock(report, brand);
}

/* 复制干净短链：调 shareReport 重新生成 .../report?id=xxx，失败退化为静态长链。 */
async function copyShortLink(report) {
  const btn = $('#copyBtn');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ 生成链接…';
  try {
    const r = await core.shareReport(report);   // 优先后端短链；不可写时退化 #data=
    const url = r.url;
    try { await navigator.clipboard.writeText(url); }
    catch { prompt('复制此链接：', url); }
    btn.textContent = r.mode === 'short' ? '✅ 短链接已复制' : '✅ 链接已复制';
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1800);
  } catch {
    btn.textContent = old; btn.disabled = false;
    alert('生成链接失败，请稍后再试。');
  }
}

/* ---------------- 底部二维码块 ----------------
 * 内容 = 这份报告的分享短链（扫码即看完整报告，传播钩子最强）。
 * 退化保护：若只能生成超长 #data= 静态链（后端不可写），URL 太长会让二维码点阵过密、
 * 手机扫不出来 → 自动改成指向首页（SITE_URL，短 URL 保证可扫）。
 * 稳定性：qrcodejs 在 Android 会把 canvas 异步转 <img>，html2canvas 截图可能时序不稳；
 * 因此生成后取 canvas.toDataURL() 转成静态 <img> 放进报告区，导出 PNG 时截的是已画好的静态图。 */
const SITE_FALLBACK = 'https://www.aabao.ai/check';

async function buildQrBlock(report, brand) {
  const block = $('#qrBlock');
  const holder = $('#qrCode');
  if (!block || !holder || typeof window.QRCode !== 'function') return;

  // 1) 决定二维码内容：优先这份报告的短链；退化长链则改指首页
  let qrUrl = brand?.url || SITE_FALLBACK;
  let toReport = false;
  try {
    const r = await core.shareReport(report);
    if (r.mode === 'short') { qrUrl = r.url; toReport = true; }   // 短链才指向报告
    // hash 退化（超长）→ 维持指向首页，避免糊码
  } catch { /* 用首页兜底 */ }

  // 2) 用 qrcodejs 画到临时容器，再转成静态 img（避开 html2canvas 的 canvas/异步时序坑）
  const tmp = document.createElement('div');
  // eslint-disable-next-line no-new
  new window.QRCode(tmp, {
    text: qrUrl, width: 132, height: 132,
    colorDark: '#14110c', colorLight: '#ffffff',
    correctLevel: window.QRCode.CorrectLevel.M,
  });
  // qrcodejs 同步在 tmp 里建 canvas；等一帧确保已绘制，再转静态 data URI
  await new Promise((res) => setTimeout(res, 60));
  const canvas = tmp.querySelector('canvas');
  let dataUri = '';
  try { dataUri = canvas ? canvas.toDataURL('image/png') : (tmp.querySelector('img')?.src || ''); } catch { dataUri = ''; }
  if (!dataUri) return;

  holder.innerHTML = `<img src="${dataUri}" width="132" height="132" alt="扫码查看检测报告">`;
  const hint = $('#qrHint');
  if (hint) {
    hint.innerHTML = toReport
      ? '📱 扫码查看这份完整检测报告<br><span class="qr-sub">中转站掺假 / 协议篡改 / 能力降级，一键鉴别 · aabao.ai/check</span>'
      : '📱 扫码自测你的 API 中转站真伪<br><span class="qr-sub">掺假冒充 / 协议篡改 / 能力降级，一键鉴别 · aabao.ai/check</span>';
  }
  block.style.display = '';
}

/* 把一个结果分到「问题 / 正常」两类，并给出排序权重（数字越大越严重、越靠前）。 */
function tierOf(r) {
  if (r.severity === 'critical') return { bad: true, rank: 4, cls: 'crit' };
  if (r.status === 'error') return { bad: true, rank: 3, cls: 'warn' };
  const s = r.score;
  if (s == null || r.status === 'skip') return { bad: false, rank: 0, cls: 'skip' }; // 跳过/不适用按正常归类
  if (s < 40) return { bad: true, rank: 3, cls: 'fail' };
  if (s < 70) return { bad: true, rank: 2, cls: 'warn' };
  return { bad: false, rank: 1, cls: 'pass' };
}

function renderResults(results) {
  const box = $('#cards');
  box.innerHTML = '';

  const tagged = results.map((r) => ({ r, t: tierOf(r) }));
  const bad = tagged.filter((x) => x.t.bad).sort((a, b) => b.t.rank - a.t.rank);
  const good = tagged.filter((x) => !x.t.bad);

  // 顶部状态条：一眼看到「几个问题 / 几个正常」
  const bar = document.createElement('div');
  bar.className = 'report-statbar';
  bar.innerHTML = bad.length
    ? `<span class="sb-bad">⚠️ ${bad.length} 项需关注</span><span class="sb-ok">✅ ${good.length} 项正常</span>`
    : `<span class="sb-allok">✅ 全部 ${good.length} 项检测正常，未发现异常</span>`;
  box.appendChild(bar);

  // 问题项：置顶、全展开（复用原卡片）
  for (const { r } of bad) box.appendChild(buildCard(r));

  // 正常项：折叠区，逐条一行，点击才展开特征/差异
  if (good.length) {
    const wrap = document.createElement('div');
    wrap.className = 'card slim-group';
    wrap.innerHTML = `<div class="slim-group-title">✅ 正常检测项（${good.length}）<span class="muted">逐项均未发现异常，点击可展开细节</span></div>`;
    for (const { r } of good) wrap.appendChild(buildSlimRow(r));
    box.appendChild(wrap);
  }
}

/* 正常项的紧凑一行：用原生 <details> 折叠，默认只显示「名称 + 分数」。 */
function buildSlimRow(r) {
  const d = document.createElement('details');
  d.className = 'probe-slim';
  const score = (r.status === 'skip' || r.score == null) ? '不适用' : r.score;
  const hasDetail = (r.features || []).length || (r.diffs || []).length;
  const ioHtml = buildIoBlock(r.io);
  d.innerHTML = `
    <summary>
      <span class="slim-tick">✅</span>
      <span class="slim-name">${core.esc(r.name)}</span>
      <span class="slim-score">${score}</span>
    </summary>
    ${hasDetail ? `
    <div class="pc-analysis" style="display:grid">
      <div class="feats"><div class="feat-title">🔍 特征</div><ul>${(r.features || []).map((f) => `<li>${core.esc(f)}</li>`).join('') || '<li class="muted">无</li>'}</ul></div>
      <div class="diffs"><div class="feat-title">差异</div><ul>${(r.diffs || []).map((x) => `<li>${core.esc(x)}</li>`).join('') || '<li class="muted">无</li>'}</ul></div>
    </div>` : ''}
    ${ioHtml}`;
  return d;
}

/* ---------------- 请求体 / 响应体 可展开区 ----------------
 * 让用户进报告页能点开看真实请求/响应，便于自查取证（尤其异常项）。
 * 标 class="io-skip-png"：导出 PNG 时 core.exportPng 会识别并隐藏它，PNG 不含 body。 */
function buildIoBlock(io) {
  if (!io) return '';
  const reqHtml = io.request != null
    ? `<div class="io-sec"><div class="io-label">📤 请求体</div><pre class="io-pre">${core.esc(core.pretty(io.request))}</pre></div>`
    : '';
  let respHtml = '';
  if (io.rounds && io.rounds.length) {
    // 多轮：逐轮展示
    respHtml = io.rounds.map((r) =>
      `<div class="io-sec"><div class="io-label">📥 ${core.esc(r.label || '响应')}${r.httpStatus != null ? ` · HTTP ${r.httpStatus}` : ''}</div><pre class="io-pre">${core.esc(core.pretty(r.body) || '(空响应)')}</pre></div>`
    ).join('');
  } else if (io.response != null) {
    respHtml = `<div class="io-sec"><div class="io-label">📥 响应体${io.httpStatus != null ? ` · HTTP ${io.httpStatus}` : ''}</div><pre class="io-pre">${core.esc(core.pretty(io.response) || '(空响应)')}</pre></div>`;
  }
  if (!reqHtml && !respHtml) return '';
  return `<details class="io-detail io-skip-png">
    <summary>📄 查看请求体 / 响应体（用于自查取证）</summary>
    <div class="io-body">${reqHtml}${respHtml}</div>
  </details>`;
}

function channelCode(ch) {
  if (!ch) return 'unknown';
  if (ch.includes('Claude Code')) return 'claudecode';
  if (ch.includes('Anthropic')) return 'anthropic';
  if (ch.includes('Bedrock')) return 'bedrock';
  if (ch.includes('Vertex')) return 'vertex';
  if (ch.includes('套壳') || ch.includes('非官方')) return 'foreign';
  return 'unknown';
}

function buildCard(r) {
  const card = document.createElement('div');
  const cls = r.severity === 'critical' ? 'crit'
    : (r.score >= 70 ? 'pass' : r.score >= 40 ? 'warn' : (r.status === 'skip' ? 'skip' : 'fail'));
  card.className = 'card probe-card ' + cls;
  const badge = r.status === 'skip' ? '⏭ 跳过' : (r.score >= 70 ? `✅ ${r.score}` : r.score >= 40 ? `⚠ ${r.score}` : `❌ ${r.score}`);
  card.innerHTML = `
    <div class="pc-head">
      <span class="name">${core.esc(r.name)}</span>
      <span class="weight">权重 ${r.weight ?? '-'}</span>
      <span class="vbadge ${cls}">${badge}</span>
    </div>
    <div class="pc-analysis" style="display:grid">
      <div class="feats"><div class="feat-title">🔍 特征</div><ul>${(r.features || []).map((f) => `<li>${core.esc(f)}</li>`).join('') || '<li class="muted">无</li>'}</ul></div>
      <div class="diffs"><div class="feat-title">⚠️ 差异</div><ul>${(r.diffs || []).map((d) => `<li>${core.esc(d)}</li>`).join('') || '<li class="muted">无</li>'}</ul></div>
    </div>
    ${buildIoBlock(r.io)}`;
  return card;
}

load();
