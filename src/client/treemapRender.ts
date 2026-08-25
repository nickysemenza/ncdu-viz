import type { Cell } from "../shared/scanLayout";

export interface DrawOptions {
  /** Resolve a cell's fill from its node index. */
  colorOf: (index: number) => string;
  /** CSS pixel dimensions (the context is already DPR-scaled). */
  width: number;
  height: number;
}

/** Cells smaller than this (in CSS px²) are not worth drawing. */
const MIN_CELL_AREA = 1;

const rectArea = (c: Cell): number => (c.x1 - c.x0) * (c.y1 - c.y0);

/**
 * Render the treemap cells: cushion-shaded rectangles.
 *
 * The hover rings are deliberately not drawn here. Canvas is immediate-mode, so
 * including them would mean repainting every cell — each with its own gradient —
 * on every mousemove. They live on a separate overlay canvas instead; see
 * `drawHover`.
 */
export function drawTreemap(
  ctx: CanvasRenderingContext2D,
  cells: readonly Cell[],
  opts: DrawOptions,
): void {
  const { colorOf, width, height } = opts;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0a0a0b";
  ctx.fillRect(0, 0, width, height);

  for (const cell of cells) {
    if (rectArea(cell) < MIN_CELL_AREA) continue;
    drawCushion(ctx, cell, colorOf(cell.index), cell.collapsed);
  }
}

function drawCushion(
  ctx: CanvasRenderingContext2D,
  r: Cell,
  base: string,
  collapsed: boolean,
): void {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;

  ctx.fillStyle = base;
  ctx.fillRect(r.x0, r.y0, w, h);

  // Diagonal cushion: white highlight toward top-left, shadow toward bottom-right.
  const g = ctx.createLinearGradient(r.x0, r.y0, r.x1, r.y1);
  g.addColorStop(0, "rgba(255,255,255,0.32)");
  g.addColorStop(0.45, "rgba(255,255,255,0)");
  g.addColorStop(0.55, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.38)");
  ctx.fillStyle = g;
  ctx.fillRect(r.x0, r.y0, w, h);

  if (w > 3 && h > 3) {
    // Collapsed directories get a brighter border so they read as "more inside".
    ctx.strokeStyle = collapsed ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.45)";
    ctx.lineWidth = collapsed ? 1 : 0.5;
    ctx.strokeRect(r.x0 + 0.25, r.y0 + 0.25, w - 0.5, h - 0.5);
  }
}

/** Hover rings, drawn onto the transparent overlay canvas. */
export function drawHover(
  ctx: CanvasRenderingContext2D,
  cell: Cell,
  group: Cell | undefined,
): void {
  if (group && group !== cell) {
    ctx.strokeStyle = "rgba(96,165,250,0.9)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      group.x0 + 0.75,
      group.y0 + 0.75,
      group.x1 - group.x0 - 1.5,
      group.y1 - group.y0 - 1.5,
    );
  }
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cell.x0 + 0.75, cell.y0 + 0.75, cell.x1 - cell.x0 - 1.5, cell.y1 - cell.y0 - 1.5);
}
