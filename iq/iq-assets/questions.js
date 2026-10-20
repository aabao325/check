/* =====================================================================
 * questions.js —— 大模型智商检测 · 题库定义
 * ---------------------------------------------------------------------
 * 每道题都是「让模型写一个自包含 HTML，用 SVG 绘制 + 动画」，
 * 极度考验模型的空间推理、动画编排与物理直觉——降智的模型会明显翻车。
 *
 * 字段说明：
 *   id        唯一标识，同时是 baselines/<id>.html 的文件名
 *   emoji     题目图标
 *   title     题目名
 *   difficulty 难度（★ 越多越难）
 *   prompt    发给模型的完整提示词（页面会原样作为 user 消息发送）
 *   focus     考察点（展示给用户看「该盯哪里」）
 *   baseline  基线文件路径（左侧对照渲染）
 *
 * 想加题：在数组里加一项，并在 baselines/ 下建同名 <id>.html 即可。
 * ===================================================================== */

// 所有题目共用的「输出纪律」——统一附加到 prompt 末尾，保证可直接渲染、可公平对比。
export const OUTPUT_RULES = [
  '要求：',
  '1. 只输出一个完整的、自包含的 HTML 文档（从 <!DOCTYPE html> 开始），不要任何多余解释文字。',
  '2. 全部用内联 SVG + CSS/JS 动画实现，禁止引用任何外部资源（图片、字体、CDN、库）。',
  '3. 画面主体要清晰可辨、动画流畅、比例协调。',
  '4. 把 HTML 代码放在一个 ```html 代码块里。',
].join('\n');

export const QUESTIONS = [
  {
    id: 'pelican-bicycle',
    emoji: '🦤',
    title: '鹈鹕骑自行车',
    difficulty: '★★★★☆',
    focus: '身体各部位比例、鹈鹕坐姿与蹬踏姿态、自行车结构完整性、骑行动画',
    prompt: '创建一个 HTML，内容是用 SVG 绘制一个鹈鹕骑自行车的 2D 动画。鹈鹕要坐在车座上、脚踩在踏板上蹬车，车轮要转动。',
    baseline: 'iq-assets/baselines/pelican-bicycle.html',
  },
  {
    id: 'solar-system',
    emoji: '☀️',
    title: '太阳系公转动画',
    difficulty: '★★★★☆',
    focus: '多层嵌套轨道、各行星相对公转速度、大小与轨道比例、卫星绕行',
    prompt: '创建一个 HTML，用 SVG 绘制一个太阳系公转动画：太阳居中，水金地火木土等行星沿各自轨道公转，越靠内的行星公转越快，地球要带一颗绕自己转的月亮。',
    baseline: 'iq-assets/baselines/solar-system.html',
  },
  {
    id: 'analog-clock',
    emoji: '🕐',
    title: '实时走动的模拟时钟',
    difficulty: '★★★☆☆',
    focus: '时/分/秒针角度是否用真实当前时间换算、三针联动、刻度均匀',
    prompt: '创建一个 HTML，用 SVG 绘制一个能实时走动的模拟时钟（圆形表盘、12 个刻度、时针分针秒针）。指针要根据用户当前的真实系统时间来定位，并每秒实时走动。',
    baseline: 'iq-assets/baselines/analog-clock.html',
  },
  {
    id: 'rain-umbrella',
    emoji: '🌧️',
    title: '雨中打伞行走的小人',
    difficulty: '★★★★★',
    focus: '雨滴粒子、伞对雨的遮挡关系、小人行走循环（四肢摆动）、雨伞握持',
    prompt: '创建一个 HTML，用 SVG 绘制一个在雨中打着伞向前行走的小人 2D 动画：天上落下密集雨滴，伞要挡住正上方落下的雨（伞下的小人不被淋到），小人的腿要交替迈步呈行走循环。',
    baseline: 'iq-assets/baselines/rain-umbrella.html',
  },
  {
    id: 'dna-helix',
    emoji: '🧬',
    title: 'DNA 双螺旋旋转',
    difficulty: '★★★★☆',
    focus: '两条链的相位差、碱基对连接、伪 3D 的正弦投影与前后遮挡、旋转动画',
    prompt: '创建一个 HTML，用 SVG 绘制一个旋转的 DNA 双螺旋 2D 动画：两条骨架链呈正弦曲线且相位相差半个周期，中间用横档（碱基对）连接，整体持续旋转并体现出前后深度感。',
    baseline: 'iq-assets/baselines/dna-helix.html',
  },
  {
    id: 'swing-kid',
    emoji: '🤸',
    title: '荡秋千的小孩',
    difficulty: '★★★★★',
    focus: '钟摆物理（两端慢中间快）、绳与座板随摆动、小孩身体与秋千的关节联动',
    prompt: '创建一个 HTML，用 SVG 绘制一个小孩荡秋千的 2D 动画：秋千从横梁垂下两根绳，绳下是座板，小孩坐在座板上。整体像单摆一样来回摆动，要有「两端慢、底部快」的钟摆节奏，小孩身体随秋千一起摆。',
    baseline: 'iq-assets/baselines/swing-kid.html',
  },
  {
    id: 'ecg-wave',
    emoji: '❤️',
    title: '心电图波形',
    difficulty: '★★★☆☆',
    focus: 'PQRST 波形形态、扫描线与波形同步、网格背景、循环无缝衔接',
    prompt: '创建一个 HTML，用 SVG 绘制一个心电图（ECG）监护仪动画：绿色网格背景上，一条心电波形（含明显的 QRS 尖峰）自左向右不断被扫描线画出，循环滚动，节奏像心跳。',
    baseline: 'iq-assets/baselines/ecg-wave.html',
  },
];

export function getQuestion(id) {
  return QUESTIONS.find((q) => q.id === id) || null;
}

// 完整提示词 = 题目 prompt + 统一输出纪律
export function fullPrompt(q) {
  return q.prompt + '\n\n' + OUTPUT_RULES;
}
