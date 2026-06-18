import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import type { ScanNode } from "./types";

/** A laid-out rectangle for one node in the treemap. */
export interface TreemapRect {
  node: ScanNode;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Depth relative to the laid-out root (root = 0). */
  depth: number;
}

export interface TreemapLayout {
  /** Every node (root, directory groups, and leaves), in pre-order. */
  nodes: TreemapRect[];
  /** Just the leaves — the cells that get drawn + hit-tested. */
  leaves: TreemapRect[];
}

export interface TreemapOptions {
  paddingInner?: number;
}

/**
 * Depth range + an adaptive default for the detail slider, relative to `focus`
 * (focus = depth 0). The default is the deepest level whose drawn-cell count
 * (leaves at-or-above it + directories collapsed at it) stays under `target`,
 * so a huge scan opens clean instead of as thousands of sub-pixel cells.
 */
export function depthStats(
  focus: ScanNode,
  target = 1500,
): { maxDepth: number; suggested: number } {
  const leavesAt: number[] = [];
  const dirsAt: number[] = [];
  let maxDepth = 0;

  const walk = (n: ScanNode, d: number): void => {
    if (d > maxDepth) maxDepth = d;
    if (n.isDir && (n.children?.length ?? 0) > 0) {
      dirsAt[d] = (dirsAt[d] ?? 0) + 1;
      for (const child of n.children ?? []) walk(child, d + 1);
    } else {
      leavesAt[d] = (leavesAt[d] ?? 0) + 1;
    }
  };
  walk(focus, 0);

  let cumLeaves = 0;
  let suggested = 1;
  for (let d = 0; d <= maxDepth; d++) {
    cumLeaves += leavesAt[d] ?? 0;
    const drawn = cumLeaves + (dirsAt[d] ?? 0);
    if (drawn <= target) suggested = d;
    else break;
  }
  return { maxDepth, suggested: Math.max(1, suggested) };
}

/**
 * Lay out a (sub)tree with d3-hierarchy's squarified treemap.
 *
 * We `.sum()` over leaves only (returning 0 for internal nodes) because each
 * directory's `size` already equals its subtree total — d3 re-derives parent
 * values bottom-up from the leaves, so summing internal sizes would double count.
 *
 * The full nested hierarchy is laid out, so every directory group also gets an
 * (x0,y0,x1,y1) rect — used for the hover ring and drill targeting — for free.
 */
export function layoutTreemap(
  root: ScanNode,
  width: number,
  height: number,
  opts: TreemapOptions = {},
): TreemapLayout {
  const { paddingInner = 1 } = opts;

  const h = hierarchy<ScanNode>(root, (d) => d.children)
    .sum((d) => (d.children && d.children.length > 0 ? 0 : d.size))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  // The layout returns a HierarchyRectangularNode with x0/y0/x1/y1 assigned.
  const laidOut = treemap<ScanNode>()
    .tile(treemapSquarify)
    .size([width, height])
    .paddingInner(paddingInner)
    .round(false)(h);

  const nodes: TreemapRect[] = [];
  const leaves: TreemapRect[] = [];
  laidOut.each((n) => {
    const rect: TreemapRect = {
      node: n.data,
      x0: n.x0,
      y0: n.y0,
      x1: n.x1,
      y1: n.y1,
      depth: n.depth,
    };
    nodes.push(rect);
    if (!n.children || n.children.length === 0) leaves.push(rect);
  });

  return { nodes, leaves };
}
