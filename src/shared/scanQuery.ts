/**
 * Queries over a `ScanTable`.
 *
 * Every function here exploits pre-order contiguity: the subtree rooted at
 * `focus` is exactly the index range `[focus, end[focus])`, so each of these is a
 * linear scan over a slice of typed arrays rather than a recursive pointer walk.
 *
 * The other theme is bounded output. The reference implementations these replace
 * materialized one object (and one joined path string) per node and then sorted
 * the lot, only to keep the top handful — which on a real scan meant millions of
 * allocations to display a thousand rows. Here the scan keeps a small ordered
 * buffer and only builds names and paths for the entries that survive.
 */

import type { DirEntry, LeafEntry } from "./types";
import { NodeFlag } from "./scanTable";
import type { ScanTable } from "./scanTable";

/**
 * Depth range and an adaptive default for the detail slider, relative to `focus`
 * (focus = depth 0). The default is the deepest level whose drawn-cell count
 * (leaves at-or-above it, plus directories collapsed at it) stays under `target`,
 * so a huge scan opens legibly instead of as thousands of sub-pixel cells.
 */
export function depthStats(
  t: ScanTable,
  focus: number,
  target = 1500,
): { maxDepth: number; suggested: number } {
  const { depth, end, flags } = t.p;
  const base = depth[focus];
  const stop = end[focus];
  const leavesAt: number[] = [];
  const dirsAt: number[] = [];
  let maxDepth = 0;

  for (let i = focus; i < stop; i++) {
    const d = depth[i] - base;
    if (d > maxDepth) maxDepth = d;
    const isDir = (flags[i] & NodeFlag.DIR) !== 0;
    if (isDir && end[i] > i + 1) dirsAt[d] = (dirsAt[d] ?? 0) + 1;
    else leavesAt[d] = (leavesAt[d] ?? 0) + 1;
  }

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

/** Total node count under `focus`, including `focus`. */
export function subtreeSize(t: ScanTable, focus: number): number {
  return t.p.end[focus] - focus;
}

interface Ranked {
  index: number;
  size: number;
}

/**
 * Keep the `limit` largest entries seen so far.
 *
 * Insertion uses a strict `>` so ties resolve in pre-order, which is what a
 * stable sort of the whole list followed by `slice` produces. That makes the
 * output identical to the reference implementation's, not merely equivalent.
 */
function insertRanked(buf: Ranked[], index: number, size: number, limit: number): void {
  if (buf.length === limit && size <= buf[limit - 1].size) return;
  let pos = buf.length;
  for (let k = 0; k < buf.length; k++) {
    if (size > buf[k].size) {
      pos = k;
      break;
    }
  }
  buf.splice(pos, 0, { index, size });
  if (buf.length > limit) buf.length = limit;
}

export interface TopLeaves {
  rows: LeafEntry[];
  /** Every non-duplicate leaf under `focus`, so the UI can say "N of M". */
  totalFiles: number;
}

/**
 * The `limit` largest files under `focus`, largest first.
 *
 * Replaces `flattenLeaves`, which built a `LeafEntry` and a joined path string
 * for every leaf in the subtree and sorted them all. Secondary hard links are
 * skipped, matching the reference: their bytes are attributed to the first
 * instance, and the kept row lists the other paths sharing the inode.
 */
export function topLeaves(t: ScanTable, focus: number, limit: number): TopLeaves {
  const { end, flags, size } = t.p;
  const stop = end[focus];
  const buf: Ranked[] = [];
  let totalFiles = 0;

  for (let i = focus; i < stop; i++) {
    const f = flags[i];
    if ((f & NodeFlag.DIR) !== 0) continue;
    if ((f & NodeFlag.DUP_HARDLINK) !== 0) continue;
    totalFiles++;
    insertRanked(buf, i, size[i], limit);
  }

  const rows = buf.map((e) => {
    const row: LeafEntry = {
      name: t.nameOf(e.index),
      size: e.size,
      ext: t.p.extTable[t.p.extId[e.index]] ?? "",
      path: t.pathOf(e.index),
    };
    const link = t.linkInfoOf(e.index);
    if (link !== null) {
      if (link.nlink > 1) row.nlink = link.nlink;
      if (link.otherPaths.length > 0) row.links = link.otherPaths;
    }
    return row;
  });

  return { rows, totalFiles };
}

/**
 * The `limit` largest directories under `focus`, excluding `focus` itself —
 * matching the reference `topDirs`, which also skips the node it starts from.
 */
export function topDirs(t: ScanTable, focus: number, limit: number): DirEntry[] {
  const { end, flags, size } = t.p;
  const stop = end[focus];
  const buf: Ranked[] = [];

  for (let i = focus + 1; i < stop; i++) {
    if ((flags[i] & NodeFlag.DIR) === 0) continue;
    insertRanked(buf, i, size[i], limit);
  }

  return buf.map((e) => ({ name: t.nameOf(e.index), size: e.size, path: t.pathOf(e.index) }));
}
