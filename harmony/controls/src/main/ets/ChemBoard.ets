// 分子结构绘制层（对齐 ChemDraw 核心交互）
// 不单独开窗口：直接覆盖在白板画布上，工具条悬浮在顶部，结构以浮层形式独立于墨迹文档。
// 渲染采用声明式 Path（数据驱动），避免 Canvas 手动重绘与组件重建的时序问题。
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
  Wedge: boolean;
}

interface ChemTool {
  Id: string;
  Label: string;
}

interface ChemRing {
  Id: string;
  Label: string;
  Sides: number;
  Aromatic: boolean;
}

const BOND_LENGTH: number = 42;
const ANGLE_STEP: number = Math.PI / 12;
const HIT_ATOM: number = 16;
const HIT_BOND: number = 9;
const SNAP: number = 15;

const ELEMENTS: string[] = ['C', 'N', 'O', 'S', 'P', 'F', 'Cl', 'Br', 'I', 'H', 'Na', 'K'];

const CHEM_TOOLS: ChemTool[] = [
  { Id: 'select', Label: '选择' },
  { Id: 'bond1', Label: '单键' },
  { Id: 'bond2', Label: '双键' },
  { Id: 'bond3', Label: '三键' },
  { Id: 'wedge', Label: '楔形' },
  { Id: 'erase', Label: '橡皮' },
  { Id: 'rings', Label: '环' },
  { Id: 'element', Label: '元素' },
  { Id: 'clean', Label: '清理' }
];

const CHEM_RINGS: ChemRing[] = [
  { Id: 'ring3', Label: '环丙烷', Sides: 3, Aromatic: false },
  { Id: 'ring4', Label: '环丁烷', Sides: 4, Aromatic: false },
  { Id: 'ring5', Label: '环戊烷', Sides: 5, Aromatic: false },
  { Id: 'ring6', Label: '环己烷', Sides: 6, Aromatic: false },
  { Id: 'ring8', Label: '环辛烷', Sides: 8, Aromatic: false },
  { Id: 'benzene', Label: '苯环', Sides: 6, Aromatic: true }
];

@Component
export struct ChemBoard {
  @Prop dark: boolean = false;
  onExit: () => void = () => {
  };

  @State atoms: ChemAtom[] = [];
  @State bonds: ChemBond[] = [];
  @State tool: string = 'select';
  @State pendingId: number = -1;
  @State selectedId: number = -1;
  @State ringMenuOpen: boolean = false;
  @State elementMenuOpen: boolean = false;
  @State hint: string = '选择工具：按住原子可拖动；单键：单击沿链延伸，或按住拖拽';
  @State previewing: boolean = false;
  @State previewX: number = 0;
  @State previewY: number = 0;
  private nextId: number = 1;
  private downX: number = 0;
  private downY: number = 0;
  private dragging: boolean = false;
  private anchorId: number = -1;
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  private tokens(): ThemeTokens {
    return themeTokens(this.dark);
  }

  private lineColor(): string {
    return this.dark ? '#FFE8ECEF' : '#FF1A1A1E';
  }

  private accent(): string {
    return '#FF38E1FF';
  }

  private snap(value: number): number {
    return Math.round(value / SNAP) * SNAP;
  }

  private snapshot(): void {
    this.undoStack.push(JSON.stringify({ a: this.atoms, b: this.bonds }));
    if (this.undoStack.length > 80) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  private restore(json: string): void {
    const state: ChemHistory = JSON.parse(json) as ChemHistory;
    this.atoms = state.a;
    this.bonds = state.b;
    let maxId = 0;
    for (let i = 0; i < this.atoms.length; i++) {
      if (this.atoms[i].Id > maxId) {
        maxId = this.atoms[i].Id;
      }
    }
    for (let i = 0; i < this.bonds.length; i++) {
      if (this.bonds[i].Id > maxId) {
        maxId = this.bonds[i].Id;
      }
    }
    this.nextId = maxId + 1;
  }

  private undo(): void {
    const last = this.undoStack.pop();
    if (last === undefined) {
      return;
    }
    this.redoStack.push(JSON.stringify({ a: this.atoms, b: this.bonds }));
    this.restore(last);
    this.pendingId = -1;
    this.selectedId = -1;
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) {
      return;
    }
    this.undoStack.push(JSON.stringify({ a: this.atoms, b: this.bonds }));
    this.restore(next);
    this.pendingId = -1;
    this.selectedId = -1;
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
    for (let i = this.atoms.length - 1; i >= 0; i--) {
      const a = this.atoms[i];
      const dx = a.X - x;
      const dy = a.Y - y;
      if (dx * dx + dy * dy <= HIT_ATOM * HIT_ATOM) {
        return a;
      }
    }
    return null;
  }

  private bondAt(x: number, y: number): ChemBond | null {
    for (let i = this.bonds.length - 1; i >= 0; i--) {
      const bond = this.bonds[i];
      const a = this.atomById(bond.A);
      const b = this.atomById(bond.B);
      if (a === null || b === null) {
        continue;
      }
      const dx = b.X - a.X;
      const dy = b.Y - a.Y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1) {
        continue;
      }
      let t = ((x - a.X) * dx + (y - a.Y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a.X + dx * t;
      const py = a.Y + dy * t;
      const ddx = x - px;
      const ddy = y - py;
      if (ddx * ddx + ddy * ddy <= HIT_BOND * HIT_BOND) {
        return bond;
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

  private addBond(a: number, b: number, order: number, wedge: boolean): void {
    if (a === b) {
      return;
    }
    for (let i = 0; i < this.bonds.length; i++) {
      const e = this.bonds[i];
      if ((e.A === a && e.B === b) || (e.A === b && e.B === a)) {
        e.Order = order;
        e.Wedge = wedge;
        this.bonds = this.bonds.slice();
        return;
      }
    }
    const bond: ChemBond = { Id: this.nextId, A: a, B: b, Order: order, Wedge: wedge };
    this.nextId++;
    this.bonds = this.bonds.concat([bond]);
  }

  private bondOrder(): number {
    if (this.tool === 'bond2') {
      return 2;
    }
    if (this.tool === 'bond3') {
      return 3;
    }
    return 1;
  }

  private targetFrom(x: number, y: number, rawAngle: number): number[] {
    const angle = Math.round(rawAngle / ANGLE_STEP) * ANGLE_STEP;
    return [
      Math.round(x + Math.cos(angle) * BOND_LENGTH),
      Math.round(y + Math.sin(angle) * BOND_LENGTH)
    ];
  }

  private commitBond(x: number, y: number): void {
    this.snapshot();
    const order = this.bondOrder();
    const wedge = this.tool === 'wedge';
    let anchor: ChemAtom | null = null;
    if (this.anchorId >= 0) {
      anchor = this.atomById(this.anchorId);
    }
    if (anchor === null && this.pendingId >= 0) {
      anchor = this.atomById(this.pendingId);
    }
    const hit = this.atomAt(x, y);
    if (anchor === null) {
      const a = this.addAtom(this.snap(x), this.snap(y), 'C');
      const point = this.targetFrom(a.X, a.Y, -Math.PI / 6);
      const b = this.addAtom(point[0], point[1], 'C');
      this.addBond(a.Id, b.Id, order, wedge);
      this.pendingId = b.Id;
      return;
    }
    if (hit !== null && hit.Id !== anchor.Id) {
      this.addBond(anchor.Id, hit.Id, order, wedge);
      this.pendingId = hit.Id;
      return;
    }
    const dx = x - anchor.X;
    const dy = y - anchor.Y;
    let angle = Math.atan2(dy, dx);
    if (dx * dx + dy * dy < 36) {
      angle = -Math.PI / 6;
    }
    const point = this.targetFrom(anchor.X, anchor.Y, angle);
    const end = this.addAtom(point[0], point[1], 'C');
    this.addBond(anchor.Id, end.Id, order, wedge);
    this.pendingId = end.Id;
  }

  private placeRing(cx: number, cy: number, sides: number, aromatic: boolean): void {
    this.snapshot();
    const radius = sides <= 4 ? BOND_LENGTH * 0.72 : BOND_LENGTH / (2 * Math.sin(Math.PI / sides));
    const created: ChemAtom[] = [];
    for (let i = 0; i < sides; i++) {
      const angle = -Math.PI / 2 + i * 2 * Math.PI / sides;
      created.push(this.addAtom(
        Math.round(cx + Math.cos(angle) * radius),
        Math.round(cy + Math.sin(angle) * radius),
        'C'
      ));
    }
    for (let i = 0; i < sides; i++) {
      const order = aromatic && i % 2 === 0 ? 2 : 1;
      this.addBond(created[i].Id, created[(i + 1) % sides].Id, order, false);
    }
    this.pendingId = -1;
    this.selectedId = -1;
  }

  private eraseAt(x: number, y: number): void {
    const atom = this.atomAt(x, y);
    if (atom !== null) {
      this.snapshot();
      this.atoms = this.atoms.filter((item: ChemAtom) => item.Id !== atom.Id);
      this.bonds = this.bonds.filter((item: ChemBond) => item.A !== atom.Id && item.B !== atom.Id);
      this.pendingId = -1;
      return;
    }
    const bond = this.bondAt(x, y);
    if (bond !== null) {
      this.snapshot();
      this.bonds = this.bonds.filter((item: ChemBond) => item.Id !== bond.Id);
    }
  }

  private cleanUp(): void {
    if (this.atoms.length === 0) {
      return;
    }
    this.snapshot();
    const mapped: ChemAtom[] = [];
    const remap: Map<number, number> = new Map();
    for (let i = 0; i < this.atoms.length; i++) {
      const atom = this.atoms[i];
      let targetId = -1;
      const candidateX = Math.round(atom.X / SNAP) * SNAP;
      const candidateY = Math.round(atom.Y / SNAP) * SNAP;
      for (let j = 0; j < mapped.length; j++) {
        const dx = mapped[j].X - candidateX;
        const dy = mapped[j].Y - candidateY;
        if (dx * dx + dy * dy < 64) {
          targetId = mapped[j].Id;
          break;
        }
      }
      if (targetId < 0) {
        const fresh: ChemAtom = { Id: atom.Id, X: candidateX, Y: candidateY, Element: atom.Element };
        mapped.push(fresh);
        remap.set(atom.Id, atom.Id);
      } else {
        remap.set(atom.Id, targetId);
      }
    }
    const nextBonds: ChemBond[] = [];
    const seen: string[] = [];
    for (let i = 0; i < this.bonds.length; i++) {
      const bond = this.bonds[i];
      const a = remap.get(bond.A);
      const b = remap.get(bond.B);
      if (a === undefined || b === undefined || a === b) {
        continue;
      }
      const key = Math.min(a, b) + '-' + Math.max(a, b);
      if (seen.indexOf(key) >= 0) {
        continue;
      }
      seen.push(key);
      nextBonds.push({ Id: bond.Id, A: a, B: b, Order: bond.Order, Wedge: bond.Wedge });
    }
    this.atoms = mapped;
    this.bonds = nextBonds;
    this.pendingId = -1;
    this.selectedId = -1;
  }

  private applyElement(element: string): void {
    const atom = this.atomById(this.selectedId);
    if (atom === null) {
      return;
    }
    this.snapshot();
    atom.Element = element;
    this.atoms = this.atoms.slice();
    this.elementMenuOpen = false;
  }

  private ringById(id: string): ChemRing | null {
    for (let i = 0; i < CHEM_RINGS.length; i++) {
      if (CHEM_RINGS[i].Id === id) {
        return CHEM_RINGS[i];
      }
    }
    return null;
  }

  private onTouchEvent(event: TouchEvent): void {
    if (event.touches.length === 0) {
      return;
    }
    const x = event.touches[0].x;
    const y = event.touches[0].y;
    if (event.type === TouchType.Down) {
      this.downX = x;
      this.downY = y;
      this.previewX = x;
      this.previewY = y;
      if (this.tool === 'select') {
        const hit = this.atomAt(x, y);
        this.selectedId = hit === null ? -1 : hit.Id;
        this.dragging = hit !== null;
        return;
      }
      if (this.tool === 'erase') {
        this.eraseAt(x, y);
        return;
      }
      if (this.tool === 'element') {
        const hit = this.atomAt(x, y);
        if (hit !== null) {
          this.selectedId = hit.Id;
          this.elementMenuOpen = true;
        }
        return;
      }
      if (this.tool.indexOf('ring') === 0 || this.tool === 'benzene') {
        this.previewing = true;
        return;
      }
      const hit = this.atomAt(x, y);
      this.anchorId = hit === null ? -1 : hit.Id;
      this.previewing = true;
    } else if (event.type === TouchType.Move) {
      if (this.tool === 'select' && this.dragging && this.selectedId >= 0) {
        const atom = this.atomById(this.selectedId);
        if (atom !== null) {
          atom.X = this.snap(x);
          atom.Y = this.snap(y);
          this.atoms = this.atoms.slice();
        }
        return;
      }
      if (!this.previewing) {
        return;
      }
      this.previewX = x;
      this.previewY = y;
    } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
      if (this.tool === 'select' && this.dragging) {
        this.dragging = false;
        this.snapshot();
        return;
      }
      if (!this.previewing) {
        return;
      }
      this.previewing = false;
      if (event.type === TouchType.Cancel) {
        return;
      }
      if (this.tool.indexOf('ring') === 0 || this.tool === 'benzene') {
        const ring = this.ringById(this.tool);
        if (ring !== null) {
          this.placeRing(this.snap(this.downX), this.snap(this.downY), ring.Sides, ring.Aromatic);
        }
        return;
      }
      const dx = x - this.downX;
      const dy = y - this.downY;
      const moved = dx * dx + dy * dy > 100;
      // 拖拽：以按下点为锚；单击：点中原子则以它为锚，点空白则沿用上次链端继续延伸。
      if (moved || this.anchorId >= 0) {
        this.pendingId = this.anchorId;
      }
      this.commitBond(moved ? x : this.downX, moved ? y : this.downY);
      this.anchorId = -1;
    }
  }

  // ---- 声明式渲染 ---------------------------------------------------------

  private bondStart(bond: ChemBond): ChemAtom | null {
    return this.atomById(bond.A);
  }

  private seg(bond: ChemBond): number[] {
    const a = this.atomById(bond.A);
    const b = this.atomById(bond.B);
    if (a === null || b === null) {
      return [0, 0, 0, 0, 0, 0, 0, 0];
    }
    const dx = b.X - a.X;
    const dy = b.Y - a.Y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    // 隐式 C 端点不缩进：C–C 键必须连续，否则相邻键之间会出现断裂。
    const padA = a.Element === 'C' ? 0 : 12;
    const padB = b.Element === 'C' ? 0 : 12;
    return [
      a.X + ux * padA, a.Y + uy * padA,
      b.X - ux * padB, b.Y - uy * padB,
      nx, ny, len
    ];
  }

  // Path 的 commands 以 px 解释，而触摸/布局是 vp：这里统一换算，避免图形缩小 1/density。
  private px(value: number): string {
    return vp2px(value).toFixed(1);
  }

  private bondsStrokePath(): string {
    let d = '';
    for (let i = 0; i < this.bonds.length; i++) {
      const bond = this.bonds[i];
      if (bond.Wedge) {
        continue;
      }
      const s = this.seg(bond);
      const x1 = s[0];
      const y1 = s[1];
      const x2 = s[2];
      const y2 = s[3];
      const nx = s[4];
      const ny = s[5];
      if (bond.Order <= 1) {
        d += 'M ' + this.px(x1) + ' ' + this.px(y1) + ' L ' + this.px(x2) + ' ' + this.px(y2) + ' ';
      } else if (bond.Order === 2) {
        d += 'M ' + this.px(x1 + nx * 2.6) + ' ' + this.px(y1 + ny * 2.6)
          + ' L ' + this.px(x2 + nx * 2.6) + ' ' + this.px(y2 + ny * 2.6) + ' ';
        d += 'M ' + this.px(x1 - nx * 2.6) + ' ' + this.px(y1 - ny * 2.6)
          + ' L ' + this.px(x2 - nx * 2.6) + ' ' + this.px(y2 - ny * 2.6) + ' ';
      } else {
        d += 'M ' + this.px(x1) + ' ' + this.px(y1) + ' L ' + this.px(x2) + ' ' + this.px(y2) + ' ';
        d += 'M ' + this.px(x1 + nx * 3.4) + ' ' + this.px(y1 + ny * 3.4)
          + ' L ' + this.px(x2 + nx * 3.4) + ' ' + this.px(y2 + ny * 3.4) + ' ';
        d += 'M ' + this.px(x1 - nx * 3.4) + ' ' + this.px(y1 - ny * 3.4)
          + ' L ' + this.px(x2 - nx * 3.4) + ' ' + this.px(y2 - ny * 3.4) + ' ';
      }
    }
    return d;
  }

  private bondsFillPath(): string {
    let d = '';
    for (let i = 0; i < this.bonds.length; i++) {
      const bond = this.bonds[i];
      if (!bond.Wedge) {
        continue;
      }
      const s = this.seg(bond);
      const x1 = s[0];
      const y1 = s[1];
      const x2 = s[2];
      const y2 = s[3];
      const nx = s[4];
      const ny = s[5];
      d += 'M ' + this.px(x1) + ' ' + this.px(y1)
        + ' L ' + this.px(x2 + nx * 5.2) + ' ' + this.px(y2 + ny * 5.2)
        + ' L ' + this.px(x2 - nx * 5.2) + ' ' + this.px(y2 - ny * 5.2) + ' Z ';
    }
    return d;
  }

  private previewPath(): string {
    if (!this.previewing || this.tool === 'select' || this.tool === 'erase'
      || this.tool === 'element' || this.tool.indexOf('ring') === 0 || this.tool === 'benzene') {
      return '';
    }
    let from: ChemAtom | null = null;
    if (this.anchorId >= 0) {
      from = this.atomById(this.anchorId);
    } else if (this.pendingId >= 0) {
      from = this.atomById(this.pendingId);
    }
    if (from === null) {
      return '';
    }
    const point = this.targetFrom(from.X, from.Y, Math.atan2(this.previewY - from.Y, this.previewX - from.X));
    return 'M ' + this.px(from.X) + ' ' + this.px(from.Y) + ' L ' + this.px(point[0]) + ' ' + this.px(point[1]);
  }

  private markIds(): number[] {
    const ids: number[] = [];
    if (this.pendingId >= 0) {
      ids.push(this.pendingId);
    }
    if (this.selectedId >= 0 && this.selectedId !== this.pendingId) {
      ids.push(this.selectedId);
    }
    return ids;
  }

  private ringPath(sides: number, size: number): string {
    let path = '';
    const radius = size / 2 - 1.5;
    for (let i = 0; i < sides; i++) {
      const angle = -Math.PI / 2 + i * 2 * Math.PI / sides;
      const x = size / 2 + Math.cos(angle) * radius;
      const y = size / 2 + Math.sin(angle) * radius;
      path += (i === 0 ? 'M ' : 'L ') + this.px(x) + ' ' + this.px(y) + ' ';
    }
    return path + 'Z';
  }

  @Builder
  AtomView(atom: ChemAtom) {
    if (atom.Element !== 'C') {
      Text(atom.Element)
        .fontSize(14)
        .fontColor(this.lineColor())
        .textAlign(TextAlign.Center)
        .width(26)
        .height(26)
        .backgroundColor(this.dark ? '#FF14161B' : '#FFFFFFFF')
        .borderRadius(13)
        .position({ x: atom.X - 13, y: atom.Y - 13 })
        .hitTestBehavior(HitTestMode.None)
    }
  }

  @Builder
  MarkView(id: number) {
    Circle()
      .width(28)
      .height(28)
      .fill(Color.Transparent)
      .stroke(this.accent())
      .strokeWidth(2)
      .position({ x: (this.atomById(id)?.X ?? 0) - 14, y: (this.atomById(id)?.Y ?? 0) - 14 })
      .hitTestBehavior(HitTestMode.None)
  }

  @Builder
  ToolButton(item: ChemTool) {
    Text(item.Label)
      .fontSize(11)
      .fontColor(this.tool === item.Id ? '#FF05070C' : '#FFE8ECEF')
      .padding({ left: 9, right: 9, top: 6, bottom: 6 })
      .backgroundColor(this.tool === item.Id ? this.accent() : '#1AFFFFFF')
      .borderRadius(7)
      .onClick(() => {
        if (item.Id === 'clean') {
          this.cleanUp();
        }
        this.tool = item.Id;
        this.ringMenuOpen = item.Id === 'rings';
        this.elementMenuOpen = false;
        this.pendingId = -1;
        this.anchorId = -1;
        this.previewing = false;
        this.hint = this.hintFor(item.Id);
      })
  }

  private hintFor(id: string): string {
    if (id === 'select') {
      return '按住原子拖动可移动；点空白取消选择';
    }
    if (id === 'erase') {
      return '点原子删除原子及其键；点键删除该键';
    }
    if (id === 'element') {
      return '点原子后选择元素符号';
    }
    if (id === 'rings') {
      return '选择环类型后单击画布放置';
    }
    if (id === 'clean') {
      return '已按 15vp 网格对齐并合并重合原子';
    }
    if (id === 'wedge') {
      return '单击或拖拽生成楔形键（朝末端变宽）';
    }
    return '单击沿链延伸（等长、15° 吸附）；按住拖拽指定方向';
  }

  @Builder
  RingChip(ring: ChemRing) {
    Row({ space: 4 }) {
      Path()
        .width(16)
        .height(16)
        .commands(this.ringPath(ring.Sides, 16))
        .fill(Color.Transparent)
        .stroke('#FFE8ECEF')
        .strokeWidth(1.2)
      Text(ring.Label)
        .fontSize(10)
        .fontColor('#FFE8ECEF')
    }
    .padding({ left: 7, right: 9, top: 5, bottom: 5 })
    .backgroundColor(this.tool === ring.Id ? '#FF38E1FF' : '#1AFFFFFF')
    .borderRadius(7)
    .onClick(() => {
      this.tool = ring.Id;
      this.ringMenuOpen = false;
      this.pendingId = -1;
      this.hint = '单击画布放置' + ring.Label;
    })
  }

  @Builder
  ElementChip(element: string) {
    Text(element)
      .fontSize(12)
      .fontColor('#FF05070C')
      .width(34)
      .height(30)
      .textAlign(TextAlign.Center)
      .backgroundColor('#FFE9EDF2')
      .borderRadius(6)
      .onClick(() => {
        this.applyElement(element);
      })
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      // 触摸层：铺满画布，负责所有输入（结构层不参与命中）
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(Color.Transparent)
        .onTouch((event: TouchEvent) => {
          this.onTouchEvent(event);
        })

      Path()
        .width('100%')
        .height('100%')
        .commands(this.bondsStrokePath())
        .fill(Color.Transparent)
        .stroke(this.lineColor())
        .strokeWidth(1.8)
        .hitTestBehavior(HitTestMode.None)

      Path()
        .width('100%')
        .height('100%')
        .commands(this.bondsFillPath())
        .fill(this.lineColor())
        .stroke(Color.Transparent)
        .hitTestBehavior(HitTestMode.None)

      ForEach(this.atoms, (atom: ChemAtom) => {
        this.AtomView(atom)
      }, (atom: ChemAtom) => 'atom-' + atom.Id + '-' + atom.Element + '-' + atom.X + '-' + atom.Y)

      ForEach(this.markIds(), (id: number) => {
        this.MarkView(id)
      }, (id: number) => 'mark-' + id)

      Path()
        .width('100%')
        .height('100%')
        .commands(this.previewPath())
        .fill(Color.Transparent)
        .stroke(this.accent())
        .strokeWidth(1.6)
        .strokeDashArray([4, 4])
        .hitTestBehavior(HitTestMode.None)

      Column({ space: 6 }) {
        Row({ space: 4 }) {
          ForEach(CHEM_TOOLS, (item: ChemTool) => {
            this.ToolButton(item)
          }, (item: ChemTool) => item.Id)
          Text('撤销')
            .fontSize(11)
            .fontColor('#FFE8ECEF')
            .padding({ left: 8, right: 8, top: 6, bottom: 6 })
            .backgroundColor('#1AFFFFFF')
            .borderRadius(7)
            .onClick(() => {
              this.undo();
            })
          Text('重做')
            .fontSize(11)
            .fontColor('#FFE8ECEF')
            .padding({ left: 8, right: 8, top: 6, bottom: 6 })
            .backgroundColor('#1AFFFFFF')
            .borderRadius(7)
            .onClick(() => {
              this.redo();
            })
          Text('退出')
            .fontSize(11)
            .fontColor('#FFFFFFFF')
            .padding({ left: 10, right: 10, top: 6, bottom: 6 })
            .backgroundColor('#FF0067C0')
            .borderRadius(7)
            .onClick(() => {
              this.onExit();
            })
        }
        .padding(6)
        .linearGradient({
          angle: 180,
          colors: [['#3DFFFFFF', 0.0], ['#E614161B', 0.12], ['#E614161B', 1.0]]
        })
        .borderRadius(12)
        .border({ width: 1, color: '#66FFFFFF' })
        .backdropBlur(18)
        .shadow({ radius: 18, color: '#33000000', offsetX: 0, offsetY: 8 })

        if (this.ringMenuOpen) {
          Row({ space: 4 }) {
            ForEach(CHEM_RINGS, (ring: ChemRing) => {
              this.RingChip(ring)
            }, (ring: ChemRing) => ring.Id)
          }
          .padding(6)
          .backgroundColor('#E614161B')
          .borderRadius(10)
          .border({ width: 1, color: '#33FFFFFF' })
          .backdropBlur(16)
        }

        if (this.elementMenuOpen) {
          Row({ space: 4 }) {
            ForEach(ELEMENTS, (element: string) => {
              this.ElementChip(element)
            }, (element: string) => element)
          }
          .padding(6)
          .backgroundColor('#F2FFFFFF')
          .borderRadius(10)
          .border({ width: 1, color: '#1A000000' })
          .shadow({ radius: 14, color: '#33000000', offsetX: 0, offsetY: 6 })
        }

        Text(this.hint)
          .fontSize(10)
          .fontColor(this.dark ? '#B3FFFFFF' : '#B3000000')
      }
      .padding({ left: 12, top: 10 })
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
  }
}

interface ChemHistory {
  a: ChemAtom[];
  b: ChemBond[];
}