/* =====================================================================
 * assets/report.js —— 归因报告分享页（只读）
 * ---------------------------------------------------------------------
 * 数据来源有两个：
 *   ?id=xxx                      分享快照（后端存的），由 store.createShare() 上传时生成
 *   data/bank/unified_bank.json  指纹库，静态文件、随仓库提交
 *
 * 报告卡直接渲染快照；两个分布图（指纹叠印 / 指纹罗盘）**用快照里的原始数字 + 当前
 * 指纹库重算**。渲染编排在 assets/charts.js —— 站内弹窗（app.js）用的是同一份，
 * 所以「分享页有图、本机弹窗没图」那种不一致不会再出现。
 *
 * 为什么用「重算」而不是把算好的图存进快照：库会更新（加模型、重建质心），派生数据
 * 的下标与当时的库绑定，用新库渲染就错位；存原始数字则永远能重算。快照里的 bb
 * （建库时间）用来在图旁标出基准版本 —— 库更新后旧分享的图形与当初略有差异时，
 * 读者看得出原因。
 *
 * 页面本身不含检测逻辑，也不引入新的渲染实现：图与站内用的是同一对函数
 * （viz.js 的 renderOverlay / renderCompass），改一处两边同步。
 * ===================================================================== */
import { renderSnapshotCard, esc } from './viz.js?v=13';
import { readShare, readSnapshot, isShareRetryable, shareIdFromUrl, SITE_LABEL } from './store.js?v=13';
import { renderCharts, chartNote } from './charts.js?v=13';
import { exportPng } from './png.js?v=13';

const $ = (s) => document.querySelector(s);

/** 两张分布图的渲染 promise。
 *  导出 PNG 前必须 await 它 —— 图要等指纹库 fetch 回来才画得出来，
 *  用户一点导出就截图会截到空图框。renderCharts 在每一条返回路径上都 resolve，
 *  所以这里等下去一定会有结果，不会挂住。 */
let chartsReady = Promise.resolve();

/** 分享页的按钮只有两个：复制链接、导出图片 —— 都在页面顶部。
 *  导出截的是 #reportHost 整块（报告卡 + 两张图 + 二维码），与链接打开所见一致，
 *  顶部这排按钮在容器外，天然不会被截进去。 */
function fail(message, { retry = false } = {}) {
  $('#reportHost').innerHTML = `<div class="share-missing">
    <h1>这份报告打不开</h1>
    <p>${esc(message)}</p>
    <div class="share-missing-acts">
      ${retry ? '<button class="btn btn-ghost" id="retryBtn" type="button">重试</button>' : ''}
      <a class="btn btn-accent" href="./" style="text-decoration:none">去归因检测</a>
    </div>
  </div>`;
  if (retry) $('#retryBtn').onclick = () => { $('#reportHost').innerHTML = '<div class="share-loading">正在读取报告…</div>'; load(); };
}

async function load() {
  const id = shareIdFromUrl(location.href);
  if (!id) {
    fail('链接里没有报告编号。完整链接形如 /s/xxxxxxxx，可能是在复制过程中被截断了。');
    return;
  }
  let raw;
  try {
    raw = await readShare(id);
  } catch (e) {
    const msg = e?.message || '报告读取失败。';
    // 只有「重试可能有用」的失败才给重试按钮 —— 编号不对 / 报告不存在，再点多少次都一样
    fail(msg, { retry: isShareRetryable(msg) });
    return;
  }
  // 后端存的是短名字段（与前端 buildSnapshot 同一套），渲染前统一翻译成长名。
  // ⚠️ 必须 forceRaw：后端落盘一定带 savedAt / 格式版本号，readSnapshot 的哨兵判断
  // 会把它误判成长名格式，翻译整段跳过 —— 表现就是结论空白、只报「报告内容不完整」。
  const snap = readSnapshot(raw, { forceRaw: true });
  if (!snap || !snap.verdict) { fail('报告内容不完整。'); return; }
  render(snap);
}

function render(snap) {
  document.title = `大模型归因报告 · ${snap.model || snap.claimed || ''} · Aabao.AI`;
  const host = $('#reportHost');
  // 图容器先占位：数据要等指纹库到齐才能算出来，算的过程中这里是隐藏的。
  host.innerHTML = `<div class="report-card">${renderSnapshotCard(snap, { site: SITE_LABEL, shared: true })}</div>
    <div class="report-charts" id="chartHost" hidden>
      <div class="viz" id="vizOverlay"></div>
      <div class="viz" id="vizCompass"></div>
      <div class="chart-note" id="chartNote"></div>
    </div>
    <div class="qr-block">
      <div class="qr-code" id="qrCode"></div>
      <div class="qr-text" id="qrHint"></div>
    </div>`;
  $('#shareActions').hidden = false;
  $('#copyBtn').onclick = copyThisLink;
  $('#pngBtn').onclick = () => exportImage(snap);

  // 二维码扫的就是本页地址 —— 短链只有几十字符，任何机型都扫得动，
  // 不再需要原先「太长就退化成站址」那套补救。
  drawQr(host.querySelector('#qrCode'), location.href);
  const hint = host.querySelector('#qrHint');
  if (hint) {
    hint.innerHTML = `📱 扫码查看这份归因报告<br><span class="qr-sub">让模型随手写 300 个数字就能认出背后是谁 · ${esc(SITE_LABEL)}</span>`;
  }

  // 图表编排交给共享模块；无论成不成都 resolve，导出前 await 它不会挂住。
  chartsReady = renderCharts({ snap, overlaySel: '#vizOverlay', compassSel: '#vizCompass' })
    .then((r) => {
      if (!r.ok) return r;
      const note = $('#chartNote');
      if (note) note.textContent = chartNote(snap.bankBuiltAt);
      $('#chartHost').hidden = false;
      return r;
    });
}

/**
 * 导出 PNG。
 *
 * 截的是 `#reportHost` 整块 —— 报告卡 + 两张分布图 + 二维码，**与分享链接打开时
 * 看到的完全一致**，这正是需求要的「图片跟分享链接的内容呈现效果一样」。
 *
 * ⚠️ 必须先 await chartsReady：两个分布图是异步画的（要等指纹库），
 * 不等就截图会得到一张缺图的 PNG。await 期间按钮改成「准备中」，
 * 免得用户以为没反应又点一次。
 */
async function exportImage(snap) {
  const btn = $('#pngBtn');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ 准备图片…';
  try {
    await chartsReady;
    const name = `大模型归因报告-${snap.model || snap.claimed || 'report'}.png`;
    await exportPng($('#reportHost'), name, { background: '#faf9f5', patchRoot: $('#reportHost') });
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/** 二维码：用 check 站同一份 qrcodejs 库，画到 canvas 后转成静态 img。
 *  转 img 是为了截图工具拿到的一定是画好的图，不受异步时序影响。 */
function drawQr(holder, url) {
  if (!holder || typeof window.QRCode !== 'function') return;
  const tmp = document.createElement('div');
  // eslint-disable-next-line no-new
  new window.QRCode(tmp, { text: url, width: 132, height: 132, colorDark: '#14110c', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
  const canvas = tmp.querySelector('canvas');
  let uri = '';
  try { uri = canvas ? canvas.toDataURL('image/png') : (tmp.querySelector('img')?.src || ''); } catch { uri = ''; }
  if (uri) holder.innerHTML = `<img src="${uri}" width="132" height="132" alt="扫码查看归因报告">`;
}

async function copyThisLink() {
  const btn = $('#copyBtn');
  const url = location.href;
  let ok = false;
  try { await navigator.clipboard.writeText(url); ok = true; } catch {
    try { ok = document.execCommand('copy'); } catch { ok = false; }
  }
  btn.textContent = ok ? '✅ 已复制本页链接' : '复制失败，请手动复制地址栏';
  setTimeout(() => { btn.textContent = '🔗 复制本页链接'; }, 2000);
}

load();
