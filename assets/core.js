/* =====================================================================
 * core.js —— 御三家检测站 · 通用引擎
 * 被 index.html 以 <script type="module"> 引入。
 * 提供：发请求(走 PHP 代理) / SSE 解析 / JSON Schema 轻量校验 /
 *       渠道识别 / 注释剥离 / 打分汇总 / 卡片渲染 / 分享 / PNG 导出。
 * ===================================================================== */

// 后端代理地址（默认同目录 api/）。高级设置里可覆盖。
export const PROXY = {
  base: './api',
};

/* ---------- 工具：剥离 JSON 里的 // 注释行（兼容用户带注释的请求体） ---------- */
export function stripJsonComments(text) {
  // 去掉整行 // 注释 和 行尾 // 注释（简单实现，够用：不处理字符串内的 //）
  return text
    .split('\n')
    .map((line) => {
      // 保护字符串里的 ://（如 https://）：只在没有引号包裹时剥离
      const idx = findCommentStart(line);
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

function findCommentStart(line) {
  let inStr = false, q = '';
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === q) inStr = false;
    } else {
      if (c === '"' || c === "'") { inStr = true; q = c; }
      else if (c === '/' && line[i + 1] === '/') return i;
    }
  }
  return -1;
}

/** 安全解析 JSON：先剥注释再 parse。返回 {ok, value, error}。 */
export function parseJsonLoose(text) {
  if (!text || !text.trim()) return { ok: false, error: '空内容' };
  try {
    return { ok: true, value: JSON.parse(stripJsonComments(text)) };
  } catch (e) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e2) {
      return { ok: false, error: String(e2) };
    }
  }
}

/* ---------- 发请求：统一走 probe.php ---------- */
/**
 * @param {object} cfg  { targetUrl, apiKey, authStyle }
 * @param {object} payload 请求体对象
 * @param {object} extraHeaders 附加头
 * @returns {Promise<{ok, httpStatus, headers, body, requestId, error}>}
 */
export async function proxyFetch(cfg, payload, extraHeaders = {}) {
  const res = await fetch(`${PROXY.base}/probe.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetUrl: cfg.targetUrl,
      apiKey: cfg.apiKey,
      authStyle: cfg.authStyle || 'x-api-key',
      payload,
      extraHeaders,
    }),
  });
  return res.json();
}

/** ping 后端，返回品牌信息或 null。 */
export async function pingBackend() {
  try {
    const r = await fetch(`${PROXY.base}/probe.php?action=ping`);
    const j = await r.json();
    return j.ok ? j : null;
  } catch {
    return null;
  }
}

/* ---------- SSE 解析：把流式响应文本还原成事件序列 + 最终消息 ---------- */
/**
 * @param {string} text  原始 SSE 文本（data: {...}\n\n ...）
 * @returns {{events:Array, message:object|null, eventTypes:string[]}}
 */
export function parseSSE(text) {
  const events = [];
  const eventTypes = [];
  const blocks = text.split(/\n\n/);
  for (const block of blocks) {
    let eventType = null;
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) {
      const dataStr = dataLines.join('\n');
      if (dataStr === '[DONE]') { eventTypes.push('done'); continue; }
      try {
        const obj = JSON.parse(dataStr);
        events.push(obj);
        eventTypes.push(eventType || obj.type || 'data');
      } catch {
        /* 忽略无法解析的块 */
      }
    }
  }
  // 重建最终消息（Anthropic 风格：message_start + content_block_delta 累积）
  const message = rebuildAnthropicMessage(events);
  return { events, message, eventTypes };
}

function rebuildAnthropicMessage(events) {
  let msg = null;
  const blocks = [];
  for (const ev of events) {
    if (ev.type === 'message_start' && ev.message) {
      msg = JSON.parse(JSON.stringify(ev.message));
    } else if (ev.type === 'content_block_start') {
      blocks[ev.index] = JSON.parse(JSON.stringify(ev.content_block || {}));
    } else if (ev.type === 'content_block_delta') {
      const b = blocks[ev.index] || (blocks[ev.index] = {});
      const d = ev.delta || {};
      if (d.type === 'text_delta') b.text = (b.text || '') + (d.text || '');
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + (d.thinking || '');
      else if (d.type === 'signature_delta') b.signature = (b.signature || '') + (d.signature || '');
      else if (d.type === 'input_json_delta') b.partial_json = (b.partial_json || '') + (d.partial_json || '');
    } else if (ev.type === 'message_delta' && ev.usage && msg) {
      msg.usage = Object.assign({}, msg.usage, ev.usage);
      if (ev.delta) Object.assign(msg, ev.delta);
    }
  }
  if (msg) {
    // 把 tool_use 的 partial_json 收尾
    for (const b of blocks) {
      if (b && b.partial_json && !b.input) {
        try { b.input = JSON.parse(b.partial_json); } catch { /* ignore */ }
      }
    }
    msg.content = blocks.filter(Boolean);
  }
  return msg;
}

/* ---------- 渠道识别：根据 message id 前缀判定来源 ---------- */
export function detectChannelById(id) {
  if (typeof id !== 'string' || !id) return { channel: '未知', code: 'unknown', critical: false };
  if (id.startsWith('msg_bdrk_')) return { channel: 'AWS Bedrock', code: 'bedrock', critical: false };
  if (id.startsWith('msg_vrtx_')) return { channel: 'Google Vertex', code: 'vertex', critical: false };
  if (id.startsWith('msg_')) return { channel: 'Anthropic 直连', code: 'anthropic', critical: false };
  if (id.startsWith('chatcmpl-')) return { channel: 'OpenAI 兼容端(疑套壳)', code: 'openai_shape', critical: true };
  return { channel: '非官方格式(疑套壳)', code: 'foreign', critical: true };
}

/* ---------- 轻量 JSON Schema 校验（够用：type/required/additionalProperties/嵌套） ---------- */
export function validateSchema(obj, schema, path = '$') {
  const errors = [];
  const t = schema.type;
  const jt = jsonType(obj);
  if (t && t !== jt && !(t === 'integer' && jt === 'number' && Number.isInteger(obj))) {
    errors.push(`${path} 期望 ${t}，实际 ${jt}`);
    return errors; // 类型都不对，不再深入
  }
  if (t === 'object') {
    const props = schema.properties || {};
    for (const req of schema.required || []) {
      if (!(req in (obj || {}))) errors.push(`${path} 缺少必需字段 "${req}"`);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj || {})) {
        if (!(k in props)) errors.push(`${path} 出现多余字段 "${k}"`);
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (obj && k in obj) errors.push(...validateSchema(obj[k], sub, `${path}.${k}`));
    }
  } else if (t === 'array' && schema.items) {
    (obj || []).forEach((item, i) => errors.push(...validateSchema(item, schema.items, `${path}[${i}]`)));
  } else if (Array.isArray(schema.enum) && !schema.enum.includes(obj)) {
    errors.push(`${path} 值 "${obj}" 不在枚举 ${JSON.stringify(schema.enum)}`);
  }
  return errors;
}

function jsonType(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v === 'object' ? 'object' : typeof v;
}

/* ---------- 打分汇总：加权平均 + CRITICAL 封顶 ---------- */
/**
 * @param {Array} results  每项 {weight, score, severity, status}
 * @returns {{total, level, verdict, hasCritical}}
 */
export function scoreTotal(results) {
  let sumW = 0, sumWS = 0, hasCritical = false;
  for (const r of results) {
    if (r.status === 'skip' || r.score == null) continue;
    sumW += r.weight;
    sumWS += r.score * r.weight;
    if (r.severity === 'critical') hasCritical = true;
  }
  let total = sumW > 0 ? Math.round(sumWS / sumW) : 0;

  let level, verdict;
  if (total >= 85) { level = 'excellent'; verdict = '高度可信'; }
  else if (total >= 70) { level = 'pass'; verdict = '基本可信'; }
  else if (total >= 50) { level = 'marginal'; verdict = '存疑'; }
  else { level = 'fail'; verdict = '不可信'; }

  // 硬否决：命中 CRITICAL 时，评级最高只能"存疑"
  if (hasCritical && total >= 70) {
    level = 'marginal';
    verdict = '存疑（命中严重异常）';
  }
  return { total, level, verdict, hasCritical };
}

/* ---------- 严重度/状态 → 徽标文本 ---------- */
export function verdictBadge(r) {
  if (r.status === 'skip') return { text: '⏭ 跳过', cls: 'skip' };
  if (r.status === 'error') return { text: '⚠ 出错', cls: 'warn' };
  if (r.verdict === '真' || r.score >= 70) return { text: `✅ 真 ${r.score}`, cls: 'pass' };
  if (r.verdict === '不适用') return { text: '➖ 不适用', cls: 'na' };
  if (r.score >= 40) return { text: `⚠ 存疑 ${r.score}`, cls: 'warn' };
  return { text: `❌ 假 ${r.score}`, cls: 'fail' };
}

/* ---------- HTML 转义 ---------- */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function pretty(objOrStr) {
  if (typeof objOrStr === 'string') {
    try { return JSON.stringify(JSON.parse(objOrStr), null, 2); } catch { return objOrStr; }
  }
  try { return JSON.stringify(objOrStr, null, 2); } catch { return String(objOrStr); }
}

/* ---------- 调后端生成 GLM 总结 ---------- */
export async function generateSummary(reportPayload) {
  try {
    const r = await fetch(`${PROXY.base}/summary.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reportPayload),
    });
    return r.json();
  } catch (e) {
    return { ok: false, error: String(e), fallback: true };
  }
}

/* ---------- 分享：存后端短链 / 退化 hash ---------- */
export async function shareReport(reportPayload) {
  // 1) 试后端短链
  try {
    const r = await fetch(`${PROXY.base}/share.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reportPayload),
    });
    const j = await r.json();
    if (j.ok && j.id) {
      const url = new URL('report', location.href);
      url.searchParams.set('id', j.id);
      return { ok: true, mode: 'short', url: url.toString() };
    }
  } catch { /* 落到 hash */ }

  // 2) 退化：URL hash 静态分享
  const packed = btoa(unescape(encodeURIComponent(JSON.stringify(reportPayload))));
  const url = new URL('report', location.href);
  url.hash = 'data=' + packed;
  return { ok: true, mode: 'hash', url: url.toString() };
}

/* ---------- PNG 导出（需页面已引入 html2canvas） ----------
 * 注意：html2canvas 不复现浏览器对 <details> 的原生折叠语义——折叠区里的内容
 * 会被照常画出且叠在 summary 上（截图重叠）。因此导出前临时展开容器内所有
 * <details>（记住原本是否 open），截完图再还原，保证 PNG 里每项明细正常铺开。 */
export async function exportPng(el, filename = 'report.png') {
  if (typeof window.html2canvas !== 'function') {
    alert('PNG 导出组件未加载（html2canvas）。请检查网络或改用链接分享。');
    return;
  }
  const details = [...el.querySelectorAll('details')];
  const prevOpen = details.map((d) => d.open);
  details.forEach((d) => { d.open = true; });
  try {
    const canvas = await window.html2canvas(el, { backgroundColor: '#faf9f5', scale: 2, useCORS: true });
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = filename;
    a.click();
  } finally {
    // 无论成功与否都还原折叠状态，避免改动用户当前看到的页面
    details.forEach((d, i) => { d.open = prevOpen[i]; });
  }
}

/* ---------- 字符串相似度（0~1，用于流式/非流式一致性） ---------- */
export function similarity(a, b) {
  a = (a || '').trim().toLowerCase().replace(/\s+/g, ' ');
  b = (b || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  // 基于较短串在较长串中的最长公共子串占比的粗略度量（够用）
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  let same = 0;
  for (let i = 0; i < shorter.length; i++) if (longer.includes(shorter[i])) same++;
  // 用编辑距离更准
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n];
}

/* ---------- 简易变异系数（一致性探针用） ---------- */
export function coefficientOfVariation(nums) {
  const arr = nums.filter((n) => typeof n === 'number');
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  if (mean === 0) return 0;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance) / mean;
}
