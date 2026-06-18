import type { TreemapLayout, TreemapRect } from "../shared/treemap";

export interface DrawOptions {
  colorFor: (ext: string | undefined) => string;
  /** CSS pixel dimensions (the context is already DPR-scaled). */
  width: number;
  height: number;
  /** Ancestor chain (root→leaf) of the hovered cell, for the highlight rings. */
  hoverChain?: TreemapRect[];
}

/** Cells smaller than this (in CSS px²) are not worth drawing. */
const MIN_CELL_AREA = 1;

const rectArea = (r: TreemapRect): number => (r.x1 - r.x0) * (r.y1 - r.y0);

/** Render the treemap: cushion-shaded leaf cells + hover rings. */
export function drawTreemap(
  ctx: CanvasRenderingContext2D,
  layout: TreemapLayout,
  opts: DrawOptions,
): void {
  const { colorFor, width, height, hoverChain } = opts;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0a0a0b";
  ctx.fillRect(0, 0, width, height);

  for (const leaf of layout.leaves) {
    if (rectArea(leaf) < MIN_CELL_AREA) continue;
    drawCushion(ctx, leaf, colorFor(leaf.node.ext));
  }

  if (hoverChain && hoverChain.length > 0) {
    drawHover(ctx, hoverChain);
  }
}

function drawCushion(ctx: CanvasRenderingContext2D, r: TreemapRect, base: string): void {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;

  // Flat base fill.
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

  // Hairline separation so adjacent cells read apart.
  if (w > 3 && h > 3) {
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(r.x0 + 0.25, r.y0 + 0.25, w - 0.5, h - 0.5);
  }
}

function drawHover(ctx: CanvasRenderingContext2D, chain: TreemapRect[]): void {
  const leaf = chain[chain.length - 1];
  const group = chain.find((r) => r.depth === 1);

  // Enclosing immediate-child group: subtle blue box (à la GrandPerspective).
  if (group && group !== leaf) {
    ctx.strokeStyle = "rgba(96,165,250,0.9)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      group.x0 + 0.75,
      group.y0 + 0.75,
      group.x1 - group.x0 - 1.5,
      group.y1 - group.y0 - 1.5,
    );
  }

  // Hovered cell: bright white hairline.
  if (leaf) {
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      leaf.x0 + 0.75,
      leaf.y0 + 0.75,
      leaf.x1 - leaf.x0 - 1.5,
      leaf.y1 - leaf.y0 - 1.5,
    );
  }
}

/** Ancestor chain (root→leaf) of whatever cell contains the point, by depth. */
export function chainAt(layout: TreemapLayout, x: number, y: number): TreemapRect[] {
  const hits = layout.nodes.filter((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);
  hits.sort((a, b) => a.depth - b.depth);
  return hits;
}
