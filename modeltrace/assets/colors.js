/* =====================================================================
 * assets/colors.js —— 把浏览器算出来的颜色「拍平」成 rgb()/rgba()
 * ---------------------------------------------------------------------
 * 为什么需要这个模块：html2canvas 1.4.1 的颜色解析器**只认** hex / rgb(a) /
 * hsl(a) / 具名色。碰到别的写法它不是跳过、而是**直接抛错**：
 *
 *   Attempting to parse an unsupported color function "color"
 *
 * 一抛错整张截图就失败 —— 用户看到的是「导出失败」，而不是「某个元素颜色没画出来」。
 * 而现代 CSS 里这类写法遍地都是：
 *
 *   color-mix(in srgb, var(--vc) 26%, transparent)   → 实测 Chrome 算成 color(srgb 0.886 0.947 0.912)
 *   oklch(0.7 0.15 200) / lab(...) / light-dark(...) → 同样不被 1.4.1 认识
 *
 * ⚠️ 关键认知：`color-mix()` **不是**「浏览器不支持才出问题」，恰恰相反 ——
 *   浏览器越新，越会把 color-mix() 算成 `color(srgb ...)` 并原样交给
 *   getComputedStyle。所以「先判断 computed 是不是 rgb()，是才补」这条路是错的：
 *   新版浏览器算出来的**永远不是** rgb()，判断恒假 → 补丁永不生效 →
 *   而页面看着完全正常（浏览器自己会画），只有导出 PNG 时才炸。
 *
 * 解法：不自己解析颜色语法（百分比、插值色彩空间、色相插值方式都是坑），
 * 而是**让浏览器自己算**：把颜色喂给 canvas 的 fillStyle → 浏览器解析 →
 * getImageData 读回 0~255 的像素值。这是浏览器唯一的「颜色 → RGBA 数值」出口，
 * 任何它能显示的颜色都必然过得了这一关，也就不必逐个语法去支持。
 * ===================================================================== */

/* 1×1 取样画布：整个会话只建一块，反复用。要的是「解析颜色」，不是画图。 */
let sampleCtx = null;
function ctx1x1() {
  if (!sampleCtx) {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    sampleCtx = c.getContext('2d', { willReadFrequently: true });
  }
  return sampleCtx;
}

const round3 = (x) => Math.round(x * 1000) / 1000;
const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/* 已经是 html2canvas 认识的格式，不必再走 canvas。 */
const SAFE_RE = /^(rgba?|hsla?)\(/i;

/* hex 走字符串快路径：报告卡里绝大多数颜色是 hex（家族色、#fff、#14110c…），
 * 每条都过一趟 canvas 读写会白白多几百次像素往返。 */
function hexToRgb(hex) {
  let h = hex.slice(1);
  if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return a === 1
    ? `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
    : `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${round3(a)})`;
}

/**
 * 任意 CSS 颜色 → `rgb()` / `rgba()`；解析不了返回 null。
 *
 * 为什么用 canvas 而不是正则：颜色语法多到数不清（`color(display-p3 …)`、
 * `oklab(… / 50%)`、`color-mix()` 的各种输出），各家浏览器序列化的形式还不一样。
 * canvas + getImageData 是一条**不依赖语法**的通路：浏览器画得出来，就读得到数值。
 * 它同时保证「PNG 里的颜色和页面上看到的完全一致」—— 读回来的就是它渲染用的像素。
 */
export function toRgb(color) {
  const s = String(color ?? '').trim();
  if (!s) return null;
  if (SAFE_RE.test(s)) return s;
  if (/^transparent$/i.test(s)) return 'rgba(0, 0, 0, 0)';
  if (HEX_RE.test(s)) return hexToRgb(s);
  // 其余（具名色 / color() / oklch() / lab() / color-mix() 的输出现形式）统一交给 canvas
  let ctx;
  try { ctx = ctx1x1(); } catch { return null; }
  if (!ctx) return null;
  try {
    // ⚠️ 必须先 clearRect 清成「全透明」，再直接填目标色。
    //    若用不透明底色打底，canvas 会把半透明色与底色合成，getImageData 拿回的
    //    alpha 就是错的（`rgba(0,0,0,.5)` 会读成不透明）。
    // ⚠️ 填之前先把 fillStyle 复位成 #000：非法颜色字符串会被**静默忽略**，
    //    fillStyle 保持上一次的值，那样读回来的是上一次的颜色（错得无声无息）。
    //    先置 #000，非法值就变成「填出一块黑」，能被下面的透明判定识别出来。
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000000';
    ctx.fillStyle = s;
    const accepted = ctx.fillStyle;          // 浏览器规范化后的值；非法输入时仍是 #000000
    // 既不是我们预设的 #000000、又不是目标色被规范化后的样子 → 判定为解析失败。
    // 这里只做一次「非纯黑」的粗判就够了：真正的黑色（#000 / black / rgb(0,0,0)）
    // 会在上面 SAFE_RE 或 HEX_RE 提前返回，走不到这里。
    if (accepted.toLowerCase() === '#000000' && !/^black$/i.test(s)) {
      // 合法输入被规范化成 #000000 的唯一情形是「本来就是黑色」——
      // 上面已排除。所以这里确实是解析失败，放弃这一条（保持原样，不比现状更差）。
      return null;
    }
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return d[3] === 255
      ? `rgb(${d[0]}, ${d[1]}, ${d[2]})`
      : `rgba(${d[0]}, ${d[1]}, ${d[2]}, ${round3(d[3] / 255)})`;
  } catch {
    return null;
  }
}

/* 需要拍平的属性。依据是「html2canvas 会不会读它」，按报告卡上实际出现过
 * 颜色声明的地方列全：只补背景会漏文字，只补边框会漏 SVG 的 fill / stroke。
 * 多列几项的代价只是「值没变就跳过」，不会产生多余的 inline style。 */
const COLOR_PROPS = [
  'color',
  'background-color',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'outline-color', 'text-decoration-color',
  'fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color',
];

/**
 * 把 root 子树里所有 html2canvas 认不出的颜色落到 inline style 上。
 *
 * 为什么写 inline 而不是改样式表：改样式表会波及整个页面的渲染，截完还得
 * 精确还原（多个元素共用一条规则时极易还原错）。inline 只影响被截的这棵子树，
 * 每个元素各自记原值，恢复时一一对应、不会串台。
 *
 * ⚠️ 必须**先全部算完、再统一写**，不能边遍历边写：给父元素写上 inline 颜色后，
 *    子元素继承到的色会跟着变，此时再读子元素的 computed 就不是原来的颜色了。
 *
 * ⚠️ 同一个元素同一个属性可能被**多条规则匹配**（比如 .rc-seal 同时来自 .rc-seal
 *    与主题覆盖），这里按「元素 + 属性」去重，避免写两次、恢复时错位。
 *
 * @returns {() => void} 还原函数，务必在 finally 里调用
 */
export function flattenColors(root) {
  const pending = [];          // [{ el, prop, value, before }]
  const done = new Set();      // `${元素序号}|${属性}` 去重
  const nodes = [root, ...root.querySelectorAll('*')];

  nodes.forEach((el, i) => {
    if (!(el instanceof Element)) return;
    let cs;
    try { cs = getComputedStyle(el); } catch { return; }
    for (const prop of COLOR_PROPS) {
      const key = `${i}|${prop}`;
      if (done.has(key)) continue;
      done.add(key);
      const computed = (cs.getPropertyValue(prop) || '').trim();
      // 空值 = 该元素没用这个属性；SAFE = 本来就是 html2canvas 认识的写法 → 都不动
      if (!computed || SAFE_RE.test(computed)) continue;
      const rgb = toRgb(computed);
      if (!rgb) continue;      // 浏览器自己也认不出 → 保持原样（与现状一致，不会更差）
      pending.push({ el, prop, value: rgb, before: el.style.getPropertyValue(prop) || '' });
    }
  });

  for (const { el, prop, value } of pending) el.style.setProperty(prop, value);

  return () => {
    for (const { el, prop, before } of pending) {
      // 原本有 inline 值就写回原值，没有就移除 —— 别把页面自己的 inline 样式抹掉
      if (before) el.style.setProperty(prop, before);
      else el.style.removeProperty(prop);
    }
  };
}

/* 向后兼容别名：早先这个名字叫 patchColorMix（且只补了 .rc-verdict / .rc-seal）。
 * 保留是为了万一别处还 import 旧名字时，不至于变成一个「模块不提供导出 X」的
 * 报错 —— 那类缓存/命名错配的报错极难从报错本身看出原因。 */
export const patchColorMix = flattenColors;
