// @parity src/InkCanvas.Ink/InkController.cs
// InkController 1:1 移植（Phase B2/B3）：工具状态机、指针路由、双指手势、选区编辑、
// 图形工具（含两步体）、面积/整笔擦除、视图变换与撤销单元语义。
//
// 边界：
// - 不 import ArkUI/@kit；只依赖 @inkcanvas/core 与本模块 ControllerTypes。
// - 宿主通过 ControllerOptions 注入文档、重绘回调、时间源与手掌决策器（core PalmRejector）。
// - 双曲线渐近线去留与 C# 一致由 kind 决定
//   （hasHyperbolaAsymptotes）；HyperbolaAsymptoteOption/AskRemoveAsymptotes 仅保留为
//   兼容宿主的旧 API 字段，提交路径不再读取。
// - 选区 Move/Rotate 拖拽与选区双指手势延迟写点：期间以 SelectionPreviewTransform
//   表达预览（PreviewStrokes/IsPreviewStroke 供渲染层消费），抬指一次性落点。
//
// 已知基线差异（2026-11-19 同步后）：
// - 选区双指手势（Select 工具）走 Begin/Apply/EndSelectionGesture 延迟写点、整手势一个撤销单元，
//   与 C# 一致；GesturesTargetSelection 非 Select 工具路径两侧均为逐 move 单元（C# 631 同款）。
// - 两步体完成后尊重 StickyShape；一般图形仅在生成结果非空时回笔（C# 934/962/971）。
// - 单笔提交 Invalidated 两次（CommitStrokes 内一次 + Up 尾部一次）——与 C# OnPointerUp 完全一致。
// - G2 元素选区（SelectedElements，:489）、SelectionFrame 定向帧（selectionFrameSummary :2337 起）、
//   TransformSelectionUndoable（:2715）均已落地；仅落点圆点动画未建
//   （ConfirmTap 已收拢为单点，动画状态未建）。
// - G1 套索擦已移植：LassoGeometry（core/selection，向量互认）+ 视图 DIP 路径 +
//   4096 抽稀 + even/odd 命中 + 恢复保叠放序（insertRange）。
const LINE_HOLD_MS = 450;
const LINE_HOLD_RADIUS = 3;

interface LineEndpoint {
  X: number;
  Y: number;
  Since: number;
}
import {
  InkDocument,
  InkStroke,
  Rect,
  InkPoint,
  LassoGeometry,
  InkColor,
  StrokeAttributes,
  SelectionFrameState,
  TaperKind,
  UndoStack,
  PalmRejector,
  TwoFingerManipulator,
  eraseDisc,
  EraseOutcome,
  generate,
  generateCuboid,
  generateHyperbolaBranches,
  isHyperbola,
  hasHyperbolaFoci,
  hasHyperbolaAsymptotes,
  stroke as shapeStroke,
  recognizeStrokes,
  ShapeKind,
  RecognizedShape,
  SelectionHandle,
  HANDLE_RADIUS,
  ROTATE_OFFSET,
  selectionDragMatrix,
  TouchIntent,
  resolvePivot,
  identityMatrix,
  matrixFromArray,
  matrixToArray,
  multiplyMatrix,
  createTranslationMatrix,
  createRotationMatrix,
  invertMatrix,
  transformPointByMatrix,
  Point2,
  Matrix3x2
} from '@inkcanvas/core';
import type { UndoAction, StrokeSummary, TwoFingerUpdate, BoundsInput, LassoPoint } from '@inkcanvas/core';
import {
  InkTool,
  InkEraserMode,
  OptionalOperation,
  PointerKind,
  TransformCenterOption,
  PointerSample,
  ControllerOptions
} from './ControllerTypes';
import type { ISelectionElement, ElementSnapshot } from './ControllerTypes';
import { InkDotAnimation } from './InkDotAnimation';
import { InkPlayback } from './InkPlayback';
import { DrawingObject, LayerAction, sortDrawingObjects, nextLayerOrder, arrangeObjects } from './DrawingObject';
import type {
  ShapeAttributesInput,
  VoidCallback,
  SlideFlipCallback,
  TimeSource,
  AskRemoveAsymptotesCallback,
  ScenarioAdvanced,
  ScenarioInitial,
  ScenarioOp,
  ScenarioPointer,
  ScenarioSeed,
  ScenarioPoint,
  ControllerScenario,
  ControllerScenarioResult,
  ControllerTraceStep,
  ControllerFinalState,
  ControllerStrokeSummary,
  ControllerFrameSummary
} from './ControllerTypes';

// ---- 小型矩阵/矩形辅助 ------------------------------------------------

function cloneRect(value: Rect): Rect {
  return new Rect(value.Left, value.Top, value.Right, value.Bottom);
}

function cloneMatrix(value: Matrix3x2): Matrix3x2 {
  return new Matrix3x2(value.M11, value.M12, value.M21, value.M22, value.M31, value.M32);
}

function determinant(m: Matrix3x2): number {
  return m.M11 * m.M22 - m.M12 * m.M21;
}

/** C# Rendering.CommittedInkLayer.TransformBounds：中心 + 绝对值展幅的 AABB。 */
function transformBounds(bounds: Rect, m: Matrix3x2): Rect {
  if (bounds.isEmpty()) {
    return bounds;
  }
  const center = transformPointByMatrix(m, bounds.centerX(), bounds.centerY());
  const x = (Math.abs(m.M11) * bounds.width() + Math.abs(m.M21) * bounds.height()) / 2;
  const y = (Math.abs(m.M12) * bounds.width() + Math.abs(m.M22) * bounds.height()) / 2;
  return new Rect(center.X - x, center.Y - y, center.X + x, center.Y + y);
}

function distanceSquared(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function transformNormal(m: Matrix3x2, x: number, y: number): Point2 {
  return new Point2(x * m.M11 + y * m.M21, x * m.M12 + y * m.M22);
}

function vectorLength(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

function createCurrentAttributes(): StrokeAttributes {
  const attributes = new StrokeAttributes();
  attributes.Color = InkColor.black();
  attributes.BaseWidth = 2.5;
  attributes.TaperKind = TaperKind.Tail;
  return attributes;
}

function attributesInput(attributes: StrokeAttributes): ShapeAttributesInput {
  return {
    ColorPacked: attributes.Color.packedArgb(),
    BaseWidth: attributes.BaseWidth,
    IsHighlighter: attributes.IsHighlighter,
    HighlighterAlpha: attributes.HighlighterAlpha,
    TaperKind: attributes.TaperKind
  };
}

/** 把 core ShapeGenerator 的 StrokeSummary 还原为 InkStroke（core 的 generate 只导出摘要）。 */
function strokeFromSummary(summary: StrokeSummary): InkStroke {
  const attributes = new StrokeAttributes();
  attributes.Color = InkColor.fromPackedArgb(summary.ColorPacked);
  attributes.BaseWidth = summary.BaseWidth;
  attributes.IsHighlighter = summary.IsHighlighter;
  attributes.HighlighterAlpha = summary.HighlighterAlpha;
  attributes.TaperKind = summary.TaperKind as TaperKind;
  const stroke = new InkStroke(attributes);
  stroke.IsRecognizedShape = summary.IsRecognizedShape;
  const points: InkPoint[] = [];
  for (let i = 0; i < summary.Points.length; i++) {
    const p = summary.Points[i];
    points.push(new InkPoint(p.X, p.Y, p.Pressure, p.Width, p.TimeMs));
  }
  stroke.restorePoints(points);
  stroke.complete();
  return stroke;
}

function strokesFromSummaries(summaries: StrokeSummary[]): InkStroke[] {
  const result: InkStroke[] = [];
  for (let i = 0; i < summaries.length; i++) {
    result.push(strokeFromSummary(summaries[i]));
  }
  return result;
}

/**
 * InkStroke 的 Transform 等价物（core ArkTS InkStroke 未提供 transform）。
 * 语义与 C# 一致：按行列式绝对值的平方根缩放点宽与 BaseWidth；ObjectFrame 以变换前包围盒
 * 为基准累积变换。
 */
function transformStroke(stroke: InkStroke, m: Matrix3x2, scaleWidth: boolean): void {
  const prior = stroke.exportObjectFrame();
  const currentBounds = stroke.bounds();
  let frameBounds = cloneRect(currentBounds);
  let frameTransform = identityMatrix();
  if (prior !== null) {
    frameBounds = new Rect(prior[0], prior[1], prior[2], prior[3]);
    frameTransform = matrixFromArray([prior[4], prior[5], prior[6], prior[7], prior[8], prior[9]]);
  }
  let widthScale = 1;
  if (scaleWidth) {
    widthScale = Math.sqrt(Math.abs(determinant(m)));
    if (widthScale <= 0.0001) {
      widthScale = 1;
    }
  }
  const nextPoints: InkPoint[] = [];
  for (let i = 0; i < stroke.Points.length; i++) {
    const point = stroke.Points[i];
    const transformed = transformPointByMatrix(m, point.X, point.Y);
    nextPoints.push(new InkPoint(
      transformed.X,
      transformed.Y,
      point.Pressure,
      point.Width * widthScale,
      point.TimeMs,
      point.TiltX,
      point.TiltY,
      point.HasPressure
    ));
  }
  stroke.restorePoints(nextPoints);
  stroke.Attributes.BaseWidth *= widthScale;
  if (!frameBounds.isEmpty()) {
    const frame = multiplyMatrix(frameTransform, m);
    stroke.importObjectFrame([
      frameBounds.Left, frameBounds.Top, frameBounds.Right, frameBounds.Bottom,
      frame.M11, frame.M12, frame.M21, frame.M22, frame.M31, frame.M32
    ]);
  }
}

/** C# DelegateAction 的 ArkTS 版本。 */
class ControllerAction implements UndoAction {
  Name: string;
  private applyCallback: VoidCallback;
  private revertCallback: VoidCallback;

  constructor(name: string, apply: VoidCallback, revert: VoidCallback) {
    this.Name = name;
    this.applyCallback = apply;
    this.revertCallback = revert;
  }

  Apply(): void {
    this.applyCallback();
  }

  Revert(): void {
    this.revertCallback();
  }
}

/** 与 C# SelectionFrame 值类型等价的定向选区框。 */
class OrientedFrame {
  Bounds: Rect;
  Transform: Matrix3x2;

  constructor(bounds: Rect, transform: Matrix3x2) {
    this.Bounds = bounds;
    this.Transform = transform;
  }
}

interface FrameDragResult {
  Delta: Matrix3x2;
  Rotation: number;
}

interface RecognizerPoint {
  X: number;
  Y: number;
}

const RESIZE_HANDLES: SelectionHandle[] = [
  SelectionHandle.TopLeft,
  SelectionHandle.Top,
  SelectionHandle.TopRight,
  SelectionHandle.Right,
  SelectionHandle.BottomRight,
  SelectionHandle.Bottom,
  SelectionHandle.BottomLeft,
  SelectionHandle.Left
];

function frameCenter(frame: OrientedFrame, view: Matrix3x2): Point2 {
  const transform = multiplyMatrix(frame.Transform, view);
  return transformPointByMatrix(transform, frame.Bounds.centerX(), frame.Bounds.centerY());
}

function frameContains(frame: OrientedFrame, x: number, y: number, view: Matrix3x2): boolean {
  if (frame.Bounds.isEmpty()) {
    return false;
  }
  const transform = multiplyMatrix(frame.Transform, view);
  if (Math.abs(determinant(transform)) < 1e-12) {
    return false;
  }
  const inverse = invertMatrix(transform);
  const local = transformPointByMatrix(inverse, x, y);
  return frame.Bounds.contains(local.X, local.Y);
}

function frameHandlePosition(frame: OrientedFrame, handle: SelectionHandle, view: Matrix3x2): Point2 {
  const transform = multiplyMatrix(frame.Transform, view);
  if (handle === SelectionHandle.Rotate) {
    const top = transformPointByMatrix(transform, frame.Bounds.centerX(), frame.Bounds.Top);
    let direction = transformNormal(transform, 0, -frame.Bounds.height() / 2);
    if (direction.X * direction.X + direction.Y * direction.Y < 0.001) {
      direction = new Point2(0, -1);
    }
    const length = vectorLength(direction.X, direction.Y);
    return new Point2(
      top.X + (direction.X / length) * ROTATE_OFFSET,
      top.Y + (direction.Y / length) * ROTATE_OFFSET
    );
  }
  let local: Point2 = new Point2(frame.Bounds.centerX(), frame.Bounds.centerY());
  if (handle === SelectionHandle.TopLeft) {
    local = new Point2(frame.Bounds.Left, frame.Bounds.Top);
  } else if (handle === SelectionHandle.TopRight) {
    local = new Point2(frame.Bounds.Right, frame.Bounds.Top);
  } else if (handle === SelectionHandle.BottomRight) {
    local = new Point2(frame.Bounds.Right, frame.Bounds.Bottom);
  } else if (handle === SelectionHandle.BottomLeft) {
    local = new Point2(frame.Bounds.Left, frame.Bounds.Bottom);
  } else if (handle === SelectionHandle.Top) {
    local = new Point2(frame.Bounds.centerX(), frame.Bounds.Top);
  } else if (handle === SelectionHandle.Right) {
    local = new Point2(frame.Bounds.Right, frame.Bounds.centerY());
  } else if (handle === SelectionHandle.Bottom) {
    local = new Point2(frame.Bounds.centerX(), frame.Bounds.Bottom);
  } else if (handle === SelectionHandle.Left) {
    local = new Point2(frame.Bounds.Left, frame.Bounds.centerY());
  }
  return transformPointByMatrix(transform, local.X, local.Y);
}

function frameHitTest(frame: OrientedFrame, x: number, y: number, view: Matrix3x2): SelectionHandle {
  if (frame.Bounds.isEmpty()) {
    return SelectionHandle.None;
  }
  const rotate = frameHandlePosition(frame, SelectionHandle.Rotate, view);
  if (distanceSquared(x, y, rotate.X, rotate.Y) <= HANDLE_RADIUS * HANDLE_RADIUS) {
    return SelectionHandle.Rotate;
  }

  const transform = multiplyMatrix(frame.Transform, view);
  const widthNormal = transformNormal(transform, frame.Bounds.width(), 0);
  const heightNormal = transformNormal(transform, 0, frame.Bounds.height());
  const width = vectorLength(widthNormal.X, widthNormal.Y);
  const height = vectorLength(heightNormal.X, heightNormal.Y);
  const center = frameCenter(frame, view);

  let nearest = SelectionHandle.None;
  let distance = HANDLE_RADIUS;
  for (let i = 0; i < RESIZE_HANDLES.length; i++) {
    const handle = RESIZE_HANDLES[i];
    if ((handle === SelectionHandle.Top || handle === SelectionHandle.Bottom) && (width < 48 || height < 24)) {
      continue;
    }
    if ((handle === SelectionHandle.Left || handle === SelectionHandle.Right) && (height < 48 || width < 24)) {
      continue;
    }
    const position = frameHandlePosition(frame, handle, view);
    const radius = Math.min(HANDLE_RADIUS, vectorLength(position.X - center.X, position.Y - center.Y) * 0.65);
    const current = vectorLength(position.X - x, position.Y - y);
    if (current <= radius && current < distance) {
      nearest = handle;
      distance = current;
    }
  }
  if (nearest !== SelectionHandle.None) {
    return nearest;
  }
  return frameContains(frame, x, y, view) ? SelectionHandle.Move : SelectionHandle.None;
}

function frameDrag(
  frame: OrientedFrame,
  handle: SelectionHandle,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  view: Matrix3x2,
  constrain: boolean
): FrameDragResult {
  if (Math.abs(determinant(view)) < 1e-12) {
    return { Delta: identityMatrix(), Rotation: 0 };
  }
  const inverseView = invertMatrix(view);
  if (handle === SelectionHandle.Move) {
    const local = transformNormal(inverseView, toX - fromX, toY - fromY);
    return { Delta: createTranslationMatrix(local.X, local.Y), Rotation: 0 };
  }
  if (handle === SelectionHandle.Rotate) {
    const center = frameCenter(frame, view);
    const ax = fromX - center.X;
    const ay = fromY - center.Y;
    const bx = toX - center.X;
    const by = toY - center.Y;
    if (ax * ax + ay * ay < 0.001 || bx * bx + by * by < 0.001) {
      return { Delta: identityMatrix(), Rotation: 0 };
    }
    let rotation = Math.atan2(by, bx) - Math.atan2(ay, ax);
    if (constrain) {
      const initial = Math.atan2(frame.Transform.M12, frame.Transform.M11);
      const step = Math.PI / 12;
      rotation = Math.round((initial + rotation) / step) * step - initial;
    }
    const delta = multiplyMatrix(
      multiplyMatrix(createTranslationMatrix(-center.X, -center.Y), createRotationMatrix(rotation)),
      createTranslationMatrix(center.X, center.Y)
    );
    return {
      Delta: multiplyMatrix(multiplyMatrix(cloneMatrix(view), delta), inverseView),
      Rotation: rotation
    };
  }

  const frameView = multiplyMatrix(frame.Transform, view);
  if (Math.abs(determinant(frameView)) < 1e-12 || Math.abs(determinant(frame.Transform)) < 1e-12) {
    return { Delta: identityMatrix(), Rotation: 0 };
  }
  const inverse = invertMatrix(frameView);
  const inverseFrame = invertMatrix(frame.Transform);
  const localFrom = transformPointByMatrix(inverse, fromX, fromY);
  const localTo = transformPointByMatrix(inverse, toX, toY);
  const local = dragMatrixRectValues(handle, frame.Bounds, localFrom.X, localFrom.Y, localTo.X, localTo.Y, constrain);
  return {
    Delta: multiplyMatrix(multiplyMatrix(inverseFrame, local), frame.Transform),
    Rotation: 0
  };
}

/**
 * core SelectionGeometry 的向量入口 selectionDragMatrix 返回 number[]；
 * 控制器需要矩阵实例，这里做一次结构转换（数学实现仍由 core 提供）。
 */
function dragMatrixRectValues(
  handle: SelectionHandle,
  bounds: Rect,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  keepAspect: boolean
): Matrix3x2 {
  const input: BoundsInput = {
    Left: bounds.Left,
    Top: bounds.Top,
    Right: bounds.Right,
    Bottom: bounds.Bottom
  };
  return matrixFromArray(selectionDragMatrix(handle, input, fromX, fromY, toX, toY, keepAspect));
}

export class InkController {
  Document: InkDocument;
  History: UndoStack;
  CurrentAttributes: StrokeAttributes;
  Palm: PalmRejector;

  private _tool: InkTool = InkTool.Pen;
  private _shapeKind: ShapeKind = ShapeKind.Line;
  StickyShape: boolean = false;
  HyperbolaAsymptoteOption: number = OptionalOperation.Ask;
  AskRemoveAsymptotes: AskRemoveAsymptotesCallback | null = null;
  private _cloneMode: boolean = false;
  EraserRadius: number = 16;
  private _eraserMode: InkEraserMode = InkEraserMode.Area;
  PalmErases: boolean = true;
  RecognizeShapes: boolean = true;
  // 墨迹转形状成功后的 UI 回调（kind：直线/圆/椭圆/三角形/矩形）
  onShapeRecognized: ((kind: string) => void) | null = null;
  MultiTouchEnabled: boolean = true;
  ViewTransform: Matrix3x2 = identityMatrix();
  ViewCenter: Point2 = new Point2(960, 540);
  TransformCenterOption: number = TransformCenterOption.CanvasCenterPoint;
  Selection: InkStroke[] = [];
  // G2 元素选区桥：宿主注入可选元素（图片/视频），与墨迹共同参与选区语义。
  GetSelectableElements: (() => ISelectionElement[]) | null = null;
  SelectedElements: ISelectionElement[] = [];
  private _marqueeInitialElements: ISelectionElement[] = [];
  private _dragElements: ISelectionElement[] = [];
  private _dragElementSnapshots: ElementSnapshot[] = [];
  // 拖拽期间已对元素应用的累计矩阵（步进 delta = 新绝对 * 逆(旧绝对)）。
  private _dragElementMatrix: Matrix3x2 | null = null;
  GesturesTargetSelection: boolean = false;

  /** 宿主重绘回调；每次逻辑失效调用一次（宿主负责合并）。 */
  Invalidated: VoidCallback | null = null;
  SelectionChanged: VoidCallback | null = null;
  ToolChanged: VoidCallback | null = null;
  SlideFlipRequested: SlideFlipCallback | null = null;

  InvalidationCount: number = 0;
  SelectionChangedCount: number = 0;
  ToolChangedCount: number = 0;

  private _live: Map<number, InkStroke> = new Map<number, InkStroke>();
  private _liveIds: number[] = [];
  private _touches: Map<number, PointerSample> = new Map<number, PointerSample>();
  private _touchOrder: number[] = [];
  private _manipulator: TwoFingerManipulator = new TwoFingerManipulator();
  private _selectionManipulator: TwoFingerManipulator = new TwoFingerManipulator();
  private _recentForRecognition: InkStroke[] = [];
  // 基线演进：直线识别端点按住门控（450ms / 3px）+ 模拟压感笔锋相对时间起点。
  private _lineEndpoints: Map<number, LineEndpoint> = new Map<number, LineEndpoint>();
  private _strokeStartTimes: Map<number, number> = new Map<number, number>();
  // G1 套索擦：闭合手绘多边形（视图 DIP），even/odd 填充；4096 点抽稀。
  private _lassoPath: LassoPoint[] = [];
  private _lassoBounds: Rect = Rect.empty();
  private _lassoPointerId: number = -1;
  private _lassoViewAtStart: Matrix3x2 = identityMatrix();
  private _lassoErasing: boolean = false;
  private _shapeDragStart: Map<number, Point2> = new Map<number, Point2>();
  private _shapePreview: InkStroke[] = [];

  private _shapeStep: number = 0;
  private _stepAnchor: Point2 = new Point2(0, 0);
  private _stepSecond: Point2 = new Point2(0, 0);
  private _stepK: number = 0;
  private _stepPending: InkStroke[] = [];
  private _lastEraserPoint: Point2 = new Point2(0, 0);
  private _erasing: boolean = false;
  private _panPointerId: number | null = null;
  private _panStartX: number = 0;
  private _panStartY: number = 0;
  private _panView: Matrix3x2 = identityMatrix();

  private _selectionGesture: boolean = false;
  private _activeHandle: SelectionHandle = SelectionHandle.None;
  private _dragFromViewX: number = 0;
  private _dragFromViewY: number = 0;
  private _viewAtDragStart: Matrix3x2 = identityMatrix();
  private _dragSnapshot: InkStroke[] | null = null;
  private _dragTargets: InkStroke[] | null = null;
  private _cloneDrag: boolean = false;
  private _dragMoved: boolean = false;
  private _selectionPointerId: number = 0;
  private _dragFrame: OrientedFrame = new OrientedFrame(Rect.empty(), identityMatrix());
  // 拖拽预览：Move/Rotate 与选区手势延迟写点，期间以绝对矩阵 _selectionPreview 表达位移。
  private _selectionPreview: Matrix3x2 = identityMatrix();
  private _previewSet: Set<InkStroke> = new Set<InkStroke>();
  private _isMarqueeSelecting: boolean = false;
  private _marqueeBounds: Rect = Rect.empty();
  private _marqueeInitialStrokes: InkStroke[] = [];

  // C# SelectionFrame 是值类型：未记住过帧时默认 Transform 为全 0（不是 Identity）。
  private _cachedFrame: OrientedFrame = new OrientedFrame(Rect.empty(), new Matrix3x2(0, 0, 0, 0, 0, 0));
  private _frameStrokes: InkStroke[] = [];
  private _frameVersions: number[] = [];
  private _geometryVersions: Map<InkStroke, number> = new Map<InkStroke, number>();
  private _cloneSerial: number = 0;

  private _erasedThisGesture: InkStroke[] = [];
  private _eraseBeforeSnapshot: InkStroke[] | null = null;
  private _partialEraseGesture: boolean = false;
  private _eraserPointerId: number = 0;
  private _gestureEraserRadius: number | null = null;
  private _slideGestureActive: boolean = false;
  private _slideGestureStartX: number = 0;

  private _timeSource: TimeSource;

  constructor(options: ControllerOptions | null = null) {
    this.Document = new InkDocument();
    this.Palm = new PalmRejector();
    let capacity = 200;
    if (options !== null) {
      if (options.Document !== null) {
        this.Document = options.Document;
      }
      if (options.Palm !== null) {
        this.Palm = options.Palm;
      }
      if (options.RequestRender !== null) {
        this.Invalidated = options.RequestRender;
      }
      capacity = options.HistoryCapacity;
    }
    this.History = new UndoStack(capacity);
    this.CurrentAttributes = createCurrentAttributes();
    const source: TimeSource | null = options === null ? null : options.TimeSource;
    if (source !== null) {
      this._timeSource = source;
    } else {
      this._timeSource = (): number => Date.now();
    }
  }

  // ---- 工具 / 模式 -------------------------------------------------------

  get Tool(): InkTool {
    return this._tool;
  }

  set Tool(value: InkTool) {
    // C#：切工具（含同值设置）先结束画布内回放。
    this.EndPlayback();
    if (this._tool === value) {
      return;
    }
    const previous = this._tool;
    this._tool = value;
    // 笔/荧光笔独立宽度：配置过 ConfigurePenWidths 后，切工具换 BaseWidth（C# Tool setter）。
    if (this.configuredPenWidth !== null) {
      this.CurrentAttributes.BaseWidth = value === InkTool.Highlighter
        ? this.configuredHighlighterWidth
        : this.configuredPenWidth;
    }
    this._panPointerId = null;
    this.CancelLassoErase();
    if (previous === InkTool.Eraser && this._erasing) {
      this.endErase();
    }
    if (previous === InkTool.Select) {
      this.ClearSelection();
      this.CloneMode = false;
    }
    // 离开图形模式放弃未完成的两步体并清除粘滞（upstream:104-112）。
    if (previous === InkTool.Shape) {
      this.resetShapeState();
      this.StickyShape = false;
    }
    this.notifyToolChanged();
  }

  // 配置笔/荧光笔独立宽度（null=未配置不换宽）；当前工具立即生效。
  private configuredPenWidth: number | null = null;
  private configuredHighlighterWidth: number = 2.5;

  ConfigurePenWidths(pen: number, highlighter: number): void {
    this.configuredPenWidth = pen;
    this.configuredHighlighterWidth = highlighter;
    this.CurrentAttributes.BaseWidth = this.Tool === InkTool.Highlighter ? highlighter : pen;
  }

  get ShapeKind(): ShapeKind {
    return this._shapeKind;
  }

  set ShapeKind(value: ShapeKind) {
    // 每次菜单选择都重置两步状态并清除粘滞（MW_ShapeDrawing.cs:124-467）。
    this.resetShapeState();
    this._shapeKind = value;
    this.StickyShape = false;
  }

  SelectShape(kind: ShapeKind, sticky: boolean = false): void {
    this.ShapeKind = kind;
    this.StickyShape = sticky;
    this.Tool = InkTool.Shape;
  }

  get CloneMode(): boolean {
    return this._cloneMode;
  }

  set CloneMode(value: boolean) {
    if (this._cloneMode === value) {
      return;
    }
    this._cloneMode = value;
    this.notifySelectionChanged();
    this.invalidate();
  }

  get EraserMode(): InkEraserMode {
    return this._eraserMode;
  }

  set EraserMode(value: InkEraserMode) {
    if (this._eraserMode === value) {
      return;
    }
    this.CancelLassoErase();
    if (this._erasing) {
      this.endErase();
    }
    this._eraserMode = value;
    if (this._tool === InkTool.Eraser) {
      this.notifyToolChanged();
    }
  }

  get LiveStrokes(): InkStroke[] {
    const result: InkStroke[] = [];
    for (let i = 0; i < this._liveIds.length; i++) {
      const stroke = this._live.get(this._liveIds[i]);
      if (stroke !== undefined) {
        result.push(stroke);
      }
    }
    return result;
  }

  get ShapePreview(): InkStroke[] {
    // 对齐 LiveStrokes 的克隆封装，避免外部持有内部数组引用被意外改写。
    return this._shapePreview.slice();
  }

  /** 框选橡皮筋（视图 DIP 矩形 [left, top, right, bottom]）；空矩形返回 null。
   *  仅供渲染层读取，命中与选择口径仍由 updateMarquee/hitTestRect 负责，本 getter 不参与判断。 */
  get MarqueeBounds(): number[] | null {
    if (this._marqueeBounds.isEmpty()) {
      return null;
    }
    const left = this._marqueeBounds.Left;
    const top = this._marqueeBounds.Top;
    const right = this._marqueeBounds.Right;
    const bottom = this._marqueeBounds.Bottom;
    // NaN 矩形会因 Rect.isEmpty 的 NaN<=0=false 漏判，导致渲染层每帧全屏重绘；四分量有限性校验兜底。
    if (!Number.isFinite(left) || !Number.isFinite(top) ||
        !Number.isFinite(right) || !Number.isFinite(bottom)) {
      return null;
    }
    return [left, top, right, bottom];
  }

  /** 切换目标文档（画板页/课件页/批注）：清空历史与活动状态，避免跨文档撤销污染。 */
  BindDocument(doc: InkDocument): void {
    this.EndPlayback();
    this.FinishDotAnimations();
    this.Document = doc;
    this.History.clear();
    this.ClearSelection();
    this._live.clear();
    this._liveIds = [];
    this._lineEndpoints.clear();
    this._strokeStartTimes.clear();
    this._recentForRecognition = [];
    this._shapePreview = [];
    this._stepPending = [];
    this._dragSnapshot = null;
    this._dragTargets = null;
    this._erasedThisGesture = [];
    this._touches.clear();
  }

  /** 供渲染层读取当前正在书写的笔画（单指/首指）。 */
  get ActiveStroke(): InkStroke | null {
    let result: InkStroke | null = null;
    this._live.forEach((stroke: InkStroke) => {
      if (result === null) {
        result = stroke;
      }
    });
    return result;
  }

  get HasSelection(): boolean {
    return this.Selection.length > 0 || this.SelectedElements.length > 0;
  }

  /** 世界坐标选区 AABB；空选区返回 Rect.empty()。预览笔画按预览矩阵变换后再并集；元素按其定向框角点并集。 */
  get SelectionBounds(): Rect {
    let result = Rect.empty();
    for (let i = 0; i < this.Selection.length; i++) {
      const stroke = this.Selection[i];
      const bounds = this.IsPreviewStroke(stroke)
        ? transformBounds(stroke.bounds(), this._selectionPreview)
        : stroke.bounds();
      result = result.union(bounds);
    }
    for (let i = 0; i < this.SelectedElements.length; i++) {
      const element = this.SelectedElements[i];
      if (element.isPresent()) {
        result = result.union(this.frameWorldBounds(element.getFrame()));
      }
    }
    return result;
  }

  // ---- G2 元素框几何助手 -----------------------------------------------------

  private selectableElements(): ISelectionElement[] {
    if (this.GetSelectableElements === null) {
      return [];
    }
    return this.GetSelectableElements();
  }

  private frameWorldBounds(frame: SelectionFrameState): Rect {
    const b = frame.Bounds;
    const corners: Point2[] = [
      new Point2(b.Left, b.Top), new Point2(b.Right, b.Top),
      new Point2(b.Right, b.Bottom), new Point2(b.Left, b.Bottom)
    ];
    let left = Number.MAX_VALUE;
    let top = Number.MAX_VALUE;
    let right = -Number.MAX_VALUE;
    let bottom = -Number.MAX_VALUE;
    for (let i = 0; i < corners.length; i++) {
      const p = transformPointByMatrix(frame.Transform, corners[i].X, corners[i].Y);
      left = Math.min(left, p.X);
      top = Math.min(top, p.Y);
      right = Math.max(right, p.X);
      bottom = Math.max(bottom, p.Y);
    }
    return new Rect(left, top, right, bottom);
  }

  private frameContainsPoint(frame: SelectionFrameState, worldX: number, worldY: number): boolean {
    if (frame.Bounds.isEmpty()) {
      return false;
    }
    const local = transformPointByMatrix(invertMatrix(frame.Transform), worldX, worldY);
    return frame.Bounds.contains(local.X, local.Y);
  }

  private frameIntersectsViewRect(frame: SelectionFrameState, viewRect: Rect): boolean {
    const view = this.ViewTransform;
    const b = frame.Bounds;
    const corners: Point2[] = [
      new Point2(b.Left, b.Top), new Point2(b.Right, b.Top),
      new Point2(b.Right, b.Bottom), new Point2(b.Left, b.Bottom)
    ];
    let left = Number.MAX_VALUE;
    let top = Number.MAX_VALUE;
    let right = -Number.MAX_VALUE;
    let bottom = -Number.MAX_VALUE;
    for (let i = 0; i < corners.length; i++) {
      const world = transformPointByMatrix(frame.Transform, corners[i].X, corners[i].Y);
      const p = transformPointByMatrix(view, world.X, world.Y);
      left = Math.min(left, p.X);
      top = Math.min(top, p.Y);
      right = Math.max(right, p.X);
      bottom = Math.max(bottom, p.Y);
    }
    return viewRect.intersects(new Rect(left, top, right, bottom));
  }

  /** C# DeferSelectionPoints：Move/Rotate 拖拽与选区双指手势把写点推迟到拖拽结束。 */
  private get DeferSelectionPoints(): boolean {
    return this._selectionGesture ||
      this._activeHandle === SelectionHandle.Move ||
      this._activeHandle === SelectionHandle.Rotate;
  }

  /** 延迟拖拽期间需按预览矩阵绘制的笔画；不在延迟拖拽中时为 null。 */
  get PreviewStrokes(): InkStroke[] | null {
    return this._dragMoved && this.DeferSelectionPoints ? this._dragTargets : null;
  }

  get SelectionPreviewTransform(): Matrix3x2 {
    return this._selectionPreview;
  }

  IsPreviewStroke(stroke: InkStroke): boolean {
    return this._dragMoved && this.DeferSelectionPoints && this._previewSet.has(stroke);
  }

  ConfigureGestures(zoom: boolean, translate: boolean, rotate: boolean): void {
    this._manipulator.AllowZoom = zoom;
    this._manipulator.AllowTranslate = translate;
    this._manipulator.AllowRotation = rotate;
    this._selectionManipulator.AllowZoom = zoom;
    this._selectionManipulator.AllowTranslate = translate;
  }

  /** 测试版缩放阻尼：1 = 旧行为，0.85–0.9 有轻微回弹感。 */
  get ZoomDamping(): number {
    return this._manipulator.ZoomDamping;
  }

  set ZoomDamping(value: number) {
    this._manipulator.ZoomDamping = value;
    this._selectionManipulator.ZoomDamping = value;
  }

  /** 双指间距死区（DIP）。 */
  get ZoomDeadZone(): number {
    return this._manipulator.ZoomDeadZone;
  }

  set ZoomDeadZone(value: number) {
    this._manipulator.ZoomDeadZone = value;
    this._selectionManipulator.ZoomDeadZone = value;
  }

  // ---- 指针路由 ----------------------------------------------------------

  onPointerDown(p: PointerSample): void {
    // G9：画布内回放期间拒绝新输入（C# 语义）。
    if (this.Playback !== null) {
      return;
    }
    this.Palm.onDown(p.Id, p.Kind, p.ContactWidth, p.ContactHeight);

    if (this._tool === InkTool.Pan) {
      if (this._panPointerId === null) {
        this._panPointerId = p.Id;
        this._panStartX = p.X;
        this._panStartY = p.Y;
        this._panView = cloneMatrix(this.ViewTransform);
      }
      return;
    }

    const world = this.toWorld(p.X, p.Y);

    if (this._tool === InkTool.Eraser && this._eraserMode === InkEraserMode.Lasso) {
      // G1 套索擦：起笔开始路径（视图 DIP），抬指自动闭合提交。
      this.beginLassoErase(p);
      return;
    }

    if (this._tool === InkTool.Select) {
      if (p.Kind === PointerKind.Touch) {
        this.touchDown(p);
        if (this._selectionGesture) {
          return;
        }
        if (this._touches.size === 2 && !this.MultiTouchEnabled && this.HasSelection) {
          this.BeginSelectionGesture();
          this._selectionManipulator.AllowRotation = this.GesturesTargetSelection && !this._cloneMode;
          const pair = this.tryGetTouchPair();
          if (pair !== null) {
            const a = this.toWorld(pair[0].X, pair[0].Y);
            const b = this.toWorld(pair[1].X, pair[1].Y);
            this._selectionManipulator.begin(a.X, a.Y, b.X, b.Y);
          }
          return;
        }
      }
      if ((this._activeHandle !== SelectionHandle.None || this._isMarqueeSelecting) && p.Id !== this._selectionPointerId) {
        return;
      }
      this.beginSelectionInteraction(p, world);
      return;
    }

    if (p.Kind === PointerKind.Touch) {
      this.touchDown(p);

      // 显式选择的橡皮保持模式/尺寸，不被当成隐含手掌擦或放映翻页。
      if (this._tool === InkTool.Eraser) {
        if (!this._erasing) {
          this.beginErase(p.Id, world, this._eraserMode === InkEraserMode.Area);
        }
        return;
      }

      // MultiTouchEnabled == true 表示多指书写（手势关闭）；仅 false 时第二指取消触摸墨迹。
      if (this._touches.size === 2 && !this.MultiTouchEnabled) {
        this.cancelTouchInk();
        const pair = this.tryGetTouchPair();
        if (pair !== null) {
          // C# 视图手势以屏幕坐标 Begin/Update（screenSpace 右乘），不做 ToWorld。
          this._manipulator.begin(pair[0].X, pair[0].Y, pair[1].X, pair[1].Y);
        }
        this.invalidate();
        return;
      }

      if (this.PalmErases && this.Palm.shouldErase(p.Id, p.Kind)) {
        this.beginErase(p.Id, world, true);
        return;
      }

      // 特殊屏分档（QuadIR / TouchMultiplier / nib-vs-finger bounds）。
      if (this.Palm.Advanced !== null) {
        const decision = this.Palm.classifyContact(p.Id, p.Kind, p.ContactWidth, p.ContactHeight);
        const intent = decision.intent;
        if (intent === TouchIntent.Ignore) {
          return;
        }
        if (intent === TouchIntent.GestureOnly) {
          this._slideGestureStartX = p.X;
          this._slideGestureActive = true;
          return;
        }
        if (intent === TouchIntent.EraseByPoint && this.PalmErases) {
          this._gestureEraserRadius = decision.eraserDiameter / 2;
          this.beginErase(p.Id, world, true);
          return;
        }
        if (intent === TouchIntent.EraseByStroke && this.PalmErases) {
          this._gestureEraserRadius = 2.5;
          this.beginErase(p.Id, world, false);
          return;
        }
      }

      if (!this.Palm.shouldDraw(p.Id, p.Kind) && (this._tool === InkTool.Pen || this._tool === InkTool.Highlighter)) {
        return;
      }
    }

    if (this._tool === InkTool.Eraser) {
      if (!this._erasing) {
        this.beginErase(p.Id, world, this._eraserMode === InkEraserMode.Area);
      }
      return;
    }
    if (this._tool === InkTool.Shape) {
      // Hyperbola 第二步把 iniP 锁在中心（upstream MW_ShapeDrawing.cs:1646-1653）。
      const hyperbolaStep = this._shapeStep === 1 && isHyperbola(this._shapeKind);
      if (hyperbolaStep) {
        this._shapeDragStart.set(p.Id, new Point2(this._stepAnchor.X, this._stepAnchor.Y));
      } else {
        this._shapeDragStart.set(p.Id, new Point2(world.X, world.Y));
      }
      return;
    }
    this.startStroke(p, world);
  }

  onPointerMove(p: PointerSample): void {
    if (this._tool === InkTool.Pan) {
      if (this._panPointerId === p.Id) {
        this.ViewTransform = multiplyMatrix(
          cloneMatrix(this._panView),
          createTranslationMatrix(p.X - this._panStartX, p.Y - this._panStartY)
        );
        this.invalidate();
      }
      return;
    }
    if (this._tool === InkTool.Eraser && this._eraserMode === InkEraserMode.Lasso) {
      if (this._lassoErasing && p.Id === this._lassoPointerId) {
        this.appendLassoPoint(p.X, p.Y);
      }
      return;
    }

    const world = this.toWorld(p.X, p.Y);

    if (this._selectionGesture) {
      if (!this._touches.has(p.Id)) {
        return;
      }
      this.touchDown(p);
      const pair = this.tryGetTouchPair();
      if (pair !== null) {
        const a = this.toWorld(pair[0].X, pair[0].Y);
        const b = this.toWorld(pair[1].X, pair[1].Y);
        const pivot = this.resolvePivot((a.X + b.X) * 0.5, (a.Y + b.Y) * 0.5);
        const result: TwoFingerUpdate = this._selectionManipulator.update(
          a.X, a.Y, b.X, b.Y, identityMatrix(), pivot.X, pivot.Y
        );
        if (result.changed) {
          this.ApplySelectionGesture(result.transform);
        }
      }
      return;
    }

    if (this._isMarqueeSelecting) {
      if (p.Id === this._selectionPointerId) {
        this.updateMarquee(p.X, p.Y);
      }
      return;
    }

    if (p.Kind === PointerKind.Touch && this._touches.has(p.Id)) {
      this.touchDown(p);
      if (this._touches.size >= 2 && !this.MultiTouchEnabled && this._tool !== InkTool.Eraser) {
        const pair = this.tryGetTouchPair();
        if (pair === null) {
          return;
        }
        const a = this.toWorld(pair[0].X, pair[0].Y);
        const b = this.toWorld(pair[1].X, pair[1].Y);
        if (this.GesturesTargetSelection && this.Selection.length > 0) {
          // 手势作用于选区：世界坐标，每次 move 传入单位阵，返回单帧 delta。
          const pivot = this.resolvePivot((a.X + b.X) * 0.5, (a.Y + b.Y) * 0.5);
          const result = this._manipulator.update(a.X, a.Y, b.X, b.Y, identityMatrix(), pivot.X, pivot.Y);
          if (result.changed) {
            this.transformSelectionByGesture(result.transform);
            this.invalidate();
          }
          return;
        }
        // 视图手势：屏幕坐标 + screenSpace 右乘（transform * delta）；
        // pivot 用屏幕空间手势中心与选区中心（C# OnPointerMove 视图分支）。
        const screenAX = pair[0].X;
        const screenAY = pair[0].Y;
        const screenBX = pair[1].X;
        const screenBY = pair[1].Y;
        const bounds = this.SelectionBounds;
        const selectionCenterView = transformPointByMatrix(
          this.ViewTransform, bounds.centerX(), bounds.centerY()
        );
        const viewPivot = resolvePivot(
          this.TransformCenterOption,
          this.ViewCenter.X, this.ViewCenter.Y,
          (screenAX + screenBX) * 0.5, (screenAY + screenBY) * 0.5,
          selectionCenterView.X, selectionCenterView.Y,
          true
        );
        const result = this._manipulator.update(
          screenAX, screenAY, screenBX, screenBY,
          cloneMatrix(this.ViewTransform), viewPivot.X, viewPivot.Y, true
        );
        if (result.changed) {
          this.ViewTransform = result.transform;
          this.invalidate();
        }
        return;
      }
    }

    if (this._activeHandle !== SelectionHandle.None) {
      if (p.Id === this._selectionPointerId) {
        this.updateSelectionDrag(p.X, p.Y, p.Shift);
      }
      return;
    }

    if (this._erasing) {
      if (p.Id !== this._eraserPointerId) {
        return;
      }
      this.eraseAlong(this._lastEraserPoint, world);
      this._lastEraserPoint = world;
      return;
    }

    if (this._tool === InkTool.Shape && this._shapeDragStart.has(p.Id)) {
      const start = this._shapeDragStart.get(p.Id);
      if (start !== undefined) {
        this._shapePreview = this.generateShapePreview(start, world);
        this.invalidate();
      }
      return;
    }

    const stroke = this._live.get(p.Id);
    if (stroke !== undefined) {
      this.appendLivePoint(p);
      this.invalidate();
    }
  }

  /** L2 批量细分加点：仅书写路径追加活体点（端点/宽度结算与 onPointerMove 逐位一致），不触发出帧；
   *  宿主对 Catmull-Rom 中间点调用本方法、对终点调用 onPointerMove 统一出帧一次，控单帧耗时。 */
  appendLivePoint(p: PointerSample): void {
    const stroke = this._live.get(p.Id);
    if (stroke === undefined) {
      return;
    }
    const world = this.toWorld(p.X, p.Y);
    const endpoint = this._lineEndpoints.get(p.Id);
    if (endpoint === undefined
      || (p.X - endpoint.X) * (p.X - endpoint.X) + (p.Y - endpoint.Y) * (p.Y - endpoint.Y)
        > LINE_HOLD_RADIUS * LINE_HOLD_RADIUS) {
      this._lineEndpoints.set(p.Id, { X: p.X, Y: p.Y, Since: p.TimeMs });
    }
    const startTime = this._strokeStartTimes.get(p.Id);
    const time = startTime !== undefined ? p.TimeMs - startTime : this.pointerTime(p);
    stroke.addPoint(world.X, world.Y, p.Pressure, time, p.TiltX, p.TiltY, p.HasPressure);
    this.markGeometry(stroke);
  }

  /** 抬笔；canceled=true 时输入被取消（不做落点收拢，但已写墨迹仍提交，与 C# 一致）。 */
  onPointerUp(p: PointerSample, canceled: boolean = false): void {
    if (this._tool === InkTool.Pan) {
      this.onPointerMove(p);
      if (this._panPointerId === p.Id) {
        this._panPointerId = null;
      }
      this.invalidate();
      this.Palm.onUp(p.Id);
      return;
    }
    if (this._tool === InkTool.Eraser && this._eraserMode === InkEraserMode.Lasso) {
      if (this._lassoErasing && p.Id === this._lassoPointerId) {
        // 抬指的最终样本可能携带新位置：先补点再闭合提交。
        this.appendLassoPoint(p.X, p.Y, true);
        this.commitLassoErase();
      }
      this.Palm.onUp(p.Id);
      return;
    }
    if (this._selectionGesture) {
      this.onPointerMove(p);
      this.Palm.onUp(p.Id);
      this.removeTouchId(p.Id);
      if (this._touches.size < 2) {
        this.EndSelectionGesture();
      }
      return;
    }

    // C#：视图手势结束的那次抬指先补一个最终 move 样本，再统一失效一次。
    const viewGestureEnded = this.IsViewManipulating;
    if (viewGestureEnded) {
      this.onPointerMove(p);
    }
    this.Palm.onUp(p.Id);
    this.removeTouchId(p.Id);
    if (this._touches.size < 2) {
      this._manipulator.reset();
    }
    if (viewGestureEnded) {
      this.invalidate();
    }

    const world = this.toWorld(p.X, p.Y);

    if (this._isMarqueeSelecting) {
      if (p.Id !== this._selectionPointerId) {
        return;
      }
      this.updateMarquee(p.X, p.Y);
      this._isMarqueeSelecting = false;
      this._marqueeBounds = Rect.empty();
      this._marqueeInitialStrokes = [];
      this._marqueeInitialElements = [];
      this.notifySelectionChanged();
      this.invalidate();
      return;
    }

    // 放映中的手指横扫（原 GestureOnly 模式）；阈值 60 DIP。
    if (this._slideGestureActive) {
      this._slideGestureActive = false;
      const dx = p.X - this._slideGestureStartX;
      if (Math.abs(dx) > 60) {
        if (this.SlideFlipRequested !== null) {
          this.SlideFlipRequested(dx < 0);
        }
      }
      return;
    }

    if (this._activeHandle !== SelectionHandle.None) {
      if (p.Id !== this._selectionPointerId) {
        return;
      }
      this.updateSelectionDrag(p.X, p.Y, p.Shift);
      this.EndSelectionDrag();
      return;
    }

    if (this._erasing) {
      if (p.Id !== this._eraserPointerId) {
        return;
      }
      // 抬笔可能带来新位置（即使没有 move 包）。
      this.eraseAlong(this._lastEraserPoint, world);
      this.endErase();
      return;
    }

    if (this._tool === InkTool.Shape && this._shapeDragStart.has(p.Id)) {
      const start = this._shapeDragStart.get(p.Id);
      this._shapeDragStart.delete(p.Id);
      if (start !== undefined) {
        this.commitShapeDrag(start, world);
      }
      return;
    }

    const stroke = this._live.get(p.Id);
    if (stroke !== undefined) {
      this.removeLive(p.Id);
      // 直线识别门控：抬笔位置在端点 3px 内且距端点时刻 ≥450ms。
      const endpoint = this._lineEndpoints.get(p.Id);
      this._lineEndpoints.delete(p.Id);
      const held = endpoint !== undefined
        && (p.X - endpoint.X) * (p.X - endpoint.X) + (p.Y - endpoint.Y) * (p.Y - endpoint.Y)
          <= LINE_HOLD_RADIUS * LINE_HOLD_RADIUS
        && p.TimeMs - endpoint.Since >= LINE_HOLD_MS;
      let final = stroke;
      if (!canceled) {
        final = this.confirmTap(stroke, world, p.Kind);
      }
      if (final.Count >= 1) {
        const strokes: InkStroke[] = [final];
        this.commitStrokes(strokes, 'ink', held);
      }
      this.invalidate();
    }
  }

  /** 取消的输入不做落点收拢；已写墨迹仍按 C# 语义提交。 */
  onPointerCanceled(p: PointerSample): void {
    this.onPointerUp(p, true);
  }

  // 基线演进 ConfirmTap：屏幕空间容差内的小幅漂移收拢为单点圆点
  // （触摸 4–6px、笔 1.5–3px；超容差原样返回）。动画状态（InkDotAnimation）未建。
  private confirmTap(stroke: InkStroke, end: Point2, kind: number): InkStroke {
    if (stroke.Count === 0) {
      return stroke;
    }
    const view = this.ViewTransform;
    const first = stroke.Points[0];
    const firstScreen = transformPointByMatrix(view, first.X, first.Y);
    const endScreen = transformPointByMatrix(view, end.X, end.Y);
    const determinant = view.M11 * view.M22 - view.M12 * view.M21;
    const scale = Math.sqrt(Math.abs(determinant));
    const screenWidth = stroke.Attributes.BaseWidth * scale;
    const tolerance = kind === PointerKind.Touch
      ? Math.min(Math.max(screenWidth * 0.35, 4), 6)
      : Math.min(Math.max(screenWidth * 0.25, 1.5), 3);
    let minX = Math.min(firstScreen.X, endScreen.X);
    let minY = Math.min(firstScreen.Y, endScreen.Y);
    let maxX = Math.max(firstScreen.X, endScreen.X);
    let maxY = Math.max(firstScreen.Y, endScreen.Y);
    if (maxX - minX > tolerance * 2 || maxY - minY > tolerance * 2) {
      return stroke;
    }
    for (let i = 0; i < stroke.Count; i++) {
      const screen = transformPointByMatrix(view, stroke.Points[i].X, stroke.Points[i].Y);
      minX = Math.min(minX, screen.X);
      minY = Math.min(minY, screen.Y);
      maxX = Math.max(maxX, screen.X);
      maxY = Math.max(maxY, screen.Y);
      if (maxX - minX > tolerance * 2 || maxY - minY > tolerance * 2) {
        return stroke;
      }
    }
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const endDx = centerX - endScreen.X;
    const endDy = centerY - endScreen.Y;
    if (endDx * endDx + endDy * endDy > tolerance * tolerance) {
      return stroke;
    }
    for (let i = 0; i < stroke.Count; i++) {
      const screen = transformPointByMatrix(view, stroke.Points[i].X, stroke.Points[i].Y);
      const dx = centerX - screen.X;
      const dy = centerY - screen.Y;
      if (dx * dx + dy * dy > tolerance * tolerance) {
        return stroke;
      }
    }
    // invertMatrix 退化时返回单位阵（与 toWorld 同约定）。
    const inverse = invertMatrix(view);
    const worldCenter = transformPointByMatrix(inverse, centerX, centerY);
    const dot = new InkStroke(stroke.Attributes.clone());
    dot.restorePoints([new InkPoint(worldCenter.X, worldCenter.Y, first.Pressure, stroke.Attributes.BaseWidth, first.TimeMs)]);
    // G6：确有收拢（多点/位移/宽度差）时记录 120ms 成形动画（C# InkDotAnimation(dot, stroke)：
    // 源=最终圆点、临时=原始笔画，向最终持久宽度过渡）。
    const firstDx = first.X - worldCenter.X;
    const firstDy = first.Y - worldCenter.Y;
    const firstWidth = Math.max(0.5, first.Width);
    const targetWidth = Math.max(0.5, stroke.Attributes.BaseWidth);
    if (stroke.Count > 1 || firstDx * firstDx + firstDy * firstDy > 0.001
      || Math.abs(firstWidth - targetWidth) > 0.001) {
      this._dotAnimations.push(new InkDotAnimation(dot, stroke));
      this.DotAnimationVersion += 1;
    }
    return dot;
  }

  // ---- G9 画布内回放（C# Playback/BeginPlayback/SeekPlayback/EndPlayback） ----------------
  // display-only：源笔画与历史不动；期间拒绝新输入，切工具/换文档自动结束。

  Playback: InkPlayback | null = null;
  PlaybackChanged: VoidCallback | null = null;

  BeginPlayback(): boolean {
    this.EndPlayback();
    this.FinishDotAnimations();
    if (this._liveIds.length > 0 || this._lassoErasing || this._erasing) {
      return false;
    }
    const source: InkStroke[] = [];
    const strokes = this.Document.Strokes;
    for (let i = 0; i < strokes.length; i++) {
      if (this.Selection.length === 0 || this.Selection.indexOf(strokes[i]) >= 0) {
        source.push(strokes[i]);
      }
    }
    if (source.length === 0) {
      return false;
    }
    this.Playback = new InkPlayback(source);
    if (this.PlaybackChanged !== null) {
      this.PlaybackChanged();
    }
    this.invalidate();
    return true;
  }

  SeekPlayback(elapsedMs: number): void {
    if (this.Playback === null) {
      return;
    }
    this.Playback.seek(elapsedMs);
    this.invalidate();
  }

  EndPlayback(): void {
    if (this.Playback === null) {
      return;
    }
    this.Playback = null;
    if (this.PlaybackChanged !== null) {
      this.PlaybackChanged();
    }
    this.invalidate();
  }

  // ---- G6 落点动画状态（C# DotAnimations/AdvanceDotAnimations/FinishDotAnimations） -------

  private _dotAnimations: InkDotAnimation[] = [];
  DotAnimationVersion: number = 0;
  DotAnimationChanged: VoidCallback | null = null;

  get DotAnimations(): InkDotAnimation[] {
    return this._dotAnimations;
  }

  IsAnimatingDot(stroke: InkStroke): boolean {
    for (let i = 0; i < this._dotAnimations.length; i++) {
      if (this._dotAnimations[i].Source === stroke) {
        return true;
      }
    }
    return false;
  }

  AdvanceDotAnimations(milliseconds: number): void {
    if (this._dotAnimations.length === 0 || !Number.isFinite(milliseconds) || milliseconds <= 0) {
      return;
    }
    for (let index = this._dotAnimations.length - 1; index >= 0; index--) {
      const animation = this._dotAnimations[index];
      if (animation.advance(milliseconds)) {
        this._dotAnimations.splice(index, 1);
        this.DotAnimationVersion += 1;
      }
    }
    if (this.DotAnimationChanged !== null) {
      this.DotAnimationChanged();
    }
  }

  FinishDotAnimations(): void {
    if (this._dotAnimations.length === 0) {
      return;
    }
    this._dotAnimations = [];
    this.DotAnimationVersion += 1;
    if (this.DotAnimationChanged !== null) {
      this.DotAnimationChanged();
    }
  }

  // ---- 视图 --------------------------------------------------------------

  /** C# IsViewManipulating：平移中，或双指视图手势进行中（非选择/橡皮工具）。 */
  get IsViewManipulating(): boolean {
    return this._panPointerId !== null ||
      (!this._selectionGesture && !this.MultiTouchEnabled && this._touches.size >= 2 &&
        this._tool !== InkTool.Select && this._tool !== InkTool.Eraser);
  }

  toWorld(x: number, y: number): Point2 {
    const inverse = invertMatrix(this.ViewTransform);
    return transformPointByMatrix(inverse, x, y);
  }

  private resolvePivot(gestureX: number, gestureY: number): Point2 {
    const bounds = this.SelectionBounds;
    return resolvePivot(
      this.TransformCenterOption,
      this.ViewCenter.X, this.ViewCenter.Y,
      gestureX, gestureY,
      bounds.centerX(), bounds.centerY(),
      true
    );
  }

  // ---- 笔迹提交 ----------------------------------------------------------

  private startStroke(p: PointerSample, world: Point2): void {
    const attributes = this.CurrentAttributes.clone();
    attributes.IsHighlighter = this._tool === InkTool.Highlighter;
    const stroke = new InkStroke(attributes);
    // 模拟压感笔锋（SmoothPen..Calligraphy）用相对时间（首点 0），其余用原始事件时间。
    const taper = attributes.effectiveTaper();
    const relativeTime = taper === TaperKind.SmoothPen || taper === TaperKind.SoftPen
      || taper === TaperKind.Natural || taper === TaperKind.Calligraphy;
    if (relativeTime) {
      this._strokeStartTimes.set(p.Id, p.TimeMs);
    }
    stroke.addPoint(
      world.X,
      world.Y,
      p.Pressure,
      relativeTime ? 0 : this.pointerTime(p),
      p.TiltX,
      p.TiltY,
      p.HasPressure
    );
    this._lineEndpoints.set(p.Id, { X: p.X, Y: p.Y, Since: p.TimeMs });
    if (!this._live.has(p.Id)) {
      this._liveIds.push(p.Id);
    }
    this._live.set(p.Id, stroke);
    this.markGeometry(stroke);
    this.invalidate();
  }

  /**
   * Complete + 移入文档 + 记录历史，然后只失效一次。
   * 注意：C# OnPointerUp 在 CommitStrokes 之后还会再发一次 Invalidated —— 保留该基线行为。
   */
  private commitStrokes(strokes: InkStroke[], name: string, lineEndpointHeld: boolean = false): void {
    // D1：提交墨迹领取层号（自后向前递增）。
    let layer = this.NextLayerOrder();
    for (let i = 0; i < strokes.length; i++) {
      strokes[i].LayerOrder = layer;
      layer += 1;
    }
    for (let i = 0; i < strokes.length; i++) {
      strokes[i].complete();
    }
    this.Document.addRange(strokes);
    this.History.push(new ControllerAction(
      name,
      (): void => {
        this.Document.addRange(strokes);
      },
      (): void => {
        this.Document.removeAll(strokes);
      }
    ));
    if (this.RecognizeShapes && name === 'ink') {
      this.tryRecognize(strokes, lineEndpointHeld);
    }
    this.MarkLayerOrderDirty();
    this.invalidate();
  }

  private recognitionGroups(strokes: InkStroke[]): RecognizerPoint[][] {
    const groups: RecognizerPoint[][] = [];
    for (let i = 0; i < strokes.length; i++) {
      const points = strokes[i].Points;
      const group: RecognizerPoint[] = [];
      for (let j = 0; j < points.length; j++) {
        group.push({ X: points[j].X, Y: points[j].Y });
      }
      groups.push(group);
    }
    return groups;
  }

  private tryRecognize(committed: InkStroke[], lineEndpointHeld: boolean = false): void {
    for (let i = 0; i < committed.length; i++) {
      this._recentForRecognition.push(committed[i]);
    }
    while (this._recentForRecognition.length > 4) {
      this._recentForRecognition.shift();
    }
    const kept: InkStroke[] = [];
    for (let i = 0; i < this._recentForRecognition.length; i++) {
      const stroke = this._recentForRecognition[i];
      if (this.Document.Strokes.indexOf(stroke) >= 0) {
        kept.push(stroke);
      }
    }
    this._recentForRecognition = kept;
    if (this._recentForRecognition.length === 0) {
      return;
    }

    // C#：直线属于刚提交的笔画（单笔优先）；附近的手写绝不被合并直线拟合替换。
    const single = recognizeStrokes(this.recognitionGroups(committed));
    const result = single.kind === RecognizedShape.Line
      ? single
      : recognizeStrokes(this.recognitionGroups(this._recentForRecognition));
    if (result.kind === RecognizedShape.None) {
      return;
    }
    // 直线额外门控（C# TryRecognize）：端点按住、单笔、非荧光笔，缺一不认。
    if (result.kind === RecognizedShape.Line && (!lineEndpointHeld || committed.length !== 1
      || single.kind !== RecognizedShape.Line || committed[0].Attributes.IsHighlighter)) {
      return;
    }

    const attributes = committed[0].Attributes.clone();
    attributes.TaperKind = TaperKind.None;
    const input = attributesInput(attributes);
    let replacement: InkStroke[] = [];
    if (result.kind === RecognizedShape.Circle) {
      // C#：圆生成改为 中心+半径（CircleFromCenter），锚定识别出的圆心。
      const radius = Math.max(result.radiusX, result.radiusY);
      replacement = strokesFromSummaries(generate(
        ShapeKind.CircleFromCenter, result.centerX, result.centerY, result.centerX + radius, result.centerY, input
      ));
    } else if (result.kind === RecognizedShape.Ellipse) {
      replacement = strokesFromSummaries(generate(
        ShapeKind.Ellipse,
        result.centerX - result.radiusX, result.centerY - result.radiusY,
        result.centerX + result.radiusX, result.centerY + result.radiusY,
        input
      ));
    } else if (result.kind === RecognizedShape.Line) {
      if (result.corners.length >= 2) {
        replacement = strokesFromSummaries(generate(
          ShapeKind.Line, result.corners[0].X, result.corners[0].Y,
          result.corners[1].X, result.corners[1].Y, input
        ));
      }
    } else if (result.kind === RecognizedShape.Triangle) {
      if (result.corners.length >= 3) {
        const points: Point2[] = [];
        for (let i = 0; i < result.corners.length; i++) {
          points.push(new Point2(result.corners[i].X, result.corners[i].Y));
        }
        points.push(new Point2(result.corners[0].X, result.corners[0].Y));
        replacement = [shapeStroke(input, points)];
      }
    } else if (result.kind === RecognizedShape.Rectangle) {
      if (result.corners.length >= 1) {
        const points: Point2[] = [];
        for (let i = 0; i < result.corners.length; i++) {
          points.push(new Point2(result.corners[i].X, result.corners[i].Y));
        }
        points.push(new Point2(result.corners[0].X, result.corners[0].Y));
        // 复刻基线：矩形替换笔画不 Complete、不标记 IsRecognizedShape。
        replacement = [shapeStroke(input, points)];
      }
    } else {
      return;
    }
    if (replacement.length === 0) {
      return;
    }

    const removed = result.kind === RecognizedShape.Line
      ? committed.slice()
      : this._recentForRecognition.slice();
    // D1：识别替换笔画领取层号。
    let layer = this.NextLayerOrder();
    for (let i = 0; i < replacement.length; i++) {
      replacement[i].LayerOrder = layer;
      layer += 1;
    }
    this.Document.removeAll(removed);
    this.Document.addRange(replacement);
    this.History.push(new ControllerAction(
      'recognize',
      (): void => {
        this.Document.removeAll(removed);
        this.Document.addRange(replacement);
      },
      (): void => {
        this.Document.removeAll(replacement);
        this.Document.addRange(removed);
      }
    ));
    this._recentForRecognition = [];
    // 识别成功对外通知（UI 层弹 toast / 记录），让"墨迹转形状"对用户可见。
    if (this.onShapeRecognized !== null) {
      const kindName = result.kind === RecognizedShape.Circle ? '圆形'
        : result.kind === RecognizedShape.Ellipse ? '椭圆'
          : result.kind === RecognizedShape.Line ? '直线'
            : result.kind === RecognizedShape.Triangle ? '三角形'
              : result.kind === RecognizedShape.Rectangle ? '矩形' : '图形';
      this.onShapeRecognized(kindName);
    }
  }

  // ---- 图形工具 ----------------------------------------------------------

  /**
   * 放弃两步状态。仅长方体前面或带渐近线双曲线的 step-1 墨迹作为独立 "shape"
   * 撤销单元提交（C# ResetShapeState），避免切换工具时丢笔。
   */
  private resetShapeState(): void {
    if (this._stepPending.length > 0 &&
      (this._shapeKind === ShapeKind.Cuboid || hasHyperbolaAsymptotes(this._shapeKind))) {
      const pending = this._stepPending;
      this._stepPending = [];
      this.commitStrokes(pending, 'shape');
    }
    this._shapeStep = 0;
    this._stepK = 0;
    this._stepAnchor = new Point2(0, 0);
    this._stepSecond = new Point2(0, 0);
    this._shapePreview = [];
    this._shapeDragStart.clear();
  }

  /** WPF 图形等宽：手写笔锋不作用于图形墨迹。 */
  private shapeAttributes(): StrokeAttributes {
    const attributes = this.CurrentAttributes.clone();
    attributes.TaperKind = TaperKind.None;
    return attributes;
  }

  private generateShapePreview(start: Point2, end: Point2): InkStroke[] {
    if (this._shapeStep === 1) {
      if (this._shapeKind === ShapeKind.Cuboid) {
        // C#：第二次拖拽给出带符号深度向量；预览即完整实体（不再拼接 step-1 pending）。
        return strokesFromSummaries(generateCuboid(
          this._stepAnchor.X, this._stepAnchor.Y, this._stepSecond.X, this._stepSecond.Y,
          end.X - start.X, end.Y - start.Y, attributesInput(this.shapeAttributes())
        ));
      }
      if (isHyperbola(this._shapeKind)) {
        const preview: InkStroke[] = this._stepPending.slice();
        const generated = strokesFromSummaries(generateHyperbolaBranches(
          this._stepAnchor.X, this._stepAnchor.Y, this._stepK, end.X, end.Y,
          hasHyperbolaFoci(this._shapeKind), attributesInput(this.shapeAttributes())
        ));
        for (let i = 0; i < generated.length; i++) {
          preview.push(generated[i]);
        }
        return preview;
      }
    }
    return strokesFromSummaries(generate(
      this._shapeKind, start.X, start.Y, end.X, end.Y, attributesInput(this.shapeAttributes())
    ));
  }

  private commitShapeDrag(start: Point2, end: Point2): void {
    const kind = this._shapeKind;
    const attributes = this.shapeAttributes();
    const input = attributesInput(attributes);

    if (kind === ShapeKind.Cuboid) {
      if (this._shapeStep === 0) {
        // 退化拖拽（宽或高 <1）直接放弃，不进入第二步。
        if (Math.abs(end.X - start.X) < 1 || Math.abs(end.Y - start.Y) < 1) {
          return;
        }
        // 第一步：前面；释放时按 min/max 归一化角点（upstream:1519-1530）。
        this._stepPending = strokesFromSummaries(generate(kind, start.X, start.Y, end.X, end.Y, input));
        this._stepAnchor = new Point2(Math.min(start.X, end.X), Math.min(start.Y, end.Y));
        this._stepSecond = new Point2(Math.max(start.X, end.X), Math.max(start.Y, end.Y));
        this._shapeStep = 1;
        this._shapePreview = this._stepPending.slice();
        this.invalidate();
        return; // 留在图形模式等待深度拖拽
      }
      // 第二步：带符号深度向量决定对面位置；全部棱一个撤销单元。
      const offsetX = end.X - start.X;
      const offsetY = end.Y - start.Y;
      if (offsetX * offsetX + offsetY * offsetY < 9) {
        this.invalidate();
        return;
      }
      const solid: InkStroke[] = strokesFromSummaries(generateCuboid(
        this._stepAnchor.X, this._stepAnchor.Y, this._stepSecond.X, this._stepSecond.Y,
        offsetX, offsetY, input
      ));
      this._stepPending = [];
      this._shapeStep = 0;
      this._shapePreview = [];
      this.commitStrokes(solid, 'shape');
      if (!this.StickyShape) {
        this.Tool = InkTool.Pen; // 基线演进：两步体完成后尊重 StickyShape（C# 934）
      }
      return;
    }

    if (isHyperbola(kind)) {
      if (this._shapeStep === 0) {
        // 第一步：虚线渐近线锁定 k（upstream:894-902,1550-1555）。
        const asymptotes = strokesFromSummaries(generate(kind, start.X, start.Y, end.X, end.Y, input));
        if (asymptotes.length === 0) {
          this.invalidate(); // 退化拖拽：可重试
          return;
        }
        this._stepPending = asymptotes;
        this._stepK = Math.abs((end.Y - start.Y) / (end.X - start.X));
        this._stepAnchor = new Point2(start.X, start.Y);
        this._shapeStep = 1;
        this._shapePreview = this._stepPending.slice();
        this.invalidate();
        return;
      }
      const branches = strokesFromSummaries(generateHyperbolaBranches(
        this._stepAnchor.X, this._stepAnchor.Y, this._stepK, end.X, end.Y,
        hasHyperbolaFoci(kind), input
      ));
      if (branches.length === 0) {
        this.invalidate();
        return;
      }
      const kept = this._stepPending;
      this._stepPending = [];
      this._shapeStep = 0;
      this._shapePreview = [];
      // C#：是否保留第一步渐近线由 kind 决定（HasHyperbolaAsymptotes），不再询问。
      let hyperbola: InkStroke[] = branches;
      if (hasHyperbolaAsymptotes(kind)) {
        hyperbola = kept.slice();
        for (let i = 0; i < branches.length; i++) {
          hyperbola.push(branches[i]);
        }
      }
      if (hyperbola.length > 0) {
        this.commitStrokes(hyperbola, 'shape');
      }
      if (!this.StickyShape) {
        this.Tool = InkTool.Pen; // 基线演进：尊重 StickyShape（C# 962）
      }
      return;
    }

    const shapes = strokesFromSummaries(generate(kind, start.X, start.Y, end.X, end.Y, input));
    this._shapePreview = [];
    if (shapes.length > 0) {
      this.commitStrokes(shapes, 'shape');
    }
    this.invalidate();
    if (shapes.length > 0 && !this.StickyShape) {
      this.Tool = InkTool.Pen; // upstream:1502-1518；退化拖拽（空结果）留在图形模式（C# 971）
    }
  }

  // ---- 擦除 --------------------------------------------------------------

  private beginErase(pointerId: number, world: Point2, partialStroke: boolean): void {
    this._eraserPointerId = pointerId;
    this._erasing = true;
    this._partialEraseGesture = partialStroke;
    this._lastEraserPoint = new Point2(world.X, world.Y);
    this._erasedThisGesture = [];
    if (partialStroke) {
      this._eraseBeforeSnapshot = this.cloneStrokes(this.Document.Strokes);
    } else {
      this._eraseBeforeSnapshot = null;
    }
    this.eraseAlong(world, world);
  }

  private eraseAlong(from: Point2, to: Point2): void {
    const radius = this._gestureEraserRadius === null ? this.EraserRadius : this._gestureEraserRadius;
    // 沿扫掠采样，避免快速划动跳过笔迹。
    const dx = to.X - from.X;
    const dy = to.Y - from.Y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const stepLength = Math.max(4, radius * 0.5);
    const steps = Math.max(1, Math.trunc(dist / stepLength));
    let any = false;
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      const px = from.X + dx * t;
      const py = from.Y + dy * t;
      if (this._partialEraseGesture) {
        const currentStrokes = this.Document.Strokes.slice();
        for (let s = 0; s < currentStrokes.length; s++) {
          const stroke = currentStrokes[s];
          const outcome: EraseOutcome = eraseDisc(stroke, px, py, radius);
          if (!outcome.Touched) {
            continue;
          }
          this.Document.replace(stroke, outcome.Fragments);
          any = true;
        }
      } else {
        const hits = this.Document.eraseAt(px, py, radius);
        if (hits.length > 0) {
          for (let h = 0; h < hits.length; h++) {
            this._erasedThisGesture.push(hits[h]);
          }
          any = true;
        }
      }
    }
    if (any) {
      this.invalidate();
    }
  }

  private endErase(): void {
    this._erasing = false;
    this._gestureEraserRadius = null;
    if (this._partialEraseGesture) {
      const before = this._eraseBeforeSnapshot === null ? [] : this._eraseBeforeSnapshot;
      const after = this.cloneStrokes(this.Document.Strokes);
      if (before.length !== after.length || !sameStrokeSnapshot(before, after)) {
        this.History.push(new ControllerAction(
          'area erase',
          (): void => {
            this.restoreDocument(after);
          },
          (): void => {
            this.restoreDocument(before);
          }
        ));
      }
      this._eraseBeforeSnapshot = null;
      this._partialEraseGesture = false;
    } else if (this._erasedThisGesture.length > 0) {
      const removed = this._erasedThisGesture.slice();
      this.History.push(new ControllerAction(
        'erase',
        (): void => {
          this.Document.removeAll(removed);
        },
        (): void => {
          this.Document.addRange(removed);
        }
      ));
      this._erasedThisGesture = [];
    }
    this.invalidate();
  }

  private restoreDocument(strokes: InkStroke[]): void {
    this.Document.clear();
    this.Document.addRange(this.cloneStrokes(strokes));
    this.Selection = [];
    this._frameStrokes = [];
    this._frameVersions = [];
    this.notifySelectionChanged();
    this.invalidate();
  }

  private cloneStrokes(strokes: InkStroke[]): InkStroke[] {
    const result: InkStroke[] = [];
    for (let i = 0; i < strokes.length; i++) {
      result.push(strokes[i].clone());
    }
    return result;
  }

  // ---- 选区 --------------------------------------------------------------

  ClearSelection(): void {
    if (this._selectionGesture) {
      this.EndSelectionGesture();
    } else if (this._activeHandle !== SelectionHandle.None) {
      this.EndSelectionDrag();
    }
    this.Selection = [];
    this.SelectedElements = [];
    this._isMarqueeSelecting = false;
    this._marqueeBounds = Rect.empty();
    this._marqueeInitialStrokes = [];
    this._marqueeInitialElements = [];
    this._touches.clear();
    this._touchOrder = [];
    this.notifySelectionChanged();
    this.invalidate();
  }

  SelectAll(): void {
    this.Tool = InkTool.Select;
    this.ClearSelection();
    for (let i = 0; i < this.Document.Strokes.length; i++) {
      this.Selection.push(this.Document.Strokes[i]);
    }
    const elements = this.selectableElements();
    for (let i = 0; i < elements.length; i++) {
      if (elements[i].isPresent()) {
        this.SelectedElements.push(elements[i]);
      }
    }
    this.notifySelectionChanged();
    this.invalidate();
  }

  private beginSelectionInteraction(p: PointerSample, world: Point2): void {
    const viewPointX = p.X;
    const viewPointY = p.Y;
    this._selectionPointerId = p.Id;
    let handle = this.HasSelection && !p.Control
      ? frameHitTest(this.selectionFrame(), viewPointX, viewPointY, this.ViewTransform)
      : SelectionHandle.None;

    if (handle === SelectionHandle.None) {
      const scale = Math.sqrt(Math.abs(determinant(this.ViewTransform)));
      const hitRadius = 6 / Math.max(0.1, scale);
      // D1：z 序统一命中（自顶向下，元素框与墨迹带宽混合；C# HitTestDrawingObject）。
      const hit = this.hitTestDrawingObject(world.X, world.Y);
      const hitElement = hit !== null && hit.Element !== null ? hit.Element : null;
      const hitStroke = hit !== null && hit.Stroke !== null ? hit.Stroke : null;
      const additive = p.Control || p.Shift;
      if (hitElement === null && hitStroke === null) {
        this._marqueeInitialStrokes = additive ? this.Selection.slice() : [];
        this._marqueeInitialElements = additive ? this.SelectedElements.slice() : [];
        if (!additive) {
          this.Selection = [];
          this.SelectedElements = [];
        }
        this._isMarqueeSelecting = true;
        this._dragFromViewX = viewPointX;
        this._dragFromViewY = viewPointY;
        this._marqueeBounds = Rect.empty();
        this.notifySelectionChanged();
        this.invalidate();
        return;
      }
      if (!additive) {
        this.Selection = [];
        this.SelectedElements = [];
      }
      if (hitElement !== null) {
        if (p.Control && this.SelectedElements.indexOf(hitElement) >= 0) {
          this.SelectedElements.splice(this.SelectedElements.indexOf(hitElement), 1);
        } else if (this.SelectedElements.indexOf(hitElement) < 0) {
          this.SelectedElements.push(hitElement);
        }
        this.notifySelectionChanged();
        if (p.Control || !this.HasSelection) {
          this.invalidate();
          return;
        }
        // 元素命中进入 Move 拖拽（元素随步进 delta 变换）。
        this.beginElementAwareDrag(handle, viewPointX, viewPointY);
        this._activeHandle = SelectionHandle.Move;
        return;
      }
      if (p.Control && this.Selection.indexOf(hitStroke) >= 0) {
        this.Selection.splice(this.Selection.indexOf(hitStroke), 1);
      } else if (this.Selection.indexOf(hitStroke) < 0) {
        this.Selection.push(hitStroke);
      }
      this.notifySelectionChanged();
      if (p.Control || !this.HasSelection) {
        this.invalidate();
        return;
      }
      handle = SelectionHandle.Move;
    }

    this._activeHandle = handle;
    this.beginElementAwareDrag(handle, viewPointX, viewPointY);
    this.invalidate();
  }

  // 选区拖拽起点公共初始化（含 G2 元素快照与累计矩阵复位）。
  private beginElementAwareDrag(handle: SelectionHandle, viewPointX: number, viewPointY: number): void {
    this._dragFromViewX = viewPointX;
    this._dragFromViewY = viewPointY;
    this._viewAtDragStart = cloneMatrix(this.ViewTransform);
    this._dragFrame = this.selectionFrame();
    this._dragTargets = this.Selection.slice();
    this._dragElements = this.SelectedElements.slice();
    this._dragElementSnapshots = [];
    for (let i = 0; i < this._dragElements.length; i++) {
      this._dragElementSnapshots.push(this._dragElements[i].capture());
    }
    this._dragElementMatrix = identityMatrix();
    this._cloneDrag = false;
    this._dragMoved = false;
    this._selectionPreview = identityMatrix();
    this._previewSet.clear();
    this._dragSnapshot = this.cloneStrokes(this._dragTargets);
  }

  private updateSelectionDrag(viewPointX: number, viewPointY: number, constrain: boolean): void {
    if (this._dragSnapshot === null || this._dragTargets === null ||
      this._dragTargets.length !== this._dragSnapshot.length) {
      return;
    }
    if (!this._dragMoved && distanceSquared(viewPointX, viewPointY, this._dragFromViewX, this._dragFromViewY) < 9) {
      return;
    }
    this._dragMoved = true;

    if (this.CloneMode && this._activeHandle === SelectionHandle.Move && !this._cloneDrag) {
      const clones: InkStroke[] = [];
      for (let i = 0; i < this.Selection.length; i++) {
        clones.push(this.cloneStrokeWithNewId(this.Selection[i]));
      }
      this.Document.addRange(clones);
      // G2：克隆拖拽同时复制元素（共享字节、新 Id、在场）。
      const elementClones: ISelectionElement[] = [];
      for (let i = 0; i < this._dragElements.length; i++) {
        elementClones.push(this._dragElements[i].duplicate());
      }
      // D1 SetCloneLayerOrder：副本按源对象的 z 序领取连续新层号。
      this.setCloneLayerOrder(this.Selection.slice(), clones, this._dragElements.slice(), elementClones);
      this._dragElements = elementClones;
      this._dragElementSnapshots = [];
      for (let i = 0; i < elementClones.length; i++) {
        this._dragElementSnapshots.push(elementClones[i].capture());
      }
      this._dragTargets = clones;
      this._cloneDrag = true;
    }

    const drag = frameDrag(
      this._dragFrame, this._activeHandle,
      this._dragFromViewX, this._dragFromViewY, viewPointX, viewPointY,
      this._viewAtDragStart, constrain
    );
    // 绝对矩阵（相对拖拽起点快照），长拖拽不累计舍入误差。
    this._selectionPreview = drag.Delta;
    // G2：元素随拖拽实时步进变换（步进 = 新绝对 × 逆(已应用)；元素无延迟写点）。
    if (this._dragElements.length > 0) {
      const previous = this._dragElementMatrix === null ? identityMatrix() : this._dragElementMatrix;
      const step = multiplyMatrix(drag.Delta, invertMatrix(previous));
      for (let i = 0; i < this._dragElements.length; i++) {
        this._dragElements[i].transform(step);
      }
      this._dragElementMatrix = cloneMatrix(drag.Delta);
    }
    if (this._previewSet.size === 0) {
      this._dragTargets.forEach((stroke: InkStroke) => {
        this._previewSet.add(stroke);
      });
    }
    if (!this.DeferSelectionPoints) {
      applySnapshot(this._dragTargets, this._dragSnapshot);
      for (let i = 0; i < this._dragTargets.length; i++) {
        transformStroke(this._dragTargets[i], drag.Delta, true);
        this.markGeometry(this._dragTargets[i]);
      }
      this.Document.touch();
    }
    this.invalidate();
  }

  private EndSelectionDrag(gesture: boolean = false): void {
    const targets = this._dragTargets === null ? this.Selection.slice() : this._dragTargets;
    const elements = this._dragElements;
    const beforeElements = this._dragElementSnapshots;
    const before = this._dragSnapshot;
    const cloneDrag = this._cloneDrag;
    const moved = this._dragMoved;
    const beforeFrame = this._dragFrame;
    const afterFrame = this.selectionFrame();
    const defer = this.DeferSelectionPoints;
    // 延迟写点的拖拽（Move/Rotate/手势）在结束时一次性应用预览矩阵；元素已在拖拽中实时变换。
    if (moved && (defer || gesture)) {
      for (let i = 0; i < targets.length; i++) {
        transformStroke(targets[i], this._selectionPreview, true);
        this.markGeometry(targets[i]);
      }
    }
    this._activeHandle = SelectionHandle.None;
    this._dragSnapshot = null;
    this._dragTargets = null;
    this._dragElements = [];
    this._dragElementSnapshots = [];
    this._dragElementMatrix = null;
    this._cloneDrag = false;
    this._dragMoved = false;
    this._selectionPreview = identityMatrix();
    this._previewSet.clear();
    if (moved) {
      if (!cloneDrag) {
        this.rememberFrame(afterFrame);
      }
      this.Document.touch();
    }

    if (cloneDrag && moved) {
      // 一个撤销单元：撤销移除副本（元素离场），重做放回落点（元素按逆序在场保 z 序）。
      const clones = targets;
      const elementClones = elements;
      this.History.push(new ControllerAction(
        'clone selection',
        (): void => {
          this.Document.addRange(clones);
          for (let i = elementClones.length - 1; i >= 0; i--) {
            elementClones[i].setPresent(true);
          }
          this.invalidate();
        },
        (): void => {
          this.Document.removeAll(clones);
          for (let i = 0; i < elementClones.length; i++) {
            elementClones[i].setPresent(false);
          }
          this.invalidate();
        }
      ));
    } else if (moved && before !== null && before.length === targets.length
      && beforeElements.length === elements.length) {
      const after = this.cloneStrokes(targets);
      const afterElements: ElementSnapshot[] = [];
      for (let i = 0; i < elements.length; i++) {
        afterElements.push(elements[i].capture());
      }
      this.History.push(new ControllerAction(
        'transform selection',
        (): void => {
          this.applySnapshotState(targets, after);
          for (let i = 0; i < elements.length; i++) {
            elements[i].restore(afterElements[i]);
          }
          this.restoreSelectionFrame(targets, afterFrame);
          this.Document.touch();
          this.notifySelectionChanged();
          this.invalidate();
        },
        (): void => {
          this.applySnapshotState(targets, before);
          for (let i = 0; i < elements.length; i++) {
            elements[i].restore(beforeElements[i]);
          }
          this.restoreSelectionFrame(targets, beforeFrame);
          this.Document.touch();
          this.notifySelectionChanged();
          this.invalidate();
        }
      ));
    }
    this.notifySelectionChanged();
    this.invalidate();
  }

  private updateMarquee(viewPointX: number, viewPointY: number): void {
    this._marqueeBounds = new Rect(
      Math.min(this._dragFromViewX, viewPointX),
      Math.min(this._dragFromViewY, viewPointY),
      Math.max(this._dragFromViewX, viewPointX),
      Math.max(this._dragFromViewY, viewPointY)
    );
    if (distanceSquared(this._dragFromViewX, this._dragFromViewY, viewPointX, viewPointY) >= 9) {
      this.Selection = this._marqueeInitialStrokes.slice();
      this.SelectedElements = this._marqueeInitialElements.slice();
      const hits = this.Document.hitTestRect(
        this._marqueeBounds.Left, this._marqueeBounds.Top,
        this._marqueeBounds.Right, this._marqueeBounds.Bottom,
        this.ViewTransform
      );
      for (let i = 0; i < hits.length; i++) {
        if (this.Selection.indexOf(hits[i]) < 0) {
          this.Selection.push(hits[i]);
        }
      }
      // G2：框选矩形（视图空间）与元素定向框相交则入选。
      const elements = this.selectableElements();
      for (let i = 0; i < elements.length; i++) {
        const element = elements[i];
        if (element.isPresent() && this.SelectedElements.indexOf(element) < 0
          && this.frameIntersectsViewRect(element.getFrame(), this._marqueeBounds)) {
          this.SelectedElements.push(element);
        }
      }
      this.notifySelectionChanged();
    }
    this.invalidate();
  }

  BeginSelectionGesture(): void {
    if (this._selectionGesture || !this.HasSelection) {
      return;
    }
    if (this._activeHandle !== SelectionHandle.None) {
      this.EndSelectionDrag();
    }
    this._isMarqueeSelecting = false;
    this._marqueeBounds = Rect.empty();
    this._marqueeInitialStrokes = [];
    this._marqueeInitialElements = [];
    this._dragTargets = this.Selection.slice();
    this._dragSnapshot = this.cloneStrokes(this.Selection);
    // G2：手势同时覆盖元素（快照 + 复位累计矩阵；元素随每帧 delta 实时变换）。
    this._dragElements = this.SelectedElements.slice();
    this._dragElementSnapshots = [];
    for (let i = 0; i < this._dragElements.length; i++) {
      this._dragElementSnapshots.push(this._dragElements[i].capture());
    }
    this._dragElementMatrix = identityMatrix();
    this._dragFrame = this.selectionFrame();
    this._cloneDrag = false;
    this._dragMoved = false;
    this._selectionPreview = identityMatrix();
    this._previewSet.clear();
    this._selectionGesture = true;
  }

  ApplySelectionGesture(delta: Matrix3x2): void {
    if (matrixEqualsValue(delta, identityMatrix()) || this._dragTargets === null) {
      return;
    }
    if (this.CloneMode && !this._cloneDrag) {
      const clones: InkStroke[] = [];
      for (let i = 0; i < this.Selection.length; i++) {
        clones.push(this.cloneStrokeWithNewId(this.Selection[i]));
      }
      this.Document.addRange(clones);
      const elementClones: ISelectionElement[] = [];
      for (let i = 0; i < this._dragElements.length; i++) {
        elementClones.push(this._dragElements[i].duplicate());
      }
      // D1 SetCloneLayerOrder（C# ApplySelectionGesture 克隆路径）。
      this.setCloneLayerOrder(this.Selection.slice(), clones, this._dragElements.slice(), elementClones);
      this._dragElements = elementClones;
      this._dragElementSnapshots = [];
      for (let i = 0; i < elementClones.length; i++) {
        this._dragElementSnapshots.push(elementClones[i].capture());
      }
      this._dragTargets = clones;
      this._cloneDrag = true;
    }
    this._dragMoved = true;
    // C#：手势期间只累计预览矩阵（_selectionPreview *= delta），落指结束才写点。
    this._selectionPreview = multiplyMatrix(this._selectionPreview, delta);
    if (this._previewSet.size === 0) {
      this._dragTargets.forEach((stroke: InkStroke) => {
        this._previewSet.add(stroke);
      });
    }
    // G2：元素随每帧 delta 实时变换（无延迟写点）。
    for (let i = 0; i < this._dragElements.length; i++) {
      this._dragElements[i].transform(delta);
    }
    this.invalidate();
  }

  EndSelectionGesture(): void {
    if (!this._selectionGesture) {
      return;
    }
    this._selectionGesture = false;
    this._selectionManipulator.reset();
    this.EndSelectionDrag(true);
  }

  /** 将手势矩阵应用到选区，并记录一个可撤销步骤（基线：每次 move 一单元）。 */
  private transformSelectionByGesture(worldDelta: Matrix3x2): void {
    const targets = this.Selection.slice();
    const before = this.cloneStrokes(targets);
    for (let i = 0; i < targets.length; i++) {
      transformStroke(targets[i], worldDelta, true);
      this.markGeometry(targets[i]);
    }
    const after = this.cloneStrokes(targets);
    this.History.push(new ControllerAction(
      'gesture selection',
      (): void => {
        this.applySnapshotState(targets, after);
        this.Document.touch();
        this.invalidate();
      },
      (): void => {
        this.applySnapshotState(targets, before);
        this.Document.touch();
        this.invalidate();
      }
    ));
    this.Document.touch();
  }

  DeleteSelection(): void {
    if (this._selectionGesture) {
      this.EndSelectionGesture();
    } else if (this._activeHandle !== SelectionHandle.None) {
      this.EndSelectionDrag();
    }
    if (!this.HasSelection) {
      return;
    }
    const removed = this.Selection.slice();
    const elements = this.SelectedElements.slice();
    this.Document.removeAll(removed);
    for (let i = 0; i < elements.length; i++) {
      elements[i].setPresent(false);
    }
    this.History.push(new ControllerAction(
      'delete',
      (): void => {
        this.Document.removeAll(removed);
        for (let i = 0; i < elements.length; i++) {
          elements[i].setPresent(false);
        }
      },
      (): void => {
        this.Document.addRange(removed);
        // 逆序在场恢复原 z 序（C# DeleteSelection 恢复序）；失效由 Undo/Redo 外层统一一次。
        for (let i = elements.length - 1; i >= 0; i--) {
          elements[i].setPresent(true);
        }
      }
    ));
    this.MarkLayerOrderDirty();
    this.ClearSelection();
  }

  /** 直接变换选区（不记历史，调用方自行管理撤销）。 */
  TransformSelection(m: Matrix3x2): void {
    if (this.Selection.length === 0) {
      return;
    }
    for (let i = 0; i < this.Selection.length; i++) {
      transformStroke(this.Selection[i], m, true);
      this.markGeometry(this.Selection[i]);
    }
    this.invalidate();
  }

  /** 供向量/宿主读取的选区框快照。 */
  selectionFrameSummary(): ControllerFrameSummary {
    const frame = this.selectionFrame();
    return {
      Bounds: [frame.Bounds.Left, frame.Bounds.Top, frame.Bounds.Right, frame.Bounds.Bottom],
      Transform: matrixToArray(frame.Transform)
    };
  }

  private selectionFrame(): OrientedFrame {
    // C# SelectionFrame：已移动的非克隆拖拽期间，帧 = 拖拽起点帧 * 预览矩阵。
    if (this._dragMoved && !this._cloneDrag) {
      return new OrientedFrame(
        cloneRect(this._dragFrame.Bounds),
        multiplyMatrix(cloneMatrix(this._dragFrame.Transform), this._selectionPreview)
      );
    }
    let valid = this._frameStrokes.length === this.Selection.length;
    for (let i = 0; valid && i < this.Selection.length; i++) {
      if (this._frameStrokes[i] !== this.Selection[i] ||
        this._frameVersions[i] !== this.geometryVersion(this.Selection[i])) {
        valid = false;
      }
    }
    if (!valid) {
      let frame: OrientedFrame;
      if (this.Selection.length === 1) {
        frame = this.singleStrokeFrame(this.Selection[0]);
      } else {
        frame = new OrientedFrame(this.SelectionBounds, identityMatrix());
      }
      this.rememberFrame(frame);
    }
    return this._cachedFrame;
  }

  private singleStrokeFrame(stroke: InkStroke): OrientedFrame {
    const data = stroke.exportObjectFrame();
    if (data !== null) {
      return new OrientedFrame(
        new Rect(data[0], data[1], data[2], data[3]),
        matrixFromArray([data[4], data[5], data[6], data[7], data[8], data[9]])
      );
    }
    return new OrientedFrame(stroke.bounds(), identityMatrix());
  }

  private rememberFrame(frame: OrientedFrame): void {
    this._cachedFrame = frame;
    this._frameStrokes = this.Selection.slice();
    this._frameVersions = [];
    for (let i = 0; i < this.Selection.length; i++) {
      this._frameVersions.push(this.geometryVersion(this.Selection[i]));
    }
  }

  /** C# RestoreSelectionFrame：选区成员未变才恢复帧缓存，否则清空缓存。 */
  private restoreSelectionFrame(strokes: InkStroke[], frame: OrientedFrame): void {
    let same = this.Selection.length === strokes.length;
    for (let i = 0; same && i < strokes.length; i++) {
      if (this.Selection[i] !== strokes[i]) {
        same = false;
      }
    }
    if (same) {
      this.rememberFrame(frame);
    } else {
      this._frameStrokes = [];
      this._frameVersions = [];
    }
  }

  private geometryVersion(stroke: InkStroke): number {
    const version = this._geometryVersions.get(stroke);
    return version === undefined ? 0 : version;
  }

  private markGeometry(stroke: InkStroke): void {
    this._geometryVersions.set(stroke, this.geometryVersion(stroke) + 1);
  }

  /** restorePoints 改变了几何：恢复快照并让选区框缓存失效。 */
  private applySnapshotState(targets: InkStroke[], snapshot: InkStroke[]): void {
    applySnapshot(targets, snapshot);
    for (let i = 0; i < targets.length; i++) {
      this.markGeometry(targets[i]);
    }
  }

  private cloneStrokeWithNewId(stroke: InkStroke): InkStroke {
    const copy = stroke.clone();
    this._cloneSerial += 1;
    copy.Id = 'clone-' + this._cloneSerial;
    return copy;
  }

  // ---- 命令 --------------------------------------------------------------

  Undo(): void {
    this.CancelLassoErase();
    if (this.History.undo()) {
      this.pruneSelection();
      this.MarkLayerOrderDirty();
      this.invalidate();
    }
  }

  Redo(): void {
    this.CancelLassoErase();
    if (this.History.redo()) {
      this.pruneSelection();
      this.MarkLayerOrderDirty();
      this.invalidate();
    }
  }

  private pruneSelection(): void {
    const kept: InkStroke[] = [];
    let removed = 0;
    for (let i = 0; i < this.Selection.length; i++) {
      if (this.Document.Strokes.indexOf(this.Selection[i]) >= 0) {
        kept.push(this.Selection[i]);
      } else {
        removed += 1;
      }
    }
    this.Selection = kept;
    const keptElements: ISelectionElement[] = [];
    for (let i = 0; i < this.SelectedElements.length; i++) {
      if (this.SelectedElements[i].isPresent()) {
        keptElements.push(this.SelectedElements[i]);
      } else {
        removed += 1;
      }
    }
    this.SelectedElements = keptElements;
    if (removed > 0) {
      this.notifySelectionChanged();
    }
  }

  // ---- D1 层排列系统（C# InkLayers partial） --------------------------------
  // 墨迹+元素统一自后向前 z 序；排列命令单撤销单元；ShapeSource 同组整体移动。

  private _drawingObjects: DrawingObject[] = [];
  private _drawingOrderDirty: boolean = true;
  LayerVersion: number = 0;
  LayersChanged: VoidCallback | null = null;

  get DrawingObjects(): DrawingObject[] {
    if (this._drawingOrderDirty) {
      const objects: DrawingObject[] = [];
      const elements = this.selectableElements();
      for (let i = 0; i < elements.length; i++) {
        if (elements[i].isPresent()) {
          objects.push(new DrawingObject(null, elements[i]));
        }
      }
      const strokes = this.Document.Strokes;
      for (let i = 0; i < strokes.length; i++) {
        objects.push(new DrawingObject(strokes[i], null));
      }
      this._drawingObjects = sortDrawingObjects(objects);
      this._drawingOrderDirty = false;
    }
    return this._drawingObjects;
  }

  /** 文档/元素变动后由宿主或内部路径调用：置脏 + LayerVersion。 */
  MarkLayerOrderDirty(): void {
    this._drawingOrderDirty = true;
    this.LayerVersion += 1;
    if (this.LayersChanged !== null) {
      this.LayersChanged();
    }
  }

  NextLayerOrder(): number {
    const objects = this.DrawingObjects;
    const orders: (number | null)[] = [];
    for (let i = 0; i < objects.length; i++) {
      orders.push(objects[i].LayerOrder);
    }
    const next = nextLayerOrder(orders);
    // 全体重排（存在 null 或接近溢出）时把结果写回对象。
    if (objects.length > 0 && next === objects.length) {
      for (let i = 0; i < objects.length; i++) {
        objects[i].LayerOrder = i;
      }
    }
    return next;
  }

  private isSelectedObject(item: DrawingObject): boolean {
    if (item.Stroke !== null) {
      return this.Selection.indexOf(item.Stroke) >= 0;
    }
    return item.Element !== null && this.SelectedElements.indexOf(item.Element) >= 0;
  }

  /** 自顶向下 z 序命中：元素框含点，或墨迹带宽内（半径 = 6/缩放 + 半笔宽）。 */
  private hitTestDrawingObject(worldX: number, worldY: number): DrawingObject | null {
    const scale = Math.sqrt(Math.abs(determinant(this.ViewTransform)));
    const radius = 6 / Math.max(0.1, scale);
    const objects = this.DrawingObjects;
    for (let i = objects.length - 1; i >= 0; i--) {
      const item = objects[i];
      if (item.Element !== null) {
        const frame = item.Element.getFrame();
        const local = transformPointByMatrix(invertMatrix(frame.Transform), worldX, worldY);
        if (frame.Bounds.contains(local.X, local.Y)) {
          return item;
        }
      }
      if (item.Stroke !== null) {
        const stroke = item.Stroke;
        const bounds = stroke.bounds().inflate(radius);
        if (bounds.contains(worldX, worldY)
          && stroke.distanceTo(worldX, worldY) <= radius + stroke.Attributes.BaseWidth / 2) {
          return item;
        }
      }
    }
    return null;
  }

  CanArrangeSelection(action: number): boolean {
    if (!this.HasSelection || action < 0 || action > 3) {
      return false;
    }
    const objects = this.DrawingObjects;
    let sawSelected = false;
    let sawOther = false;
    const forward = action === LayerAction.BringToFront || action === LayerAction.MoveForward;
    for (let i = 0; i < objects.length; i++) {
      const selected = this.isSelectedObject(objects[i]);
      if (forward && !selected && sawSelected) {
        return true;
      }
      if (!forward && selected && sawOther) {
        return true;
      }
      sawSelected = sawSelected || selected;
      sawOther = sawOther || !selected;
    }
    return false;
  }

  // D1 SetCloneLayerOrder：副本按源对象在 z 序中的出现顺序领取连续新层号（C# 语义）。
  private setCloneLayerOrder(
    sourceStrokes: InkStroke[],
    strokeCopies: InkStroke[],
    sourceElements: ISelectionElement[],
    elementCopies: ISelectionElement[]
  ): void {
    const next = this.NextLayerOrder();
    const copyOf = new Map<string, DrawingObject>();
    for (let i = 0; i < sourceStrokes.length && i < strokeCopies.length; i++) {
      copyOf.set(sourceStrokes[i].Id, new DrawingObject(strokeCopies[i], null));
    }
    for (let i = 0; i < sourceElements.length && i < elementCopies.length; i++) {
      copyOf.set(sourceElements[i].id(), new DrawingObject(null, elementCopies[i]));
    }
    let order = next;
    const objects = this.DrawingObjects;
    for (let i = 0; i < objects.length; i++) {
      const copy = copyOf.get(objects[i].id());
      if (copy !== undefined) {
        copy.LayerOrder = order;
        order += 1;
      }
    }
  }

  /** 排列选中对象（置顶/前移/后移/置底），一个可撤销单元；ShapeSource 同组绑定排名。 */
  ArrangeSelection(action: number): void {
    if (this._selectionGesture) {
      this.EndSelectionGesture();
    } else if (this._activeHandle !== SelectionHandle.None) {
      this.EndSelectionDrag();
    }
    const objects = this.DrawingObjects;
    const ids: string[] = [];
    const orders: (number | null)[] = [];
    const groupIds: (string | null)[] = [];
    const selectedIds: string[] = [];
    for (let i = 0; i < objects.length; i++) {
      const item = objects[i];
      ids.push(item.id());
      orders.push(item.LayerOrder);
      groupIds.push(item.Stroke !== null && item.Stroke.ShapeSource !== null ? item.Stroke.ShapeSource.GroupId : null);
      if (this.isSelectedObject(item)) {
        selectedIds.push(item.id());
      }
    }
    const result = arrangeObjects({ Ids: ids, Orders: orders, SelectedIds: selectedIds, GroupIds: groupIds, Action: action });
    if (result.Order === null) {
      return;
    }
    const before = orders.slice();
    const next = result.Orders.slice();
    const apply = (values: (number | null)[]): void => {
      const present = new Set<string>();
      const current = this.DrawingObjects;
      for (let i = 0; i < current.length; i++) {
        present.add(current[i].id());
      }
      for (let i = 0; i < ids.length; i++) {
        if (present.has(ids[i])) {
          const item = objects[i];
          item.LayerOrder = values[i];
        }
      }
      this._drawingOrderDirty = true;
      this.LayerVersion += 1;
      if (this.LayersChanged !== null) {
        this.LayersChanged();
      }
      this.notifySelectionChanged();
      this.invalidate();
    };
    apply(next);
    this.History.push(new ControllerAction('arrange selection',
      (): void => apply(next),
      (): void => apply(before)));
  }

  // ---- G3 选区命令（C# Recolor/ScaleWidth/RestoreWidth/TransformSelectionUndoable） ----

  RecolorSelection(color: InkColor): void {
    this.changeSelectionAttributes('selection color', (attributes: StrokeAttributes): void => {
      attributes.Color = color;
    });
  }

  ScaleSelectionWidth(factor: number): void {
    this.changeSelectionAttributes('selection width', (attributes: StrokeAttributes): void => {
      attributes.BaseWidth = Math.min(Math.max(attributes.BaseWidth * factor, 0.5), 60);
    });
  }

  RestoreSelectionWidth(): void {
    this.changeSelectionAttributes('selection width restore', (attributes: StrokeAttributes): void => {
      attributes.BaseWidth = this.CurrentAttributes.BaseWidth;
    });
  }

  private changeSelectionAttributes(name: string, change: (attributes: StrokeAttributes) => void): void {
    const targets = this.Selection.slice();
    if (targets.length === 0) {
      return;
    }
    const before: StrokeAttributes[] = [];
    for (let i = 0; i < targets.length; i++) {
      before.push(targets[i].Attributes.clone());
    }
    for (let i = 0; i < targets.length; i++) {
      change(targets[i].Attributes);
    }
    const after: StrokeAttributes[] = [];
    for (let i = 0; i < targets.length; i++) {
      after.push(targets[i].Attributes.clone());
    }
    const restore = (attributes: StrokeAttributes[]): void => {
      for (let i = 0; i < targets.length; i++) {
        targets[i].Attributes.Color = attributes[i].Color;
        targets[i].Attributes.BaseWidth = attributes[i].BaseWidth;
      }
      this.Document.touch();
      this.notifySelectionChanged();
      this.invalidate();
    };
    this.History.push(new ControllerAction(name, (): void => restore(after), (): void => restore(before)));
    this.Document.touch();
    this.notifySelectionChanged();
    this.invalidate();
  }

  /** 对选区应用矩阵（可选随缩放改笔宽），一个可撤销单元；元素同步变换。 */
  TransformSelectionUndoable(matrix: Matrix3x2, name: string, scaleWidth: boolean = true): void {
    if (!this.HasSelection) {
      return;
    }
    const strokes = this.Selection.slice();
    const elements = this.SelectedElements.slice();
    const beforeFrame = this.selectionFrame();
    const before = this.cloneStrokes(strokes);
    const beforeElements: ElementSnapshot[] = [];
    for (let i = 0; i < elements.length; i++) {
      beforeElements.push(elements[i].capture());
    }
    for (let i = 0; i < strokes.length; i++) {
      transformStroke(strokes[i], matrix, scaleWidth);
      this.markGeometry(strokes[i]);
    }
    for (let i = 0; i < elements.length; i++) {
      elements[i].transform(matrix);
    }
    const after = this.cloneStrokes(strokes);
    const afterElements: ElementSnapshot[] = [];
    for (let i = 0; i < elements.length; i++) {
      afterElements.push(elements[i].capture());
    }
    const afterFrame = new OrientedFrame(beforeFrame.Bounds, multiplyMatrix(beforeFrame.Transform, matrix));
    this.rememberFrame(afterFrame);
    const restore = (state: InkStroke[], elementState: ElementSnapshot[], frame: OrientedFrame): void => {
      this.applySnapshotState(strokes, state);
      for (let i = 0; i < elements.length; i++) {
        elements[i].restore(elementState[i]);
      }
      this.restoreSelectionFrame(strokes, frame);
      this.Document.touch();
      this.notifySelectionChanged();
      this.invalidate();
    };
    this.History.push(new ControllerAction(
      name,
      (): void => restore(after, afterElements, afterFrame),
      (): void => restore(before, beforeElements, beforeFrame)
    ));
    this.Document.touch();
    this.notifySelectionChanged();
    this.invalidate();
  }

  Clear(): void {
    this.CancelLassoErase();
    this.ClearSelection();
    // 清空时一并清除形状预览，避免空文档早退路径残留预览上屏。
    this._shapePreview = [];
    if (this.Document.Count === 0) {
      return;
    }
    const removed = this.Document.Strokes.slice();
    this.Document.clear();
    this.History.push(new ControllerAction(
      'clear',
      (): void => {
        this.Document.removeAll(removed);
      },
      (): void => {
        this.Document.addRange(removed);
      }
    ));
    this.invalidate();
  }

  Delete(): void {
    this.DeleteSelection();
  }

  // ---- 套索擦（G1，C# BeginLassoErase/AppendLassoPoint/CommitLassoErase/CancelLassoErase） ----

  get IsLassoErasing(): boolean {
    return this._lassoErasing;
  }

  get LassoPath(): LassoPoint[] {
    return this._lassoPath;
  }

  get LassoVisualBounds(): Rect {
    return this._lassoErasing ? this._lassoBounds.inflate(4) : Rect.empty();
  }

  private beginLassoErase(p: PointerSample): void {
    this._lassoPath = [];
    this._lassoPointerId = p.Id;
    this._lassoViewAtStart = this.ViewTransform;
    this._lassoBounds = new Rect(p.X, p.Y, p.X, p.Y);
    this._lassoErasing = true;
    this.appendLassoPoint(p.X, p.Y, true);
  }

  private appendLassoPoint(x: number, y: number, final: boolean = false): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    if (this._lassoPath.length > 0) {
      const last = this._lassoPath[this._lassoPath.length - 1];
      const dx = x - last.X;
      const dy = y - last.Y;
      if (dx * dx + dy * dy < (final ? 0.001 : 4)) {
        return;
      }
    }
    // 超长手势限内存与路径渲染量：保序抽稀（隔点保留）。
    if (this._lassoPath.length >= 4096) {
      const thinned: LassoPoint[] = [this._lassoPath[0]];
      for (let i = 2; i < this._lassoPath.length; i += 2) {
        thinned.push(this._lassoPath[i]);
      }
      this._lassoPath = thinned;
    }
    this._lassoPath.push({ X: x, Y: y });
    this._lassoBounds = new Rect(
      Math.min(this._lassoBounds.Left, x), Math.min(this._lassoBounds.Top, y),
      Math.max(this._lassoBounds.Right, x), Math.max(this._lassoBounds.Bottom, y));
    this.invalidate();
  }

  private commitLassoErase(): void {
    const lasso = new LassoGeometry(this._lassoPath.slice());
    const view = this._lassoViewAtStart;
    // 文档通知可渲染已提交帧之前，先清瞬态路径。
    this._lassoErasing = false;
    this._lassoPath = [];
    this._lassoBounds = Rect.empty();
    if (lasso.IsValid) {
      const removed: { Index: number; Stroke: InkStroke }[] = [];
      const strokes = this.Document.Strokes;
      for (let i = 0; i < strokes.length; i++) {
        if (lasso.IntersectsStroke(strokes[i], view)) {
          removed.push({ Index: i, Stroke: strokes[i] });
        }
      }
      // G2：套索同时擦命中的元素（定向框相交；整体在框内也算命中）。
      const elements: ISelectionElement[] = [];
      const selectable = this.selectableElements();
      for (let i = 0; i < selectable.length; i++) {
        const element = selectable[i];
        if (element.isPresent() && lasso.IntersectsFrame(element.getFrame(), view)) {
          elements.push(element);
        }
      }
      if (removed.length > 0 || elements.length > 0) {
        const removedStrokes: InkStroke[] = [];
        for (let i = 0; i < removed.length; i++) {
          removedStrokes.push(removed[i].Stroke);
        }
        const apply = (): void => {
          this.Document.removeAll(removedStrokes);
          for (let i = 0; i < elements.length; i++) {
            elements[i].setPresent(false);
          }
        };
        const restore = (): void => {
          this.Document.insertRange(removed);
          // 逆序在场恢复原 z 序。
          for (let i = elements.length - 1; i >= 0; i--) {
            elements[i].setPresent(true);
          }
        };
        apply();
        this.History.push(new ControllerAction('lasso erase', apply, restore));
        this.pruneSelection();
        this.MarkLayerOrderDirty();
      }
    }
    this.invalidate();
  }

  CancelLassoErase(): void {
    if (!this._lassoErasing) {
      return;
    }
    this._lassoErasing = false;
    this._lassoPath = [];
    this._lassoBounds = Rect.empty();
    this.invalidate();
  }

  private cancelTouchInk(): void {
    // 只取消触摸指针产生的 live stroke，不动笔/鼠标。
    const ids = this._touchOrder.slice();
    for (let i = 0; i < ids.length; i++) {
      this.removeLive(ids[i]);
    }
  }

  private tryGetTouchPair(): PointerSample[] | null {
    const result: PointerSample[] = [];
    for (let i = 0; i < this._touchOrder.length && result.length < 2; i++) {
      const sample = this._touches.get(this._touchOrder[i]);
      if (sample !== undefined) {
        result.push(sample);
      }
    }
    if (result.length < 2) {
      return null;
    }
    return result;
  }

  Dispose(): void {
    this._panPointerId = null;
    this._live.clear();
    this._liveIds = [];
    this._touches.clear();
    this._touchOrder = [];
    this.Selection = [];
    this._frameStrokes = [];
    this._frameVersions = [];
    this._shapeDragStart.clear();
    this._stepPending = [];
    this._shapePreview = [];
    this._isMarqueeSelecting = false;
    this._marqueeBounds = Rect.empty();
    this._marqueeInitialStrokes = [];
    this._marqueeInitialElements = [];
  }

  // ---- 内部事件/集合辅助 -------------------------------------------------

  private touchDown(p: PointerSample): void {
    if (!this._touches.has(p.Id)) {
      this._touchOrder.push(p.Id);
    }
    this._touches.set(p.Id, p);
  }

  private removeTouchId(id: number): void {
    this._touches.delete(id);
    const index = this._touchOrder.indexOf(id);
    if (index >= 0) {
      this._touchOrder.splice(index, 1);
    }
  }

  private removeLive(id: number): void {
    this._live.delete(id);
    this._lineEndpoints.delete(id);
    this._strokeStartTimes.delete(id);
    const index = this._liveIds.indexOf(id);
    if (index >= 0) {
      this._liveIds.splice(index, 1);
    }
  }

  private pointerTime(p: PointerSample): number {
    if (Number.isFinite(p.TimeMs)) {
      return p.TimeMs;
    }
    return this._timeSource();
  }

  private invalidate(): void {
    this.InvalidationCount += 1;
    if (this.Invalidated !== null) {
      this.Invalidated();
    }
  }

  private notifySelectionChanged(): void {
    this.SelectionChangedCount += 1;
    if (this.SelectionChanged !== null) {
      this.SelectionChanged();
    }
  }

  private notifyToolChanged(): void {
    this.ToolChangedCount += 1;
    if (this.ToolChanged !== null) {
      this.ToolChanged();
    }
  }
}

function matrixEqualsValue(a: Matrix3x2, b: Matrix3x2): boolean {
  return a.M11 === b.M11 && a.M12 === b.M12 && a.M21 === b.M21 &&
    a.M22 === b.M22 && a.M31 === b.M31 && a.M32 === b.M32;
}

function sameStrokeSnapshot(a: InkStroke[], b: InkStroke[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i].Count !== b[i].Count) {
      return false;
    }
    for (let p = 0; p < a[i].Count; p++) {
      if (a[i].Points[p].X !== b[i].Points[p].X || a[i].Points[p].Y !== b[i].Points[p].Y) {
        return false;
      }
    }
  }
  return true;
}

function applySnapshot(targets: InkStroke[], snapshot: InkStroke[]): void {
  for (let i = 0; i < targets.length && i < snapshot.length; i++) {
    targets[i].restorePoints(snapshot[i].Points);
    targets[i].Attributes.BaseWidth = snapshot[i].Attributes.BaseWidth;
    const data = snapshot[i].exportObjectFrame();
    if (data !== null) {
      targets[i].importObjectFrame(data);
    } else {
      const bounds = targets[i].bounds();
      if (!bounds.isEmpty()) {
        targets[i].importObjectFrame([
          bounds.Left, bounds.Top, bounds.Right, bounds.Bottom,
          1, 0, 0, 1, 0, 0
        ]);
      }
    }
  }
}

// ---- 黄金向量场景驱动 ----------------------------------------------------

function scenarioPointer(pointer: ScenarioPointer | undefined): PointerSample {
  if (pointer === undefined) {
    throw new Error('controller scenario: pointer missing');
  }
  const pressure = pointer.Pressure === undefined ? 0.5 : pointer.Pressure;
  const contactWidth = pointer.ContactWidth === undefined ? 0 : pointer.ContactWidth;
  const contactHeight = pointer.ContactHeight === undefined ? 0 : pointer.ContactHeight;
  const timeMs = pointer.TimeMs === undefined ? 0 : pointer.TimeMs;
  return new PointerSample(
    pointer.Id, pointer.X, pointer.Y, pressure, contactWidth, contactHeight,
    pointer.Kind, timeMs, pointer.Shift === true, pointer.Control === true
  );
}

function scenarioSeedStroke(seed: ScenarioSeed): InkStroke {
  const attributes = new StrokeAttributes();
  attributes.Color = InkColor.black();
  attributes.BaseWidth = 3;
  attributes.TaperKind = TaperKind.Tail;
  if (seed.Attributes !== undefined) {
    const input = seed.Attributes;
    attributes.Color = InkColor.fromPackedArgb(input.ColorPacked);
    attributes.BaseWidth = input.BaseWidth;
    attributes.IsHighlighter = input.IsHighlighter;
    attributes.HighlighterAlpha = input.HighlighterAlpha;
    attributes.TaperKind = input.TaperKind as TaperKind;
  }
  const stroke = new InkStroke(attributes);
  const points: InkPoint[] = [];
  for (let i = 0; i < seed.Points.length; i++) {
    const p = seed.Points[i];
    const pressure = p.Pressure === undefined ? 0.5 : p.Pressure;
    const width = p.Width === undefined ? 0 : p.Width;
    const timeMs = p.TimeMs === undefined ? 0 : p.TimeMs;
    points.push(new InkPoint(p.X, p.Y, pressure, width, timeMs));
  }
  stroke.restorePoints(points);
  if (seed.IsCompleted === true) {
    stroke.complete();
  }
  return stroke;
}

function applyScenarioInitial(controller: InkController, initial: ScenarioInitial): void {
  if (initial.Tool !== undefined) {
    controller.Tool = initial.Tool as InkTool;
  }
  if (initial.ShapeKind !== undefined) {
    controller.ShapeKind = initial.ShapeKind as ShapeKind;
  }
  if (initial.EraserMode !== undefined) {
    controller.EraserMode = initial.EraserMode as InkEraserMode;
  }
  if (initial.EraserRadius !== undefined) {
    controller.EraserRadius = initial.EraserRadius;
  }
  if (initial.ViewTransform !== undefined && initial.ViewTransform.length >= 6) {
    controller.ViewTransform = matrixFromArray(initial.ViewTransform);
  }
  if (initial.ViewCenter !== undefined && initial.ViewCenter.length >= 2) {
    controller.ViewCenter = new Point2(initial.ViewCenter[0], initial.ViewCenter[1]);
  }
  if (initial.MultiTouchEnabled !== undefined) {
    controller.MultiTouchEnabled = initial.MultiTouchEnabled;
  }
  if (initial.PalmErases !== undefined) {
    controller.PalmErases = initial.PalmErases;
  }
  if (initial.RecognizeShapes !== undefined) {
    controller.RecognizeShapes = initial.RecognizeShapes;
  }
  if (initial.GesturesTargetSelection !== undefined) {
    controller.GesturesTargetSelection = initial.GesturesTargetSelection;
  }
  if (initial.CloneMode !== undefined) {
    controller.CloneMode = initial.CloneMode;
  }
  if (initial.StickyShape !== undefined) {
    controller.StickyShape = initial.StickyShape;
  }
  if (initial.HyperbolaAsymptoteOption !== undefined) {
    controller.HyperbolaAsymptoteOption = initial.HyperbolaAsymptoteOption;
  }
  if (initial.AskRemoveAsymptotes !== undefined) {
    if (initial.AskRemoveAsymptotes === null) {
      controller.AskRemoveAsymptotes = null;
    } else {
      const answer = initial.AskRemoveAsymptotes;
      controller.AskRemoveAsymptotes = (): boolean => answer;
    }
  }
  if (initial.TransformCenterOption !== undefined) {
    controller.TransformCenterOption = initial.TransformCenterOption;
  }
  const zoom = initial.AllowZoom === undefined ? true : initial.AllowZoom;
  const translate = initial.AllowTranslate === undefined ? true : initial.AllowTranslate;
  const rotate = initial.AllowRotation === undefined ? false : initial.AllowRotation;
  controller.ConfigureGestures(zoom, translate, rotate);
  if (initial.CurrentAttributes !== undefined) {
    const input = initial.CurrentAttributes;
    controller.CurrentAttributes.Color = InkColor.fromPackedArgb(input.ColorPacked);
    controller.CurrentAttributes.BaseWidth = input.BaseWidth;
    controller.CurrentAttributes.IsHighlighter = input.IsHighlighter;
    controller.CurrentAttributes.HighlighterAlpha = input.HighlighterAlpha;
    controller.CurrentAttributes.TaperKind = input.TaperKind as TaperKind;
  }
  if (initial.Palm !== undefined) {
    const palm = initial.Palm;
    if (palm.Advanced !== undefined) {
      if (palm.Advanced === null) {
        controller.Palm.Advanced = null;
      } else {
        const advanced: ScenarioAdvanced = palm.Advanced;
        controller.Palm.Advanced = {
          isSpecialScreen: advanced.isSpecialScreen,
          isQuadIR: advanced.isQuadIR,
          touchMultiplier: advanced.touchMultiplier,
          nibModeBoundsWidth: advanced.nibModeBoundsWidth,
          fingerModeBoundsWidth: advanced.fingerModeBoundsWidth,
          nibModeBoundsWidthThresholdValue: advanced.nibModeBoundsWidthThresholdValue,
          fingerModeBoundsWidthThresholdValue: advanced.fingerModeBoundsWidthThresholdValue,
          nibModeBoundsWidthEraserSize: advanced.nibModeBoundsWidthEraserSize,
          fingerModeBoundsWidthEraserSize: advanced.fingerModeBoundsWidthEraserSize
        };
      }
    }
    if (palm.NibMode !== undefined) {
      controller.Palm.NibMode = palm.NibMode;
    }
    if (palm.ForceEraser !== undefined) {
      controller.Palm.ForceEraser = palm.ForceEraser;
    }
    if (palm.ForcePointEraser !== undefined) {
      controller.Palm.ForcePointEraser = palm.ForcePointEraser;
    }
    if (palm.PptGestureEligible !== undefined) {
      controller.Palm.PptGestureEligible = palm.PptGestureEligible;
    }
    if (palm.PalmContactThreshold !== undefined) {
      controller.Palm.PalmContactThreshold = palm.PalmContactThreshold;
    }
    if (palm.PenHasPriority !== undefined) {
      controller.Palm.PenHasPriority = palm.PenHasPriority;
    }
  }
}

function applyScenarioOp(controller: InkController, op: ScenarioOp): void {
  const name = op.Op;
  if (name === 'down') {
    controller.onPointerDown(scenarioPointer(op.Pointer));
  } else if (name === 'move') {
    controller.onPointerMove(scenarioPointer(op.Pointer));
  } else if (name === 'up') {
    controller.onPointerUp(scenarioPointer(op.Pointer));
  } else if (name === 'cancel') {
    controller.onPointerCanceled(scenarioPointer(op.Pointer));
  } else if (name === 'seed') {
    if (op.Stroke === undefined) {
      throw new Error('controller scenario: seed stroke missing');
    }
    controller.Document.add(scenarioSeedStroke(op.Stroke));
  } else if (name === 'undo') {
    controller.Undo();
  } else if (name === 'redo') {
    controller.Redo();
  } else if (name === 'clear') {
    controller.Clear();
  } else if (name === 'deleteSelection') {
    controller.DeleteSelection();
  } else if (name === 'clearSelection') {
    controller.ClearSelection();
  } else if (name === 'selectAll') {
    controller.SelectAll();
  } else if (name === 'selectIndex') {
    const value = op.Value === undefined ? -1 : op.Value;
    controller.Selection.push(controller.Document.Strokes[value]);
  } else if (name === 'setTool') {
    controller.Tool = (op.Value === undefined ? 0 : op.Value) as InkTool;
  } else if (name === 'setEraserMode') {
    controller.EraserMode = (op.Value === undefined ? 0 : op.Value) as InkEraserMode;
  } else if (name === 'setShapeKind') {
    controller.ShapeKind = (op.Value === undefined ? 0 : op.Value) as ShapeKind;
  } else if (name === 'selectShape') {
    controller.SelectShape((op.Value === undefined ? 0 : op.Value) as ShapeKind, op.Flag === true);
  } else if (name === 'setCloneMode') {
    controller.CloneMode = op.Flag === true;
  } else if (name === 'configureGestures') {
    controller.ConfigureGestures(op.Zoom === true, op.Translate === true, op.Rotate === true);
  } else {
    throw new Error('controller scenario: unknown op ' + name);
  }
}

function scenarioSelectionIndices(controller: InkController): number[] {
  const result: number[] = [];
  for (let i = 0; i < controller.Selection.length; i++) {
    result.push(controller.Document.Strokes.indexOf(controller.Selection[i]));
  }
  return result;
}

function scenarioTrace(controller: InkController, inv: number, selCh: number, toolCh: number, slides: number): ControllerTraceStep {
  const doc: number[] = [];
  const docFirst: number[][] = [];
  for (let i = 0; i < controller.Document.Strokes.length; i++) {
    const stroke = controller.Document.Strokes[i];
    doc.push(stroke.Count);
    if (stroke.Count > 0) {
      docFirst.push([stroke.Points[0].X, stroke.Points[0].Y]);
    } else {
      docFirst.push([]);
    }
  }
  return {
    Doc: doc,
    DocFirst: docFirst,
    Live: controller.LiveStrokes.length,
    Preview: controller.ShapePreview.length,
    Sel: scenarioSelectionIndices(controller),
    Undo: controller.History.UndoCount,
    Redo: controller.History.RedoCount,
    Tool: controller.Tool,
    View: matrixToArray(controller.ViewTransform),
    Inv: inv,
    SelCh: selCh,
    ToolCh: toolCh,
    Slides: slides
  };
}

function scenarioFinal(controller: InkController): ControllerFinalState {
  const strokes: ControllerStrokeSummary[] = [];
  for (let i = 0; i < controller.Document.Strokes.length; i++) {
    const stroke = controller.Document.Strokes[i];
    const points: number[][] = [];
    for (let p = 0; p < stroke.Points.length; p++) {
      const point = stroke.Points[p];
      points.push([point.X, point.Y, point.Pressure, point.Width, point.TimeMs]);
    }
    strokes.push({
      Points: points,
      BaseWidth: stroke.Attributes.BaseWidth,
      ColorPacked: stroke.Attributes.Color.packedArgb(),
      IsHighlighter: stroke.Attributes.IsHighlighter,
      HighlighterAlpha: stroke.Attributes.HighlighterAlpha,
      TaperKind: stroke.Attributes.TaperKind,
      IsRecognizedShape: stroke.IsRecognizedShape,
      IsCompleted: stroke.IsCompleted
    });
  }
  const bounds = controller.SelectionBounds;
  const frame = controller.selectionFrameSummary();
  return {
    Strokes: strokes,
    Sel: scenarioSelectionIndices(controller),
    Tool: controller.Tool,
    EraserMode: controller.EraserMode,
    CloneMode: controller.CloneMode,
    View: matrixToArray(controller.ViewTransform),
    ViewCenter: [controller.ViewCenter.X, controller.ViewCenter.Y],
    Undo: controller.History.UndoCount,
    Redo: controller.History.RedoCount,
    SelectionBounds: [bounds.Left, bounds.Top, bounds.Right, bounds.Bottom],
    SelectionFrame: frame
  };
}

/**
 * 黄金向量入口：执行与 C# ControllerVectors 相同的场景，返回逐步 trace 与最终状态。
 * 两侧共同消费 parity/vectors/controller.json。
 */
export function runControllerScenario(scenario: ControllerScenario): ControllerScenarioResult {
  const controller = new InkController();
  let inv = 0;
  let selCh = 0;
  let toolCh = 0;
  const slides: boolean[] = [];
  controller.Invalidated = (): void => {
    inv += 1;
  };
  controller.SelectionChanged = (): void => {
    selCh += 1;
  };
  controller.ToolChanged = (): void => {
    toolCh += 1;
  };
  controller.SlideFlipRequested = (next: boolean): void => {
    slides.push(next);
  };

  applyScenarioInitial(controller, scenario.Initial);
  const trace: ControllerTraceStep[] = [];
  for (let i = 0; i < scenario.Ops.length; i++) {
    applyScenarioOp(controller, scenario.Ops[i]);
    trace.push(scenarioTrace(controller, inv, selCh, toolCh, slides.length));
  }
  const finalState = scenarioFinal(controller);
  controller.Dispose();
  return { Trace: trace, Final: finalState, SlideFlips: slides };
}
