// 新增（鸿蒙端增强）— AI 教学助手交互层
// 三块界面：圈选识题/识公式、板书一键转课堂纪要、智能图形规整。
// 视觉语言：深色 HUD + 青色扫描光 + 弹簧入场；全部动效尊重「减少动效」开关。
// 诚实边界：识别与纪要内容来自 core 的本地确定性引擎（端侧演示），不是真实模型推理；
// 卡片底部固定展示引擎来源，避免把演示结果误当成真实识别。
import type { AiRegion, AiRecognizeResult, LectureNotes, LectureNoteCard, ShapeSnapOption } from '@inkcanvas/core';
import { confidencePercent, recommendedSnapIndex } from '@inkcanvas/core';
import { ThemeTokens, themeTokens } from './ThemeTokens';
import { panelBackground, panelBlurStyle } from './PanelStyle';
import { animateMotion, MOTION_FAST, MOTION_STANDARD, MOTION_SLOW, motionDuration } from './Motion';

const AI_CYAN: string = '#FF38E1FF';
const AI_BLUE: string = '#FF2E7BFF';
const AI_VIOLET: string = '#FF7C4DFF';
const AI_MINT: string = '#FF22C55E';
const AI_AMBER: string = '#FFF59E0B';
const AI_TRACK: string = '#3322D3EE';

// 圈选阶段文案（0.4s 一档）。
const SCAN_STAGES: string[] = [
  '定位圈选区域…',
  '提取笔迹与公式结构…',
  '生成识别结果…'
];

// 图形规整预览路径（原手绘轮廓 + 四种规整形态）。
const RAW_PATH: string = 'M 36 118 C 58 44, 132 26, 186 56 C 226 78, 226 128, 190 152 C 152 176, 72 170, 40 146 C 30 138, 30 126, 36 118';
const CIRCLE_PATH: string = 'M 64 100 A 66 66 0 1 1 196 100 A 66 66 0 1 1 64 100';
const RECT_PATH: string = 'M 56 44 L 204 44 L 204 156 L 56 156 Z';
const TRIANGLE_PATH: string = 'M 130 34 L 206 164 L 54 164 Z';
const LINE_PATH: string = 'M 46 156 L 214 44';

function pathForKind(kind: number): string {
  if (kind === 2) {
    return CIRCLE_PATH;
  }
  if (kind === 5) {
    return RECT_PATH;
  }
  if (kind === 4) {
    return TRIANGLE_PATH;
  }
  return LINE_PATH;
}

function stageOf(elapsed: number): number {
  const index = Math.floor(elapsed / 420);
  if (index > 2) {
    return 2;
  }
  return index;
}

// ---------------------------------------------------------------- 圈选层

@Component
export struct AiCaptureOverlay {
  @Prop dark: boolean = false;
  @Prop reduceMotion: boolean = false;
  @Prop scanning: boolean = false;
  @Prop hint: string = '圈出要识别的题目或公式';
  @Prop scanLabel: string = '正在识别选区';
  onCapture: (region: AiRegion) => void = (region: AiRegion) => {
    void region;
  };
  onCancel: () => void = () => {
  };

  @State selX: number = 0;
  @State selY: number = 0;
  @State selW: number = 0;
  @State selH: number = 0;
  @State dragging: boolean = false;
  @State scanPhase: number = 0;
  @State scanStage: number = 0;
  @State armed: boolean = false;

  private startX: number = 0;
  private startY: number = 0;
  private areaW: number = 0;
  private areaH: number = 0;
  private scanTimer: number = -1;
  private scanStart: number = 0;
  private vGrid: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
  private hGrid: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

  aboutToAppear(): void {
    this.armed = true;
  }

  aboutToDisappear(): void {
    this.stopScan();
  }

  private stopScan(): void {
    if (this.scanTimer >= 0) {
      clearInterval(this.scanTimer);
      this.scanTimer = -1;
    }
  }

  private beginScan(): void {
    this.scanStart = Date.now();
    this.scanStage = 0;
    this.stopScan();
    this.scanTimer = setInterval(() => {
      const elapsed = Date.now() - this.scanStart;
      const phase = (elapsed % 1400) / 1400;
      this.scanPhase = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
      this.scanStage = stageOf(elapsed);
    }, 40);
  }

  private finishSelection(): void {
    if (this.selW < 24 || this.selH < 24) {
      this.selW = 0;
      this.selH = 0;
      this.dragging = false;
      return;
    }
    this.dragging = false;
    this.beginScan();
    this.onCapture({ Left: this.selX, Top: this.selY, Width: this.selW, Height: this.selH });
  }

  private stageText(): string {
    return SCAN_STAGES[this.scanStage];
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor('#CC05070C')

      // 科技感网格（低透明度，不参与命中）。
      ForEach(this.vGrid, (i: number) => {
        Rect()
          .width(1)
          .height('100%')
          .fill('#1438E1FF')
          .position({ x: (i * 100 / 18) + '%', y: 0 })
      }, (i: number) => 'v' + i)
      ForEach(this.hGrid, (i: number) => {
        Rect()
          .width('100%')
          .height(1)
          .fill('#1438E1FF')
          .position({ x: 0, y: (i * 100 / 12) + '%' })
      }, (i: number) => 'h' + i)

      // 顶部指令条
      Row({ space: 10 }) {
        Stack({ alignContent: Alignment.Center }) {
          Circle()
            .width(30)
            .height(30)
            .fill('#3338E1FF')
          Circle()
            .width(30)
            .height(30)
            .stroke(AI_CYAN)
            .strokeWidth(1)
          Text('AI')
            .fontSize(11)
            .fontColor(AI_CYAN)
            .fontWeight(FontWeight.Bold)
        }
        Column({ space: 2 }) {
          Text(this.scanning ? this.scanLabel : this.hint)
            .fontSize(15)
            .fontColor('#F2FFFFFF')
            .fontWeight(FontWeight.Medium)
          Text(this.scanning ? this.stageText() : '拖拽框选区域 · 松手后自动识别')
            .fontSize(11)
            .fontColor('#A8FFFFFF')
        }
        Blank()
        Text('取消')
          .fontSize(12)
          .fontColor('#D8FFFFFF')
          .padding({ left: 12, right: 12, top: 7, bottom: 7 })
          .backgroundColor('#26FFFFFF')
          .borderRadius(14)
          .onClick(() => {
            this.stopScan();
            this.onCancel();
          })
      }
      .width('100%')
      .padding({ left: 22, right: 22, top: 18, bottom: 18 })
      .backgroundColor('#99000000')
      .border({ width: { bottom: 1 }, color: '#2638E1FF' })

      // 圈选矩形
      if (this.selW > 0 && this.selH > 0) {
        Rect()
          .width(this.selW)
          .height(this.selH)
          .fill('#1238E1FF')
          .stroke('#FF38E1FF')
          .strokeWidth(1.6)
          .shadow({ radius: 24, color: '#6638E1FF', offsetX: 0, offsetY: 0 })
          .position({ x: this.selX, y: this.selY })

        // 四角光点
        ForEach([0, 1, 2, 3], (index: number) => {
          Circle()
            .width(8)
            .height(8)
            .fill(AI_CYAN)
            .shadow({ radius: 14, color: AI_CYAN, offsetX: 0, offsetY: 0 })
            .position({
              x: (index === 0 || index === 3) ? this.selX - 4 : this.selX + this.selW - 4,
              y: (index < 2) ? this.selY - 4 : this.selY + this.selH - 4
            })
        }, (index: number) => 'corner' + index)

        // 尺寸标签
        Text(Math.round(this.selW) + ' × ' + Math.round(this.selH))
          .fontSize(10)
          .fontColor('#D8FFFFFF')
          .padding({ left: 6, right: 6, top: 3, bottom: 3 })
          .backgroundColor('#99000000')
          .borderRadius(4)
          .position({ x: this.selX + this.selW - 74, y: this.selY + this.selH + 6 })

        // 扫描光带
        if (this.scanTimer >= 0) {
          Column()
            .width(this.selW)
            .height(58)
            .linearGradient({
              angle: 180,
              colors: [['#0038E1FF', 0.0], ['#5538E1FF', 0.45], ['#AA38E1FF', 0.52], ['#0038E1FF', 1.0]]
            })
            .position({ x: this.selX, y: this.selY + this.scanPhase * Math.max(0, this.selH - 58) })
          Rect()
            .width(this.selW)
            .height(2)
            .fill(AI_CYAN)
            .shadow({ radius: 18, color: AI_CYAN, offsetX: 0, offsetY: 0 })
            .position({ x: this.selX, y: this.selY + this.scanPhase * Math.max(0, this.selH - 2) })
          ForEach([0, 1, 2], (index: number) => {
            Circle()
              .width(5)
              .height(5)
              .fill('#E6FFFFFF')
              .position({
                x: this.selX + this.selW * (0.24 + index * 0.26),
                y: this.selY + this.scanPhase * Math.max(0, this.selH - 6)
              })
          }, (index: number) => 'particle' + index)
        }
      }

      // 底部状态
      Row({ space: 8 }) {
        if (this.scanTimer >= 0) {
          Circle()
            .width(8)
            .height(8)
            .fill(AI_CYAN)
          Text(this.stageText())
            .fontSize(12)
            .fontColor('#E6FFFFFF')
          LoadingProgress()
            .width(14)
            .height(14)
            .color(AI_CYAN)
        } else {
          Text('提示：公式可横向圈选，题目尽量包含完整题干与选项')
            .fontSize(11)
            .fontColor('#8CFFFFFF')
        }
      }
      .position({ x: 22, y: '100%' })
      .translate({ y: -34 })
    }
    .width('100%')
    .height('100%')

    .onAreaChange((oldValue: Area, newValue: Area) => {
      this.areaW = Number(newValue.width);
      this.areaH = Number(newValue.height);
    })
    .onTouch((event: TouchEvent) => {
      if (this.scanTimer >= 0) {
        return;
      }
      if (event.touches.length === 0) {
        return;
      }
      const touch = event.touches[0];
      if (event.type === TouchType.Down) {
        this.dragging = true;
        this.startX = touch.x;
        this.startY = touch.y;
        this.selX = touch.x;
        this.selY = touch.y;
        this.selW = 0;
        this.selH = 0;
      } else if (event.type === TouchType.Move && this.dragging) {
        const dx = touch.x - this.startX;
        const dy = touch.y - this.startY;
        this.selX = Math.min(this.startX, this.startX + dx);
        this.selY = Math.min(this.startY, this.startY + dy);
        this.selW = Math.abs(dx);
        this.selH = Math.abs(dy);
      } else if (event.type === TouchType.Up && this.dragging) {
        this.finishSelection();
      } else if (event.type === TouchType.Cancel) {
        this.dragging = false;
      }
    })
  }
}

// ---------------------------------------------------------------- 生成中覆盖层

@Component
export struct AiGeneratingOverlay {
  @Prop dark: boolean = false;
  @Prop reduceMotion: boolean = false;
  @Prop title: string = 'AI 正在梳理板书';
  @Prop subtitle: string = '提取要点 · 关联公式 · 生成课堂纪要';
  @Prop progress: number = 0;

  @State spin: number = 0;
  private spinTimer: number = -1;

  aboutToAppear(): void {
    this.spinTimer = setInterval(() => {
      this.spin = (this.spin + 6) % 360;
    }, 40);
  }

  aboutToDisappear(): void {
    if (this.spinTimer >= 0) {
      clearInterval(this.spinTimer);
      this.spinTimer = -1;
    }
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor('#B305070C')

      Column({ space: 18 }) {
        Stack({ alignContent: Alignment.Center }) {
          Circle()
            .width(120)
            .height(120)
            .fill('#1238E1FF')
            .stroke('#3338E1FF')
            .strokeWidth(1)
          Circle()
            .width(96)
            .height(96)
            .stroke('#22FFFFFF')
            .strokeWidth(1)
          Circle()
            .width(120)
            .height(120)
            .stroke(AI_CYAN)
            .strokeWidth(3)
            .borderRadius(60)
            .rotate({ angle: this.spin })
            .opacity(0.9)
          Circle()
            .width(150)
            .height(150)
            .stroke('#2238E1FF')
            .strokeWidth(1)
            .opacity(0.7)
          Text(Math.round(this.progress * 100) + '%')
            .fontSize(22)
            .fontColor('#F2FFFFFF')
            .fontWeight(FontWeight.Bold)
        }
        Text(this.title)
          .fontSize(18)
          .fontColor('#F2FFFFFF')
          .fontWeight(FontWeight.Medium)
        Text(this.subtitle)
          .fontSize(12)
          .fontColor('#A8FFFFFF')
        Row()
          .width(260)
          .height(4)
          .backgroundColor('#26FFFFFF')
          .borderRadius(2)
          .linearGradient({
            angle: 90,
            colors: [[AI_CYAN, 0.0], [AI_BLUE, 0.5], [AI_VIOLET, 1.0]]
          })
          .opacity(this.progress > 0.02 ? 1 : 0)
        Text('端侧演示引擎 · 不上传任何板书内容')
          .fontSize(10)
          .fontColor('#7338E1FF')
      }
      .padding(28)
      .width(420)
      .backgroundColor('#E605070C')
      .borderRadius(20)
      .border({ width: 1, color: '#3338E1FF' })
      .shadow({ radius: 40, color: '#5538E1FF', offsetX: 0, offsetY: 8 })
    }
    .width('100%')
    .height('100%')
  }
}

// ---------------------------------------------------------------- 识别结果卡

@Component
export struct AiResultCard {
  @Prop dark: boolean = false;
  @Prop reduceMotion: boolean = false;
  @Prop result: AiRecognizeResult = {
    Kind: 0,
    Title: '识别完成',
    Badge: '',
    Question: '',
    Formula: '',
    FormulaLatex: '',
    Candidates: [],
    Givens: [],
    Goal: '',
    Pitfalls: [],
    Warnings: [],
    Steps: [],
    Tags: [],
    Confidence: 0.9,
    Engine: ''
  };
  onClose: () => void = () => {
  };
  onCopy: () => void = () => {
  };
  onRecapture: () => void = () => {
  };
  onInsertNotes: () => void = () => {
  };

  @State reveal: boolean = false;
  @State ringValue: number = 0;
  @State stepsReveal: number = 0;
  private stepTimer: number = -1;

  aboutToAppear(): void {
    const target = confidencePercent(this.result.Confidence);
    setTimeout(() => {
      this.reveal = true;
      animateMotion(this.getUIContext(), this.reduceMotion, 720, () => {
        this.ringValue = target;
      });
      this.stepTimer = setInterval(() => {
        if (this.stepsReveal < this.result.Steps.length) {
          this.stepsReveal++;
        } else if (this.stepTimer >= 0) {
          clearInterval(this.stepTimer);
          this.stepTimer = -1;
        }
      }, 110);
    }, 30);
  }

  aboutToDisappear(): void {
    if (this.stepTimer >= 0) {
      clearInterval(this.stepTimer);
      this.stepTimer = -1;
    }
  }

  private tokens(): ThemeTokens {
    return themeTokens(this.dark);
  }

  private accent(): string {
    return this.result.Kind === 1 ? AI_VIOLET : AI_CYAN;
  }

  @Builder
  TagChip(label: string) {
    Text(label)
      .fontSize(10)
      .fontColor(this.dark ? '#D8FFFFFF' : '#D8000000')
      .padding({ left: 8, right: 8, top: 4, bottom: 4 })
      .backgroundColor(this.dark ? '#1AFFFFFF' : '#0F000000')
      .borderRadius(10)
      .border({ width: 1, color: this.dark ? '#26FFFFFF' : '#1A000000' })
  }

  build() {
    Column({ space: 0 }) {
      // 顶部渐变条
      Row()
        .width('100%')
        .height(3)
        .linearGradient({
          angle: 90,
          colors: [[this.accent(), 0.0], [AI_BLUE, 0.6], ['#0038E1FF', 1.0]]
        })
        .borderRadius({ topLeft: 18, topRight: 18 })

      Scroll() {
      Column({ space: 14 }) {
        Row({ space: 10 }) {
          Stack({ alignContent: Alignment.Center }) {
            Circle()
              .width(34)
              .height(34)
              .fill('#2638E1FF')
            Text(this.result.Kind === 1 ? 'ƒ' : 'AI')
              .fontSize(this.result.Kind === 1 ? 17 : 11)
              .fontColor(this.accent())
              .fontWeight(FontWeight.Bold)
          }
          Column({ space: 3 }) {
            Text(this.result.Title)
              .fontSize(17)
              .fontColor(this.tokens().textPrimary)
              .fontWeight(FontWeight.Medium)
            Text(this.result.Badge)
              .fontSize(10)
              .fontColor(this.accent())
          }
          Blank()
          Text('✕')
            .fontSize(14)
            .fontColor(this.tokens().textSecondary)
            .padding(8)
            .onClick(() => {
              this.onClose();
            })
        }

        // 识别文本
        Column({ space: 6 }) {
          Row({ space: 6 }) {
            Rect()
              .width(3)
              .height(12)
              .fill(this.accent())
              .borderRadius(2)
            Text(this.result.Kind === 1 ? '识别到的公式' : '识别到的题目')
              .fontSize(10)
              .fontColor(this.tokens().textSecondary)
            Blank()
            Text('可复制')
              .fontSize(10)
              .fontColor(this.accent())
          }
          Text(this.result.Question)
            .fontSize(14)
            .fontColor(this.tokens().textPrimary)
            .lineHeight(21)
            .width('100%')
        }
        .padding(12)
        .width('100%')
        .backgroundColor(this.dark ? '#14FFFFFF' : '#0A000000')
        .borderRadius(10)
        .border({ width: 1, color: this.dark ? '#1FFFFFFF' : '#0F000000' })

        // 识别质量提示（不阻断展示）
        if (this.result.Warnings.length > 0) {
          Column({ space: 3 }) {
            ForEach(this.result.Warnings, (w: string, index: number) => {
              Text('⚠ ' + w)
                .fontSize(10)
                .fontColor('#FFE0A040')
                .width('100%')
            }, (w: string, index: number) => 'warn' + index)
          }
          .alignItems(HorizontalAlign.Start)
          .padding(10)
          .width('100%')
          .backgroundColor('#12F59E0B')
          .borderRadius(8)
        }

        // 已知 / 所求（搜题增强）
        if (this.result.Givens.length > 0 || this.result.Goal !== '') {
          Column({ space: 6 }) {
            if (this.result.Givens.length > 0) {
              Row({ space: 8 }) {
                Text('已知')
                  .fontSize(9)
                  .fontColor(this.accent())
                  .width(26)
                Text(this.result.Givens.join('；'))
                  .fontSize(12)
                  .fontColor(this.tokens().textPrimary)
                  .lineHeight(17)
                  .layoutWeight(1)
              }
              .alignItems(VerticalAlign.Top)
              .width('100%')
            }
            if (this.result.Goal !== '') {
              Row({ space: 8 }) {
                Text('求')
                  .fontSize(9)
                  .fontColor(this.accent())
                  .width(26)
                Text(this.result.Goal)
                  .fontSize(12)
                  .fontColor(this.tokens().textPrimary)
                  .lineHeight(17)
                  .layoutWeight(1)
              }
              .alignItems(VerticalAlign.Top)
              .width('100%')
            }
          }
          .alignItems(HorizontalAlign.Start)
          .padding(12)
          .width('100%')
          .backgroundColor(this.dark ? '#14FFFFFF' : '#0A000000')
          .borderRadius(10)
          .border({ width: 1, color: this.dark ? '#1FFFFFFF' : '#0F000000' })
        }

        // 公式
        if (this.result.Formula !== '') {
          Column({ space: 4 }) {
            Text('关键式')
              .fontSize(9)
              .fontColor(this.tokens().textSecondary)
            Text(this.result.Formula)
              .fontSize(16)
              .fontColor(this.dark ? '#FFE6F7FF' : '#FF0B3A66')
              .fontWeight(FontWeight.Medium)
              .letterSpacing(0.4)
            if (this.result.FormulaLatex !== '') {
              Text('LaTeX  ' + this.result.FormulaLatex)
                .fontSize(10)
                .fontColor(this.tokens().textSecondary)
                .width('100%')
                .maxLines(3)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
            }
          }
          .alignItems(HorizontalAlign.Start)
          .padding(12)
          .width('100%')
          .backgroundColor('#1438E1FF')
          .borderRadius(10)
          .border({ width: 1, color: '#3338E1FF' })
        }

        // 候选公式（同一圈选区域内其它高分行）
        if (this.result.Candidates.length > 0) {
          Column({ space: 4 }) {
            Text('其他候选公式 · 按匹配度排序')
              .fontSize(9)
              .fontColor(this.tokens().textSecondary)
            ForEach(this.result.Candidates, (line: string, index: number) => {
              Text('· ' + line)
                .fontSize(11)
                .fontColor(this.tokens().textSecondary)
                .lineHeight(16)
                .width('100%')
                .maxLines(2)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
            }, (line: string, index: number) => 'cand' + index)
          }
          .alignItems(HorizontalAlign.Start)
          .padding(10)
          .width('100%')
          .backgroundColor(this.dark ? '#0FFFFFFF' : '#08000000')
          .borderRadius(8)
        }

        // 解题步骤（错峰出现）
        if (this.result.Steps.length > 0) {
          Column({ space: 8 }) {
            Text(this.result.Kind === 1 ? '推导步骤' : '解题思路')
              .fontSize(10)
              .fontColor(this.tokens().textSecondary)
            ForEach(this.result.Steps, (step: string, index: number) => {
              Row({ space: 8 }) {
                Text(String(index + 1))
                  .fontSize(10)
                  .fontColor('#FF05070C')
                  .fontWeight(FontWeight.Bold)
                  .width(16)
                  .height(16)
                  .textAlign(TextAlign.Center)
                  .backgroundColor(this.accent())
                  .borderRadius(8)
                Text(step)
                  .fontSize(12)
                  .fontColor(this.tokens().textPrimary)
                  .lineHeight(18)
                  .layoutWeight(1)
              }
              .width('100%')
              .opacity(index < this.stepsReveal ? 1 : 0)
              .translate({ y: index < this.stepsReveal ? 0 : 8 })
              .animation({ duration: this.reduceMotion ? 0 : MOTION_STANDARD, curve: Curve.EaseOut })
            }, (step: string, index: number) => 'step' + index)
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')
        }

        // 易错提醒（搜题增强）
        if (this.result.Pitfalls.length > 0) {
          Column({ space: 6 }) {
            Text('易错提醒')
              .fontSize(10)
              .fontColor('#FFF59E0B')
            ForEach(this.result.Pitfalls, (item: string, index: number) => {
              Text('· ' + item)
                .fontSize(11)
                .fontColor(this.tokens().textSecondary)
                .lineHeight(17)
                .width('100%')
            }, (item: string, index: number) => 'pit' + index)
          }
          .alignItems(HorizontalAlign.Start)
          .padding(10)
          .width('100%')
          .backgroundColor('#14F59E0B')
          .borderRadius(10)
          .border({ width: 1, color: '#33F59E0B' })
        }

        // 知识点
        if (this.result.Tags.length > 0) {
          Flex({ wrap: FlexWrap.Wrap }) {
            ForEach(this.result.Tags, (tag: string) => {
              this.TagChip(tag)
            }, (tag: string) => tag)
          }
          .width('100%')
        }

        Divider()
          .color(this.dark ? '#1AFFFFFF' : '#0F000000')

        // 底部：置信度 + 操作
        Row({ space: 12 }) {
          Stack({ alignContent: Alignment.Center }) {
            Progress({ value: this.ringValue, total: 100, type: ProgressType.Ring })
              .width(46)
              .height(46)
              .color(this.accent())
              .backgroundColor(AI_TRACK)
              .style({ strokeWidth: 4 })
            Text(this.ringValue + '%')
              .fontSize(10)
              .fontColor(this.tokens().textPrimary)
              .fontWeight(FontWeight.Medium)
          }
          Column({ space: 2 }) {
            Text('识别置信度')
              .fontSize(9)
              .fontColor(this.tokens().textSecondary)
            Text(this.result.Engine)
              .fontSize(9)
              .fontColor(this.tokens().textSecondary)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)

          Text('重选')
            .fontSize(12)
            .fontColor(this.tokens().textPrimary)
            .padding({ left: 10, right: 10, top: 7, bottom: 7 })
            .backgroundColor(this.dark ? '#1AFFFFFF' : '#0F000000')
            .borderRadius(14)
            .onClick(() => {
              this.onRecapture();
            })
          Text('复制')
            .fontSize(12)
            .fontColor(this.tokens().textPrimary)
            .padding({ left: 10, right: 10, top: 7, bottom: 7 })
            .backgroundColor(this.dark ? '#1AFFFFFF' : '#0F000000')
            .borderRadius(14)
            .onClick(() => {
              this.onCopy();
            })
          Text('转纪要')
            .fontSize(12)
            .fontColor('#FF05070C')
            .fontWeight(FontWeight.Medium)
            .padding({ left: 12, right: 12, top: 7, bottom: 7 })
            .linearGradient({ angle: 135, colors: [[AI_CYAN, 0.0], [AI_BLUE, 1.0]] })
            .borderRadius(14)
            .onClick(() => {
              this.onInsertNotes();
            })
        }
        .width('100%')
      }
      .padding({ left: 18, right: 18, top: 16, bottom: 18 })
      .width('100%')
      }
      .constraintSize({ maxHeight: '82%' })
      .scrollBar(BarState.Auto)
      .edgeEffect(EdgeEffect.Spring)
    }
    .width(500)
    .constraintSize({ maxWidth: '92%' })
    .backgroundColor(panelBackground(this.dark, true))
    .backgroundBlurStyle(panelBlurStyle(true))
    .borderRadius(18)
    .border({ width: 1, color: this.dark ? '#3338E1FF' : '#5538E1FF' })
    .shadow({ radius: 36, color: '#6638E1FF', offsetX: 0, offsetY: 10 })
    .opacity(this.reveal ? 1 : 0)
    .translate({ y: this.reveal ? 0 : 26 })
    .scale({ x: this.reveal ? 1 : 0.94, y: this.reveal ? 1 : 0.94 })
    .animation({
      duration: motionDuration(MOTION_SLOW, this.reduceMotion),
      curve: Curve.EaseOut
    })
  }
}

// ---------------------------------------------------------------- 课堂纪要面板

@Component
export struct AiNotesPanel {
  @Prop dark: boolean = false;
  @Prop reduceMotion: boolean = false;
  @Prop notes: LectureNotes = {
    Title: '课堂纪要',
    Subtitle: '',
    Cards: [],
    Markdown: '',
    Coverage: 0
  };
  onClose: () => void = () => {
  };
  onCopy: () => void = () => {
  };
  onSave: () => void = () => {
  };
  onReplayCard: (card: LectureNoteCard) => void = (card: LectureNoteCard) => {
    void card;
  };

  @State revealIndex: number = 0;
  private revealTimer: number = -1;

  aboutToAppear(): void {
    this.revealTimer = setInterval(() => {
      if (this.revealIndex < this.notes.Cards.length) {
        this.revealIndex++;
      } else if (this.revealTimer >= 0) {
        clearInterval(this.revealTimer);
        this.revealTimer = -1;
      }
    }, 110);
  }

  aboutToDisappear(): void {
    if (this.revealTimer >= 0) {
      clearInterval(this.revealTimer);
      this.revealTimer = -1;
    }
  }

  private tokens(): ThemeTokens {
    return themeTokens(this.dark);
  }

  @Builder
  NoteCard(card: LectureNoteCard, index: number) {
    Row({ space: 12 }) {
      Column()
        .width(3)
        .height(58)
        .backgroundColor(card.Accent)
        .borderRadius(2)
        .shadow({ radius: 10, color: card.Accent, offsetX: 0, offsetY: 0 })
      Column({ space: 6 }) {
        Row({ space: 8 }) {
          Text('0' + (card.Index + 1))
            .fontSize(9)
            .fontColor(card.Accent)
            .fontWeight(FontWeight.Bold)
            .letterSpacing(1)
          Text(card.Title)
            .fontSize(14)
            .fontColor(this.tokens().textPrimary)
            .fontWeight(FontWeight.Medium)
          Blank()
          Text('回看')
            .fontSize(10)
            .fontColor(this.tokens().textSecondary)
            .padding({ left: 6, right: 6, top: 3, bottom: 3 })
            .backgroundColor(this.dark ? '#14FFFFFF' : '#0A000000')
            .borderRadius(8)
            .onClick(() => {
              this.onReplayCard(card);
            })
        }
        .width('100%')
        ForEach(card.Bullets, (bullet: string) => {
          Row({ space: 6 }) {
            Circle()
              .width(4)
              .height(4)
              .fill(card.Accent)
              .margin({ top: 6 })
            Text(bullet)
              .fontSize(11)
              .fontColor(this.tokens().textSecondary)
              .lineHeight(17)
              .layoutWeight(1)
          }
          .alignItems(VerticalAlign.Top)
          .width('100%')
        }, (bullet: string) => card.Id + bullet)
        if (card.Formula !== '') {
          Text(card.Formula)
            .fontSize(12)
            .fontColor(this.dark ? '#D8E6F7FF' : '#FF0B3A66')
            .padding({ left: 10, right: 10, top: 6, bottom: 6 })
            .width('100%')
            .backgroundColor('#1438E1FF')
            .borderRadius(8)
            .border({ width: 1, color: '#2638E1FF' })
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .padding(12)
    .alignItems(VerticalAlign.Top)
    .backgroundColor(this.dark ? '#0DFFFFFF' : '#08000000')
    .borderRadius(12)
    .border({ width: 1, color: this.dark ? '#14FFFFFF' : '#0A000000' })
    .opacity(this.revealIndex > index ? 1 : 0)
    .translate({ x: this.revealIndex > index ? 0 : 28, y: this.revealIndex > index ? 0 : 10 })
    .animation({ duration: motionDuration(MOTION_SLOW, this.reduceMotion), curve: Curve.EaseOut })
  }

  build() {
    Column({ space: 0 }) {
      // 封面区
      Stack({ alignContent: Alignment.TopStart }) {
        Column()
          .width('100%')
          .height(104)
          .linearGradient({
            angle: 120,
            colors: [['#332E7BFF', 0.0], ['#2238E1FF', 0.45], ['#117C4DFF', 1.0]]
          })
        Column({ space: 6 }) {
          Row({ space: 8 }) {
            Text('AI')
              .fontSize(10)
              .fontColor(AI_CYAN)
              .fontWeight(FontWeight.Bold)
              .padding({ left: 6, right: 6, top: 2, bottom: 2 })
              .border({ width: 1, color: '#6638E1FF' })
              .borderRadius(4)
            Text('课堂纪要 · 一键生成')
              .fontSize(10)
              .fontColor('#C6FFFFFF')
            Blank()
            Text('✕')
              .fontSize(14)
              .fontColor('#D8FFFFFF')
              .padding(6)
              .onClick(() => {
                this.onClose();
              })
          }
          .width('100%')
          Text(this.notes.Title)
            .fontSize(20)
            .fontColor('#FFFFFFFF')
            .fontWeight(FontWeight.Medium)
          Text(this.notes.Subtitle)
            .fontSize(10)
            .fontColor('#A8FFFFFF')
        }
        .padding({ left: 18, right: 14, top: 14 })
        .width('100%')
      }
      .width('100%')
      .height(104)

      // 覆盖度
      Row({ space: 10 }) {
        Text('知识覆盖')
          .fontSize(10)
          .fontColor(this.tokens().textSecondary)
        Stack({ alignContent: Alignment.Start }) {
          Row()
            .width('100%')
            .height(4)
            .backgroundColor(this.dark ? '#1AFFFFFF' : '#0F000000')
            .borderRadius(2)
          Row()
            .width(this.notes.Coverage + '%')
            .height(4)
            .linearGradient({ angle: 90, colors: [[AI_CYAN, 0.0], [AI_BLUE, 1.0]] })
            .borderRadius(2)
        }
        .layoutWeight(1)
        .height(4)
        Text(this.notes.Coverage + '%')
          .fontSize(10)
          .fontColor(AI_CYAN)
      }
      .width('100%')
      .padding({ left: 18, right: 18, top: 14, bottom: 6 })

      Scroll() {
        Column({ space: 10 }) {
          ForEach(this.notes.Cards, (card: LectureNoteCard, index: number) => {
            this.NoteCard(card, index)
          }, (card: LectureNoteCard) => card.Id)
          Text('内容由 ' + (this.notes.Cards.length > 0 ? '端侧演示引擎' : 'AI') + ' 依据本页板书生成，仅供课堂复盘参考。')
            .fontSize(9)
            .fontColor(this.tokens().textSecondary)
            .width('100%')
            .textAlign(TextAlign.Center)
            .padding({ top: 4, bottom: 8 })
        }
        .padding({ left: 16, right: 16, top: 8, bottom: 8 })
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)

      Row({ space: 10 }) {
        Text('复制 Markdown')
          .fontSize(12)
          .fontColor(this.tokens().textPrimary)
          .padding({ left: 12, right: 12, top: 8, bottom: 8 })
          .backgroundColor(this.dark ? '#1AFFFFFF' : '#0F000000')
          .borderRadius(16)
          .onClick(() => {
            this.onCopy();
          })
        Blank()
        Text('完成')
          .fontSize(12)
          .fontColor('#FF05070C')
          .fontWeight(FontWeight.Medium)
          .padding({ left: 14, right: 14, top: 8, bottom: 8 })
          .linearGradient({ angle: 135, colors: [[AI_CYAN, 0.0], [AI_BLUE, 1.0]] })
          .borderRadius(16)
          .onClick(() => {
            this.onClose();
          })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 10, bottom: 14 })
      .border({ width: { top: 1 }, color: this.dark ? '#14FFFFFF' : '#0A000000' })
    }
    .width(540)
    .constraintSize({ maxWidth: '94%' })
    .height('72%')
    .backgroundColor(panelBackground(this.dark, true))
    .backgroundBlurStyle(panelBlurStyle(true))
    .borderRadius(18)
    .border({ width: 1, color: this.dark ? '#26FFFFFF' : '#14000000' })
    .shadow({ radius: 40, color: '#55000000', offsetX: 0, offsetY: 12 })
    .clip(true)
  }
}

// ---------------------------------------------------------------- 智能图形规整

@Component
export struct ShapeSnapPanel {
  @Prop dark: boolean = false;
  @Prop reduceMotion: boolean = false;
  @Prop options: ShapeSnapOption[] = [];
  onApply: (kind: number) => void = (kind: number) => {
    void kind;
  };
  onClose: () => void = () => {
  };

  @State selected: number = 0;
  @State morph: boolean = false;
  @State pulse: number = 0;
  private pulseTimer: number = -1;

  aboutToAppear(): void {
    this.selected = recommendedSnapIndex(this.options);
    setTimeout(() => {
      this.morph = true;
    }, 60);
    this.pulseTimer = setInterval(() => {
      this.pulse = (this.pulse + 5) % 100;
    }, 50);
  }

  aboutToDisappear(): void {
    if (this.pulseTimer >= 0) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = -1;
    }
  }

  private tokens(): ThemeTokens {
    return themeTokens(this.dark);
  }

  private currentKind(): number {
    if (this.options.length === 0) {
      return 2;
    }
    const index = this.selected < this.options.length ? this.selected : 0;
    return this.options[index].Kind;
  }

  @Builder
  OptionChip(option: ShapeSnapOption, index: number) {
    Column({ space: 2 }) {
      Text(option.Label)
        .fontSize(12)
        .fontColor(this.selected === index ? '#FF05070C' : this.tokens().textPrimary)
        .fontWeight(this.selected === index ? FontWeight.Medium : FontWeight.Normal)
      Text(confidencePercent(option.Confidence) + '%')
        .fontSize(9)
        .fontColor(this.selected === index ? '#CC05070C' : this.tokens().textSecondary)
    }
    .padding({ left: 14, right: 14, top: 7, bottom: 7 })
    .backgroundColor(this.selected === index
      ? '#FF38E1FF'
      : (this.dark ? '#1AFFFFFF' : '#0F000000'))
    .borderRadius(14)
    .border({
      width: 1,
      color: this.selected === index ? AI_CYAN : (this.dark ? '#26FFFFFF' : '#1A000000')
    })
    .shadow(this.selected === index
      ? { radius: 14, color: '#6638E1FF', offsetX: 0, offsetY: 0 }
      : { radius: 0, color: '#00000000', offsetX: 0, offsetY: 0 })
    .onClick(() => {
      this.selected = index;
    })
  }

  build() {
    Column({ space: 14 }) {
      Row({ space: 10 }) {
        Stack({ alignContent: Alignment.Center }) {
          Circle()
            .width(32)
            .height(32)
            .fill('#1F38E1FF')
          Text('◇')
            .fontSize(14)
            .fontColor(AI_CYAN)
        }
        Column({ space: 2 }) {
          Text('智能图形规整')
            .fontSize(15)
            .fontColor(this.tokens().textPrimary)
            .fontWeight(FontWeight.Medium)
          Text('识别手绘轮廓，吸附为规整几何图形')
            .fontSize(10)
            .fontColor(this.tokens().textSecondary)
        }
        Blank()
        Text('✕')
          .fontSize(14)
          .fontColor(this.tokens().textSecondary)
          .padding(6)
          .onClick(() => {
            this.onClose();
          })
      }
      .width('100%')

      // 预览区
      Stack({ alignContent: Alignment.Center }) {
        Column()
          .width('100%')
          .height(190)
          .backgroundColor('#AA05070C')
          .borderRadius(14)
          .border({ width: 1, color: '#2638E1FF' })

        // 网格
        ForEach([1, 2, 3, 4, 5, 6, 7], (i: number) => {
          Rect()
            .width(1)
            .height(190)
            .fill('#0F38E1FF')
            .position({ x: (i * 100 / 8) + '%', y: 0 })
        }, (i: number) => 'sgv' + i)
        ForEach([1, 2, 3, 4, 5], (i: number) => {
          Rect()
            .width('100%')
            .height(1)
            .fill('#0F38E1FF')
            .position({ x: 0, y: i * 32 })
        }, (i: number) => 'sgh' + i)

        // 原手绘轮廓（残影）
        Path({ commands: RAW_PATH })
          .width(260)
          .height(190)
          .fill(Color.Transparent)
          .stroke('#5538E1FF')
          .strokeWidth(2)
          .strokeDashArray([5, 5])
          .opacity(this.morph ? 0.45 : 1)

        // 规整结果（带呼吸光）
        Path({ commands: pathForKind(this.currentKind()) })
          .width(260)
          .height(190)
          .fill('#0F38E1FF')
          .stroke(AI_CYAN)
          .strokeWidth(2.4)
          .shadow({ radius: 16, color: '#8838E1FF', offsetX: 0, offsetY: 0 })
          .opacity(this.morph ? 1 : 0.2)
          .scale({ x: this.morph ? 1 : 0.88, y: this.morph ? 1 : 0.88 })
          .animation({ duration: motionDuration(MOTION_SLOW, this.reduceMotion), curve: Curve.EaseOut })

        Row({ space: 6 }) {
          Circle()
            .width(6)
            .height(6)
            .fill(AI_MINT)
          Text('吸附完成 · 可撤销')
            .fontSize(10)
            .fontColor('#C6FFFFFF')
        }
        .padding({ left: 10, right: 10, top: 5, bottom: 5 })
        .backgroundColor('#99000000')
        .borderRadius(10)
        .position({ x: 14, y: 14 })

        Text('原轮廓')
          .fontSize(9)
          .fontColor('#8038E1FF')
          .position({ x: 14, y: 160 })
        Text('规整预览')
          .fontSize(9)
          .fontColor(AI_CYAN)
          .position({ x: 200, y: 160 })
      }
      .width('100%')

      // 候选
      Column({ space: 8 }) {
        Text('候选形态')
          .fontSize(10)
          .fontColor(this.tokens().textSecondary)
          .width('100%')
        Flex({ wrap: FlexWrap.Wrap }) {
          ForEach(this.options, (option: ShapeSnapOption, index: number) => {
            this.OptionChip(option, index)
          }, (option: ShapeSnapOption, index: number) => option.Label + index)
        }
        .width('100%')
      }
      .alignItems(HorizontalAlign.Start)

      Row({ space: 10 }) {
        Text('保持手绘')
          .fontSize(12)
          .fontColor(this.tokens().textPrimary)
          .padding({ left: 12, right: 12, top: 8, bottom: 8 })
          .backgroundColor(this.dark ? '#1AFFFFFF' : '#0F000000')
          .borderRadius(16)
          .onClick(() => {
            this.onClose();
          })
        Blank()
        Text('应用规整')
          .fontSize(12)
          .fontColor('#FF05070C')
          .fontWeight(FontWeight.Medium)
          .padding({ left: 16, right: 16, top: 8, bottom: 8 })
          .linearGradient({ angle: 135, colors: [[AI_CYAN, 0.0], [AI_BLUE, 1.0]] })
          .borderRadius(16)
          .shadow({ radius: 16, color: '#6638E1FF', offsetX: 0, offsetY: 4 })
          .onClick(() => {
            this.onApply(this.currentKind());
          })
      }
      .width('100%')
    }
    .width(460)
    .constraintSize({ maxWidth: '92%' })
    .padding(16)
    .backgroundColor(panelBackground(this.dark, true))
    .backgroundBlurStyle(panelBlurStyle(this.dark))
    .borderRadius(18)
    .border({ width: 1, color: '#3338E1FF' })
    .shadow({ radius: 30, color: '#5538E1FF', offsetX: 0, offsetY: 8 })
  }
}