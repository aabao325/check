/* =====================================================================
 * iq-assets/summary-format.js —— AI 视觉裁判总结 · 富文本渲染
 * ---------------------------------------------------------------------
 * 裁判模型返回的内容分两部分：
 *   ① 思考过程（reasoning）—— glm-4.1v-thinking 等思考型模型才有。
 *      来源可能是 <think>…</think> 标签（后端已尽量拆开），也可能是
 *      后端单独给的 thinking 字段。这里一并兜底解析，默认展开、可收起。
 *   ② 评审正文 —— 「结论/亮点/可以更好/总评」分段 + - 列表。
 * 输出：带颜色的「档位徽章」+ 思考折叠区 + 结构化正文。
 * 首页(app.js)与分享报告(report.js)共用，保证展示一致。
 * ===================================================================== */

// 四档：按「严重优先」顺序匹配（先查跑偏/降智，避免文里出现「不算降智」被误判）
const DIMS = [
  { cls: 'bad',  kw: '完全跑偏', icon: '❌', label: '完全跑偏' },
  { cls: 'bad',  kw: '明显降智', icon: '🧠', label: '明显降智' },
  { cls: 'warn', kw: '略有瑕疵', icon: '⚠️', label: '略有瑕疵' },
  { cls: 'ok',   kw: '正常发挥', icon: '✅', label: '正常发挥' },
];
// 正文分段标签：只认行首，避免正文里引用到这些词被误切。
// 两组写法都要吃：① 「亮点：内容」同行（旧格式）② 「亮点」独占一行、无冒号（glm 系常见）
const SECTIONS = /^(结论|亮点|优点|可以更好|待改进|不足|建议|总评)[：:]\s*(.*)$/;
const SECTION_BARE = /^(结论|亮点|优点|可以更好|待改进|不足|建议|总评)$/;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 行内标记：先转义，再还原 **加粗** 与 【高亮】（这两个符号不在转义集合内，安全）
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/【(.+?)】/g, '<span class="hl">【$1】</span>');
}

// 思考文本 → HTML：先转义，再还原加粗、剥离残留标签、把列表项换成中点
function thinkHtml(s) {
  let t = String(s || '').replace(/\r\n?/g, '\n');
  t = t.replace(/<\/?(?:think(?:ing)?|answer|reasoning|response|final|analysis)[^>]{0,20}>/gi, '\n'); // 去掉模型自带的结构标签
  t = esc(t);
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/^\s{0,3}[-*•]\s+/gm, '· ');       // 思考里的列表项统一成中点，避免与正文 › 撞风格
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/**
 * 从原始文本里剥离 <think> 思考块（后端没拆干净时的前端兜底）
 * 只有「成对」标签才认，避免正文里提到 <think> 一词被误切。
 * @returns {{thinking:string, answer:string}}
 */
function splitThink(raw) {
  let thinking = '';
  let answer = String(raw || '');
  const m = answer.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i);
  if (m) { thinking = m[1]; answer = answer.replace(m[0], ''); }
  answer = answer.replace(/<\/?think(?:ing)?>/gi, '');
  return { thinking: thinking.trim(), answer: answer.trim() };
}

/**
 * @param {string} text 裁判模型返回的正文
 * @param {string} [thinkingExtra] 后端单独返回的思考内容（可选，优先于正文内嵌的 <think>）
 * @returns {{cls:string, icon:string, label:string, bodyHtml:string, hasThink:boolean}}
 */
export function formatSummary(text, thinkingExtra = '') {
  const split = splitThink(text);
  const thinking = String(thinkingExtra || '').trim() || split.thinking;
  const raw = split.answer || String(text || '').trim();

  // 徽章：只从【正文】里找档位，绝不让思考里的「不算降智」之类把结论带偏
  let badge = { cls: '', icon: '🤖', label: 'AI 评审' };
  for (const d of DIMS) { if (raw.includes(d.kw)) { badge = d; break; } }

  const out = [];
  const think = [];
  let list = [];
  const flush = () => { if (list.length) { out.push('<ul>' + list.map((li) => `<li>${li}</li>`).join('') + '</ul>'); list = []; } };

  raw.split(/\n+/).forEach((line) => {
    const t = line.trim();
    if (!t) return;
    if (/^[-•·*]\s+/.test(t)) { list.push(inline(t.replace(/^[-•·*]\s+/, ''))); return; }
    flush();
    const m = t.match(SECTIONS);
    if (m) {
      const rest = m[2] ? ' ' + inline(m[2]) : '';
      out.push(`<p class="sm-p"><span class="sm-sec">${m[1]}</span>${rest}</p>`);
      return;
    }
    // 「亮点」独占一行：渲染成小节标题。它下面如果是 - 列表，标题要紧凑贴着列表
    if (SECTION_BARE.test(t)) {
      out.push(`<p class="sm-p sm-sec-line"><span class="sm-sec">${t}</span></p>`);
      return;
    }
    out.push(`<p class="sm-p">${inline(t)}</p>`);
  });
  flush();

  // 思考区：默认展开（open），点标题可收起；与正文用不同的底纹/字体明确区分
  const hasThink = !!thinking;
  if (hasThink) {
    think.push(
      '<details class="sm-think" open>',
      '<summary class="sm-think-head">',
      '<span class="st-em">💭</span><span class="st-t">模型思考过程</span>',
      '<span class="st-hint"></span>',
      '</summary>',
      `<div class="sm-think-body">${thinkHtml(thinking)}</div>`,
      '</details>'
    );
  }

  return {
    cls: badge.cls,
    icon: badge.icon,
    label: badge.label,
    bodyHtml: think.join('') + out.join(''),
    hasThink,
  };
}

// 直接把徽章 + 正文写进一个容器（app.js / report.js 复用）
export function paintSummary(cardEl, verdictEl, bodyEl, text, thinking = '') {
  const { cls, icon, label, bodyHtml } = formatSummary(text, thinking);
  if (verdictEl) { verdictEl.className = 'vc-verdict ' + cls; verdictEl.innerHTML = `<span class="vi">${icon}</span>${label}`; }
  if (bodyEl) bodyEl.innerHTML = bodyHtml;
  if (cardEl) cardEl.className = cardEl.className.replace(/\b(ok|warn|bad)\b/g, '').trim() + (cls ? ' ' + cls : '');
  return { cls, label };
}
