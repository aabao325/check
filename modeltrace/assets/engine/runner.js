/* =====================================================================
 * engine/runner.js —— 检测编排：以「三份有效回答」为目标
 * ---------------------------------------------------------------------
 * 流程（与 ModelTrace enrollment.test_automatic 一致，另加了并发与提前终止）：
 *   生成 6 条随机探针 → 前 3 条**同时起飞**，从共享队列领任务 → 数字达标的计入
 *   → 凑满 3 份就停。某条作废（数字不足 / 被截断 / 上游 5xx）就由空闲的 worker
 *   补下一条，最多用到第 6 条。
 *
 * 为什么是「三条直接并发」而不是「先单跑一条探协议」：
 *   绝大多数中转站同时提供 OpenAI Chat Completions 与 Anthropic Messages 两种协议，
 *   为「不确定用哪种」先花一整次请求去探路，纯属白等一次往返（整轮耗时从 2× 变 1×）。
 *   所以这里按 Base URL 猜一个默认协议直接开跑（贴了 /messages 结尾就用 Anthropic，
 *   其余一律 OpenAI），三条探针用同一个协议。
 *   **兜底**：万一整轮一条都没成功、且失败原因全是「格式不对」，说明猜错了 ——
 *   此时换另一种协议把这几条重跑一遍（最多 6 次请求，与最坏情况的上限一致，不额外超支）。
 *   只要有任意一条成功过，就认定协议猜对了，后面不再回头换。
 *
 * 提前终止：鉴权失败 / 模型名不认 / 网络不通 / 限流 —— 这几类错误重试也没用，
 * 继续发只会白白烧用户的额度，所以立即停下并告诉用户原因。
 * 只有「这一份数字不够 / 被截断 / 上游 5xx」才换下一条探针继续。
 *
 * 不碰 DOM：进度通过 onEvent 回调抛给界面。
 * ===================================================================== */
import { generateChallenges } from './challenges.js?v=13';
import { parseNumbers, minimumNumbers } from './fingerprint.js?v=13';
import { requestCompletion, formatOrder, ProbeError, FORMATS } from './transport.js?v=13';

export const TARGET_VALID = 3;
export const MAX_ATTEMPTS = 6;
/* 两种协议的固定全集，给「整轮换协议重跑」挑另一种用。顺序无关紧要 —— 这里只是枚举。 */
const FORMAT_ORDER_ALL = ['openai', 'responses', 'anthropic'];
/* 重试也没用的错误：直接终止整轮，不再烧额度。
 * ⚠️ 'format' 不在此列 —— 协议是开跑前定下的，「格式不对」只说明选错了，
 * 由 runDetection 末尾那轮整轮换协议重跑来兜。见 one() 里的注释。 */
const FATAL = new Set(['auth', 'model', 'network', 'quota', 'aborted']);

/* onEvent(e)：
 *   { type:'attempt', index, challenge }              开始第 index 条
 *   { type:'progress', index, parsed, expected }       流式中实时解析出的数字个数
 *   { type:'format', format }                          用上了哪种接口格式
 *   { type:'accepted', index, parsed, minimum, ms }    计入
 *   { type:'rejected', index, reason, parsed? }        作废（继续下一条）
 *   { type:'fatal', error }                            终止 */
export async function runDetection({ baseUrl, apiKey, model, protocol = 'auto', customPath = '', signal, onEvent = () => {}, request = requestCompletion, challenges = generateChallenges(MAX_ATTEMPTS) }) {
  const outputs = [];
  const attempts = [];
  let viaProxy = false;
  let fatal = null;
  /* 协议：用户在下拉里怎么选就怎么用（auto 时按 Base URL 推断一个默认值）。
   *
   * 早先是「猜一个再兜底翻另一种」，因为那时只有 chat/messages 两条路可猜。
   * 现在多出 /v1/responses，且用户的模型常常只认它，光靠地址猜不出来了 ——
   * 所以把选择权交给用户，猜测只作为 auto 模式的行为保留。
   * 猜之前不花任何请求去探路。 */
  const locked = protocol !== 'auto';          // 用户显式选了路径 → 不许再翻
  let format = locked ? protocol : formatOrder(baseUrl)[0];
  onEvent({ type: 'format', format, locked });

  /* 跑一条探针。成功计入返回 true；作废返回 false；遇到不可重试的错误把 fatal 置上并返回 false。
   *
   * 三条探针**同时**调这里，各自带自己的 index 和协议 —— 不存在「谁发起探测、谁有权用掉
   * 这次探测的回答」那种归属问题（早先单跑一条探协议就是为了绕开它）。
   * 每条探针的提示词只发一次：作废时由空闲 worker 换**下一条**探针，绝不重发同一条。 */
  async function one(index) {
    if (fatal || signal?.aborted) return false;
    const ch = challenges[index];
    if (!ch) return false;
    onEvent({ type: 'attempt', index, challenge: ch });
    const onText = (full) => onEvent({ type: 'progress', index, parsed: parseNumbers(full).length, expected: ch.expected_count });
    try {
      const r = await request({ baseUrl, apiKey, model, format, customPath, prompt: ch.prompt, system: ch.system, signal, onText });
      viaProxy = viaProxy || !!r.viaProxy;
      const parsed = parseNumbers(r.text).length;
      const minimum = minimumNumbers(ch.expected_count);
      if (parsed >= minimum) {
        outputs.push({ text: r.text, expected_count: ch.expected_count, ms: r.ms, index });
        attempts.push({ index, status: 'accepted', parsed, minimum, ms: r.ms });
        onEvent({ type: 'accepted', index, parsed, minimum, ms: r.ms });
        return true;
      }
      const reason = `有效数字不足：解析到 ${parsed} 个，至少需要 ${minimum} 个`;
      attempts.push({ index, status: 'rejected', parsed, minimum, reason });
      onEvent({ type: 'rejected', index, reason, parsed });
      return false;
    } catch (e) {
      const err = e instanceof ProbeError ? e : new ProbeError('upstream', String(e?.message || e));
      // kind==='format' 在这里**不再是终止条件**：协议是一开始就猜定并固定下来的，
      // 「格式不对」只说明猜错了 —— 交给调用层整轮换协议重跑，而不是把这次当致命错误停下。
      // 早先它是 FATAL 成员，因为那时每条探针都自己探格式、报 format 就意味着两种都不通。
      if (FATAL.has(err.kind)) {
        attempts.push({ index, status: 'fatal', reason: err.message, kind: err.kind });
        // 只认第一次 fatal：并行时另外两条也会陆续抛错，界面上要显示的永远是「最初那个原因」。
        // ⚠️ index 必须带上：界面上每条探针一个槽位，靠 index 把出错的格子标红。
        // 早先只传 error，e.index 是 undefined → setSlot(undefined) 直接 return，
        // 结果出错的格子永远停在「请求中」转圈，用户看不到是第几条挂了。
        if (!fatal) {
          fatal = err;
          onEvent({ type: 'fatal', index, error: err });
        }
        return false;
      }
      attempts.push({ index, status: 'rejected', reason: err.message, kind: err.kind });
      onEvent({ type: 'rejected', index, reason: err.message });
      return false;
    }
  }

  /* ── 一轮采集：3 路并发，从共享队列领任务 ──
   *
   * 用「共享游标」而不是「每个 worker 固定步长 (w, w+3, w+6...)」：
   *   步长写法下，一个 worker 跑完一条后会直接去拿自己步长里的下一条，**不管自己那条有没有作废** ——
   *   于是「补位」不再只发生在作废时，正常情况也会多发一条探针（实测 4 条变 5 条）。
   *   共享游标下每个 worker 每次只领「当前队列里下一条」，领完一条就回头取，行为完全一致，
   *   总数严格等于「3 + 作废条数」，不会凭空多出一次请求。
   *
   * start 是这一轮的起点：第 1 轮从 0 开始（探针 0/1/2 同时起飞），
   * 换协议重跑那轮也从 0 开始（见下方 —— 上一轮一条都没成功，那几条等于白跑，重跑不重复）。 */
  async function collect(start) {
    if (fatal || signal?.aborted) return;
    let cursor = start;
    let inflight = 0;
    const nextIndex = () => (cursor < challenges.length ? cursor++ : -1);
    const workers = Math.max(1, Math.min(TARGET_VALID, challenges.length - start));
    await Promise.all(Array.from({ length: workers }, async () => {
      for (;;) {
        if (fatal || signal?.aborted) return;
        // 「作废才补位」的真正落点：已经凑够 3 份、或「已到手 + 还在飞」已经有 3 份，就不该再开新探针。
        // 只看 outputs.length 会漏掉在飞的那几条，三条同时在飞时每条回来都以为自己该补位，多发一轮。
        if (outputs.length + inflight >= TARGET_VALID) return;
        const i = nextIndex();
        if (i < 0) return;                                   // 队列空了（6 条探针用尽）
        inflight += 1;
        try { await one(i); } finally { inflight -= 1; }
      }
    }));
  }

  await collect(0);

  /* ── 兜底：整轮一条都没成功、且失败全是「格式不对」→ 换另一种协议把前几条重跑一遍 ──
   *
   * 触发条件卡得很死，两个都满足才重跑：
   *   ① 这一轮一份有效回答都没拿到（拿到过任意一份，就说明协议猜对了，后面不必回头换）
   *   ② 这一轮的失败**全部**是 kind==='format'（只要有一条是别的错 —— 鉴权、模型名、超时 ——
   *      换协议也救不了，重跑只会白烧额度）
   * 重跑复用第 0/1/2 条探针：上一轮它们一个字节的正文都没产出（格式就是错的），
   * 不构成「两份回答重复」——归因检测全押在「三份是三个独立样本」上，这条不能含糊。
   * 请求数上限仍是 3 + 3 = 6，与 MAX_ATTEMPTS 一致，不会超支。 */
  const alts = FORMAT_ORDER_ALL.filter((f) => f !== format);
  const allFormatErrors = attempts.length > 0
    && attempts.every((a) => a.status !== 'accepted' && a.kind === 'format');
  if (!locked && !fatal && !signal?.aborted && !outputs.length && allFormatErrors) {
    // 一条条往下列的格式试。chat 与 messages 都撞了才会轮到 responses —— 顺序按 FORMAT_ORDER_ALL，
    // 绝大多数中转站第一条就能命中，多出来的尝试只在「地址里毫无线索」时才发生。
    for (const alt of alts) {
      attempts.length = 0;                     // 那一轮什么都没产出，记录清掉重新记
      format = alt;
      onEvent({ type: 'format', format, locked: false });
      await collect(0);
      if (outputs.length || fatal || signal?.aborted) break;
    }
  }

  const error = fatal || (signal?.aborted ? new ProbeError('aborted', '已取消') : null);
  outputs.sort((a, b) => a.index - b.index);
  attempts.sort((a, b) => a.index - b.index);
  return { ok: outputs.length > 0, complete: outputs.length >= TARGET_VALID, outputs, attempts, format, formatName: format ? FORMATS[format].name : null, viaProxy, error };
}

/* ---------------------------------------------------------------------
 * 管理员建档：跑 36 条固定套件（或其中缺失的几条）。
 *   - **开跑前定下接口路径**（用户显式选的，或 auto 时按 Base URL 推断），
 *     所有条目一视同仁直接进并发池 —— 没有「先单跑一条探路」那一步。
 *   - auto 猜错时的兜底：整轮一条都没成功、且失败全是「格式不对」→ 依次翻成其它格式，
 *     把那条原样重发一次（每次翻只多花一次请求，最多翻到三种都试完）。
 *   - 每条最多 1 + retries 次；鉴权 / 模型名 / 网络 / 限流 这类错误立即全部停止
 * onEvent(e)：{ type:'start'|'progress'|'done'|'failed'|'fatal'|'format', challenge_id, ... }
 * 返回 { rows:[{challenge_id, condition_id, expected_count, numbers, ms}], errors:[...], format, viaProxy, fatal }
 * --------------------------------------------------------------------- */
export async function runCollection({ baseUrl, apiKey, model, challenges, format: knownFormat = null, protocol = 'auto', customPath = '', concurrency = 2, retries = 1, signal, onEvent = () => {}, request = requestCompletion }) {
  const rows = [];
  const errors = [];
  let viaProxy = false;
  let fatal = null;
  const queue = challenges.slice();

  /* 接口格式：**开跑前就定下来**，不再先单跑一条去探。
   *
   * 优先用调用方给的具体格式（`format`，管理员上次采集用的那个，导入归档时复现用）；
   * 否则看用户选的路径：显式选了就用它，auto 才按 Base URL 推断。
   *
   * 早先的做法是「首条单跑，兼探协议」—— 理由是格式没定之前并发会让每条都各试两种格式，
   * 白白多花一倍请求。那个理由只在「完全不知道格式」时成立，而 formatOrder 已经能从
   * Base URL 猜出来（前台检测 runDetection 就是这么做的，注释里写着「猜之前不花任何请求去探路」）。
   * 代价是首条要等它整个跑完（1~2k 输出 token，十几秒到一分钟），那段时间并发池只有 1 路在飞，
   * 紧接着才起满 —— 用户看到的就是「并发设了 10，前半天只有 1 个格子转」。
   *
   * auto 猜错的代价：整轮一条都没成功、且失败原因全是「格式不对」时，就地翻成另一种格式把那条重发
   *（只翻一次，见下面 catch 里那一段）。比起原先每次都先花一次请求探路，猜对时省一整次。 */
  const locked = protocol !== 'auto';          // 用户显式选了路径 → 不许再翻
  let format = knownFormat || (locked ? protocol : formatOrder(baseUrl)[0]);
  onEvent({ type: 'format', format, locked });
  /* auto 模式的「还能翻到哪条路径」队列 —— **全局**一个，所有 worker 共享。
   *
   * 为什么是全局而不是每条自己记：并发下多条会同时撞上同一个 format 错。若各自翻各自的，
   * 会出现「A 翻成 responses、B 又翻回 chat」的来回打转；而每翻一次都退一格 attempt，
   * 这种来回就变成**死循环** —— 跑满整个套件都不收敛。这条踩过：并发 2 时表现为
   * 「有的条目跑通、有的莫名失败」。
   *
   * 为什么是队列而不是布尔闸门（原来那样）：布尔只能表达「翻过没有」，两路径时代够用；
   * 现在有三条路径，翻一次可能落在另一个同样不通的路径上，得能接着翻到没得翻为止。
   * 队列天然有界（每个格式至多出队一次），照样不会死循环。 */
  const pendingFormats = FORMAT_ORDER_ALL.filter((f) => f !== format);
  const takeNextFormat = () => (pendingFormats.length ? pendingFormats.shift() : null);

  async function one(ch) {
    /* 这条自己试过哪些路径。用来判断「还能不能翻」——翻到已经试过的路径上纯属浪费额度。
     * 与 pendingFormats 的分工：队列管「全局还有哪些没试过」，这里管「这条已经试过哪些」。 */
    const tried = new Set([format]);
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (fatal || signal?.aborted) return;
      onEvent({ type: 'start', challenge_id: ch.challenge_id, attempt });
      const onText = (full) => onEvent({ type: 'progress', challenge_id: ch.challenge_id, parsed: parseNumbers(full).length, expected: ch.expected_count });
      try {
        const r = await request({ baseUrl, apiKey, model, format, customPath, prompt: ch.prompt, system: ch.system, signal, onText });
        viaProxy = viaProxy || !!r.viaProxy;
        const numbers = parseNumbers(r.text);
        const minimum = minimumNumbers(ch.expected_count);
        if (numbers.length >= minimum) {
          rows.push({ challenge_id: ch.challenge_id, condition_id: ch.condition, expected_count: ch.expected_count, numbers, ms: r.ms });
          onEvent({ type: 'done', challenge_id: ch.challenge_id, parsed: numbers.length, ms: r.ms });
          return;
        }
        errors.push(`${ch.challenge_id}：有效数字不足 ${numbers.length}/${minimum}`);
        onEvent({ type: 'failed', challenge_id: ch.challenge_id, reason: `数字不足 ${numbers.length}/${minimum}`, final: attempt === retries });
      } catch (e) {
        const err = e instanceof ProbeError ? e : new ProbeError('upstream', String(e?.message || e));
        /* 「格式不对」在猜定格式的编排下不再致命，而是**选错了**的信号。
         *
         * 触发条件卡得很死，三个都满足才翻：
         *   ① 用户没显式选路径（`!locked`）—— 选了就照他的来，翻格式只会给出误导性的报错。
         *   ② 到这条为止一条都没成功过（`rows.length === 0`）—— 只要有一条跑通过，
         *      就说明路径是对的，后面不该再动。这一条同时兜住了并发：另一个 worker
         *      先成功的话，在飞的这几条就不会因为「格式错」去翻。
         *   ③ 全局队列里还有没试过的路径。
         * 翻完把 attempt 退一格，让这次重发**不算进重试次数**：它纠正的是「选错了」，
         * 不是「这次请求失败了」。队列空了就往下走，如实报这条的错误。 */
        if (err.kind === 'format' && !locked && rows.length === 0 && !tried.has('__exhausted__')) {
          const next = takeNextFormat();
          if (next) {
            tried.add(next);
            format = next;
            onEvent({ type: 'format', format, locked: false });
            errors.push(`${ch.challenge_id}：${err.message} → 改用 ${FORMATS[format].name} 重试`);
            attempt -= 1;
            continue;
          }
          tried.add('__exhausted__');       // 队列空了：这条不再翻，后面的报错如实记下
        }
        if (FATAL.has(err.kind)) {
          if (!fatal) { fatal = err; onEvent({ type: 'fatal', challenge_id: ch.challenge_id, error: err }); }
          return;
        }
        errors.push(`${ch.challenge_id}：${err.message}`);
        onEvent({ type: 'failed', challenge_id: ch.challenge_id, reason: err.message, final: attempt === retries });
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    while (queue.length && !fatal && !signal?.aborted) await one(queue.shift());
  });
  await Promise.all(workers);
  rows.sort((a, b) => a.challenge_id.localeCompare(b.challenge_id));
  return { rows, errors, format, viaProxy, fatal, aborted: !!signal?.aborted };
}
