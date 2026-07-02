/* =====================================================================
 * protocols/openai_signals.js —— OpenAI 渠道「纯信号」判定函数集
 * ---------------------------------------------------------------------
 * 本文件【只放纯函数】：不依赖 DOM、不发请求、不 import 任何带 ?v= 版本号的模块，
 * 因此既能被浏览器（openai_signals.js?v=NN）导入，也能被 Node（node --test）直接
 * 导入做离线单测。综合研判（codex_verdict）与回链探针（upstream_trace）的核心
 * 判定逻辑都抽到这里，保证可测、可复用。
 *
 * 提供：
 *   scanAzureContentFilter(samples) —— 深扫响应体/响应头里的 Azure 内容过滤签名
 *   scanResponseHeaders(samples)    —— 响应头指纹：OpenAI 官方头 / Azure 头 / 逆向中转头三类
 *   classifyOrg(info)               —— 把 IP 归属 org/asn 归类（azure/openai/cdn/cloud/other）
 *   decideConclusion(sig)           —— 汇总各信号 → 纯官/Azure/Codex/非官 等结论态
 * ===================================================================== */

// Azure 在响应体里特有的内容过滤字段名（chat 用 prompt_filter_results + 每 choice
// content_filter_results；Responses/新版用 content_filters 数组 + content_filter_offsets）。
export const AZURE_BODY_KEYS = [
  'content_filter_results',
  'prompt_filter_results',
  'content_filters',
  'content_filter_offsets',
];

// 审核类别键：其值通常是 {filtered, severity}（hate/sexual/violence/self_harm/profanity）
// 或 {detected, filtered}（jailbreak）。selfharm 兼容无下划线写法。
export const MOD_CATEGORIES = ['hate', 'sexual', 'violence', 'self_harm', 'selfharm', 'jailbreak', 'profanity'];

// Azure / APIM 网关特有的响应头：命中任一即可坐实 Azure（OpenAI on Azure），
// 因为这些头是 Azure 基础设施（APIM 网关 / AzureML 管线 / 区域路由）自己加的，
// 官方 openai.com 直连永远不会有。中转可能删，但几乎不会凭空伪造这一整套。
export const AZURE_HEADER_KEYS = [
  'apim-request-id',          // Azure API Management 网关请求 id
  'azureml-model-session',    // AzureML 模型会话（如 d20260620024045-7010d398）
  'azureai-fe-is-streaming',  // Azure AI 前端流式标记
  'x-ms-region',              // Azure 数据中心区域（如 East US 2）
  'x-ms-served-model',        // Azure 实际服务的模型部署名
  'x-ms-client-request-id',
  'x-ms-rai-invoked',         // 负责任 AI（内容审核）已调用
  'x-group-used',             // Azure 路由分组（如 gpt-azure）
];

// OpenAI 官方直连特有的响应头：openai.com 推理层/网关加的，Azure 与逆向通常没有。
export const OPENAI_HEADER_KEYS = [
  'openai-organization',  // 组织 id —— 官方直连最强正向信号
  'openai-processing-ms', // 官方推理层处理耗时
  'openai-version',       // 官方 API 版本
];

// 逆向 / 中转网关常见的「代理特征头」：出现这些（尤其在缺官方头时）是中转/逆向的高价值异常信号。
export const PROXY_HEADER_KEYS = [
  'via', 'x-proxy-id', 'x-gateway', 'x-upstream', 'x-proxy-by', 'x-served-by',
  'x-backend-server', 'x-upstream-addr', 'forwarded', 'x-forwarded-host', 'x-powered-by',
];

// Cloudflare / 边缘头（OpenAI 官方前置常见；中转也可能套 CF，仅作辅助）。
export const CF_HEADER_KEYS = ['cf-ray', 'cf-cache-status', 'alt-svc'];

// x-request-id 是否官方短 UUID 形态（官方常带 req_ 前缀，或标准 UUID）。仅作弱信号、不单独定性。
function isOfficialRequestId(v) {
  if (typeof v !== 'string' || !v) return false;
  return /^req_[A-Za-z0-9]+$/.test(v) || /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(v);
}

// 已知中转软件（one-api / new-api）会带自己的 request-id（如 x-oneapi-request-id），
// 这是「你直连的就是中转软件」的强证据——即便它把上游 openai-*/x-ms-* 头透传，这个头也会暴露它。
function relaySoftwareOf(lk) {
  if (lk.startsWith('x-oneapi') || lk.includes('oneapi') || lk.includes('one-api')) return 'one-api/new-api';
  if (lk.startsWith('x-new-api') || lk.startsWith('x-newapi') || lk.includes('new-api') || lk.includes('newapi')) return 'one-api/new-api';
  return '';
}

/**
 * 响应头指纹：从一组样本的响应头判定上游归属。
 * 判定优先级（特异性从高到低）：
 *   relay-software（one-api/new-api 专属头，证明直连对象是中转软件）
 *   > azure（x-ms-* / apim-* / azureml-* / azureai-* 专属，特异性高于 openai-*）
 *   > openai（openai-* 专属头；x-request-id 是通用头不算）
 *   > relay（无官方头但有代理头 / 头异常少）
 *   > unknown。
 * 注意：透传型中转会把上游 openai- / x-ms- 头原样转发，故 relay-software 命中时，azure/openai 命中
 *       表示「中转背后透传的上游」，最终归属需结合出口 IP/UA（见 decideConclusion）。
 * @param {Array<{headers?:object}>} samples
 */
export function scanResponseHeaders(samples) {
  const openai = new Set(), azure = new Set(), cloudflare = new Set(), proxy = new Set();
  let relaySoftware = '', hasOfficialReqId = false, headerCount = 0;
  const facts = {};
  for (const s of samples || []) {
    const h = s && s.headers;
    if (!h || typeof h !== 'object') continue;
    for (const [k, v] of Object.entries(h)) {
      headerCount++;
      const lk = String(k).toLowerCase();
      // OpenAI 官方专属头：只认 openai-* 前缀（x-request-id 是通用头，谁都有，绝不算官方信号）
      if (lk.startsWith('openai-')) openai.add(`${lk}: ${clipVal(v)}`);
      // Azure 专属头：x-ms-* / apim-* / azureml-* / azureai-* 前缀
      if (lk.startsWith('x-ms-') || lk.startsWith('apim-') || lk.startsWith('azureml-') || lk.startsWith('azureai-')) azure.add(`${lk}: ${clipVal(v)}`);
      if (CF_HEADER_KEYS.includes(lk) || (lk === 'server' && String(v).toLowerCase().includes('cloudflare'))) cloudflare.add(`${lk}: ${clipVal(v)}`);
      if (PROXY_HEADER_KEYS.includes(lk)) proxy.add(`${lk}: ${clipVal(v)}`);
      const rs = relaySoftwareOf(lk);
      if (rs) { if (!relaySoftware) relaySoftware = rs; proxy.add(`${lk}: ${clipVal(v)}  ← 中转软件(${rs})特征`); }
      // 收集高价值附加事实
      if (lk === 'x-ms-served-model') facts.azureServedModel = String(v);
      if (lk === 'x-ms-region') facts.azureRegion = String(v);
      if (lk === 'x-group-used') facts.azureGroup = String(v);
      if (lk === 'openai-version') facts.openaiVersion = String(v);
      if (lk === 'openai-project') facts.openaiProject = String(v);
      if (lk === 'openai-processing-ms') facts.openaiProcessingMs = String(v);
      if (lk === 'x-request-id' && isOfficialRequestId(v)) hasOfficialReqId = true;
    }
  }
  const hasAnyOpenAI = openai.size > 0;
  const hasAnyAzure = azure.size > 0;
  const hasAnyProxy = proxy.size > 0;

  let verdict, label, confidence;
  if (relaySoftware) {
    verdict = 'relay-software';
    label = `🧩 中转软件（${relaySoftware}，命中其专属响应头）`
      + (hasAnyAzure ? '；并透传了 Azure 响应头（上游疑似 Azure OpenAI）'
        : hasAnyOpenAI ? '；并透传了 OpenAI 官方响应头（上游疑似真·OpenAI）' : '');
    confidence = 'high';
  } else if (hasAnyAzure) {
    verdict = 'azure';
    label = '☁️ Azure OpenAI（命中 x-ms-* / apim / azureml 头）';
    confidence = azure.size >= 2 ? 'high' : 'medium';
  } else if (hasAnyOpenAI) {
    verdict = 'openai';
    const strong = openai.size >= 2;
    label = '🤖 OpenAI 官方特征（命中 openai-* 头' + (strong ? '，且多项齐全' : '') + '）';
    confidence = strong ? 'high' : 'medium';
  } else if (hasAnyProxy) {
    verdict = 'relay';
    label = '🚨 非官方 / 逆向中转（无 openai-*、x-ms-* 头，且出现代理头）';
    confidence = 'medium';
  } else if (headerCount > 0 && headerCount <= 6) {
    // 头异常少但没有代理头：只是弱信号，不武断判逆向（很多正常响应头本就不多）。
    verdict = 'sparse';
    label = '⚠️ 响应头偏少且无官方特征头（弱信号，需结合其它维度）';
    confidence = 'low';
  } else {
    verdict = headerCount > 0 ? 'unknown' : 'none';
    label = headerCount > 0 ? '❓ 无法判定（无官方特征头，也无明显代理头）' : '未捕获到响应头';
    confidence = 'low';
  }

  const signals = [];
  if (relaySoftware) signals.push(`中转软件特征：${relaySoftware}`);
  if (azure.size) signals.push(`Azure 专属头：${[...azure].join('；')}`);
  if (openai.size) signals.push(`OpenAI 官方头：${[...openai].join('；')}`);
  if (cloudflare.size) signals.push(`Cloudflare/边缘头：${[...cloudflare].join('；')}`);
  if (proxy.size) signals.push(`代理/中转头：${[...proxy].join('；')}`);
  if (verdict === 'sparse') signals.push('响应头偏少且无官方特征头（弱信号）');

  return {
    verdict, label, confidence, relaySoftware, facts, headerCount,
    openai: [...openai], azure: [...azure], cloudflare: [...cloudflare], proxy: [...proxy],
    hasOfficialReqId, hasAnyOpenAI, hasAnyAzure, hasAnyProxy, signals,
  };
}

function clipVal(v) { const s = String(v == null ? '' : v); return s.length > 120 ? s.slice(0, 120) + '…' : s; }

/* ---------- 深度递归扫描一份响应体 JSON，累加 Azure 审核信号 ---------- */
function deepScan(node, acc, depth) {
  if (depth > 10 || node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) deepScan(x, acc, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    const lk = k.toLowerCase();
    if (AZURE_BODY_KEYS.includes(lk)) acc.keys.add(lk);
    // 审核类别对象：{filtered, severity} 或 {detected, filtered}
    if (MOD_CATEGORIES.includes(lk) && v && typeof v === 'object' && !Array.isArray(v)
        && ('filtered' in v || 'severity' in v || 'detected' in v)) {
      acc.categories.add(lk === 'selfharm' ? 'self_harm' : lk);
      if (v.filtered === true || v.detected === true) acc.anyBlocked = true;
      if (typeof v.severity === 'string' && v.severity.toLowerCase() !== 'safe') acc.anyBlocked = true;
    }
    // 顶层 blocked:true（content_filters 数组项常见）
    if (lk === 'blocked' && v === true) acc.anyBlocked = true;
    deepScan(v, acc, depth + 1);
  }
}

/**
 * 深扫一组响应样本，识别 Azure 内容过滤签名。
 * @param {Array<{json?:object, headers?:object}>} samples 前序探针的响应体/响应头快照
 * @returns {{detected:boolean, bodyDetected:boolean, headerDetected:boolean,
 *            anyBlocked:boolean, keys:string[], categories:string[],
 *            headerSignals:string[], signals:string[]}}
 */
export function scanAzureContentFilter(samples) {
  const acc = { keys: new Set(), categories: new Set(), anyBlocked: false };
  const headerSignals = new Set();
  for (const s of samples || []) {
    if (s && s.json) deepScan(s.json, acc, 0);
    const h = s && s.headers;
    if (h && typeof h === 'object') {
      for (const hk of Object.keys(h)) {
        if (AZURE_HEADER_KEYS.includes(String(hk).toLowerCase())) headerSignals.add(String(hk).toLowerCase());
      }
    }
  }
  const bodyDetected = acc.keys.size > 0 || acc.categories.size > 0;
  const headerDetected = headerSignals.size > 0;
  const signals = [];
  if (acc.keys.size) signals.push(`响应体含 Azure 内容过滤字段：${[...acc.keys].join(', ')}`);
  if (acc.categories.size) signals.push(`审核类别：${[...acc.categories].join(' / ')}${acc.anyBlocked ? '（有命中或非 safe）' : '（均 safe）'}`);
  if (headerDetected) signals.push(`Azure 响应头：${[...headerSignals].join(', ')}`);
  return {
    detected: bodyDetected || headerDetected,
    bodyDetected,
    headerDetected,
    anyBlocked: acc.anyBlocked,
    keys: [...acc.keys],
    categories: [...acc.categories],
    headerSignals: [...headerSignals],
    signals,
  };
}

/**
 * 把一个 IP 的归属信息归类。
 * @param {string|{org?:string,isp?:string,as?:string,asname?:string,asn?:string}} info
 * @returns {{kind:'azure'|'openai'|'cdn'|'cloud'|'other'|'unknown', label:string}}
 */
export function classifyOrg(info) {
  const hay = (typeof info === 'string'
    ? info
    : [info && info.org, info && info.isp, info && info.as, info && info.asname, info && info.asn]
        .filter(Boolean).join(' ')).toLowerCase();
  if (!hay.trim()) return { kind: 'unknown', label: '未知' };
  if (/\bmicrosoft\b|azure|msft/.test(hay)) return { kind: 'azure', label: 'Microsoft / Azure 网段' };
  if (/openai/.test(hay)) return { kind: 'openai', label: 'OpenAI 自有网段' };
  if (/cloudflare/.test(hay)) return { kind: 'cdn', label: 'Cloudflare（CDN / 前置）' };
  if (/amazon|\baws\b|ec2/.test(hay)) return { kind: 'cloud', label: 'Amazon AWS（疑中转）' };
  if (/google|gcp|1e100/.test(hay)) return { kind: 'cloud', label: 'Google Cloud（疑中转）' };
  if (/oracle|\bovh\b|hetzner|digitalocean|linode|akamai|fastly|vultr|tencent|alibaba|aliyun|huawei|ucloud/.test(hay)) {
    return { kind: 'cloud', label: '云厂商 / IDC（疑中转）' };
  }
  return { kind: 'other', label: typeof info === 'string' ? info : ((info && (info.org || info.isp)) || '未知') };
}

/**
 * 综合研判：把渠道/注入/截断/Azure/回链上游各信号汇总成一个结论态。
 * @param {{
 *   channelCode?:string,        // channel_id/identity 判出的渠道码：openai/codex/chat_shape/foreign/unknown
 *   truncOk?:boolean|null,      // param_check：max_output_tokens 是否精确截断+计费（null=未跑）
 *   injSuspected?:boolean,      // param_check：两句 input_tokens 是否都偏高
 *   identityCodex?:boolean,     // identity：是否自发肯定自己是 codex
 *   azure?:ReturnType<typeof scanAzureContentFilter>|null,
 *   headers?:ReturnType<typeof scanResponseHeaders>|null,  // 响应头指纹
 *   upstream?:{kind:string, org?:string, uaSawOpenAI?:boolean, uaSawAzure?:boolean}|null  // 回链：出口 IP org 归类 + 出口 UA 自报
 * }} sig
 * @returns {{conclusion:string, verdict:string, severity:string, score:number, reasons:string[]}}
 */
export function decideConclusion(sig) {
  sig = sig || {};
  const isRespOfficial = sig.channelCode === 'openai' || sig.channelCode === 'codex';
  const azureDetected = !!(sig.azure && sig.azure.detected);
  const hdr = sig.headers || null;
  const headerSays = hdr ? hdr.verdict : 'none';     // relay-software/azure/openai/relay/unknown/none
  const headerAzure = !!(hdr && hdr.hasAnyAzure);    // 响应头透传/命中 Azure 专属头
  const headerOpenAI = !!(hdr && hdr.hasAnyOpenAI);  // 响应头透传/命中 openai-* 专属头（x-request-id 不算）
  // 铁证级 OpenAI 官方头：openai-organization / openai-project 属 openai.com 账户体系专属，
  // 真正的 Azure OpenAI 服务【绝不会】带这些头。有它 = OpenAI 官方铁证，是区分 OpenAI vs Azure 的最强依据。
  // 关键认知：OpenAI 官方推理本就跑在微软 Azure 基础设施上，「出口 IP 在微软云」对官方/Azure 都成立，
  //   绝不能单独作为 Azure 判据；真正区分二者的是这些专属响应头/审核签名。
  const hdrOpenAIList = (hdr && hdr.openai) || [];
  const headerOpenAIStrong = hdrOpenAIList.some((s) => /^openai-(organization|project)\b/i.test(s));

  // 末端出口（回链探针）：IP 归属 + 出口 UA 自报。kind: azure/openai/cloud/cdn/other/none/error
  const up = sig.upstream || null;
  const upKind = up && up.kind;
  const exitMicrosoft = upKind === 'azure';
  const exitOpenAIIp = upKind === 'openai';
  const exitOther = upKind === 'cloud' || upKind === 'cdn' || upKind === 'other';
  const uaSawOpenAI = !!(up && up.uaSawOpenAI);
  const uaSawAzure = !!(up && up.uaSawAzure);
  const exitLabel = (up && (up.org || up.label)) || '';
  const identityCodex = !!sig.identityCodex;
  const injSuspected = !!sig.injSuspected;

  // 中转软件(one-api/new-api)只是「你直连的传输层」——夹一层中转是正常现象，不是末端上游归属本身。
  // 因此它【不作为结论】，只在依据里附一句注记；下面照常判定它转发的【真实末端上游】渠道与真假。
  const relayNote = (headerSays === 'relay-software' && hdr && hdr.relaySoftware)
    ? `直连传输层为中转软件 ${hdr.relaySoftware}（夹一层中转属正常，以下研判其转发的真实末端上游）`
    : '';
  const R = (arr) => (relayNote ? [relayNote, ...arr] : arr);

  // 0) 非 resp_ 官方前缀（chatcmpl- / 异常格式）→ 末端响应本身就不对，套壳/逆向
  if (!isRespOfficial) {
    const rs = [];
    if (azureDetected || headerAzure) rs.push('含 Azure 签名/响应头，但响应本身已是非官方格式（套壳）');
    rs.push('响应 id 非官方 resp_ 前缀 → 套壳 / 逆向');
    return { conclusion: '非官渠道（套壳 / 逆向）', verdict: '假', severity: 'critical', score: 0, reasons: R(rs) };
  }

  // B) 明确逆向：响应头无任何官方/Azure 特征 + 代理头/头异常少。
  //    注意：relay-software（one-api 等正规中转）不算逆向——它会透传官方头，要继续判其上游，不在此拦截。
  if (headerSays === 'relay') {
    const rs = ['响应头缺少 openai-*/x-ms-* 官方特征' + (hdr.hasAnyProxy ? '，且出现代理头' : '，且响应头异常少')];
    if (exitMicrosoft) {
      rs.push(`但回链出口 IP 在微软云（${exitLabel}）→ 信号矛盾，无法断定，请复核`);
      return { conclusion: '存疑：响应头像逆向但出口在微软云', verdict: '存疑', severity: '', score: 50, reasons: R(rs) };
    }
    if (exitOther) rs.push(`回链出口 IP 落在第三方机房/VPS（${exitLabel}），二者一致`);
    return { conclusion: '非官渠道（逆向）', verdict: '假', severity: 'critical', score: 0, reasons: R(rs) };
  }

  // C) Azure：真 Azure 服务标志（x-ms-*/apim-*/azureml- 头 或 内容审核签名 或 出口 UA 自报 azure）。
  //    且无铁证级官方头 openai-organization/project（真 Azure 绝不会有）。
  //    「出口 IP 在微软云」对 OpenAI 官方也成立，绝不能单独当 Azure 判据。
  if ((headerAzure || azureDetected || uaSawAzure) && !headerOpenAIStrong) {
    const rs = [];
    if (headerAzure) rs.push(`检出 Azure 基础设施响应头：${hdr.azure.join('；')}（APIM 网关/AzureML/区域路由，官方直连不会有）`);
    if (azureDetected) rs.push('检出 Azure 内容过滤签名（有审核 → 一定不是 openai.com 直连）');
    if (uaSawAzure) rs.push('回链出口 UA 自报 Azure');
    if (exitMicrosoft) rs.push(`回链出口 IP 属微软云（${exitLabel}），互相印证`);
    if (headerAzure && exitOther && !exitMicrosoft) {
      rs.push(`但出口 IP 实际落在 ${exitLabel}（非微软云）→ 疑中转透传了 Azure 响应头，无法确定真实上游，请人工复核`);
      return { conclusion: '存疑：响应头像 Azure，出口 IP 不在微软云', verdict: '存疑', severity: '', score: 50, reasons: R(rs) };
    }
    return { conclusion: 'Azure（OpenAI on Azure）', verdict: '真', severity: '', score: 100, reasons: R(rs) };
  }

  // D) Codex：模型身份自述为 codex —— 强且具体的信号，优先于通用 OpenAI 判定。
  //    Codex 是 OpenAI 官方的 CLI 工具、经 OpenAI 官方上游，故结论标明「上游 OpenAI 官方」。
  if (identityCodex) {
    const rs = ['模型身份自述为 Codex → 可断言 Codex（OpenAI 官方 CLI 工具，身份自述是强证据）'];
    if (headerOpenAI) rs.push(`响应头含 openai-* 官方特征：${hdr.openai.join('；')}，佐证上游为 OpenAI 官方`);
    if (uaSawOpenAI) rs.push('回链出口 UA 自报 OpenAI');
    if (exitOpenAIIp) rs.push(`回链出口 IP 属 OpenAI 自有网段（${exitLabel}）`);
    else if (exitMicrosoft) rs.push(`回链出口 IP 在微软云（${exitLabel}，OpenAI 官方推理跑在 Azure 上）`);
    if (injSuspected) rs.push('两句 input_tokens 偏高，符合 Codex 注入系统提示词的特征');
    return { conclusion: 'Codex（上游 OpenAI 官方）', verdict: '真', severity: '', score: 100, reasons: R(rs) };
  }

  // E) OpenAI 官方：需「直接证据」——响应头 openai-* 或出口 UA/IP 任一坐实
  if (headerOpenAI || exitOpenAIIp || uaSawOpenAI) {
    const rs = [];
    if (exitOpenAIIp || uaSawOpenAI || exitMicrosoft) {
      if (headerOpenAI) rs.push(`响应头含 openai-* 官方特征：${hdr.openai.join('；')}`);
      if (uaSawOpenAI) rs.push('回链出口 UA 自报 OpenAI（如 "OpenAI Image Downloader"，强归属信号）');
      if (exitOpenAIIp) rs.push(`回链出口 IP 归属 OpenAI 自有网段（${exitLabel}）`);
      else if (exitMicrosoft) rs.push(`回链出口 IP 落在微软云（${exitLabel}，OpenAI 官方推理跑在 Azure 基础设施上）`);
      return { conclusion: 'OpenAI 官方（高可信）', verdict: '真', severity: '', score: 100, reasons: R(rs) };
    }
    if (exitOther) {
      rs.push(`响应头含 openai-* 特征，但回链出口 IP 实际落在 ${exitLabel}（非官方云段）→ 强烈怀疑「透传 openai- 响应头的中转」`);
      rs.push('这正是只看响应头会被骗、必须结合出口 IP 的典型情形，无法确定真实上游，请自行核实');
      return { conclusion: '存疑：响应头像官方，出口 IP 在第三方', verdict: '存疑', severity: '', score: 40, reasons: R(rs) };
    }
    rs.push(`响应头含 openai-* 官方特征：${hdr.openai.join('；')}`);
    rs.push('但未捕获到出口 IP（官方常在纯转发层不下载图片）→ 倾向官方但未达"纯官"定论，建议结合回链核实');
    return { conclusion: '倾向 OpenAI 官方（中等可信，缺出口直证）', verdict: '真', severity: '', score: 80, reasons: R(rs) };
  }

  // E2) 无任何官方/Azure 响应头特征，但回链出口 IP 落在微软云 → 基本判断为官方（跑在 Azure 上）
  if (exitMicrosoft) {
    const rs = [`回链出口 IP 落在微软云（${exitLabel}）→ 基本判断为官方上游（OpenAI 官方推理即部署在 Azure 上）`,
      '注意：响应头未捕获到 openai-* / x-ms-* 归属特征，无法进一步区分「OpenAI 官方」与「第三方 Azure 部署」，仅凭出口 IP 定性，请知悉'];
    return { conclusion: '基本官方（出口微软云，OpenAI/Azure 难细分）', verdict: '真', severity: '', score: 85, reasons: R(rs) };
  }

  // F) 协议层异常（截断不精确）→ 疑网关/逆向
  if (sig.truncOk === false) {
    const rs = ['响应像官方 resp_，但 max_output_tokens 未被精确截断+计费 → 上游疑为网关/逆向'];
    if (hdr && hdr.headerCount && hdr.headerCount <= 6) rs.push('且响应头异常少 → 官方头疑被中转剥离');
    return { conclusion: '非官渠道（疑网关 / 逆向）', verdict: '存疑', severity: '', score: 30, reasons: R(rs) };
  }

  // G) 疑提示词注入（input_tokens 偏高但问不出 codex）
  if (injSuspected) {
    return { conclusion: '官方上游·疑提示词注入（待核实）', verdict: '存疑', severity: '', score: 60,
      reasons: R(['官方 resp_ 且截断正常，但两句 input_tokens 明显偏高 → 上游被注入系统提示词，来源未知']) };
  }

  // H) 协议像官方，但无任何响应头指纹、无回链出口证据 → 无法断言归属（存疑，交用户判断）
  const rs = [];
  if (sig.truncOk === true) rs.push('协议特征齐全：resp_ + max_output_tokens 精确截断计费 + 无注入（说明上游行为像官方）');
  else rs.push('（快测档未跑参数强验真，结论信号更不足）');
  rs.push('但未捕获到任何响应头指纹（无 openai-* / x-ms-* / apim- 等归属特征头），回链也未捕获出口 IP');
  rs.push('→ 无法断定是官方直连、Azure 还是透传型中转。请跑「末端上游回链探测」或检查响应头后自行判断');
  return { conclusion: '无法确定上游归属（协议像官方，但缺归属证据）', verdict: '存疑', severity: '', score: 60, reasons: R(rs) };
}
