/* =====================================================================
 * iq-assets/report.js —— 智商检测分享报告（只读）
 * 来源：/iq/s/<id>（新版短链，nginx 内部重写到本页）或 ?id=xxx（旧短链），
 *       两者都读 iq-share.php；#data=base64 仅作为本地直开文件时的兼容分支。
 * · 左右用 sandbox iframe 活图渲染标准答案与模型输出
 * · AI 总结放在图片上方（第一时间看结论）
 * · iframe 内自截图（postMessage），支持导出 PNG（html2canvas 截不到跨源 iframe，
 *   导出时把 iframe 换成截图 <img>）
 * · 底部二维码：扫码看这份报告
 * ===================================================================== */
import { paintSummary } from './summary-format.js?v=2';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 分享短链：`<站点>/iq/s/<id>`。与 app.js 的 shareUrl 同形（那边生成、这边复用）。
 *
 *  ⚠️ 二维码内容**必须**是当前这份报告的地址，不能退回「指向首页」：
 *     扫出来看不到报告就是实打实的错，不是降级。 */
function shareUrl(id) {
  const base = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}s`;
  return `${base}/${encodeURIComponent(id)}`;
}

/** 上一版链接形状：`iq-report?id=<id>`。只在短链不可达（nginx 规则没配）时用。 */
function legacyShareUrl(id) {
  const u = new URL('iq-report', location.href);
  u.searchParams.set('id', id);
  return u.toString();
}

/** 挑一条能打开的链接：先探短链，404 就退回 ?id= 那条。
 *  两款链接指向同一份报告，短链只是更短 —— 打不开的短链不如打得开的长链。 */
async function pickShareUrl(id) {
  const short = shareUrl(id);
  try {
    const r = await fetch(short, { method: 'HEAD' });
    if (r.ok) return short;
  } catch { /* 探测失败即视为不可达 */ }
  return legacyShareUrl(id);
}

/** 从当前地址取报告 id。兼容 /iq/s/<id> 与 ?id=<id>。
 *  ⚠️ 用 /s/ 定位而不是「取路径最后一段」：站点部署在子路径（/iq/），
 *     裸取最后一段会把目录名当成 id。 */
function shareIdFromLocation() {
  const q = new URLSearchParams(location.search).get('id');
  if (q) return q;
  const m = location.pathname.match(/\/s\/([A-Za-z0-9]+)\/?$/);
  return m ? m[1] : null;
}

/** 当前地址是不是「本页自己就是一份分享报告」（/iq/s/<id>）。
 *  是就返回它（短链，可直接对外发）；否则返回 null。 */
function ownShareUrl() {
  return /\/s\/[A-Za-z0-9]+\/?$/.test(location.pathname) ? location.href : null;
}

/* iframe 内自截图 —— 截【整个文档】而非只截 <svg>（与 app.js 同款，说明见那边）。
 * 关键点：html2canvas 在 sandbox="allow-scripts" 内会因 opaque origin 被拦死，
 * 故改用 foreignObject + 内联 CSS 的方式；失败退回只截 SVG。 */
const SHOT_SCRIPT = `
<script>(function(){
  function send(u){ parent.postMessage({__iq:'shot',dataUrl:u||null},'*'); }
  function bg(el){ try{ var c=getComputedStyle(el).backgroundColor; return (c&&c!=='rgba(0, 0, 0, 0)'&&c!=='transparent')?c:''; }catch(e){ return ''; } }
  function shootSvgOnly(){
    try{
      var svg=document.querySelector('svg');
      if(!svg){ send(null); return; }
      var vb=(svg.viewBox&&svg.viewBox.baseVal)||null;
      var w=svg.clientWidth||(vb&&vb.width)||480, h=svg.clientHeight||(vb&&vb.height)||360;
      var clone=svg.cloneNode(true); clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
      if(!clone.getAttribute('width')) clone.setAttribute('width',w);
      if(!clone.getAttribute('height')) clone.setAttribute('height',h);
      var xml=new XMLSerializer().serializeToString(clone);
      var fill=bg(document.body)||bg(document.documentElement)||'#faf9f5';
      var img=new Image();
      img.onload=function(){ try{
        var scale=Math.min(2,900/Math.max(1,w));
        var c=document.createElement('canvas'); c.width=Math.round(w*scale); c.height=Math.round(h*scale);
        var ctx=c.getContext('2d'); ctx.fillStyle=fill; ctx.fillRect(0,0,c.width,c.height); ctx.drawImage(img,0,0,c.width,c.height);
        send(c.toDataURL('image/png'));
      }catch(e){ send(null); } };
      img.onerror=function(){ send(null); };
      img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(xml);
    }catch(e){ send(null); }
  }
  function shootFull(){
    try{
      var css='';
      for(var i=0;i<document.styleSheets.length;i++){
        try{ var rs=document.styleSheets[i].cssRules; for(var j=0;j<rs.length;j++) css+=rs[j].cssText+'\\n'; }catch(e){}
      }
      css=css.replace(/(^|[},\\s])(html|body)(?=[\\s,{:])/g,'$1.iq-root');
      var w=document.documentElement.clientWidth||480;
      var h=document.documentElement.clientHeight||360;
      var ser=new XMLSerializer(), inner='';
      for(var k=0;k<document.body.childNodes.length;k++){
        var n=document.body.childNodes[k];
        if(n.nodeType===1 && n.tagName==='SCRIPT') continue;
        try{
          inner += (n.nodeType===3)
            ? (n.nodeValue||'').replace(/[<&]/g,function(c){return c==='<'?'&lt;':'&amp;';})
            : ser.serializeToString(n);
        }catch(e){}
      }
      if(!inner){ shootSvgOnly(); return; }
      var rootBg=bg(document.body)||bg(document.documentElement)||'';
      var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">'
        +'<foreignObject x="0" y="0" width="'+w+'" height="'+h+'">'
        +'<div xmlns="http://www.w3.org/1999/xhtml" class="iq-root" style="width:'+w+'px;height:'+h+'px;overflow:hidden'
        +(rootBg?(';background:'+rootBg):'')+'">'
        +'<style type="text/css">'+css.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</style>'
        +inner+'</div></foreignObject></svg>';
      var img=new Image();
      img.onload=function(){ try{
        var c=document.createElement('canvas'); c.width=w*2; c.height=h*2;
        var ctx=c.getContext('2d'); ctx.scale(2,2); ctx.drawImage(img,0,0);
        send(c.toDataURL('image/png'));
      }catch(e){ shootSvgOnly(); } };
      img.onerror=function(){ shootSvgOnly(); };
      img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
    }catch(e){ shootSvgOnly(); }
  }
  setTimeout(shootFull, 1600);
})();<\/script>`;
function injectShot(html) {
  if (!html) return html;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, SHOT_SCRIPT + '</body>');
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, SHOT_SCRIPT + '</html>');
  return html + SHOT_SCRIPT;
}

const frames = { baseline: null, model: null };
const shots  = { baseline: null, model: null };
window.addEventListener('message', (e) => {
  const d = e.data; if (!d || d.__iq !== 'shot') return;
  if (frames.baseline && e.source === frames.baseline.contentWindow) shots.baseline = d.dataUrl || null;
  else if (frames.model && e.source === frames.model.contentWindow) shots.model = d.dataUrl || null;
});

async function load() {
  const id = shareIdFromLocation();
  let report = null;
  if (id) {
    try { const r = await fetch(`./iq-share.php?id=${encodeURIComponent(id)}`); const j = await r.json(); if (j.ok) report = j.report; } catch {}
  }
  if (!report && location.hash.startsWith('#data=')) {
    // 兼容分支：本地直开 iq-report.html 文件时用的静态载荷（不出现在对外链接里）
    try { report = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(6))))); } catch {}
  }
  if (!report) { $('#reportArea').innerHTML = '<div class="panel-card">报告不存在或链接已失效。<a href="./">去检测</a></div>'; return; }
  render(report);
}

function frame(host, html, side, emptyText) {
  if (!html) { host.innerHTML = `<div class="stage-empty">${esc(emptyText)}</div>`; return; }
  const iframe = document.createElement('iframe');
  iframe.className = 'stage-frame';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.srcdoc = injectShot(html);
  if (side) frames[side] = iframe;
  host.innerHTML = ''; host.appendChild(iframe);
}

function codeBlock(host, code, label) {
  if (!code) { host.innerHTML = ''; return; }
  host.innerHTML = `<details class="code-toggle"><summary>${esc(label)}</summary><div class="code-wrap"><button class="code-copy" type="button">复制</button><pre></pre></div></details>`;
  host.querySelector('pre').textContent = code;
  host.querySelector('.code-copy').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    navigator.clipboard.writeText(code).then(() => { btn.classList.add('ok'); btn.textContent = '已复制'; setTimeout(() => { btn.classList.remove('ok'); btn.textContent = '复制'; }, 1500); });
  });
}

function render(r) {
  document.title = `${r.questionName || '智商检测'} · 大模型智商检测报告 — Aabao.AI`;
  // 检测时间：优先 savedAt，否则当前
  const when = (() => {
    const d = r.savedAt ? new Date(r.savedAt) : new Date();
    if (isNaN(d.getTime())) return esc((r.savedAt || '').slice(0, 16));
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  })();
  // 摘要条：检测项（题名）单独一块 + 模型/档位/协议/时间 各一列
  const chip = (label, val) => `<div class="rs-item"><span class="rs-k">${label}</span><span class="rs-v">${val}</span></div>`;
  const items = [];
  items.push(`<div class="rs-item rs-q"><span class="rs-em">${esc(r.questionEmoji || '🧠')}</span><span class="rs-v">${esc(r.questionName || '智商检测')}</span></div>`);
  if (r.model) items.push(chip('模型', `<b>${esc(r.model)}</b>`));
  if (r.think) items.push(chip('思考档位', esc(r.think)));
  if (r.protocol) items.push(chip('协议', esc(r.protocol)));
  // ⚠️ 地址口径：『不显示地址』时 targetHost 仍存在（后端照存，只是不该展示），
  //    所以按 urlMode 过滤，不能靠字段为空兜底 —— 后端的口径字段才是权威。
  if (r.targetHost && r.urlMode !== 'none') items.push(chip('目标站', esc(r.targetHost)));
  items.push(chip('检测时间', when));
  $('#repMeta').innerHTML = items.join('');
  $('#repPrompt').textContent = r.prompt || '';
  $('#repModelTag').textContent = r.model || 'MODEL';

  // AI 总结（图上方）· 富文本渲染（档位徽章 + 思考折叠区 + 结构化正文）
  const sb = $('#repSummary');
  if (r.summary) { sb.classList.add('show'); paintSummary(sb, $('#repSummaryVerdict'), $('#repSummaryBody'), r.summary, r.summaryThink || ''); }
  else sb.style.display = 'none';

  // 左右图
  const modelHtml = r.modelHtml || '';
  frame($('#repLeft'), r.baselineHtml || '', 'baseline', '该题未提供标准答案基线');
  if (modelHtml) frame($('#repRight'), modelHtml, 'model', '');
  else $('#repRight').innerHTML = `<div class="stage-empty">${r.modelRaw ? '模型未产出可渲染 HTML，见下方源码' : '无模型输出'}</div>`;

  codeBlock($('#repCodeLeft'), r.baselineHtml || '', '标准答案 HTML 源码');
  codeBlock($('#repCodeRight'), modelHtml || r.modelRaw || '', modelHtml ? '模型输出 HTML 源码' : '模型原始回复');

  buildQr();
  $('#pngBtn').onclick = () => exportPng(r);
}

/* ---------- 二维码：扫码看这份报告 ----------
 * 内容 = 当前这份报告的地址。自己就是短链（/iq/s/<id>）时直接用当前地址；
 * 旧的 ?id= 链接则按 id 重建，并**探测短链是否真的可达**（依赖 nginx 重写规则），
 * 不可达就退回 ?id= 那条 —— 二维码里放的必须是真能扫开的报告地址。
 * 连 id 都拿不到（仅本地 #data=）时不显示二维码，而不是错指首页。 */
async function buildQr() {
  const block = $('#qrBlock'), holder = $('#qrCode');
  if (!block || !holder || typeof window.QRCode !== 'function') return;
  const id = shareIdFromLocation();
  let url = ownShareUrl();
  if (!url && id) url = await pickShareUrl(id);
  if (!url) return;
  const tmp = document.createElement('div');
  // eslint-disable-next-line no-new
  new window.QRCode(tmp, { text: url, width: 120, height: 120, colorDark: '#14110c', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
  setTimeout(() => {
    const canvas = tmp.querySelector('canvas');
    let uri = ''; try { uri = canvas ? canvas.toDataURL('image/png') : (tmp.querySelector('img')?.src || ''); } catch {}
    if (!uri) return;
    holder.innerHTML = `<img src="${uri}" width="128" height="128" alt="扫码查看报告">`;
    $('#qrHint').innerHTML = '<span class="qr-main">📱 扫码查看这份检测报告</span>'
      + '<span class="qr-sub">让模型用 SVG 画一段动画，看它降智了没</span>'
      + `<span class="qr-url">${esc(url.replace(/^https?:\/\//, ''))}</span>`;
    block.style.display = '';
  }, 60);
}

/* ---------- PNG 导出 ----------
 * html2canvas 截不到跨源 sandbox iframe，故导出前把两侧 iframe 临时替换为其截图 <img>，
 * 展开所有 <details> 源码，截完再还原。截图来自 iframe 自截（postMessage 收集）。 */
async function exportPng(r) {
  const btn = $('#pngBtn'), old = btn.textContent;
  if (typeof window.html2canvas !== 'function') { alert('PNG 导出组件未加载（html2canvas），请检查网络或改用链接分享。'); return; }
  btn.disabled = true; btn.textContent = '⏳ 生成中…';

  // 等截图就绪（最多等 2.2s）
  const t0 = Date.now();
  // 截图链路：iframe 内 1.6s 后自截图（本地渲染），留足余量
  while ((frames.baseline && !shots.baseline || frames.model && !shots.model) && Date.now() - t0 < 4000) {
    await new Promise((res) => setTimeout(res, 120));
  }

  const swaps = [];  // 记录被替换的节点以便还原
  function swapToImg(hostSel, shot, side) {
    const host = $(hostSel); const iframe = host.querySelector('iframe'); if (!iframe) return;
    const ph = document.createElement(shot ? 'img' : 'div');
    if (shot) { ph.src = shot; ph.className = 'stage-shot'; }
    else { ph.className = 'stage-empty'; ph.textContent = '（此侧无渲染截图）'; ph.style.height = '420px'; }
    host.replaceChild(ph, iframe); swaps.push({ host, iframe, ph });
  }
  swapToImg('#repLeft', shots.baseline, 'baseline');
  swapToImg('#repRight', shots.model, 'model');
  // 展开源码 details
  const details = Array.from(document.querySelectorAll('#reportArea details'));
  const wasOpen = details.map((d) => d.open); details.forEach((d) => (d.open = false)); // 源码太长，导出时收起更清爽

  // 导出时给报告区加外留白（.export-pad：padding + 纸底），PNG 四周留白、不铺满
  const area = $('#reportArea');
  area.classList.add('export-pad');
  try {
    const canvas = await window.html2canvas(area, { backgroundColor: '#faf9f5', scale: 2, useCORS: true, logging: false });
    const link = document.createElement('a');
    link.download = `智商检测-${(r.model || 'report').replace(/[^\w.-]/g, '_')}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    btn.textContent = '✅ 已导出';
  } catch (e) {
    btn.textContent = '导出失败'; console.error(e);
  } finally {
    area.classList.remove('export-pad');
    // 还原
    swaps.forEach(({ host, iframe, ph }) => { try { host.replaceChild(iframe, ph); } catch {} });
    details.forEach((d, i) => (d.open = wasOpen[i]));
    setTimeout(() => { btn.disabled = false; btn.textContent = old; }, 1600);
  }
}

/* ---------- 复制本页链接 ----------
 * 复制的是**报告地址本身**：本页由 nginx 把 /iq/s/<id> 内部重写而来，地址栏没变，
 * 所以 location.href 就是那条短链。旧的 ?id= 链接或站内 #data= 预览则按 id 重建
 * （并探测可达性），用户拿到手的永远是能打开的那种形状。 */
$('#copyBtn')?.addEventListener('click', async () => {
  const id = shareIdFromLocation();
  const url = ownShareUrl() || (id ? await pickShareUrl(id) : location.href);
  navigator.clipboard.writeText(url).then(() => {
    const b = $('#copyBtn'); const t = b.textContent; b.textContent = '✓ 已复制'; setTimeout(() => (b.textContent = t), 1500);
  }).catch(() => prompt('复制此链接：', url));
});

load();
