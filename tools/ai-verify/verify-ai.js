const fs = require('fs');
const path = require('path');
const ts = require('D:/Huawei/DevEcoCLI/command-line-tools/sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript');

const srcPath = 'D:/Ink-Canvas-HEHS/harmony/core/src/main/ets/ai/AiAssistant.ts';
let src = fs.readFileSync(srcPath, 'utf8');
src = src.replace(/^import .*$/gm, '');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const outPath = path.join(__dirname, 'AiAssistant.compiled.js');
fs.writeFileSync(outPath, js);
const ai = require(outPath);

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('PASS ' + name);
  } else {
    fail++;
    console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
}

const ink = { StrokeCount: 3, PointCount: 90, ColorCount: 2, ShapeCount: 0 };
const region = { Left: 0, Top: 0, Width: 400, Height: 60 };

const f1 = ai.recognizeFromText({ Kind: 1, Text: '∫₀¹ (3x² + 2x) dx = 2', Available: true, Region: region, Ink: ink });
check('公式-类型', f1.Kind === 1);
check('公式-公式行', f1.Formula.length > 0, f1.Formula);
check('公式-LaTeX积分上下限', f1.FormulaLatex.indexOf('\\int_{0}^{1}') >= 0, f1.FormulaLatex);
check('公式-LaTeX幂', f1.FormulaLatex.indexOf('^{2}') >= 0, f1.FormulaLatex);
check('公式-类型标签', f1.Badge.indexOf('积分式') >= 0, f1.Badge);
check('公式-引擎可追溯', f1.Engine.indexOf('规则转写') >= 0, f1.Engine);
check('公式-步骤', f1.Steps.length >= 2);

const f2 = ai.recognizeFromText({ Kind: 1, Text: 'x^2/4 + y^2/9 = 1', Available: true, Region: region, Ink: ink });
check('公式2-LaTeX分式', f2.FormulaLatex.indexOf('\\frac{x^{2}}{4}') >= 0, f2.FormulaLatex);
check('公式2-方程类型', f2.Badge.indexOf('方程') >= 0 || f2.Badge.indexOf('等式') >= 0, f2.Badge);

const f3 = ai.recognizeFromText({ Kind: 1, Text: 'sin 2θ = 2 sinθ cosθ', Available: true, Region: region, Ink: ink });
check('公式3-三角类型', f3.Badge.indexOf('三角式') >= 0, f3.Badge);
check('公式3-函数名转写', f3.FormulaLatex.indexOf('\\sin') >= 0, f3.FormulaLatex);
check('公式3-希腊字母', f3.FormulaLatex.indexOf('\\theta') >= 0, f3.FormulaLatex);

const f4 = ai.recognizeFromText({
  Kind: 1,
  Text: '例题讲解\nf(x) = x² − 4x + 3\n判别式 Δ = b² − 4ac',
  Available: true,
  Region: { Left: 0, Top: 0, Width: 400, Height: 200 },
  Ink: ink
});
check('公式4-主公式', f4.Formula.length > 0, f4.Formula);
check('公式4-有候选', f4.Candidates.length >= 1, JSON.stringify(f4.Candidates));

const q1 = ai.recognizeFromText({
  Kind: 0,
  Text: '已知函数 f(x) = x² − 4x + 3，求 f(x) 在闭区间 [0, 3] 上的最小值与最大值。',
  Available: true,
  Region: { Left: 0, Top: 0, Width: 500, Height: 200 },
  Ink: ink
});
check('搜题-类型', q1.Kind === 0);
check('搜题-已知抽取', q1.Givens.length > 0 && q1.Givens[0].indexOf('函数') >= 0, JSON.stringify(q1.Givens));
check('搜题-所求抽取', q1.Goal.indexOf('最小值') >= 0, q1.Goal);
check('搜题-易错', q1.Pitfalls.length > 0, JSON.stringify(q1.Pitfalls));
check('搜题-标签含函数', q1.Tags[0] === '函数与图像', JSON.stringify(q1.Tags));
check('搜题-引擎明确未联网', q1.Engine.indexOf('未联网') >= 0, q1.Engine);
check('搜题-步骤', q1.Steps.length >= 3);

const auto = ai.recognizeFromText({ Kind: 0, Text: 'a² + b² = c²', Available: true, Region: region, Ink: ink });
check('自动判型-公式', auto.Kind === 1, String(auto.Kind));

const noOcr = ai.recognizeFromText({ Kind: 0, Text: '', Available: false, Region: region, Ink: ink });
check('无OCR-不编造', noOcr.Confidence <= 0.3 && noOcr.Title.indexOf('不支持') >= 0, noOcr.Title);

const handInk = ai.recognizeFromText({
  Kind: 1,
  Text: '',
  Available: true,
  Region: region,
  Ink: { StrokeCount: 6, PointCount: 240, ColorCount: 1, ShapeCount: 0 }
});
check('手写-墨迹统计', handInk.Steps.length >= 3 && handInk.Tags[0] === '手写板书', JSON.stringify(handInk.Tags));

const warn = ai.recognizeFromText({ Kind: 1, Text: 'f(x = x² + 1', Available: true, Region: region, Ink: ink });
check('质量告警-括号', warn.Warnings.length > 0, JSON.stringify(warn.Warnings));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);