// 新增（鸿蒙端增强）— 分子结构绘制面板（ChemDraw 基本功能子集）
// 支持：单键 / 双键 / 三键拖拽成键、苯环与环己烷一键放置、元素切换、擦除、撤销、清空。
// 结构与墨迹完全独立：只在本面板的 Canvas 上绘制，关闭即还原，不改动白板文档。
import { ThemeTokens, themeTokens } from './ThemeTokens';

export interface ChemAtom {
  Id: number;
  X: number;
  Y: number;
  Element: string;
}

export interface ChemBond {
  Id: number;
  A: number;
  B: number;
  Order: number;
}

interface ChemTool {
  Id: string;
  Label: string;
}

const ELEMENT_CYCLE: string[] = ['C', 'N', 'O', 'S', 'P', 'F', 'Cl', 'Br', 'H'];

const CHEM_TOOLS: ChemTool[] = [
  { Id: 'bond1', Label: '单键' },
  { Id: 'bond2', Label: '双键' },
  { Id: 'bond3', Label: '三键' },
  { Id: 'benzene', Label: '苯环' },
  { Id: 'cyclohex', Label: '环己烷' },
  { Id: 'element', Label: '元素' },
  { Id: 'erase', Label: '擦除' }
];

@Component
export struct ChemBoard {
  @Prop dark: boolean = false;
  onClose: () => void = () => {
  };

  @State atoms: ChemAtom[] = [];
  @State bonds: ChemBond[] = [];
  @State tool: string = 'bond1';
  @State hint: string = '在网格上拖拽即可成键；点「苯环」后单击放置';
  @State previewing: boolean = false;
  // 点-点成键的起点（触摸下比拖拽更稳）：第二次点击自动连键，空白处自动补原子。
  @State pendingId: number = -1;
  private canvasW: number = 0;
  private canvasH: number = 0;
  private ready: boolean = false;
  private nextId: number = 1;
  private startId: number = -1;
  private previewX: number = 0;
  private previewY: number = 0;
  private downX: number = 0;
  private downY: number = 0;
  private history: string[] = [];
  private settings: RenderingContextSettings = new RenderingContextSettings(true);
  private ctx: CanvasRenderingContext2D = new CanvasRenderingContext2D(this.settings);

  private tokens(): ThemeTokens {
    return themeTokens(this.dark);
  }

  private lineColor(): string {
    return this.dark ? '#FFE8ECEF' : '#FF1A1A1E';
  }

  private paperColor(): string {
    return this.dark ? '#FF14161B' : '#FFFFFFFF';
  }

  private snap(value: number): number {
    return Math.round(value / 30) * 30;
  }

  private snapshot(): void {
    this.history.push(JSON.stringify({ a: this.atoms, b: this.bonds }));
    if (this.history.length > 60) {
      this.history.shift();
    }
  }

  private undo(): void {
    const last = this.history.pop();
    if (last === undefined) {
      return;
    }
    const state: ChemHistory = JSON.parse(last) as ChemHistory;
    this.atoms = state.a;
    this.bonds = state.b;
    this.redraw();
  }

  private atomById(id: number): ChemAtom | null {
    for (let i = 0; i < this.atoms.length; i++) {
      if (this.atoms[i].Id === id) {
        return this.atoms[i];
      }
    }
    return null;
  }

  private atomAt(x: number, y: number): ChemAtom | null {
    const hit = 22;
    for (let i = this.atoms.length - 1; i >= 0; i--) {
      const a = this.atoms[i];
      const dx = a.X - x;
      const dy = a.Y - y;
      if (dx * dx + dy * dy <= hit * hit) {
        return a;
      }
    }
    return null;
  }

  private addAtom(x: number, y: number, element: string): ChemAtom {
    const atom: ChemAtom = { Id: this.nextId, X: x, Y: y, Element: element };
    this.nextId++;
    this.atoms = this.atoms.concat([atom]);
    return atom;
  }

  private addBond(a: number, b: number, order: number): void {
    if (a === b) {
      return;
    }
    for (let i = 0; i < this.bonds.length; i++) {
      const e = this.bonds[i];
      if ((e.A === a && e.B === b) || (e.A === b && e.B === a)) {
        e.Order = order;
        this.bonds = this.bonds.slice();
        return;
      }
    }
    const bond: ChemBond = { Id: this.nextId, A: a, B: b, Order: order };
    this.nextId++;
    this.bonds = this.bonds.concat([bond]);
  }

  private placeRing(cx: number, cy: number, aromatic: boolean): void {
    this.snapshot();
    const radius = 54;
    const created: ChemAtom[] = [];
    for (let i = 0; i < 6; i++) {
      const angle = -Math.PI / 2 + i * Math.PI / 3;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      created.push(this.addAtom(Math.round(x), Math.round(y), 'C'));
    }
    for (let i = 0; i < 6; i++) {
      const order = aromatic && i % 2 === 0 ? 2 : 1;
      this.addBond(created[i].Id, created[(i + 1) % 6].Id, order);
    }
    this.redraw();
  }

  private cycleElementAt(x: number, y: number): void {
    const atom = this.atomAt(x, y);
    if (atom === null) {
      return;
    }
    this.snapshot();
    let index = ELEMENT_CYCLE.indexOf(atom.Element);
    if (index < 0) {
      index = 0;
    }
    atom.Element = ELEMENT_CYCLE[(index + 1) % ELEMENT_CYCLE.length];
    this.atoms = this.atoms.slice();
    this.redraw();
  }

  private eraseAt(x: number, y: number): void {
    const atom = this.atomAt(x, y);
    if (atom === null) {
      return;
    }
    this.snapshot();
    this.atoms = this.atoms.filter((item: ChemAtom) => item.Id !== atom.Id);
    this.bonds = this.bonds.filter((item: ChemBond) => item.A !== atom.Id && item.B !== atom.Id);
    this.redraw();
  }

  private clearAll(): void {
    if (this.atoms.length === 0 && this.bonds.length === 0) {
      return;
    }
    this.snapshot();
    this.atoms = [];
    this.bonds = [];
    this.redraw();
  }

  private orderOfTool(): number {
    if (this.tool === 'bond2') {
      return 2;
    }
    if (this.tool === 'bond3') {
      return 3;
    }
    return 1;
  }

  private onTouchEvent(event: TouchEvent): void {
    if (event.touches.length === 0) {
      return;
    }
    const x = event.touches[0].x;
    const y = event.touches[0].y;
    if (event.type === TouchType.Down) {
      if (this.tool === 'benzene') {
        this.placeRing(this.snap(x), this.snap(y), true);
        return;
      }
      if (this.tool === 'cyclohex') {
        this.placeRing(this.snap(x), this.snap(y), false);
        return;
      }
      if (this.tool === 'erase') {
        this.eraseAt(x, y);
        return;
      }
      if (this.tool === 'element') {
        this.cycleElementAt(x, y);
        return;
      }
      // 已有起点：第二次点击直接成键（触摸下比拖拽更稳），空白处自动补原子。
      if (this.pendingId >= 0) {
        this.snapshot();
        let target = this.atomAt(x, y);
        if (target === null) {
          target = this.addAtom(this.snap(x), this.snap(y), 'C');
        }
        this.addBond(this.pendingId, target.Id, this.orderOfTool());
        this.pendingId = -1;
        this.previewing = false;
        this.redraw();
        return;
      }
      this.snapshot();
      let start = this.atomAt(x, y);
      if (start === null) {
        start = this.addAtom(this.snap(x), this.snap(y), 'C');
      }
      this.pendingId = start.Id;
      this.startId = start.Id;
      this.downX = x;
      this.downY = y;
      this.previewX = x;
      this.previewY = y;
      this.previewing = true;
      this.redraw();
    } else if (event.type === TouchType.Move) {
      if (!this.previewing) {
        return;
      }
      this.previewX = x;
      this.previewY = y;
      this.redraw();
    } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
      if (!this.previewing) {
        return;
      }
      this.previewing = false;
      if (event.type === TouchType.Cancel) {
        this.pendingId = -1;
        this.redraw();
        return;
      }
      const dx = x - this.downX;
      const dy = y - this.downY;
      if (dx * dx + dy * dy < 100) {
        // 视为「点选起点」：保留 pendingId，等待下一次点击成键。
        this.redraw();
        return;
      }
      let end = this.atomAt(x, y);
      if (end === null) {
        end = this.addAtom(this.snap(x), this.snap(y), 'C');
      }
      this.addBond(this.startId, end.Id, this.orderOfTool());
      this.pendingId = -1;
      this.redraw();
    }
  }

  private drawBond(ctx: CanvasRenderingContext2D, a: ChemAtom, b: ChemAtom, order: number): void {
    const dx = b.X - a.X;
    const dy = b.Y - a.Y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) {
      return;
    }
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    const padA = a.Element === 'C' ? 4 : 12;
    const padB = b.Element === 'C' ? 4 : 12;
    const x1 = a.X + ux * padA;
    const y1 = a.Y + uy * padA;
    const x2 = b.X - ux * padB;
    const y2 = b.Y - uy * padB;
    ctx.strokeStyle = this.lineColor();
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    if (order <= 1) {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    } else if (order === 2) {
      ctx.moveTo(x1 + nx * 2.6, y1 + ny * 2.6);
      ctx.lineTo(x2 + nx * 2.6, y2 + ny * 2.6);
      ctx.moveTo(x1 - nx * 2.6, y1 - ny * 2.6);
      ctx.lineTo(x2 - nx * 2.6, y2 - ny * 2.6);
    } else {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.moveTo(x1 + nx * 3.4, y1 + ny * 3.4);
      ctx.lineTo(x2 + nx * 3.4, y2 + ny * 3.4);
      ctx.moveTo(x1 - nx * 3.4, y1 - ny * 3.4);
      ctx.lineTo(x2 - nx * 3.4, y2 - ny * 3.4);
    }
    ctx.stroke();
  }

  private redraw(): void {
    if (!this.ready) {
      return;
    }
    const ctx = this.ctx;
    const w = this.canvasW > 0 ? this.canvasW : 600;
    const h = this.canvasH > 0 ? this.canvasH : 420;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.paperColor();
    ctx.fillRect(0, 0, w, h);
    // 网格点：帮助对齐（吸附步长 30vp）
    ctx.fillStyle = this.dark ? '#26FFFFFF' : '#14000000';
    for (let gx = 15; gx < w; gx += 30) {
      for (let gy = 15; gy < h; gy += 30) {
        ctx.fillRect(gx - 1, gy - 1, 2, 2);
      }
    }
    for (let i = 0; i < this.bonds.length; i++) {
      const bond = this.bonds[i];
      const a = this.atomById(bond.A);
      const b = this.atomById(bond.B);
      if (a !== null && b !== null) {
        this.drawBond(ctx, a, b, bond.Order);
      }
    }
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < this.atoms.length; i++) {
      const atom = this.atoms[i];
      if (atom.Element === 'C') {
        continue;
      }
      ctx.fillStyle = this.paperColor();
      ctx.beginPath();
      ctx.arc(atom.X, atom.Y, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = this.lineColor();
      ctx.fillText(atom.Element, atom.X, atom.Y);
    }
    if (this.previewing) {
      const start = this.atomById(this.startId);
      if (start !== null) {
        ctx.strokeStyle = this.dark ? '#99A8E6FF' : '#990066BF';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(start.X, start.Y);
        ctx.lineTo(this.previewX, this.previewY);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (this.pendingId >= 0) {
      const pending = this.atomById(this.pendingId);
      if (pending !== null) {
        ctx.strokeStyle = '#FF38E1FF';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pending.X, pending.Y, 14, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  @Builder
  ToolButton(item: ChemTool) {
    Text(item.Label)
      .fontSize(12)
      .fontColor(this.tool === item.Id ? '#FF05070C' : this.tokens().textPrimary)
      .padding({ left: 10, right: 10, top: 6, bottom: 6 })
      .backgroundColor(this.tool === item.Id ? '#FF38E1FF' : (this.dark ? '#1AFFFFFF' : '#0F000000'))
      .borderRadius(8)
      .onClick(() => {
        this.tool = item.Id;
        if (item.Id === 'benzene' || item.Id === 'cyclohex') {
          this.hint = '单击画布放置' + item.Label;
        } else if (item.Id === 'element') {
          this.hint = '单击原子循环切换元素（C→N→O→S→P→F→Cl→Br→H）';
        } else if (item.Id === 'erase') {
          this.hint = '单击原子删除该原子及其所有键';
        } else {
          this.hint = '在网格上拖拽即可成键';
        }
      })
  }

  build() {
    Column({ space: 8 }) {
      Row({ space: 10 }) {
        Text('分子结构')
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.tokens().textPrimary)
        Text('ChemDraw 基本绘制')
          .fontSize(10)
          .fontColor(this.tokens().textSecondary)
        Blank()
        Text('撤销')
          .fontSize(12)
          .fontColor(this.history.length > 0 ? this.tokens().textPrimary : this.tokens().textSecondary)
          .padding({ left: 8, right: 8, top: 5, bottom: 5 })
          .backgroundColor(this.dark ? '#1AFFFFFF' : '#0F000000')
          .borderRadius(7)
          .onClick(() => {
            this.undo();
          })
        Text('清空')
          .fontSize(12)
          .fontColor(this.tokens().textPrimary)
          .padding({ left: 8, right: 8, top: 5, bottom: 5 })
          .backgroundColor(this.dark ? '#1AFFFFFF' : '#0F000000')
          .borderRadius(7)
          .onClick(() => {
            this.clearAll();
          })
        Text('关闭')
          .fontSize(12)
          .fontColor('#FFFFFFFF')
          .padding({ left: 10, right: 10, top: 5, bottom: 5 })
          .backgroundColor('#FF0067C0')
          .borderRadius(7)
          .onClick(() => {
            this.onClose();
          })
      }
      .width('100%')

      Scroll() {
        Row({ space: 6 }) {
          ForEach(CHEM_TOOLS, (item: ChemTool) => {
            this.ToolButton(item)
          }, (item: ChemTool) => item.Id)
        }
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .width('100%')

      Text(this.hint)
        .fontSize(10)
        .fontColor(this.tokens().textSecondary)
        .width('100%')

      Canvas(this.ctx)
        .width('100%')
        .layoutWeight(1)
        .backgroundColor(this.paperColor())
        .onReady(() => {
          this.ready = true;
          this.redraw();
        })
        .onAreaChange((oldValue: Area, newValue: Area) => {
          this.canvasW = Number(newValue.width);
          this.canvasH = Number(newValue.height);
          this.redraw();
        })
        .onTouch((event: TouchEvent) => {
          this.onTouchEvent(event);
        })
        .clip(true)
        .borderRadius(12)
        .border({ width: 1, color: this.dark ? '#26FFFFFF' : '#14000000' })
    }
    .padding(14)
    .width('94%')
    .constraintSize({ maxWidth: 1080, maxHeight: '88%' })
    .backgroundColor(this.dark ? '#F214161B' : '#FAFFFFFF')
    .borderRadius(18)
    .border({ width: 1, color: this.dark ? '#66FFFFFF' : '#1A000000' })
    .shadow({ radius: 24, color: '#33000000', offsetX: 0, offsetY: 10 })
  }
}

interface ChemHistory {
  a: ChemAtom[];
  b: ChemBond[];
}