// @parity src/InkCanvas.Core/Recognition/ShapeRecognizer.cs — 图形识别语义参考（AI 教学助手本身无 C# 对应）
// 新增（鸿蒙端增强）— AI 教学助手 · 本地确定性推理层
// WinUI3 基线没有 AI 能力；本模块把「圈选识题 / 板书纪要 / 图形规整」需要的
// 判定与文案生成收敛为纯函数，UI 与交互可以独立验证，后续可整体替换为真实
// OCR / 公式识别 / LLM 服务（保持同一组接口即可）。
//
// 诚实边界：识别内容由圈选几何与墨迹统计确定性生成，属端侧演示引擎，
// 不是真实模型推理；界面上必须标注引擎来源，测试记录里同样标注「未接真实服务」。

import { InkStroke } from '../ink/InkStroke';

export enum AiCaptureKind {
  Question = 0,
  Formula = 1
}

export interface AiRegion {
  Left: number;
  Top: number;
  Width: number;
  Height: number;
}

export interface AiInkSummary {
  StrokeCount: number;
  PointCount: number;
  ColorCount: number;
  ShapeCount: number;
}

export interface AiCaptureInput {
  Kind: number;
  Region: AiRegion;
  Ink: AiInkSummary;
}

export interface AiRecognizeResult {
  Kind: number;
  Title: string;
  Badge: string;
  Question: string;
  Formula: string;
  // 以下为「公式识别 / 搜题」增强字段：
  // FormulaLatex —— 由公式行按确定性规则转写的 LaTeX，可直接复制到公式编辑器；
  // Candidates —— 同一次识别中得分靠前的其它候选公式行（多行板书时避免只取一行）；
  // Givens / Goal —— 从题干中抽取的已知条件与所求目标；
  // Pitfalls —— 按题型给出的易错提醒；Warnings —— 识别质量提示（不阻断展示）。
  FormulaLatex: string;
  Candidates: string[];
  Givens: string[];
  Goal: string;
  Pitfalls: string[];
  Warnings: string[];
  Steps: string[];
  Tags: string[];
  Confidence: number;
  Engine: string;
}

export interface LectureNoteCard {
  Id: string;
  Index: number;
  Title: string;
  Bullets: string[];
  Formula: string;
  Accent: string;
}

export interface LectureNotes {
  Title: string;
  Subtitle: string;
  Cards: LectureNoteCard[];
  Markdown: string;
  Coverage: number;
}

export interface ShapeSnapOption {
  Kind: number;
  Label: string;
  Confidence: number;
}

export const AI_ENGINE_LABEL: string = '端侧演示引擎 · 规则生成';

export const AI_NOTE_ACCENTS: string[] = ['#FF38E1FF', '#FF7C4DFF', '#FF22C55E', '#FFF59E0B'];

const QUESTION_TEMPLATES: string[] = [
  '已知函数 f(x) = x² − 4x + 3，求 f(x) 在闭区间 [0, 3] 上的最小值与最大值。',
  '化简：sin(π/2 + α)·cos(π − α) ÷ tan(π + α)，并说明每一步所用的诱导公式。',
  '如图，在 △ABC 中 AB = AC，∠BAC = 120°，D 为 BC 中点，求 AD : BC 的值。'
];

const FORMULA_TEMPLATES: string[] = [
  '∫₀¹ (3x² + 2x) dx = [x³ + x²]₀¹ = 2',
  'sin²θ + cos²θ = 1（同角三角函数基本关系）',
  'a² + b² = c²（勾股定理，直角边 a、b，斜边 c）'
];

const QUESTION_TAGS: string[][] = [
  ['二次函数', '配方法', '闭区间最值'],
  ['三角恒等变换', '诱导公式', '化简求值'],
  ['等腰三角形', '中点', '线段比例']
];

const FORMULA_TAGS: string[][] = [
  ['定积分', '牛顿-莱布尼茨', '多项式'],
  ['三角恒等式', '平方关系', '任意角'],
  ['勾股定理', '直角三角形', '边长关系']
];

const QUESTION_STEPS: string[][] = [
  ['配方：f(x) = (x − 2)² − 1', '顶点 x = 2 落在区间内，最小值 f(2) = −1', '比较端点：f(0) = 3，f(3) = 0，最大值 3'],
  ['sin(π/2 + α) = cos α，cos(π − α) = −cos α', 'tan(π + α) = tan α，原式 = −cos²α / tan α', '化为 −cos³α / sin α，再按象限讨论符号'],
  ['取 BC 中点 D，连接 AD 得中线与高线', '由 AB = AC 得 AD ⊥ BC，且 ∠BAD = 60°', '设 AB = 2k，则 BD = √3k，AD = k，故 AD : BC = 1 : 2√3']
];

const FORMULA_STEPS: string[][] = [
  ['原式 = ∫₀¹ 3x² dx + ∫₀¹ 2x dx', '分别积分：x³ 与 x²', '代入上下限：1 + 1 = 2'],
  ['由单位圆定义，sin²θ 与 cos²θ 为同一点坐标平方和', '横纵坐标平方和恒等于半径平方 1', '对任意角 θ 成立'],
  ['设直角边 a、b，斜边 c', '以三边向外作正方形，面积关系 a² + b² = c²', '逆定理可用于判定直角三角形']
];

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function seedOf(region: AiRegion): number {
  const w = Math.round(Math.max(1, region.Width) / 8);
  const h = Math.round(Math.max(1, region.Height) / 8);
  const raw = w * 31 + h * 17;
  return Math.abs(raw) % 3;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function normalizeRegion(region: AiRegion): AiRegion {
  const left = Math.min(region.Left, region.Left + region.Width);
  const top = Math.min(region.Top, region.Top + region.Height);
  return {
    Left: left,
    Top: top,
    Width: Math.max(1, Math.abs(region.Width)),
    Height: Math.max(1, Math.abs(region.Height))
  };
}

/** 宽高比 / 高度阈值判型：扁平长条视为公式，其余按题目处理。 */
export function classifyCaptureKind(region: AiRegion): number {
  const r = normalizeRegion(region);
  const ratio = r.Width / Math.max(1, r.Height);
  if (ratio >= 2.6 || r.Height < 90) {
    return AiCaptureKind.Formula;
  }
  return AiCaptureKind.Question;
}

export function summarizeInk(strokes: InkStroke[]): AiInkSummary {
  let points = 0;
  let shapes = 0;
  const colors: number[] = [];
  for (let i = 0; i < strokes.length; i++) {
    const stroke = strokes[i];
    points += stroke.Count;
    if (stroke.IsRecognizedShape) {
      shapes++;
    }
    const packed = stroke.Attributes.Color.packedArgb();
    let seen = false;
    for (let c = 0; c < colors.length; c++) {
      if (colors[c] === packed) {
        seen = true;
        break;
      }
    }
    if (!seen) {
      colors.push(packed);
    }
  }
  return {
    StrokeCount: strokes.length,
    PointCount: points,
    ColorCount: colors.length,
    ShapeCount: shapes
  };
}

export function recognizeCapture(input: AiCaptureInput): AiRecognizeResult {
  const region = normalizeRegion(input.Region);
  const kind = input.Kind === AiCaptureKind.Formula
    ? AiCaptureKind.Formula
    : classifyCaptureKind(region);
  const seed = seedOf(region);
  const inkBoost = clamp(input.Ink.StrokeCount * 0.004, 0, 0.04);
  const base = kind === AiCaptureKind.Formula ? 0.9 + seed * 0.02 : 0.91 + seed * 0.02;
  const confidence = round2(clamp(base + inkBoost, 0.8, 0.99));
  if (kind === AiCaptureKind.Formula) {
    return {
      Kind: AiCaptureKind.Formula,
      Title: '公式识别完成',
      Badge: '公式 · LaTeX 可复制',
      Question: '已在圈选区域内识别到 1 个数学表达式。',
      Formula: FORMULA_TEMPLATES[seed],
      FormulaLatex: '',
      Candidates: [],
      Givens: [],
      Goal: '',
      Pitfalls: [],
      Warnings: [],
      Steps: FORMULA_STEPS[seed],
      Tags: FORMULA_TAGS[seed],
      Confidence: confidence,
      Engine: AI_ENGINE_LABEL
    };
  }
  return {
    Kind: AiCaptureKind.Question,
    Title: '题目识别完成',
    Badge: '题目 · 含解题思路',
    Question: QUESTION_TEMPLATES[seed],
    Formula: kind === AiCaptureKind.Question ? 'f(x) = a(x − h)² + k' : '',
    FormulaLatex: '',
    Candidates: [],
    Givens: [],
    Goal: '',
    Pitfalls: [],
    Warnings: [],
    Steps: QUESTION_STEPS[seed],
    Tags: QUESTION_TAGS[seed],
    Confidence: confidence,
    Engine: AI_ENGINE_LABEL
  };
}

export function buildLectureNotes(ink: AiInkSummary, pageIndex: number, clockLabel: string): LectureNotes {
  const page = pageIndex + 1;
  const strokeText = ink.StrokeCount + ' 笔板书';
  const shapeText = ink.ShapeCount > 0 ? ink.ShapeCount + ' 个已识别图形' : '以自由笔迹为主';
  const colorText = ink.ColorCount > 1 ? ink.ColorCount + ' 种颜色标注' : '单色板书';
  const coverage = clamp(58 + ink.StrokeCount * 2 + ink.ShapeCount * 3, 58, 98);
  const cards: LectureNoteCard[] = [
    {
      Id: 'note-core',
      Index: 0,
      Title: '本页核心',
      Bullets: [
        '板书记录：' + strokeText + '，' + colorText,
        '视觉结构：' + shapeText,
        '建议在课堂小结时回看本页左上方主板书区'
      ],
      Formula: '',
      Accent: AI_NOTE_ACCENTS[0]
    },
    {
      Id: 'note-formula',
      Index: 1,
      Title: '关键公式',
      Bullets: [
        'f(x) = a(x − h)² + k（顶点式）',
        'sin²θ + cos²θ = 1（同角关系）',
        '公式与板书中的推导步骤已建立关联'
      ],
      Formula: 'f(x) = a(x − h)² + k',
      Accent: AI_NOTE_ACCENTS[1]
    },
    {
      Id: 'note-path',
      Index: 2,
      Title: '推导脉络',
      Bullets: [
        '从具体例子归纳出通式，再回到题目验证',
        '重点步骤：配方 → 定顶点 → 比较端点',
        '课堂节奏：讲解约 12 分钟，练习约 8 分钟'
      ],
      Formula: '',
      Accent: AI_NOTE_ACCENTS[2]
    },
    {
      Id: 'note-warn',
      Index: 3,
      Title: '易错提醒',
      Bullets: [
        '闭区间最值必须同时比较顶点与两个端点',
        '注意判别式 Δ 的符号对根的影响',
        '书写公式时保持等号对齐，便于学生拍照留存'
      ],
      Formula: '',
      Accent: AI_NOTE_ACCENTS[3]
    }
  ];
  const notes: LectureNotes = {
    Title: '第 ' + page + ' 页 · 课堂纪要',
    Subtitle: clockLabel + ' · ' + strokeText + ' · 覆盖度 ' + coverage + '%',
    Cards: cards,
    Markdown: '',
    Coverage: coverage
  };
  notes.Markdown = toMarkdown(notes);
  return notes;
}

export function toMarkdown(notes: LectureNotes): string {
  let text = '# ' + notes.Title + '\n\n' + notes.Subtitle + '\n\n';
  for (let i = 0; i < notes.Cards.length; i++) {
    const card = notes.Cards[i];
    text += '## ' + (i + 1) + '. ' + card.Title + '\n';
    for (let b = 0; b < card.Bullets.length; b++) {
      text += '- ' + card.Bullets[b] + '\n';
    }
    if (card.Formula !== '') {
      text += '\n> ' + card.Formula + '\n';
    }
    text += '\n';
  }
  text += '_由 ' + AI_ENGINE_LABEL + ' 生成，仅供课堂复盘参考_\n';
  return text;
}

export function shapeSnapOptions(ink: AiInkSummary): ShapeSnapOption[] {
  const bonus = ink.ShapeCount > 0 ? 0 : 0.02;
  return [
    { Kind: 2, Label: '圆', Confidence: round2(clamp(0.95 + bonus, 0.8, 0.99)) },
    { Kind: 5, Label: '矩形', Confidence: round2(clamp(0.93 + bonus, 0.8, 0.99)) },
    { Kind: 4, Label: '三角形', Confidence: round2(clamp(0.87 + bonus, 0.8, 0.99)) },
    { Kind: 1, Label: '直线', Confidence: round2(clamp(0.9 + bonus, 0.8, 0.99)) }
  ];
}

export function recommendedSnapIndex(options: ShapeSnapOption[]): number {
  let best = 0;
  for (let i = 1; i < options.length; i++) {
    if (options[i].Confidence > options[best].Confidence) {
      best = i;
    }
  }
  return best;
}

export function confidencePercent(value: number): number {
  return Math.round(clamp(value, 0, 1) * 100);
}

export function aiAssistantProbe(region: AiRegion, ink: AiInkSummary): AiRecognizeResult {
  const kind = classifyCaptureKind(region);
  return recognizeCapture({ Kind: kind, Region: region, Ink: ink });
}
// ---- 真实文本路径（端侧 OCR 结果 → 识别卡片） ----------------------------
// 与上面的演示引擎不同：题干、公式、关键式全部来自 OCR 返回的文本；
// 只有“解题提示”按题型关键词挑选（不是模型推理），引擎字段会明确标注。

export interface AiTextInput {
  Kind: number;
  Text: string;
  Available: boolean;
  Region: AiRegion;
  Ink: AiInkSummary;
}

// 加权符号表：等号 / 积分 / 求和代表「等式或运算主体」，权重高于普通运算符；
// 幂、根号、函数名权重居中；加减乘除与数字权重最低。用加权替代「命中即 1 分」，
// 可显著提升多行板书里「挑真正的公式行」的准确率。
interface WeightedToken {
  token: string;
  weight: number;
}

const WEIGHTED_TOKENS: WeightedToken[] = [
  { token: '=', weight: 3 },
  { token: '∫', weight: 3 },
  { token: '∑', weight: 3 },
  { token: 'Σ', weight: 3 },
  { token: '√', weight: 2 },
  { token: '²', weight: 2 },
  { token: '³', weight: 2 },
  { token: '^', weight: 2 },
  { token: 'sin', weight: 2 },
  { token: 'cos', weight: 2 },
  { token: 'tan', weight: 2 },
  { token: 'log', weight: 2 },
  { token: 'ln', weight: 2 },
  { token: 'lim', weight: 2 },
  { token: '≤', weight: 2 },
  { token: '≥', weight: 2 },
  { token: '≠', weight: 2 },
  { token: '±', weight: 2 },
  { token: '×', weight: 2 },
  { token: '÷', weight: 2 },
  { token: '≈', weight: 1 },
  { token: '+', weight: 1 },
  { token: '−', weight: 1 },
  { token: '-', weight: 1 },
  { token: 'π', weight: 1 },
  { token: 'θ', weight: 1 },
  { token: 'α', weight: 1 },
  { token: 'β', weight: 1 },
  { token: 'γ', weight: 1 },
  { token: 'Δ', weight: 1 }
];

function normalizeText(text: string): string {
  let out = text.replace(/\r/g, '\n');
  out = out.replace(/[ \t]+/g, ' ');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

function splitLines(text: string): string[] {
  const raw = text.split('\n');
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].trim();
    if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

// 运算密度：数学字符占比。纯符号计分容易被「含大量数字的题干」带偏，
// 用密度再修正一次，让「短而密」的公式行胜出。
function mathDensity(line: string): number {
  if (line.length === 0) {
    return 0;
  }
  let mathChars = 0;
  for (let i = 0; i < line.length; i++) {
    if (/[0-9+\-−×÷=≈≠≤≥√∫∑Σ²³^πθαβγ]/.test(line.charAt(i))) {
      mathChars++;
    }
  }
  return mathChars / line.length;
}

function mathScore(line: string): number {
  let score = 0;
  for (let i = 0; i < WEIGHTED_TOKENS.length; i++) {
    if (line.indexOf(WEIGHTED_TOKENS[i].token) >= 0) {
      score += WEIGHTED_TOKENS[i].weight;
    }
  }
  if (/[0-9]/.test(line)) {
    score += 1;
  }
  return round2(score + mathDensity(line) * 2);
}

// 候选公式行：按得分降序返回前 limit 行，供 UI 在同一圈选区域内切换。
function rankedFormulaLines(lines: string[], limit: number): string[] {
  const picked: string[] = [];
  const scores: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const score = mathScore(lines[i]);
    if (score <= 0) {
      continue;
    }
    let at = picked.length;
    for (let j = 0; j < picked.length; j++) {
      if (score > scores[j]) {
        at = j;
        break;
      }
    }
    picked.splice(at, 0, lines[i]);
    scores.splice(at, 0, score);
  }
  const out: string[] = [];
  for (let i = 0; i < picked.length && i < limit; i++) {
    out.push(picked[i]);
  }
  return out;
}

function bestFormulaLine(lines: string[]): string {
  const ranked = rankedFormulaLines(lines, 1);
  return ranked.length > 0 ? ranked[0] : '';
}

interface TopicRule {
  tag: string;
  pattern: RegExp;
  weight: number;
}

// 关键词命中次数 × 权重后排序取 Top3：旧实现按 if 顺序 push，
// 一旦题干同时含「函数」「三角」两个词，解题模板永远只按固定顺序命中第一个。
const TOPIC_RULES: TopicRule[] = [
  { tag: '函数与图像', pattern: /函数|f\s*\(\s*x\s*\)|二次|抛物线|顶点|单调|最值|定义域|值域/g, weight: 3 },
  { tag: '三角函数', pattern: /sin|cos|tan|cot|三角|弧度|诱导公式|正弦|余弦/g, weight: 3 },
  { tag: '平面几何', pattern: /三角形|△|∠|垂直|平行|圆心|半径|相似|全等|中位线|中线/g, weight: 3 },
  { tag: '方程与根', pattern: /方程|判别式|求根|根为|解得|一元二次|不等式的解/g, weight: 3 },
  { tag: '微积分', pattern: /积分|∫|导数|微分|求导|极限|原函数/g, weight: 3 },
  { tag: '概率统计', pattern: /概率|期望|方差|统计|频率|随机变量/g, weight: 3 },
  { tag: '数列', pattern: /数列|等差|等比|通项|前\s*n\s*项|递推/g, weight: 3 }
];

interface TopicScore {
  tag: string;
  score: number;
}

function detectTopics(text: string): string[] {
  const scores: TopicScore[] = [];
  for (let i = 0; i < TOPIC_RULES.length; i++) {
    const rule = TOPIC_RULES[i];
    const found = text.match(rule.pattern);
    const hits = found !== null ? found.length : 0;
    if (hits > 0) {
      scores.push({ tag: rule.tag, score: hits * rule.weight });
    }
  }
  scores.sort((a: TopicScore, b: TopicScore) => b.score - a.score);
  const tags: string[] = [];
  for (let i = 0; i < scores.length && i < 3; i++) {
    tags.push(scores[i].tag);
  }
  if (tags.length === 0) {
    tags.push('课堂板书');
  }
  return tags;
}

function stepsForTopics(topics: string[]): string[] {
  if (topics.indexOf('函数与图像') >= 0) {
    return ['提取解析式并确认定义域', '确定顶点 / 零点 / 单调区间', '按题目要求比较端点或极值并回代检验'];
  }
  if (topics.indexOf('三角函数') >= 0) {
    return ['统一角与函数名（诱导公式或辅助角）', '化简表达式并标出取值限制', '代入特殊角或数值验证结果'];
  }
  if (topics.indexOf('平面几何') >= 0) {
    return ['标出已知条件与关键点，连接辅助线', '用全等 / 相似或勾股建立关系', '由关系式推出所求量并检查符号'];
  }
  if (topics.indexOf('方程与根') >= 0) {
    return ['整理为标准形式并确认系数', '判断判别式与根的范围', '求解后回代验证'];
  }
  if (topics.indexOf('微积分') >= 0) {
    return ['确定积分区间与被积函数', '求原函数（或导数）', '代入上下限 / 临界点计算并检验'];
  }
  if (topics.indexOf('概率统计') >= 0) {
    return ['明确样本空间与事件', '列出概率 / 统计量公式', '计算结果并检查合理性'];
  }
  if (topics.indexOf('数列') >= 0) {
    return ['写出通项或递推关系', '判断等差 / 等比或求和类型', '代入前几项核对'];
  }
  return ['圈出已知条件与所求量', '把条件转成代数式或图形关系', '选择公式求解并回代验证'];
}

// ---- 搜题增强：已知 / 所求 / 易错 ----------------------------------------

interface TopicPitfalls {
  tag: string;
  items: string[];
}

const TOPIC_PITFALLS: TopicPitfalls[] = [
  { tag: '函数与图像', items: ['闭区间上的最值要同时比较顶点与两个端点', '求解析式后先确认定义域，再讨论单调性'] },
  { tag: '三角函数', items: ['诱导公式先定符号，再化简函数名', '开方或约分时注意角的取值范围'] },
  { tag: '平面几何', items: ['辅助线要落在已知条件能推出的位置', '用相似 / 全等前先写清对应关系'] },
  { tag: '方程与根', items: ['移项后方程两边要同号整理，勿漏负号', '判别式 Δ 的符号决定根的数量与范围'] },
  { tag: '微积分', items: ['积分上下限与变量要一一对应', '求导后回代原式检查量纲与符号'] },
  { tag: '概率统计', items: ['样本空间要写全，事件之间勿重复计数', '期望 / 方差公式中的概率需满足归一化'] },
  { tag: '数列', items: ['等差 / 等比判定要用相邻项差值或比值', '求和时注意项数与首项是否对应'] }
];

function pitfallsForTopics(topics: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < topics.length; i++) {
    for (let j = 0; j < TOPIC_PITFALLS.length; j++) {
      if (TOPIC_PITFALLS[j].tag === topics[i]) {
        for (let k = 0; k < TOPIC_PITFALLS[j].items.length; k++) {
          out.push(TOPIC_PITFALLS[j].items[k]);
        }
      }
    }
  }
  if (out.length === 0) {
    out.push('回到原题核对单位、符号与取值范围');
  }
  return out;
}

const GIVEN_RULES: RegExp[] = [
  /已知[：:]?\s*([^，,。；;\n]{2,48})/,
  /设\s*([^，,。；;\n]{1,36})/,
  /[0-9]+(?:\.[0-9]+)?\s*(?:cm|mm|kg|°|度|米|厘米)/
];

function extractGivens(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < GIVEN_RULES.length; i++) {
    const m = GIVEN_RULES[i].exec(text);
    if (m === null || m.length < 2) {
      continue;
    }
    const value = m[1].trim();
    if (value.length === 0) {
      continue;
    }
    let dup = false;
    for (let j = 0; j < out.length; j++) {
      if (out[j] === value) {
        dup = true;
        break;
      }
    }
    if (!dup) {
      out.push(value);
    }
    if (out.length >= 3) {
      break;
    }
  }
  return out;
}

const GOAL_RULES: RegExp[] = [
  /求\s*([^，。；;？?\n]{1,40})/,
  /证明\s*([^。；;\n]{1,40})/,
  /化简\s*([^，。；;\n]{1,40})/,
  /计算\s*([^。；;\n]{1,40})/,
  /判断\s*([^，。；;？?\n]{1,40})/
];

function extractGoal(text: string): string {
  for (let i = 0; i < GOAL_RULES.length; i++) {
    const m = GOAL_RULES[i].exec(text);
    if (m !== null && m.length >= 2) {
      const value = m[1].trim();
      if (value.length > 0) {
        return value;
      }
    }
  }
  return '';
}

function questionWarnings(text: string, goal: string): string[] {
  const out: string[] = [];
  if (goal.length === 0 && text.length > 20) {
    out.push('未找到「求 / 证明 / 化简」等目标词，已按知识点给出通用提示');
  }
  const asks = text.match(/求|证明|化简|计算|判断/g);
  if (asks !== null && asks.length > 2) {
    out.push('区域内出现 ' + asks.length + ' 个设问，可能圈入了多道题');
  }
  if (text.length > 220) {
    out.push('文本较长，建议只圈选单道题目以提升准确度');
  }
  return out;
}

// ---- 公式增强：归一化 / LaTeX 规则转写 / 类型判定 / 质量提示 ------------

const MATH_SYMBOLS: string[] = [
  '=', '≈', '≠', '≤', '≥', '+', '−', '×', '÷', '√', '∫', '∑', 'Σ', 'Δ',
  '²', '³', 'π', 'θ', 'α', 'β', 'γ', 'sin', 'cos', 'tan', 'log', 'ln', 'lim'
];

// 全角 ASCII（U+FF01..U+FF5E）→ 半角：OCR 常把公式里的等号、括号识别成全角。
function toHalfWidth(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input.charAt(i);
    const code = ch.charCodeAt(0);
    if (code === 0x3000) {
      out += ' ';
    } else if (code >= 0xFF01 && code <= 0xFF5E) {
      out += String.fromCharCode(code - 0xFEE0);
    } else {
      out += ch;
    }
  }
  return out;
}

function normalizeFormula(input: string): string {
  return toHalfWidth(input).replace(/\s+/g, ' ').trim();
}

// Unicode 下标数字（₀..₉）在 OCR 结果里很常见（如 ∫₀¹），先转成 ASCII 再走 LaTeX 规则。
function subscriptDigitsToAscii(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input.charAt(i);
    const code = ch.charCodeAt(0);
    if (code >= 0x2080 && code <= 0x2089) {
      out += '_' + String(code - 0x2080);
    } else {
      out += ch;
    }
  }
  return out;
}

interface LatexPair {
  from: string;
  to: string;
}

const LATEX_PAIRS: LatexPair[] = [
  { from: 'π', to: '\\pi' },
  { from: 'θ', to: '\\theta' },
  { from: 'α', to: '\\alpha' },
  { from: 'β', to: '\\beta' },
  { from: 'γ', to: '\\gamma' },
  { from: 'δ', to: '\\delta' },
  { from: 'λ', to: '\\lambda' },
  { from: 'μ', to: '\\mu' },
  { from: 'ω', to: '\\omega' },
  { from: 'Ω', to: '\\Omega' },
  { from: 'Δ', to: '\\Delta' },
  { from: 'Σ', to: '\\Sigma' },
  { from: '∫', to: '\\int' },
  { from: '∑', to: '\\sum' },
  { from: '∞', to: '\\infty' },
  { from: '≤', to: '\\le' },
  { from: '≥', to: '\\ge' },
  { from: '≠', to: '\\ne' },
  { from: '≈', to: '\\approx' },
  { from: '±', to: '\\pm' },
  { from: '×', to: '\\times' },
  { from: '÷', to: '\\div' },
  { from: '·', to: '\\cdot' },
  { from: '→', to: '\\to' },
  { from: '−', to: '-' }
];

const LATEX_FUNCS: string[] = ['sin', 'cos', 'tan', 'cot', 'log', 'ln', 'lim'];

// 规则转写（不是模型）：上下标 / 根号 / 分式 / 希腊字母 / 函数名 → LaTeX。
function formulaToLatex(input: string): string {
  let s = normalizeFormula(input);
  if (s.length === 0) {
    return '';
  }
  s = subscriptDigitsToAscii(s);
  s = s.split('²').join('^2');
  s = s.split('³').join('^3');
  s = s.split('¹').join('^1');
  s = s.replace(/√\s*\(([^()]+)\)/g, '\\sqrt{$1}');
  s = s.replace(/√\s*([A-Za-z0-9]+)/g, '\\sqrt{$1}');
  s = s.replace(/\^([0-9]+)/g, '^{$1}');
  s = s.replace(/_([0-9]+)/g, '_{$1}');
  s = s.replace(/\(([^()]+)\)\s*\/\s*\(([^()]+)\)/g, '\\frac{$1}{$2}');
  s = s.replace(/([A-Za-z0-9]+\^\{[0-9]+\})\s*\/\s*([A-Za-z0-9]+)/g, '\\frac{$1}{$2}');
  s = s.replace(/([A-Za-z0-9]+)\s*\/\s*([A-Za-z0-9]+\^\{[0-9]+\})/g, '\\frac{$1}{$2}');
  s = s.replace(/([A-Za-z0-9]+)\s*\/\s*([A-Za-z0-9]+)/g, '\\frac{$1}{$2}');
  for (let i = 0; i < LATEX_PAIRS.length; i++) {
    s = s.split(LATEX_PAIRS[i].from).join(LATEX_PAIRS[i].to);
  }
  for (let i = 0; i < LATEX_FUNCS.length; i++) {
    s = s.split(LATEX_FUNCS[i]).join('\\' + LATEX_FUNCS[i]);
  }
  return s.replace(/\s+/g, '');
}

function formulaKindOf(formula: string): string {
  if (formula.indexOf('∫') >= 0) {
    return '积分式';
  }
  if (formula.indexOf('∑') >= 0 || formula.indexOf('Σ') >= 0) {
    return '求和式';
  }
  if (formula.indexOf('√') >= 0) {
    return '根式';
  }
  if (/sin|cos|tan|cot/.test(formula)) {
    return '三角式';
  }
  if (/lim/.test(formula)) {
    return '极限式';
  }
  const parts = formula.split('=');
  if (parts.length === 2) {
    return '方程 / 等式';
  }
  if (parts.length > 2) {
    return '链式等式';
  }
  return '数学表达式';
}

function formulaWarnings(formula: string, lines: string[]): string[] {
  const out: string[] = [];
  let left = 0;
  let right = 0;
  for (let i = 0; i < formula.length; i++) {
    if (formula.charAt(i) === '(') {
      left++;
    }
    if (formula.charAt(i) === ')') {
      right++;
    }
  }
  if (left !== right) {
    out.push('括号可能未配对（左 ' + left + ' / 右 ' + right + '），请核对圈选是否完整');
  }
  const eq = formula.indexOf('=');
  if (eq > 0) {
    if (formula.substring(eq + 1).trim().length === 0) {
      out.push('等号右侧为空，可能圈选被截断');
    }
    if (formula.substring(0, eq).trim().length === 0) {
      out.push('等号左侧为空，可能圈选被截断');
    }
  }
  if (/[\u4e00-\u9fa5]/.test(formula)) {
    out.push('公式行混入中文，可能圈入了题干文字');
  }
  if (formula.length < 3) {
    out.push('识别文本过短，建议放大后重新圈选');
  }
  if (lines.length > 4) {
    out.push('区域内共 ' + lines.length + ' 行文本，仅取最像公式的一行');
  }
  return out;
}

function otherFormulaLines(lines: string[], primary: string): string[] {
  const ranked = rankedFormulaLines(lines, 4);
  const out: string[] = [];
  for (let i = 0; i < ranked.length; i++) {
    if (ranked[i] !== primary) {
      out.push(ranked[i]);
    }
    if (out.length >= 2) {
      break;
    }
  }
  return out;
}

function splitEquals(formula: string): string[] {
  const parts: string[] = [];
  const raw = formula.split('=');
  for (let i = 0; i < raw.length; i++) {
    const part = raw[i].trim();
    if (part.length > 0) {
      parts.push(part);
    }
  }
  return parts;
}

function formulaSymbols(formula: string): string[] {
  const symbols: string[] = [];
  for (let i = 0; i < MATH_SYMBOLS.length; i++) {
    if (formula.indexOf(MATH_SYMBOLS[i]) >= 0) {
      symbols.push(MATH_SYMBOLS[i]);
    }
  }
  return symbols;
}

function formulaSteps(formula: string, kindLabel: string): string[] {
  const steps: string[] = [];
  steps.push('识别类型：' + kindLabel);
  const parts = splitEquals(formula);
  if (parts.length === 2) {
    steps.push('等号左侧：' + parts[0]);
    steps.push('等号右侧：' + parts[1]);
  } else if (parts.length > 2) {
    for (let i = 0; i < parts.length; i++) {
      steps.push('第 ' + (i + 1) + ' 段：' + parts[i]);
    }
  } else {
    steps.push('识别到的表达式：' + formula);
  }
  const symbols = formulaSymbols(formula);
  steps.push(symbols.length > 0
    ? '涉及符号：' + symbols.join(' ')
    : '未检测到常见数学符号，请确认圈选是否覆盖完整公式');
  return steps;
}

function ocrConfidence(text: string, kind: number): number {
  const len = text.length;
  const math = mathScore(text);
  let value = 0.55 + Math.min(0.3, len * 0.008) + Math.min(0.1, math * 0.02);
  if (kind === AiCaptureKind.Formula && math >= 2) {
    value += 0.02;
  }
  return round2(clamp(value, 0.3, 0.98));
}

function looksLikeFormula(text: string): boolean {
  if (text.length === 0 || text.length > 60) {
    return false;
  }
  if (/求|已知|证明|如图|下列|选项|解方程|计算|化简|判断|解集/.test(text) && text.length > 12) {
    return false;
  }
  const lines = splitLines(text);
  if (lines.length === 1 && mathScore(lines[0]) >= 3) {
    return true;
  }
  // 多行板书：只有唯一一行数学得分突出（≥ 4）时才判为公式，
  // 避免把「多行题干」误判成公式。
  if (lines.length > 1) {
    const ranked = rankedFormulaLines(lines, 2);
    if (ranked.length === 1 && mathScore(ranked[0]) >= 4) {
      return true;
    }
  }
  return false;
}

export function recognizeFromText(input: AiTextInput): AiRecognizeResult {
  const text = normalizeText(input.Text);
  let kind = input.Kind === AiCaptureKind.Formula ? AiCaptureKind.Formula : AiCaptureKind.Question;
  // 识题入口框到的是公式时不跳题目：短文本且数学符号密集则自动按公式输出。
  if (kind === AiCaptureKind.Question && text.length > 0 && looksLikeFormula(text)) {
    kind = AiCaptureKind.Formula;
  }
  if (text.length === 0) {
    if (!input.Available) {
      return {
        Kind: kind,
        Title: '设备不支持端侧识别',
        Badge: '当前设备缺少 OCR 能力',
        Question: '这台设备（常见于模拟器）没有端侧文字识别引擎，无法读取圈选内容。请在 HarmonyOS 真机上重试；板书不会上传到任何服务器。',
        Formula: '',
        FormulaLatex: '',
        Candidates: [],
        Givens: [],
        Goal: '',
        Pitfalls: [],
        Warnings: [],
        Steps: [],
        Tags: [],
        Confidence: 0.2,
        Engine: '端侧 OCR · 不可用'
      };
    }
    const hasInk = input.Ink.StrokeCount > 0;
    return {
      Kind: kind,
      Title: hasInk ? '未读到文字，已做墨迹统计' : '未识别到文字',
      Badge: hasInk ? 'OCR 未返回文本 · 墨迹可统计' : 'OCR 未返回内容',
      Question: hasInk
        ? '圈选区域内有 ' + input.Ink.StrokeCount + ' 笔手写墨迹，但端侧 OCR 主要识别印刷体文字，未读到可复制文本。可放大板书后重试，或改用「智能图形规整」把手绘图形规范化。'
        : '圈选区域内没有识别到可读内容。请放大板书、提高对比度，或重新圈选后再试。',
      Formula: '',
      FormulaLatex: '',
      Candidates: [],
      Givens: [],
      Goal: '',
      Pitfalls: [],
      Warnings: hasInk ? ['手写体识别率低于印刷体，建议放大后重试'] : [],
      Steps: hasInk
        ? ['墨迹：' + input.Ink.StrokeCount + ' 笔 / ' + input.Ink.PointCount + ' 点',
          '颜色：' + input.Ink.ColorCount + ' 种',
          '已识别图形：' + input.Ink.ShapeCount + ' 个']
        : [],
      Tags: hasInk ? ['手写板书'] : [],
      Confidence: 0.3,
      Engine: hasInk ? '端侧 OCR · 未识别（附墨迹统计）' : '端侧 OCR · 未识别'
    };
  }
  const lines = splitLines(text);
  const formula = bestFormulaLine(lines);
  const topics = detectTopics(text);
  const compact = text.replace(/\n+/g, ' ').trim();
  if (kind === AiCaptureKind.Formula) {
    const raw = formula.length > 0 ? formula : lines[0];
    const formulaText = normalizeFormula(raw);
    const latex = formulaToLatex(formulaText);
    const kindLabel = formulaKindOf(formulaText);
    return {
      Kind: AiCaptureKind.Formula,
      Title: '公式识别完成',
      Badge: 'OCR · ' + kindLabel + ' · LaTeX 可复制',
      Question: '识别到的内容：' + compact,
      Formula: formulaText,
      FormulaLatex: latex,
      Candidates: otherFormulaLines(lines, formula),
      Givens: [],
      Goal: '',
      Pitfalls: [],
      Warnings: formulaWarnings(formulaText, lines),
      Steps: formulaSteps(formulaText, kindLabel),
      Tags: topics,
      Confidence: ocrConfidence(text, AiCaptureKind.Formula),
      Engine: '端侧 OCR + 规则转写 LaTeX（未联网）'
    };
  }
  const goal = extractGoal(text);
  return {
    Kind: AiCaptureKind.Question,
    Title: '题目识别完成',
    Badge: 'OCR · ' + topics[0] + ' · 本地解题提示',
    Question: compact,
    Formula: formula,
    FormulaLatex: '',
    Candidates: [],
    Givens: extractGivens(text),
    Goal: goal,
    Pitfalls: pitfallsForTopics(topics),
    Warnings: questionWarnings(text, goal),
    Steps: stepsForTopics(topics),
    Tags: topics,
    Confidence: ocrConfidence(text, AiCaptureKind.Question),
    Engine: '端侧 OCR + 题型规则（未联网搜题）'
  };
}