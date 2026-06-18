import type { ScanNode } from "../shared/types";
import type { TreemapLayout, TreemapRect } from "../shared/treemap";

export interface DrawOptions {
  /** Resolve a cell's fill from its node (leaf → its ext; collapsed dir → dominant ext). */
  colorOf: (node: ScanNode) => string;
  /** CSS pixel dimensions (the context is already DPR-scaled). */
  width: number;
  height: number;
  /** Hovered cell + its enclosing immediate-child group, for the highlight rings. */
  hover?: { cell: TreemapRect; group: TreemapRect | undefined };
}

/** Cells smaller than this (in CSS px²) are not worth drawing. */
const MIN_CELL_AREA = 1;

const rectArea = (r: TreemapRect): number => (r.x1 - r.x0) * (r.y1 - r.y0);

/** A rect is a leaf cell if its node has no drawable children. */
function isLeafRect(r: TreemapRect): boolean {
  return !r.node.isDir || (r.node.children?.length ?? 0) === 0;
}

/**
 * The set of cells to draw at a given detail depth: every leaf at-or-above
 * `maxDepth`, plus every directory sitting exactly at `maxDepth` (drawn as one
 * aggregated cell). These tile the focus rect with no overlap.
 */
export function frontier(layout: TreemapLayout, maxDepth: number): TreemapRect[] {
  return layout.nodes.filter((r) => (isLeafRect(r) ? r.depth <= maxDepth : r.depth === maxDepth));
}

/** The frontier cell + ancestor chain under a point (for hover/drill). */
export function frontierAt(
  layout: TreemapLayout,
  maxDepth: number,
  x: number,
  y: number,
): { chain: TreemapRect[]; cell: TreemapRect | undefined } {
  const chain = layout.nodes
    .filter((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1)
    .sort((a, b) => a.depth - b.depth);
  let cell: TreemapRect | undefined;
  for (const r of chain) {
    if (isLeafRect(r) ? r.depth <= maxDepth : r.depth === maxDepth) cell = r;
  }
  return { chain, cell };
}

/** Render the treemap frontier: cushion-shaded cells + hover rings. */
export function drawTreemap(
  ctx: CanvasRenderingContext2D,
  cells: TreemapRect[],
  opts: DrawOptions,
): void {
  const { colorOf, width, height, hover } = opts;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0a0a0b";
  ctx.fillRect(0, 0, width, height);

  for (const cell of cells) {
    if (rectArea(cell) < MIN_CELL_AREA) continue;
    drawCushion(ctx, cell, colorOf(cell.node), !isLeafRect(cell));
  }

  if (hover?.cell) drawHover(ctx, hover.cell, hover.group);
}

function drawCushion(
  ctx: CanvasRenderingContext2D,
  r: TreemapRect,
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

function drawHover(
  ctx: CanvasRenderingContext2D,
  cell: TreemapRect,
  group: TreemapRect | undefined,
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
