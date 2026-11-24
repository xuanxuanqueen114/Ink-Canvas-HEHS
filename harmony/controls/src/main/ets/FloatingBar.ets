// @parity src/InkCanvas.Controls/Controls/FloatingBar.cs
// 四卡布局：拖动把手 / 主栏 / 手势 / PPT 退出牌。平板与 2in1 使用同一组件。
import { FLOATING_BAR_BUTTONS, FloatingBarButton } from './FloatingBarCatalog';
import { ThemeTokens, themeTokens } from './ThemeTokens';
import { IconGlyph, symbolForButton } from './IconGlyph';
import { barCollapseTransition } from './Motion';

@Component
export struct FloatingBar {
  @Prop dark: boolean = false;
  @Prop showLabels: boolean = false;
  @Prop uiScale: number = 1;
  @Prop selectedId: string = 'pen';
  @Prop folded: boolean = false;
  // 用户主动展开后覆盖“窄屏自动折叠”，避免点击胶囊却仍被宽度规则压回折叠态。
  @State forceExpanded: boolean = false;
  @Prop pptActive: boolean = false;
  @Prop textIconFallback: boolean = true;
  // 能力门控由 entry 探测后传入（controls 不直接依赖 platform）。
  @Prop materialBlur: boolean = false;
  @Prop symbolIcons: boolean = true;
  // true = 优先用内置 Segoe Fluent Icons 字体渲染（与 Windows 端一致）；
  // false = 回退系统 SymbolGlyph。
  @Prop useIconFont: boolean = false;
  @Prop reduceMotion: boolean = false;
  // 磨砂玻璃：0 = 不透明，100 = 高通透（模糊半径与底色 alpha 联动）。
  @Prop glassIntensity: number = 55;
  // 窗口可用宽度（vp）：窄屏/竖屏/分屏时自动切换为折叠胶囊，避免溢出。
  @Prop availableWidth: number = 0;
  // appearance 设置接线（显隐/彩色/透明按钮）。
  @Prop showEraserButton: boolean = true;
  @Prop showHideControlButton: boolean = false;
  @Prop showLRSwitchButton: boolean = false;
  @Prop showExitButton: boolean = false;
  @Prop showFingerToggle: boolean = false;
  @Prop colorfulBackground: boolean = false;
  @Prop transparentButtons: boolean = true;
  onAction: (id: string) => void = (id: string) => {
    void id;
  };
  onDrag: (dx: number, dy: number) => void = (dx: number, dy: number) => {
    void dx;
    void dy;
  };
  onDragFinished: () => void = () => {
  };
  // 手势开始：宿主记录当前位移基准，后续 onDrag 用「基准 + 累计偏移」，
  // 避免第二次拖动时把累计位移当成本次偏移导致跳位。
  onBarDragStart: () => void = () => {
  };

  private tokens(): ThemeTokens {
    return themeTokens(this.dark);
  }

  // Windows 端工具栏视觉：深色胶囊底、白色图标、实心蓝选中。
  private winIcon(): string {
    return '#FFFFFFFF';
  }

  private winSelected(): string {
    return '#FF2D6B8A';
  }

  private winSurface(): string {
    return '#FF232327';
  }

  private winSurfaceAlt(): string {
    return '#FF2A2A2F';
  }

  private winBorder(): string {
    return '#26FFFFFF';
  }

  private iconText(button: FloatingBarButton): string {
    return this.textIconFallback ? button.Label.substring(0, 1) : button.Glyph;
  }

  // 内置字体模式下的码点：对目录中重复的字形按 id 纠正，避免“两个一模一样图案”。
  private glyphForId(id: string, glyph: string): string {
    if (id === 'clearAndMouse') {
      return '\uE72C';
    }
    if (id === 'tools') {
      // 齿轮比原先的“命令/扳手”字形更容易一眼认出是「更多设置」。
      return '\uE713';
    }
    if (id === 'insertVideo') {
      return '\uE714';
    }
    if (id === 'eraserStroke') {
      return '\uE75C';
    }
    if (id === 'eraserCircle') {
      return '\uE75B';
    }
    return glyph;
  }

  private glyphForButton(button: FloatingBarButton): string {
    return this.glyphForId(button.Id, button.Glyph);
  }

  private glyphForSelected(): string {
    for (let i = 0; i < FLOATING_BAR_BUTTONS.length; i++) {
      if (FLOATING_BAR_BUTTONS[i].Id === this.selectedId) {
        return this.glyphForButton(FLOATING_BAR_BUTTONS[i]);
      }
    }
    return '';
  }

  // 字体中缺少直观字形的按钮改走系统 Symbol（白板 / 收起），其余保持 Windows 字形。
  private useFontFor(id: string): boolean {
    if (!this.useIconFont) {
      return false;
    }
    if (id === 'board' || id === 'fold') {
      return false;
    }
    return true;
  }

  private buttonVisible(button: FloatingBarButton): boolean {
    if (button.Id === 'eraserCircle' || button.Id === 'eraserStroke') {
      return this.showEraserButton;
    }
    if (button.Id === 'hideControl') {
      return this.showHideControlButton;
    }
    if (button.Id === 'lrSwitch') {
      return this.showLRSwitchButton;
    }
    // 主栏内的「手势」按钮与右侧独立手势卡（GestureCard）的图标、动作完全重复：
    // 精简为一个入口，保留右侧手势卡，主栏不再渲染该按钮（catalog 目录数据保持不变）。
    if (button.Id === 'gesture') {
      return false;
    }
    // 「清空并鼠标」与「清空」+「鼠标」组合重复，图标也无法直观表达，精简掉。
    if (button.Id === 'clearAndMouse') {
      return false;
    }
    return button.DefaultVisible;
  }

  // 彩色浮条：C# PopupBrushes.FloatBarColorful 渐变 #9580B0FF → #95C0FFC0，(0,0)→(1,1)。
  // 非彩色时用同色双 stop 渐变等效纯色，保持单一渲染路径。
  private barGradient(base: string): LinearGradientOptions {
    if (this.colorfulBackground) {
      return { angle: 135, colors: [['#9580B0FF', 0.0], ['#95C0FFC0', 1.0]] };
    }
    return { angle: 135, colors: [[base, 0.0], [base, 1.0]] };
  }

  private buttonBase(): ResourceColor {
    // 玻璃模式下按钮不画底色：整条工具栏是一块连续玻璃，避免"玻璃里嵌一块深色条/格子"。
    if (this.transparentButtons || this.materialBlur) {
      return Color.Transparent;
    }
    return '#1AFFFFFF';
  }

  // 内部卡片底色：玻璃模式下透明（由外层统一承载），非玻璃模式保持原实心底。
  private cardSurface(base: string): LinearGradientOptions {
    if (this.materialBlur) {
      return { angle: 180, colors: [['#00FFFFFF', 0.0], ['#00FFFFFF', 1.0]] };
    }
    return this.barGradient(base);
  }

  private alphaHex(alpha: number): string {
    const value = Math.max(0, Math.min(255, Math.round(alpha)));
    const hex = value.toString(16).toUpperCase();
    return hex.length === 1 ? '0' + hex : hex;
  }

  // 通透度越高：深色底越透明、模糊越强（对齐 iOS 玻璃拟态：低不透明度 + 强模糊 + 白色高光边）。
  private glassAlpha(): number {
    // 白板上玻璃会叠成中灰，白图标需要足够底色对比；默认偏实，通透度滑块仍可调到更透。
    const intensity = Math.min(100, Math.max(0, this.glassIntensity));
    return Math.max(0.36, Math.min(0.93, 0.82 - (intensity - 20) * 0.0055));
  }

  // 背景模糊：参考图 20~30 量级，随通透度在 18~32 之间。
  private glassRadius(): number {
    const intensity = Math.min(100, Math.max(0, this.glassIntensity));
    return Math.max(12, Math.min(32, 18 + intensity * 0.14));
  }

  private glassTop(): string {
    return '#' + this.alphaHex(this.glassAlpha() * 255) + '232329';
  }

  private glassBottom(): string {
    const a = Math.max(0.18, this.glassAlpha() - 0.06);
    return '#' + this.alphaHex(a * 255) + '141419';
  }

  private barFill(): LinearGradientOptions {
    if (!this.materialBlur) {
      return this.barGradient(this.winSurface());
    }
    // 顶部 7% 叠一层白色高光（模拟玻璃上沿内反光），其余为深灰渐变（顶亮底暗）。
    return {
      angle: 180,
      colors: [
        ['#1FFFFFFF', 0.0],
        [this.glassTop(), 0.07],
        [this.glassBottom(), 0.62],
        [this.glassBottom(), 1.0]
      ]
    };
  }

  // 窄屏自动折叠：19 按钮主栏 + 拖动把手 + 手势卡的实际宽度估算。
  private compactMode(): boolean {
    if (this.folded) {
      return true;
    }
    if (this.forceExpanded) {
      return false;
    }
    if (this.availableWidth <= 0) {
      return false;
    }
    const extras = (this.showEraserButton ? 46 : 0) + (this.showFingerToggle ? 46 : 0) + (this.showExitButton ? 46 : 0);
    const estimated = (50 + 18 * 46 + 47 + extras) * Math.max(0.5, this.uiScale);
    return estimated > this.availableWidth - 16;
  }

  build() {
    Row({ space: 2.778 * this.uiScale }) {
      this.DragHandleCard()
      if (!this.compactMode()) {
        this.PrimaryCard()
        this.GestureCard()
      } else {
        this.CompactCard()
      }
      if (this.pptActive) {
        this.PptExitCard()
      }
    }
    .padding({
      left: this.tokens().barPadding[0] * this.uiScale,
      top: this.tokens().barPadding[1] * this.uiScale,
      right: this.tokens().barPadding[2] * this.uiScale,
      bottom: this.tokens().barPadding[3] * this.uiScale
    })
    .linearGradient(this.barFill())
    .backdropBlur(this.materialBlur ? this.glassRadius() : 0)
    .backgroundBlurStyle(BlurStyle.NONE)
    .borderRadius(26)
    .border({ width: 1, color: this.materialBlur ? '#66FFFFFF' : this.winBorder() })
    // 柔和外投影：把玻璃胶囊从画布上"抬起"，对齐 iOS 玻璃拟态的层次。
    .shadow({
      radius: this.materialBlur ? 26 : 0,
      color: this.materialBlur ? '#2E000000' : '#00000000',
      offsetX: 0,
      offsetY: this.materialBlur ? 10 : 0
    })
    .gesture(
      PanGesture()
        .onActionStart(() => {
          this.onBarDragStart();
        })
        .onActionUpdate((event: GestureEvent) => {
          this.onDrag(event.offsetX, event.offsetY);
        })
        .onActionEnd((event: GestureEvent) => {
          // 结束帧再同步一次最终偏移：部分输入/快速拖动最后一帧不触发
          // onActionUpdate，只用中间帧会让工具栏停在半途。
          this.onDrag(event.offsetX, event.offsetY);
          this.onDragFinished();
        })
    )
  }

  @Builder
  DragHandleCard() {
    Column({ space: 4 * this.uiScale }) {
      Row({ space: 4 * this.uiScale }) {
        Circle()
          .width(3 * this.uiScale)
          .height(3 * this.uiScale)
          .fill('#99FFFFFF')
        Circle()
          .width(3 * this.uiScale)
          .height(3 * this.uiScale)
          .fill('#99FFFFFF')
      }
      Row({ space: 4 * this.uiScale }) {
        Circle()
          .width(3 * this.uiScale)
          .height(3 * this.uiScale)
          .fill('#99FFFFFF')
        Circle()
          .width(3 * this.uiScale)
          .height(3 * this.uiScale)
          .fill('#99FFFFFF')
      }
    }
    .width(44 * this.uiScale)
    .height(44 * this.uiScale)
    .justifyContent(FlexAlign.Center)
    .borderRadius(22)
    .linearGradient(this.cardSurface(this.winSurfaceAlt()))
    .onClick(() => {
      this.onAction('toggleCollapse');
    })
  }

  // 折叠态白名单（对齐 Windows 端折叠浮条）：只保留最常用的 6 项，仍可直接切换工具，
  // 不是只显示当前工具的单按钮胶囊；其余功能收进「展开」后按需调用。
  private compactVisible(id: string): boolean {
    return id === 'mouse' || id === 'pen' || id === 'highlighter'
      || id === 'clear' || id === 'board' || id === 'tools';
  }

  @Builder
  CompactCard() {
    Row({ space: 0 }) {
      ForEach(FLOATING_BAR_BUTTONS, (button: FloatingBarButton) => {
        if (this.compactVisible(button.Id) && this.buttonVisible(button)) {
          this.ButtonCell(button)
        }
      }, (button: FloatingBarButton) => 'compact-' + button.Id)
      Column() {
        Text('⌃')
          .fontSize(15 * this.uiScale)
          .fontColor(this.winIcon())
      }
      .width(Math.max(44, 40 * this.uiScale))
      .height(Math.max(44, this.tokens().buttonHeight * this.uiScale))
      .justifyContent(FlexAlign.Center)
      .borderRadius(10)
      .backgroundColor(this.buttonBase())
      .onClick(() => {
        // 窗口过窄时会因 availableWidth 自动折叠，这里同时置 forceExpanded，
        // 保证「展开」在窄屏也一定回到完整主栏。
        this.forceExpanded = true;
        this.onAction('toggleCollapse');
      })
    }
    .padding({ left: 6, right: 4, top: 2, bottom: 2 })
    .borderRadius(22)
    .transition(barCollapseTransition(this.reduceMotion))
  }

  // 折叠胶囊：当前工具 + 展开箭头；用 Button 承载点击（真机触摸下 onClick/gesture 易被父级手势拦截）。
  @Builder
  CollapsedCapsule() {
    Button({ type: ButtonType.Normal, stateEffect: false }) {
      Row({ space: 2 }) {
        Column() {
          IconGlyph({
            symbol: symbolForButton(this.selectedId, 'pen'),
            fallback: this.textIconFallback ? '笔' : '',
            size: 22 * this.uiScale,
            color: this.winIcon(),
            enabled: this.symbolIcons,
            glyph: this.glyphForSelected(),
            useIconFont: this.useFontFor(this.selectedId)
          })
        }
        .width(Math.max(44, 44 * this.uiScale))
        .height(Math.max(44, 44 * this.uiScale))
        .justifyContent(FlexAlign.Center)


        Column() {
          Text('⌄')
            .fontSize(15 * this.uiScale)
            .fontColor(this.winIcon())
        }
        .width(Math.max(44, 34 * this.uiScale))
        .height(Math.max(44, 44 * this.uiScale))
        .justifyContent(FlexAlign.Center)
      }
      .backgroundColor(this.winSurface())
      .borderRadius(22)
    }
    .backgroundColor(Color.Transparent)
    .padding(0)
    .onClick(() => {
      this.forceExpanded = true;
      this.onAction('toggleCollapse');
    })
    .gesture(
      PanGesture()
        .onActionStart(() => {
          this.onBarDragStart();
        })
        .onActionUpdate((event: GestureEvent) => {
          this.onDrag(event.offsetX, event.offsetY);
        })
        .onActionEnd((event: GestureEvent) => {
          // 结束帧再同步一次最终偏移：部分输入/快速拖动最后一帧不触发
          // onActionUpdate，只用中间帧会让工具栏停在半途。
          this.onDrag(event.offsetX, event.offsetY);
          this.onDragFinished();
        })
    )
    .transition(barCollapseTransition(this.reduceMotion))
  }

  @Builder
  PrimaryCard() {
    Row({ space: 0 }) {
      ForEach(FLOATING_BAR_BUTTONS, (button: FloatingBarButton) => {
        if (this.buttonVisible(button)) {
          this.ButtonCell(button)
        }
      }, (button: FloatingBarButton) => button.Id)
      if (this.showFingerToggle) {
        this.ExtraCell('fingerMode', '手指', 'person_2', '\uE716')
      }
      // 浮批：推出画布，仅保留工具栏；侧边：折叠并吸附到屏幕左右两侧。
      this.ExtraCell('floatBoard', '浮批', 'move', '')
      this.ExtraCell('dockSide', '侧边', 'chevron_left', '')
      if (this.showExitButton) {
        this.ExtraCell('exit', '退出', 'xmark', '\uE711')
      }
    }
    .padding({ left: 6, right: 6, top: 2, bottom: 2 })
    .linearGradient(this.cardSurface(this.winSurface()))
    .borderRadius(16)
    .transition(barCollapseTransition(this.reduceMotion))
  }

  // 目录外的条件按钮（退出/手指模式），不改 19 按钮目录（floating-bar-catalog 向量钉住）。
  @Builder
  ExtraCell(id: string, label: string, symbol: string, glyph: string) {
    Column() {
      IconGlyph({
        symbol: symbol,
        fallback: this.textIconFallback ? label.substring(0, 1) : '',
        size: 22 * this.uiScale,
        color: this.winIcon(),
        enabled: this.symbolIcons,
        glyph: glyph,
        useIconFont: this.useFontFor(id)
      })
      if (this.showLabels) {
        Text(label)
          .fontSize(this.tokens().labelSize * this.uiScale)
          .fontColor(this.winIcon())
          .margin({ top: -1.389 * this.uiScale })
      }
    }
    .width(Math.max(44, this.tokens().buttonWidth * this.uiScale))
    .height(Math.max(44, this.tokens().buttonHeight * this.uiScale))
    .justifyContent(FlexAlign.Center)
    .borderRadius(this.selectedId === id ? 12 : 10)
    .backgroundColor(this.selectedId === id ? this.winSelected() : this.buttonBase())
    .onClick(() => {
      this.onAction(id);
    })
  }

  @Builder
  ButtonCell(button: FloatingBarButton) {
    Column() {
      IconGlyph({
        symbol: symbolForButton(button.Id, button.Glyph),
        fallback: this.iconText(button),
        size: 22 * this.uiScale,
        color: this.winIcon(),
        enabled: this.symbolIcons,
        glyph: this.glyphForButton(button),
        useIconFont: this.useFontFor(button.Id)
      })
      if (this.showLabels) {
        Text(button.Label)
          .fontSize(this.tokens().labelSize * this.uiScale)
          .fontColor(this.winIcon())
          .margin({ top: -1.389 * this.uiScale })
      }
    }
    .width(Math.max(44, this.tokens().buttonWidth * this.uiScale))
    .height(Math.max(44, this.tokens().buttonHeight * this.uiScale))
    .justifyContent(FlexAlign.Center)
    .borderRadius(this.selectedId === button.Id ? 12 : 10)
    .backgroundColor(this.selectedId === button.Id ? this.winSelected() : this.buttonBase())
    .opacity(button.DefaultEnabled ? 1 : 0.4)
    .onClick(() => {
      if (button.DefaultEnabled) {
        this.onAction(button.Id);
      }
    })
  }

  @Builder
  GestureCard() {
    Column() {
      IconGlyph({
        symbol: 'hand_tap',
        fallback: this.textIconFallback ? '手' : '',
        size: 22 * this.uiScale,
        color: this.winIcon(),
        enabled: this.symbolIcons,
        glyph: '\uF271',
        useIconFont: this.useFontFor('gesture')
      })
      if (this.showLabels) {
        Text('手势')
          .fontSize(this.tokens().labelSize * this.uiScale)
          .fontColor(this.winIcon())
      }
    }
    .width(Math.max(44, 44 * this.uiScale))
    .height(Math.max(44, 44 * this.uiScale))
    .justifyContent(FlexAlign.Center)
    .borderRadius(22)
    .linearGradient(this.cardSurface(this.winSurfaceAlt()))
    .transition(barCollapseTransition(this.reduceMotion))
    .onClick(() => {
      this.onAction('gesture');
    })
  }

  @Builder
  PptExitCard() {
    Column() {
      Text('退出')
        .fontSize(11 * this.uiScale)
        .fontColor(this.winIcon())
    }
    .width(Math.max(44, 41.667 * this.uiScale))
    .height(Math.max(44, 27.778 * this.uiScale))
    .justifyContent(FlexAlign.Center)
    .borderRadius(22)
    .linearGradient(this.cardSurface(this.winSurfaceAlt()))
    .onClick(() => {
      this.onAction('pptExit');
    })
  }
}