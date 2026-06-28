/* =====================================================================
 * report.js —— 分享报告查看页（只读）
 * 支持两种来源：?id=xxx（后端短链）/ #data=base64（静态分享）
 * ===================================================================== */
import * as core from './core.js?v=7';

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
    document.body.innerHTML = '<div class="wrap"><div class="card">报告不存在或链接已失效。<a href="index.html">去检测</a></div></div>';
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

  // 探针明细
  const box = $('#cards');
  for (const r of report.results || []) {
    box.appendChild(buildCard(r));
  }

  // 按钮
  $('#pngBtn').onclick = () => core.exportPng($('#reportArea'), `检测报告-${report.model || ''}.png`);
  $('#copyBtn').onclick = async () => { try { await navigator.clipboard.writeText(location.href); alert('链接已复制'); } catch { prompt('复制此链接：', location.href); } };
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
    </div>`;
  return card;
}

load();
