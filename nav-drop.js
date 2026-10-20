/* =====================================================================
 * nav-drop.js —— 「大模型检测」导航下拉（跨页共用）
 * ---------------------------------------------------------------------
 * 本仓库收录三个检测站，导航下拉把它们收在同一个入口里，三站之间可直接跳转。
 * 公共版只保留这三件套，不包含任何个人站点 / 中转站分流信息。
 *
 * 用法（子页）：
 *   <script src="../nav-drop.js"></script>
 *   <script>
 *     initModelDrop('modelDrop', 'modelDropBtn', {
 *       pathPrefix: '../',            // 首页 './'，子页 '../'
 *       current: '智商检测',           // 当前所在项，用于高亮
 *       iconBase: '../check/assets/icons/',
 *     });
 *   </script>
 *
 * 交互口径：
 *   鼠标移入按钮或菜单 → 展开；移开 → 约 180ms 后自动收起（留出鼠标跨过间隙的时间）。
 *   同时保留点击展开 / 收起、Esc 可关 —— 触屏与键盘用户没法「悬停」。
 * ===================================================================== */
(function () {
  /* ───────────── 图标注册表 ─────────────
     统一规格：viewBox 0 0 24 24、fill none、stroke currentColor、1.7 线宽。
     只写 path 内容，外壳由 icon() 统一包，保证三枚图标线宽绝对一致。 */
  const ICON_PATHS = {
    // 真伪检测：盾牌 + 勾
    check: '<path d="M12 3 19.5 6v6c0 4.7-3.1 8.3-7.5 10C7.6 20.3 4.5 16.7 4.5 12V6Z"/><path d="M8.6 12.1l2.4 2.4 4.6-4.8"/>',
    // 智商检测：发光灯泡
    iq: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.8 1 .9 1.6l.1.6h5.2l.1-.6c.1-.6.4-1.2.9-1.6A6 6 0 0 0 12 3Z"/>',
    // 归因检测：指纹
    fingerprint: '<path d="M12 4.5c-2 0-3.8.8-5.1 2.1"/><path d="M4.8 9.6A8 8 0 0 1 20 12v1"/><path d="M7 12a5 5 0 0 1 10 0v2.5"/><path d="M9.5 12a2.5 2.5 0 0 1 5 0c0 2.4-.4 4.4-1.2 6"/><path d="M4.6 12c0 2.3.4 4.4 1.3 6.2"/><path d="M12 16v1.4"/>',
    // 箭头
    chevron: '<path d="M9 6l6 6-6 6"/>',
  };

  function icon(name) {
    const p = ICON_PATHS[name] || ICON_PATHS.chevron;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }

  /* ───────────── 三个检测站 ─────────────
     名称与「大模型检测」下辖的三个入口一一对应，副标一行说清各自测什么。 */
  const TESTS = [
    { name: '真伪检测', icon: 'check', href: './check/',
      sub: '鉴别中转站真伪，掺假冒充逐项可见' },
    { name: '智商检测', icon: 'iq', href: './iq/',
      sub: 'SVG 画动画，AI 视觉裁判评审是否降智' },
    { name: '归因检测', icon: 'fingerprint', href: './modeltrace/',
      sub: '数字指纹库归因，验证背后究竟哪个模型' },
  ];

  /* ───────────── 品牌图标（平台 logo）注入 ─────────────
     菜单里的 <span data-icon="claude"> 在初始化时按 iconBase 取图。
     取不到就留空（CSS 里 data-icon 有空态底色），不报错、不影响使用。 */
  let iconBase = './check/assets/icons/';
  const iconCache = {};
  function injectIcons(root) {
    (root || document).querySelectorAll('[data-icon]').forEach((el) => {
      const key = el.dataset.icon;
      if (!key) return;
      if (!iconCache[key]) {
        iconCache[key] = fetch(iconBase + key + '.svg')
          .then((r) => (r.ok ? r.text() : ''))
          .catch(() => '');
      }
      iconCache[key].then((svg) => { if (svg) el.innerHTML = svg; });
    });
  }
  window.injectIcons = injectIcons;

  const MENU_CLASS = 'model-dropmenu';
  const OPEN_DELAY = 40;
  const CLOSE_DELAY = 180;
  let currentCloser = null;

  /* 样式随脚本注入：三站共用一份，不必每页各拷一段再各自漂移。
     颜色走各页已有的 CSS 变量，变量缺失时给兜底值。 */
  const CSS = `
  .model-dropmenu {
    position: fixed; z-index: 9999; min-width: 304px; padding: 6px;
    background: var(--card, #fff); border: 1px solid var(--line, #e7e3d8);
    border-radius: 14px; box-shadow: 0 18px 50px -12px rgba(20,17,12,.22), 0 2px 8px rgba(20,17,12,.06);
    opacity: 0; transform: translateY(-6px); pointer-events: none;
    transition: opacity .14s ease, transform .14s ease;
  }
  .model-dropmenu.on { opacity: 1; transform: translateY(0); pointer-events: auto; }
  .model-dropmenu .mdm-cap {
    font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
    color: var(--ink-faint, #8b8678); padding: 7px 10px 5px; font-weight: 600;
  }
  .model-dropmenu .mdm-item {
    display: flex; align-items: center; gap: 11px; width: 100%;
    padding: 9px 10px; border: 0; border-radius: 10px; background: none;
    text-align: left; color: var(--ink, #14110c); cursor: pointer;
    text-decoration: none; font: inherit; transition: background .12s;
  }
  .model-dropmenu .mdm-item:hover,
  .model-dropmenu .mdm-item.on { background: var(--paper-2, #f3f1e9); }
  .model-dropmenu .mdm-ico {
    width: 30px; height: 30px; flex: none; border-radius: 9px;
    display: grid; place-items: center;
    background: var(--paper-2, #f3f1e9); color: var(--ink-soft, #5b564c);
  }
  .model-dropmenu .mdm-ico svg { width: 16px; height: 16px; display: block; }
  .model-dropmenu .mdm-ico[data-icon]:empty { background: var(--paper-2, #f3f1e9); }
  .model-dropmenu .mdm-txt { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .model-dropmenu .mdm-txt b { font-size: 13.5px; font-weight: 600; }
  .model-dropmenu .mdm-txt small {
    font-size: 11px; line-height: 1.45; color: var(--ink-faint, #8b8678);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .model-dropmenu .mdm-go {
    margin-left: auto; flex: none; color: var(--ink-faint, #8b8678);
    opacity: 0; transition: opacity .14s;
  }
  .model-dropmenu .mdm-item:hover .mdm-go,
  .model-dropmenu .mdm-item.on .mdm-go { opacity: 1; }
  .model-dropmenu .mdm-go svg { width: 14px; height: 14px; display: block; }
  .nav-drop-btn { display: inline-flex; align-items: center; gap: 6px; }
  .nav-drop-btn .dc-md { width: 14px; height: 14px; transition: transform .16s; }
  .nav-drop-btn.open .dc-md { transform: rotate(180deg); }
  `;
  let cssDone = false;
  function injectCss() {
    if (cssDone) return;
    const s = document.createElement('style');
    s.id = 'model-drop-css';
    s.textContent = CSS;
    document.head.appendChild(s);
    cssDone = true;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /* 链接拼接分三种情况：
     站内相对路径（./iq/）要加 pathPrefix —— 子页变成 ../iq/；
     站内绝对路径（/dashboard）与站外地址（https://…）原样用，加了前缀会 404。 */
  function itemHtml(t, anchor, current) {
    const isAbsolute = /^([a-z][a-z0-9+.-]*:)?\/\//i.test(t.href) || /^\//.test(t.href);
    const url = isAbsolute ? t.href : anchor + t.href.replace(/^\.\//, '');
    const on = current && current === t.name ? ' on' : '';
    return `<a class="mdm-item${on}" href="${esc(url)}">
      <span class="mdm-ico">${icon(t.icon)}</span>
      <span class="mdm-txt"><b>${esc(t.name)}</b>${t.sub ? `<small>${esc(t.sub)}</small>` : ''}</span>
      <span class="mdm-go">${icon('chevron')}</span>
    </a>`;
  }

  /* ───────────── 通用下拉 ───────────── */
  window.initDropdown = function (containerId, btnId, opts) {
    const o = opts || {};
    if (o.iconBase) iconBase = o.iconBase;
    const box = document.getElementById(containerId);
    const btn = document.getElementById(btnId);
    if (!box || !btn) return null;
    injectCss();
    box.classList.add('model-drop');

    const anchor = o.pathPrefix || './';
    let menu = null, openTimer = null, closeTimer = null, pinned = false;

    function build() {
      menu = document.createElement('div');
      menu.className = MENU_CLASS;
      menu.innerHTML = '<div class="mdm-cap">大模型检测 · 三件套</div>' +
        TESTS.map((t) => itemHtml(t, anchor, o.current)).join('');
      menu.setAttribute('role', 'menu');
      // 挂到 body 而不是导航容器：hero 区元素带 z-index 时会抢走鼠标命中，
      // 菜单随即收到 mouseleave 当场收起，表现为「鼠标靠近就不见了」。
      document.body.appendChild(menu);
      menu.addEventListener('click', (e) => {
        if (e.target.closest('.mdm-item')) close();
      });

      const inMe = (t) => btn.contains(t) || menu.contains(t);
      document.addEventListener('mouseover', (e) => {
        if (btn.contains(e.target)) { open(); return; }
        if (menu.contains(e.target)) { clearTimeout(closeTimer); return; }
        if (menu.classList.contains('on') && !pinned) closeSoon();
      });
      document.addEventListener('click', (e) => { if (!inMe(e.target)) close(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
      window.addEventListener('blur', close);
      // 菜单是 fixed 定位，不跟着页面走；滚动/缩放时收起，免得浮在半空错位
      window.addEventListener('scroll', () => { if (menu.classList.contains('on')) close(); }, { passive: true });
      window.addEventListener('resize', close);
    }

    function place() {
      const r = btn.getBoundingClientRect();
      const mw = menu.offsetWidth || 304;
      let left = o.anchorLeft ? r.left : r.left + r.width / 2 - mw / 2;
      left = Math.max(12, Math.min(left, window.innerWidth - mw - 12));
      menu.style.left = left + 'px';
      menu.style.top = (r.bottom + 8) + 'px';
    }

    function open() {
      clearTimeout(closeTimer);
      if (!menu) build();
      if (currentCloser && currentCloser !== close) currentCloser();
      currentCloser = close;
      clearTimeout(openTimer);
      openTimer = setTimeout(() => {
        place();
        menu.classList.add('on');
        btn.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
        injectIcons(menu);
      }, OPEN_DELAY);
    }

    function closeSoon() {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(close, CLOSE_DELAY);
    }

    function close() {
      clearTimeout(openTimer);
      if (!menu) return;
      menu.classList.remove('on');
      btn.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      if (currentCloser === close) currentCloser = null;
    }

    btn.addEventListener('mouseenter', open);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (menu && menu.classList.contains('on')) { pinned = false; close(); }
      else { pinned = true; open(); }
    });
    box.addEventListener('mouseleave', () => { if (!pinned) closeSoon(); });
    return { close, open, get menu() { return menu; } };
  };

  /* 兼容调用点：语义就是「大模型检测」那个下拉。 */
  window.initModelDrop = function (containerId, btnId, opts) {
    const o = opts || {};
    return window.initDropdown(containerId, btnId, {
      pathPrefix: o.pathPrefix,
      anchorLeft: o.anchorLeft,
      current: o.current,
      iconBase: o.iconBase,
    });
  };

  /* 对外暴露目录与图标，供首页矩阵复用 */
  window.AABAO = { ICON_PATHS, TESTS, icon };
}());
