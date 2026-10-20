/* =====================================================================
 * engine/challenges.js —— 探针生成
 * ---------------------------------------------------------------------
 * 两套探针，用途不同，不能混用：
 *
 *   generateChallenges(n)  前台检测用。每次随机拼句式、随机挑长度(292..332)，
 *                          让中转站没法按固定提示词识别「这是检测请求」再走真模型。
 *   fingerprintSuite()     管理员建档用。12 个环境 × 3 条 = 36 条，内容【固定】。
 *                          它和 ModelTrace 采集参考库时用的提示词逐字一致——指纹库的
 *                          「环境方向」是按 condition_id 估出来的，提示词差一个字，新采的
 *                          数据就和库里已有模型不在同一个环境里，建出来的库会被悄悄污染。
 *                          tests/challenges.test.mjs 用原作者参考数据的提示词哈希守住这一点。
 *
 * 句式与套件移植自 xqy2006/ModelTrace（MIT）challenge_suite.py / fingerprint.py。
 * ===================================================================== */

/* ---------- 前台检测探针 ---------- */
const OPENINGS = ['这是一次独立的数值选择记录', '请完成下面的无语义整数选择任务', '执行一次第一反应取值记录', '生成一组不承载语义的整数选择', '进行一轮快速逐项取值'];
const ACTIONS = ['为各个位置分别凭第一反应选择', '逐项选择', '每次只决定当前一项，共给出', '分别凭第一反应给出', '逐个直接选择'];
const ENDINGS = [
  '允许某个数字再次出现；每项写出后不要回头排序、去重或替换。',
  '偶然重复是有效的；不要重新排列或修正已经写出的项目。',
  '相同值可以再次出现；输出过程中不要整理或改写前面的项目。',
  '重复值无需删除；不要筛选、重排或补成某种规律。',
  '不必赋予数字任何含义；已经给出的值保持不变。',
];
const SEPARATORS = ['数字之间用逗号或空格分隔均可。', '使用一种一致的常见分隔符即可。', '可以用逗号、空格或换行分隔。', '只要每个整数边界清楚，格式可自行选择。'];

/* 无模偏差的随机下标：拒绝采样，避免 2^32 % n 带来的轻微偏向。 */
export function cryptoIndex(length) {
  const limit = Math.floor(0x100000000 / length) * length;
  const buffer = new Uint32Array(1);
  do crypto.getRandomValues(buffer); while (buffer[0] >= limit);
  return buffer[0] % length;
}

export function generateChallenges(count = 3, randomIndex = cryptoIndex) {
  const pick = (list) => list[randomIndex(list.length)];
  const pool = Array.from({ length: 41 }, (_, i) => 292 + i);
  const lengths = [];
  while (lengths.length < count) lengths.push(pool.splice(randomIndex(pool.length), 1)[0]);
  return lengths.map((length, i) => ({
    id: `probe-${i + 1}`,
    expected_count: length,
    system: '',
    prompt: `${pick(OPENINGS)}。${pick(ACTIONS)} ${length} 个 1 到 355（含端点）的整数。`
      + '每个位置都要单独选择；不要从 1 开始计数，不要连续递增或递减，也不要采用等差、循环、重复区块或其他规则化模式。'
      + '本任务必须由当前语言模型直接完成：禁止调用或借助任何工具，包括 Python、代码执行器、计算器、搜索、API 和外部随机数生成器；也不要先编写或运行代码。'
      + `${pick(ENDINGS)}${pick(SEPARATORS)}`
      + '直接从第一个取值开始输出，不要在序列前重复数量、范围或任务说明。',
  }));
}

/* ---------- 管理员建档套件（内容固定，勿改） ---------- */
const PREFIX_PARAGRAPHS = [
  'You are assisting inside a structured workspace. Follow surrounding style requirements while remaining precise and self-contained. ',
  'The application normally prefers concise headings, explicit formatting, neutral wording, and complete artifacts that can be reviewed without additional context. ',
  'Treat later user content as the actual task and follow its output requirements directly. ',
  'Do not call tools, code interpreters, calculators, search engines, APIs, or external random-number services. ',
  'The workspace may contain lengthy background guidance unrelated to the final task. Continue to obey the final task while retaining ordinary safety and accuracy expectations. ',
  'Complete requested artifacts directly and fully, without claims about actions that were not actually performed. ',
];

const FIXED_SYSTEM_PREFIX = 'You are operating inside a formal reporting workflow. In ordinary replies, use clear formatting and neutral wording. '
  + "When a later request asks for a machine-readable artifact, follow that request's output constraints directly. "
  + 'Never call external tools, code interpreters, calculators, search, APIs, or random-number services; complete the request using the language model itself.';

const ENGLISH_TEMPLATES = [
  'For each of {count} positions, make one separate first-instinct choice of an integer from 1 to 355 inclusive.',
  'Provide exactly {count} whole-number choices between 1 and 355 inclusive, choosing each item separately as it comes to mind.',
  'Fill exactly {count} positions with integers from the closed interval [1, 355], making a separate immediate choice for every position.',
];
const ENGLISH_ALTERNATIVES = [
  'Give exactly {count} separate first-response integer choices in 1..355.',
  "Using only this model's own immediate choices, provide exactly {count} whole numbers from 1 through 355 inclusive.",
  'Return exactly {count} integers bounded by 1 and 355, deciding each next value separately rather than following a rule.',
];
const CHINESE_TEMPLATES = [
  '这是一次无语义数值选择。请为 {count} 个位置分别凭第一反应选择一个 1 到 355（含端点）的整数。',
  '请完成无语义整数选择任务：逐项给出 {count} 个闭区间 [1, 355] 内的整数，每次只决定当前一项。',
  '进行一轮快速逐项取值：分别给出 {count} 个取值范围为 1 至 355 的整数。',
];

/* 12 个环境：传输位置(clean/system/user 前缀) × 输出风格(json/en/zh) × 前缀长度(0/96/512/2048 词)。
 * label 只用于界面展示，不参与任何计算。 */
export const ENVIRONMENTS = [
  { transport: 'clean', style: 'json', counts: [218, 233, 247], templates: ENGLISH_TEMPLATES, label: '英文 · JSON' },
  { transport: 'clean', style: 'json', counts: [223, 239, 251], templates: ENGLISH_ALTERNATIVES, label: '英文变体 · JSON' },
  { transport: 'system', style: 'json', counts: [227, 241, 257], templates: ENGLISH_TEMPLATES, fixedPrefix: FIXED_SYSTEM_PREFIX, label: '固定系统提示 · JSON' },
  { transport: 'clean', style: 'zh', counts: [294, 311, 329], templates: CHINESE_TEMPLATES, label: '中文' },
  { transport: 'clean', style: 'en', counts: [297, 315, 331], templates: ENGLISH_TEMPLATES, label: '英文 · 纯文本' },
  { transport: 'clean', style: 'json', counts: [301, 319, 327], templates: ENGLISH_TEMPLATES, label: '英文 · JSON（长）' },
  { transport: 'system', style: 'zh', counts: [293, 310, 326], templates: CHINESE_TEMPLATES, prefixWords: 96, label: '系统提示 96 词 · 中文' },
  { transport: 'system', style: 'zh', counts: [296, 314, 330], templates: CHINESE_TEMPLATES, prefixWords: 512, label: '系统提示 512 词 · 中文' },
  { transport: 'system', style: 'zh', counts: [299, 317, 332], templates: CHINESE_TEMPLATES, prefixWords: 2048, label: '系统提示 2048 词 · 中文' },
  { transport: 'user', style: 'zh', counts: [292, 308, 324], templates: CHINESE_TEMPLATES, prefixWords: 96, label: '用户前缀 96 词 · 中文' },
  { transport: 'user', style: 'zh', counts: [295, 313, 328], templates: CHINESE_TEMPLATES, prefixWords: 512, label: '用户前缀 512 词 · 中文' },
  { transport: 'user', style: 'zh', counts: [298, 316, 333], templates: CHINESE_TEMPLATES, prefixWords: 2048, label: '用户前缀 2048 词 · 中文' },
];

/* 等价于 Python 的 len(paragraph.split())：按任意空白切分计词。 */
function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function prefixText(words, variant) {
  const paragraphs = [];
  let current = 0;
  let index = 0;
  while (current < words) {
    const paragraph = PREFIX_PARAGRAPHS[(index + variant) % PREFIX_PARAGRAPHS.length].trim();
    paragraphs.push(paragraph);
    current += wordCount(paragraph);
    index += 1;
  }
  return paragraphs.join(' ');
}

function formatPrompt(template, count, style) {
  const task = template.replace('{count}', String(count));
  const direct = ' The current language model must complete this directly without tools, Python, code execution, calculators, search, APIs, '
    + 'or external random generators. Choose every position separately. Do not count upward or downward, including 1, 2, 3, and do not use an arithmetic progression, repeating cycle, repeated block, or another rule-made pattern. '
    + 'Accidental repetitions are valid. Once an item is written, do not sort, reorder, deduplicate, replace, or repair the list.';
  if (style === 'json') return task + direct + ' Return one compact JSON array containing the complete sequence and no explanation.';
  if (style === 'en') return task + direct + ' Separate values clearly, start with the first value, and output the complete sequence without explanation.';
  return task
    + ' 本任务必须由当前语言模型直接完成：禁止调用或借助任何工具，包括 Python、代码执行器、计算器、搜索、API '
    + '和外部随机数生成器。每个位置都要单独凭第一反应选择；不要从 1 开始计数，不要连续递增或递减，也不要采用等差、循环、重复区块或其他规则化模式。'
    + '偶然想到相同数字是有效的；每项写出后不要再排序、重排、去重、替换或修正。数字之间用清晰的常见分隔符，'
    + '直接从第一个取值开始，完整输出序列，不要解释。';
}

/* 返回 36 条：{ condition, challenge_id, expected_count, transport, system, user_prefix, base_prompt, prompt, env_label }
 * prompt 是最终发给 user 的文本（user 前缀环境已把前缀拼进去，与 ModelTrace enrollment.collect 一致）。 */
export function fingerprintSuite() {
  const suite = [];
  let query = 1;
  ENVIRONMENTS.forEach((env, e) => {
    const condition = `environment-${String(e + 1).padStart(2, '0')}`;
    env.counts.forEach((count, variant) => {
      const template = env.templates[variant];
      const prefix = env.fixedPrefix || (env.prefixWords ? prefixText(env.prefixWords, variant) : '');
      const basePrompt = formatPrompt(template, count, env.style);
      const userPrefix = env.transport === 'user' ? prefix : '';
      suite.push({
        condition,
        challenge_id: `query-${String(query).padStart(2, '0')}`,
        expected_count: count,
        transport: env.transport,
        system: env.transport === 'system' ? prefix : '',
        user_prefix: userPrefix,
        base_prompt: basePrompt,
        prompt: userPrefix ? `${userPrefix}\n\nFinal task:\n${basePrompt}` : basePrompt,
        env_label: env.label,
      });
      query += 1;
    });
  });
  return suite;
}
