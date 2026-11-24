// 新增（鸿蒙端增强）— 画板三栏底栏
// 左栏页面、中栏工具、右栏文件与退出；每项为「图标 + 中文标签」的竖向按钮，
// 对齐桌面端底部工具条视觉（不再用汉字充当图标）。
// 触控热区最小 44vp；与悬浮栏共用磨砂玻璃参数，保持质感一致。
import { ThemeTokens, themeTokens } from './ThemeTokens';
import { IconGlyph } from './IconGlyph';

@Component
export struct BoardDock {
  @Prop dark: boolean = false;
  @Prop uiScale: number = 1;
  @Prop pageIndex: number = 0;
  @Prop pageCount: number = 1;
  @Prop boardBackground: number = 0;
  @Prop selectedId: string = 'pen';
  @Prop materialBlur: boolean = false;
  @Prop glassIntensity: number = 55;
  onCommand: (id: string) => void = (id: string) => {
    void id;
  };

  private tokens(): ThemeTokens {
    return themeTokens(this.dark);
  }

  private alphaHex(alpha: number): string {
    const value = Math.max(0, Math.min(255, Math.round(alpha)));
    const hex = value.toString(16).toUpperCase();
    return hex.length === 1 ? '0' + hex : hex;
  }

  // 与主浮动工具栏一致的深色玻璃：低不透明度 + 顶部白光 + 深灰渐变。
  private dockGradient(): LinearGradientOptions {
    const intensity = Math.min(100, Math.max(0, this.glassIntensity));
    const alpha = Math.max(0.22, Math.min(0.70, 0.62 - (intensity - 20) * 0.004));
    const top = '#' + this.alphaHex(alpha * 255) + '232329';
    const bottom = '#' + this.alphaHex(Math.max(0.18, alpha - 0.06) * 255) + '141419';
    return {
      angle: 180,
      colors: [['#1FFFFFFF', 0.0], [top, 0.08], [bottom, 1.0]]
    };
  }

  private glassRadius(): number {
    const intensity = Math.min(100, Math.max(0, this.glassIntensity));
    return Math.max(12, Math.min(32, 18 + intensity * 0.14));
  }

  private backgroundLabel(): string {
    if (this.boardBackground === 1) {
      return '白';
    }
    if (this.boardBackground === 2) {
      return '网格';
    }
    if (this.boardBackground === 3) {
      return '横线';
    }
    return '黑';
  }

  private scaleFactor(): number {
    return Math.max(1, this.uiScale);
  }

  // 单个底栏按钮：上图标、下中文标签；选中态用强调色填充整块。
  @Builder
  DockButton(id: string, label: string, symbol: string, active: boolean) {
    Column({ space: 2 * this.scaleFactor() }) {
      IconGlyph({
        symbol: symbol,
        fallback: '',
        size: 20 * this.scaleFactor(),
        color: active ? '#FF05070C' : '#F2FFFFFF',
        enabled: true,
        useIconFont: false
      })
      Text(label)
        .fontSize(9.5 * this.scaleFactor())
        .fontColor(active ? '#FF05070C' : '#B3FFFFFF')
        .maxLines(1)
    }
    .width(46 * this.scaleFactor())
    .height(50 * this.scaleFactor())
    .constraintSize({ minWidth: 44, minHeight: 44 })
    .justifyContent(FlexAlign.Center)
    .backgroundColor(active ? '#FF38E1FF' : Color.Transparent)
    .borderRadius(this.tokens().buttonRadius)
    .onClick(() => {
      this.onCommand(id);
    })
  }

  @Builder
  PageLabel() {
    Column({ space: 1 * this.scaleFactor() }) {
      Text((this.pageIndex + 1) + '/' + this.pageCount)
        .fontSize(12 * this.scaleFactor())
        .fontColor('#F2FFFFFF')
        .maxLines(1)
      Text('页码')
        .fontSize(9 * this.scaleFactor())
        .fontColor('#B3FFFFFF')
    }
    .width(46 * this.scaleFactor())
    .height(50 * this.scaleFactor())
    .constraintSize({ minWidth: 44, minHeight: 44 })
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  DockGroup() {
    Row({ space: 2 * this.scaleFactor() })
      .padding(4 * this.scaleFactor())
      .linearGradient(this.dockGradient())
      .borderRadius(22)
      .border({ width: 1, color: '#66FFFFFF' })
      .backdropBlur(this.materialBlur ? this.glassRadius() : 0)
  }

  build() {
    Row({ space: 8 * this.scaleFactor() }) {
      // 左栏：翻页
      Row({ space: 2 * this.scaleFactor() }) {
        this.DockButton('pagePrev', '上一页', 'chevron_left', false)
        this.PageLabel()
        this.DockButton('pageNext', '下一页', 'chevron_right', false)
        this.DockButton('pageAdd', '加页', 'plus', false)
      }
      .padding(4 * this.scaleFactor())
      .linearGradient(this.dockGradient())
      .borderRadius(22)
      .border({ width: 1, color: '#66FFFFFF' })
      .backdropBlur(this.materialBlur ? this.glassRadius() : 0)

      // 中栏：工具
      Row({ space: 2 * this.scaleFactor() }) {
        this.DockButton('gesture', '手势', 'hand_tap', this.selectedId === 'gesture')
        this.DockButton('bgCycle', '画布', 'rectangle_stack', false)
        this.DockButton('select', '选择', 'mouse', this.selectedId === 'select')
        this.DockButton('pen', '墨迹', 'pencil_tip', this.selectedId === 'pen')
        this.DockButton('eraserCircle', '橡皮', 'eraser_line_fill',
          this.selectedId === 'eraserCircle' || this.selectedId === 'eraserStroke')
        this.DockButton('shapes', '图形', 'square_dashed', this.selectedId === 'shapes')
        this.DockButton('insertImage', '插入图片', 'picture', false)
        this.DockButton('undo', '撤销', 'undo', false)
        this.DockButton('redo', '重做', 'redo', false)
        this.DockButton('tools', '更多', 'wrench_and_screwdriver', this.selectedId === 'tools')
      }
      .padding(4 * this.scaleFactor())
      .linearGradient(this.dockGradient())
      .borderRadius(22)
      .border({ width: 1, color: '#66FFFFFF' })
      .backdropBlur(this.materialBlur ? this.glassRadius() : 0)

      // 右栏：文件与退出
      Row({ space: 2 * this.scaleFactor() }) {
        this.DockButton('save', '保存', 'save', false)
        this.DockButton('open', '打开', 'folder', false)
        this.DockButton('clearPage', '清页', 'trash', false)
        this.DockButton('exit', '退出', 'arrow_right_to_line', false)
      }
      .padding(4 * this.scaleFactor())
      .linearGradient(this.dockGradient())
      .borderRadius(22)
      .border({ width: 1, color: '#66FFFFFF' })
      .backdropBlur(this.materialBlur ? this.glassRadius() : 0)
    }
    .padding(4 * this.scaleFactor())
    .constraintSize({ maxWidth: '98%' })
    .shadow({
      radius: this.materialBlur ? 22 : 0,
      color: this.materialBlur ? '#2E000000' : '#00000000',
      offsetX: 0,
      offsetY: this.materialBlur ? 8 : 0
    })
  }
}