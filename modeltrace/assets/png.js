/* =====================================================================
 * assets/png.js —— 把归因报告导出成 PNG（站内弹窗与分享页共用）
 * ---------------------------------------------------------------------
 * 与 check 检测站同一套口径：html2canvas 截 DOM（页面须先引入 html2canvas）。
 * 两处场景共用这一个模块，是因为它们的坑完全一样 ——
 *
 * ⚠️ 坑①：html2canvas 1.4.1 的颜色解析器只认 hex / rgb(a) / hsl(a) / 具名色，
 *   碰到 `color()` 这类写法**直接抛错**，整张截图失败。而现代 CSS 里
 *   `color-mix()` 经 Chrome 计算后交出来的正是 `color(srgb …)`：
 *     .rc-verdict { border: 1px solid color-mix(in srgb, var(--vc) 26%, transparent) }
 *     .rc-seal    { background: color-mix(in srgb, var(--vc) 14%, #fff) }
 *   实测那一刻的 computed 值是 `color(srgb 0.885804 0.946745 0.912157)` ——
 *   于是导出报 `Attempting to parse an unsupported color function "color"`。
 *   对策见 colors.js：把浏览器算出来的颜色统一拍平成 rgb()，截完还原。
 *   早先这里写的是「先判断 computed 是不是 rgb()，是才补」，那条判断在会解析
 *   color-mix() 的新浏览器上**恒为假** —— 补丁一次都没生效过。
 *
 * ⚠️ 坑②：分享页的两个分布图要等指纹库 fetch 回来才画得出来。
 *   用户一点导出就截图会截到空图框。所以调用方必须先等图渲染完（见 report.js /
 *   charts.js 的 ready），本模块只管截图本身，不负责等数据。
 *
 * ⚠️ 坑③：html2canvas 会把 DOM 里的 SVG 读一遍，其中 <defs>/<linearGradient> 的
 *   stop-color 若仍是 `color(srgb …)` 也会抛错。所以拍平范围要覆盖 SVG 属性，
 *   这条已在 colors.js 的 COLOR_PROPS 里处理。
 *
 * ⚠️ 坑④：html2canvas 只截**元素自己的盒子**，元素外的留白一律不进图。
 *   两处调用点把留白都做在了容器**外面**（分享页是 .share-wrap 的 24px 内边距，
 *   弹窗是 .detail-body 的 16px），于是导出的图左右贴边、像被裁过一刀 ——
 *   页面上看着正常，导出后才难看，属于「只在图片里才暴露」的问题。
 *   对策是截之前给元素临时加上内边距、截完立刻还原（见 opts.padding）。
 *   不改调用点的 CSS：留白是**导出时**才需要的，页面本身已有外层间距，
 *   写进样式表会让分享页凭空多出一圈空隙。
 * ===================================================================== */
import { flattenColors } from './colors.js?v=13';

/** 导出时给截图容器临时补上的内边距（CSS px，导出后再乘 scale）。
 *  28 是「看起来像一张留了边的卡片」的下限：再多会把两张分布图压瘦，
 *  再少则四角仍然贴边。 */
const EXPORT_PADDING = 28;

/**
 * 导出 PNG。
 * @param {HTMLElement} el        要截图的容器
 * @param {string} filename       下载文件名
 * @param {object} [opts]
 * @param {string} [opts.background] 底色，取页面暖纸色；不传则 PNG 透明底，
 *                                   贴到深色聊天框里会很难看
 * @param {string} [opts.patchRoot]  颜色拍平的作用范围，默认同 el
 * @param {number} [opts.padding]    截图时临时补的内边距，默认 EXPORT_PADDING；
 *                                   传 0 表示不补（由调用点自己保证留白）
 * @returns {Promise<boolean>}    是否真的下载了
 */
export async function exportPng(el, filename = 'report.png', opts = {}) {
  if (!el) return false;
  if (typeof window.html2canvas !== 'function') {
    alert('PNG 导出组件未加载（html2canvas）。请检查网络或改用链接分享。');
    return false;
  }
  // 1) 展开所有 <details>：html2canvas 不复现原生折叠语义，折叠区里的内容会被照常画出、
  //    叠在 summary 上（截图重叠）。记下原本的展开状态，截完还原。
  const details = [...el.querySelectorAll('details')];
  const prevOpen = details.map((d) => d.open);
  details.forEach((d) => { d.open = true; });
  // 2) 拍平颜色（否则 color-mix() 算出的 color(srgb …) 会让整个导出抛错）
  const restoreColors = flattenColors(opts.patchRoot || el);
  // 3) 补导出留白。⚠️ 内边距补在元素自身上，缩进的是**内容**而不是把整块撑大 ——
  //    因为 html2canvas 截的是 border box，padding 天然在框内。
  //    背景色也要一起补上：光加 padding 会得到一圈透明边，
  //    贴到白底页面里像是图被裁掉了一块。
  const pad = opts.padding === undefined ? EXPORT_PADDING : opts.padding;
  const prevPad = el.style.padding;
  const prevBg = el.style.backgroundColor;
  if (pad > 0) {
    el.style.padding = `${pad}px`;
    el.style.backgroundColor = opts.background || '#faf9f5';
  }
  try {
    const canvas = await window.html2canvas(el, {
      backgroundColor: opts.background || '#faf9f5',
      scale: 2,
      useCORS: true,
      // 日志默认会往控制台刷「已渲染 N 个元素」之类，页面控制台本来就够吵了，
      // 关掉它，真出问题时我们靠 catch 到的异常信息定位。
      logging: false,
    });
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = filename;
    a.click();
    return true;
  } catch (e) {
    // 把「哪个元素 / 哪种颜色」这类线索也带出来，否则用户只看到一句英文异常，
    // 我们排查时得从头复现一遍。颜色相关的失败是最常见的，单独给一句可读的提示。
    const raw = String(e?.message || e);
    const hint = /unsupported color function/i.test(raw)
      ? '（页面里有 html2canvas 不认识的 CSS 颜色写法，已尝试自动转换；若仍失败请反馈）'
      : '';
    alert(`导出失败：${raw}${hint}`);
    return false;
  } finally {
    // 无论成功与否都还原，别改动用户当前看到的页面
    if (pad > 0) {
      el.style.padding = prevPad;
      el.style.backgroundColor = prevBg;
    }
    restoreColors();
    details.forEach((d, i) => { d.open = prevOpen[i]; });
  }
}
