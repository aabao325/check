/* =====================================================================
 * assets/charts.js —— 两个分布图（指纹叠印 / 指纹罗盘）的渲染编排
 * ---------------------------------------------------------------------
 * 谁在用：
 *   分享页（report.js）—— 报告卡下方两张图，页面主要看点
 *   站内弹窗（app.js）—— 历史详情里的两张图，与报告卡同一个弹窗
 *
 * 为什么抽出来共用：这两张图的渲染链路有一串不能省的时序与降级判断
 * （等指纹库 → 用快照原始数字重算 → 缺料就不画、不报错），在三个调用点各写
 * 一遍必然会走样。站内弹窗最初就没有这两个图 —— 同一份报告在分享页有图、
 * 在本机弹窗里只有一张卡，用户会以为历史记录丢了东西。
 *
 * 数据从哪来：快照里的 rawNumbers（每份回答的原始数字）+ 当前指纹库。
 *   不存算好的图表数据，是因为库会更新（加模型、重建质心），派生数据的数组
 *   下标与当时的库绑定，用新库渲染就错位；原始数字永远能重算。
 *
 * ⚠️ 全链路「缺料就不画」：旧快照没有 rn 字段、指纹库拉不到、分析抛错 ——
 *   一律静默隐藏整块图，**不显示空图框、不弹错**。图是附加信息，结论卡才是主体。
 * ===================================================================== */
import { renderOverlay, renderCompass } from './viz.js?v=13';
import { analyzeOutputs } from './engine/fingerprint.js?v=13';

/** 指纹库缓存：同一会话里只取一次（近 1MB，浏览器也会缓存，但没必要重复解析）。
 *  站内弹窗与分享页共用这一份 —— 两边都在页面上引了本模块。
 *
 *  ⚠️ 用 `new URL(..., import.meta.url)` 而不是 `'../data/...'`：相对 URL 的基准是
 *     **页面地址**，而站内弹窗在 /modeltrace/、分享页在 /modeltrace/report 上，
 *     同一串相对路径在两处解析出的绝对地址不同，必然有一边 404。
 *     以模块自身为基准就没有这个二义性 —— 模块在哪，数据就在它的上一层。 */
const BANK_URL = new URL('../data/bank/unified_bank.json', import.meta.url).href;
let bankPromise = null;
export function loadBank(url = BANK_URL) {
  if (!bankPromise) {
    bankPromise = fetch(url, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`指纹库加载失败（HTTP ${r.status}）`);
      return r.json();
    }).catch((e) => {
      bankPromise = null;      // 失败不缓存，下次调用还能重试
      throw e;
    });
  }
  return bankPromise;
}

/**
 * 在 host 内渲染两张分布图。返回一个 Promise，**每条返回路径都会 resolve** ——
 * 调用方（导 PNG 前）可以无条件 await，不会挂住。
 *
 * @param {object} opts
 * @param {object} opts.snap            长名快照（readSnapshot 的产物）
 * @param {string} opts.overlaySel      叠印图容器选择器
 * @param {string} opts.compassSel      罗盘容器选择器
 * @param {string} [opts.bankUrl]       指纹库地址（默认与站点同级的 data/bank）
 * @returns {Promise<{ok: boolean, reason?: string}>} ok=false 表示没有画出图
 */
export async function renderCharts({ snap, overlaySel, compassSel, bankUrl }) {
  const raws = snap?.rawNumbers || [];
  if (!raws.length) return { ok: false, reason: 'no-raw' };   // 旧快照 / 无原料

  const overlayHost = document.querySelector(overlaySel);
  const compassHost = document.querySelector(compassSel);
  if (!overlayHost || !compassHost) return { ok: false, reason: 'no-host' };

  let bank;
  let result;
  try {
    bank = await loadBank(bankUrl);
    // 与前台同一条链路：原始数字 → 归因结果。expected_count 用快照里的数字个数 ——
    // 它决定「这份回答算不算有效」，用当初那份回答自己的长度最忠实。
    result = analyzeOutputs(
      raws.map((x) => ({ text: (x.numbers || []).join(' '), expected_count: (x.numbers || []).length })),
      bank,
    );
  } catch (e) {
    console.warn('[modeltrace] 分布图未能渲染：', e);
    return { ok: false, reason: 'bank' };
  }

  // claimed / verdict 一律用**快照里存的**（当初的声称模型与结论），不要用重算的
  // prediction：保证图与报告卡说的是同一个结论，否则库更新后可能出现
  // 「卡说一致、图指向别的模型」这种自相矛盾的呈现。
  const view = {
    result,
    verdict: snap.verdict,
    claimed: snap.claimed || snap.model,
    bank,
    labels: snap.responses?.length ? snap.responses.map((x) => `第 ${x.index + 1} 份`) : undefined,
    partial: snap.partial,
    variant: snap.variant,
  };
  try {
    renderOverlay(overlayHost, view);
    renderCompass(compassHost, view);
  } catch (e) {
    console.warn('[modeltrace] 分布图渲染失败：', e);
    return { ok: false, reason: 'render' };
  }
  return { ok: true, bank, result };
}

/** 建库时间只显示到「年-月-日」，图旁那句话不需要精确到分钟。 */
export function fmtBankDate(iso) {
  const s = String(iso || '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

/** 图旁那行说明。
 *
 *  ⚠️ 这段文字会跟着导出的 PNG 一起流传出去，读者是**拿到图片的陌生人**，
 *     不是站内用户。所以只说「图是什么、怎么看」，不提「本页用你浏览器里的指纹库
 *     现算」「基准库版本」这类实现细节 —— 那是给排查问题的人看的，摆在小白面前
 *     只会让人以为报告有问题。基准库日期仍以日期本身的形式保留（读者能判断新旧），
 *     但不解释它是「重算」来的。 */
export function chartNote(bb) {
  const date = fmtBankDate(bb);
  return `两张图分别从「数字分布」和「模型距离」两个角度看这份回答与各模型的接近程度，越贴合越可信。`
    + (date ? `参考基准更新于 ${date}，更早的报告以该日期为准。` : '');
}
