export const MODULE: string = 'controls';
export { themeTokens } from './src/main/ets/ThemeTokens';
export type { ThemeTokens } from './src/main/ets/ThemeTokens';
export { FLOATING_BAR_BUTTONS, catalogSummary } from './src/main/ets/FloatingBarCatalog';
export type { FloatingBarButton, FloatingBarCatalogSummary } from './src/main/ets/FloatingBarCatalog';
export { FloatingBar } from './src/main/ets/FloatingBar';
export { BoardDock } from './src/main/ets/BoardDock';
export { ChemBoard } from './src/main/ets/ChemBoard';
export type { ChemAtom, ChemBond } from './src/main/ets/ChemBoard';
export {
  PEN_COLORS_DARK,
  PEN_COLORS_LIGHT,
  HIGHLIGHTER_COLORS,
  PEN_WIDTH_MIN,
  PEN_WIDTH_MAX,
  PEN_WIDTH_STEP,
  HIGHLIGHTER_ALPHA_MIN,
  HIGHLIGHTER_ALPHA_MAX,
  HIGHLIGHTER_ALPHA_STEP,
  HIGHLIGHTER_ALPHA_DEFAULT,
  TAPER_LABELS,
  toStoredPenWidth,
  toMenuPenWidth,
  snap,
  taperKindForIndex,
  packedSwatch,
  paletteSummary
} from './src/main/ets/PenPaletteCatalog';
export type { Swatch, PaletteSummary } from './src/main/ets/PenPaletteCatalog';
export { PenPalette } from './src/main/ets/PenPalette';
export { SHAPE_MENU_ROWS, shapeCatalogSummary } from './src/main/ets/ShapePickerCatalog';
export type { ShapeMenuEntry, ShapeCatalogSummary } from './src/main/ets/ShapePickerCatalog';
export { ShapePicker, ShapePreviewCell } from './src/main/ets/ShapePicker';
export {
  MOTION_FAST,
  MOTION_STANDARD,
  MOTION_SLOW,
  motionDuration,
  springCurve,
  sharedId,
  overlayTransition,
  panelTransition,
  barCollapseTransition,
  animateMotion
} from './src/main/ets/Motion';
export { panelBackground, panelBlurStyle } from './src/main/ets/PanelStyle';
export {
  AiCaptureOverlay,
  AiGeneratingOverlay,
  AiResultCard,
  AiNotesPanel,
  ShapeSnapPanel
} from './src/main/ets/AiStudio';
export {
  GLYPH_SYMBOLS,
  symbolForCodepoint,
  symbolForButton,
  symbolForTool,
  IconGlyph
} from './src/main/ets/IconGlyph';
export type { GlyphSymbolEntry, IconGlyphOptions } from './src/main/ets/IconGlyph';
