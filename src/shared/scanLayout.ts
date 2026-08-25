/**
 * Squarified treemap layout over a `ScanTable`.
 *
 * ## What we keep from d3, and what we drop
 *
 * The tiling maths is still d3's: `treemapSquarify` is imported and called
 * directly. It only duck-types its input — it reads `parent.value` and
 * `parent.children[].value` and writes `x0/y0/x1/y1` back onto those children —
 * so it can be driven from plain objects without building a hierarchy. Geometry
 * is therefore identical to the previous implementation by construction, not by
 * reimplementation.
 *
 * What we drop is `d3.hierarchy()`. It walks the whole subtree eagerly and
 * allocates a wrapper per node, `.sum()` and `.sort()` traverse it again, and the
 * caller ends up with a rectangle per node. On a multi-million-node scan that is
 * seconds of work and about a gigabyte of garbage — repeated on every drill and
 * every window resize — to paint a few hundred rectangles. The eager walk is
 * inherent to building a hierarchy at all, so the only way out is not to build one.
 *
 * Instead the recursion is driven here and pruned at the source: a directory is
 * descended into only if it is above the detail depth *and* its rectangle is big
 * enough to be worth subdividing. Everything else becomes a single collapsed
 * cell. Cost scales with cells drawn, not with tree size.
 *
 * Driving the recursion ourselves is also what makes area pruning possible at
 * all: it depends on the rectangle a node actually received, which is not known
 * until its parent has been tiled. d3's model computes the full hierarchy before
 * laying anything out, so it cannot express that.
 *
 * The values fed in are already correct: a directory's `size` in the table is the
 * sum of its leaf descendants, exactly what d3's `.sum()` derives — so a
 * collapsed directory stands in for its whole subtree.
 */

import { treemapSquarify } from "d3-hierarchy";
import { NodeFlag } from "./scanTable";
import type { ScanTable } from "./scanTable";

/** One laid-out rectangle. `index` refers to a node in the table. */
export interface Cell {
  index: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Depth relative to the focus (focus = 0). */
  depth: number;
  /** A directory drawn as one aggregated cell because recursion stopped here. */
  collapsed: boolean;
}

export interface TreemapLayout {
  /** The drawn cells. They tile the focus rectangle with no overlap. */
  cells: Cell[];
  /** Rects of the focus's immediate children, used for the hover group ring. */
  groups: Cell[];
}

export interface LayoutOptions {
  paddingInner?: number;
  /** Max depth below the focus to subdivide; deeper directories collapse. */
  maxDepth?: number;
  /**
   * Stop subdividing a rectangle smaller than this (px²). Cells below the
   * drawing threshold are invisible anyway, so descending into them is pure cost.
   */
  minArea?: number;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Minimal stand-in for a d3 hierarchy node. `treemapSquarify` reads `value` and
 * writes the rect fields, and touches nothing else.
 */
interface TileNode extends Rect {
  value: number;
}

interface TileParent {
  value: number;
  children: TileNode[];
}

/**
 * d3's published type demands a full `HierarchyRectangularNode`, but the
 * implementation only ever reads `parent.value` / `child.value` and writes the
 * four rect fields (see d3-hierarchy/src/treemap/squarify.js). Narrowing the
 * signature to what it actually touches lets us tile without building a
 * hierarchy — which is the entire point of this module.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const tileSquarify = treemapSquarify as unknown as (
  parent: TileParent,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) => void;

/** Collapse a degenerate rect to its midpoint, as d3's `positionNode` does. */
function normalize(r: Rect): Rect {
  let { x0, y0, x1, y1 } = r;
  if (x1 < x0) x0 = x1 = (x0 + x1) / 2;
  if (y1 < y0) y0 = y1 = (y0 + y1) / 2;
  return { x0, y0, x1, y1 };
}

interface Pending {
  index: number;
  rect: Rect;
  depth: number;
}

/**
 * Lay out the subtree under `focus` into a `width` x `height` rectangle.
 *
 * Only cells that will be drawn are produced: leaves at or above `maxDepth`, and
 * directories collapsed at `maxDepth` or below `minArea`. Together they tile the
 * focus rectangle exactly.
 */
export function layoutTreemap(
  t: ScanTable,
  focus: number,
  width: number,
  height: number,
  opts: LayoutOptions = {},
): TreemapLayout {
  const { paddingInner = 1, maxDepth = Infinity, minArea = 0 } = opts;
  const { end, flags, size } = t.p;

  const cells: Cell[] = [];
  const groups: Cell[] = [];
  const half = paddingInner / 2;

  const hasKids = (i: number): boolean => (flags[i] & NodeFlag.DIR) !== 0 && end[i] > i + 1;

  const rootRect = normalize({ x0: 0, y0: 0, x1: width, y1: height });
  const stack: Pending[] = [{ index: focus, rect: rootRect, depth: 0 }];

  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    const { index, rect, depth } = node;
    const area = (rect.x1 - rect.x0) * (rect.y1 - rect.y0);

    // Stop here: a leaf, at the detail limit, or too small to be worth splitting.
    if (!hasKids(index) || depth >= maxDepth || area < minArea) {
      const cell: Cell = { index, ...rect, depth, collapsed: hasKids(index) };
      if (depth > 0) cells.push(cell);
      if (depth === 1) groups.push(cell);
      continue;
    }

    if (depth === 1) groups.push({ index, ...rect, depth, collapsed: false });

    // d3 expands the tiling rect by half the inner padding and then insets each
    // child by the same amount, so gaps appear between siblings but not at the
    // outer edge. Mirrored here so the geometry matches exactly.
    const tileRect = normalize({
      x0: rect.x0 - half,
      y0: rect.y0 - half,
      x1: rect.x1 + half,
      y1: rect.y1 + half,
    });

    const kids: number[] = [];
    for (let j = index + 1; j < end[index]; j = end[j]) kids.push(j);
    // Descending by size. Array sort is stable, so ties keep emission order —
    // matching d3, whose children array is also in document order before sorting.
    kids.sort((a, b) => size[b] - size[a]);

    // Drive d3's own tiling from throwaway stubs: it reads `value` and writes the
    // rect fields, so no hierarchy is needed and nothing outlives this iteration.
    const tileParent: TileParent = {
      value: size[index],
      children: kids.map((k) => ({ value: size[k], x0: 0, y0: 0, x1: 0, y1: 0 })),
    };
    tileSquarify(tileParent, tileRect.x0, tileRect.y0, tileRect.x1, tileRect.y1);

    // Pushed in reverse so the stack pops them in layout order, which keeps the
    // emitted cell order stable and comparable against a top-down walk.
    for (let k = kids.length - 1; k >= 0; k--) {
      const r = tileParent.children[k];
      stack.push({
        index: kids[k],
        rect: normalize({ x0: r.x0 + half, y0: r.y0 + half, x1: r.x1 - half, y1: r.y1 - half }),
        depth: depth + 1,
      });
    }
  }

  return { cells, groups };
}

/** The drawn cell under a point, or undefined outside the tiling. */
export function cellAt(layout: TreemapLayout, x: number, y: number): Cell | undefined {
  for (const c of layout.cells) {
    if (x >= c.x0 && x < c.x1 && y >= c.y0 && y < c.y1) return c;
  }
  return undefined;
}

/** The focus's immediate child containing a point, for the hover group ring. */
export function groupAt(layout: TreemapLayout, x: number, y: number): Cell | undefined {
  for (const g of layout.groups) {
    if (x >= g.x0 && x < g.x1 && y >= g.y0 && y < g.y1) return g;
  }
  return undefined;
}
