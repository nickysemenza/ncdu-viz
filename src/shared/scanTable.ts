/**
 * Flat, structure-of-arrays representation of a scanned tree.
 *
 * Why not a pointer tree (`ScanNode`): a real scan is millions of nodes. One JS
 * object per node costs ~93 bytes and, worse, makes every traversal a pointer
 * chase that the GC must trace. The columnar form below is ~46 bytes/node, holds
 * a handful of objects instead of millions, and — critically — is built from
 * `ArrayBuffer`s that can be *transferred* across a worker boundary rather than
 * structured-cloned.
 *
 * ## The load-bearing invariant: pre-order contiguity
 *
 * ncdu emits a directory as `[ {info}, child, child, ... ]`, so JSON nesting *is*
 * tree nesting and emission order is a depth-first pre-order walk by construction.
 * We assign node indices in emission order, which makes index order a pre-order
 * numbering, and therefore:
 *
 *     every subtree is the contiguous index range [i, end[i])
 *
 * That single property is what makes stats, depth histograms, extension totals
 * and top-N selection linear scans over a range instead of recursive walks.
 *
 * It also lets one `end` column stand in for both `firstChild` and `nextSibling`:
 *
 *     firstChild(i)  = i + 1              (valid iff end[i] > i + 1)
 *     nextSibling(j) = end[j]
 *     children(i)    = for (j = i+1; j < end[i]; j = end[j]) yield j
 *
 * A corollary used by the dominant-extension pass: a child's index is always
 * greater than its parent's, so a single reverse scan propagates values upward
 * with no recursion.
 */

import type { ScanMeta, ScanStats } from "./types";
import { joinSegments } from "./path";

/**
 * Per-node bit flags. A plain frozen object rather than a `const enum` because
 * `isolatedModules` is on and `const enum` does not survive single-file transpile.
 */
export const NodeFlag = {
  DIR: 1,
  /** Secondary hard link: bytes are attributed to the first instance, size is 0. */
  DUP_HARDLINK: 2,
  /** Has a row in the hard-link side tables. */
  HAS_LINK: 4,
  /** Name bytes still contain JSON escapes; decode via `JSON.parse`. */
  NAME_ESCAPED: 8,
} as const;

/** Top-N rollup, computed during parse so no consumer has to walk the tree for it. */
export interface ScanDigest {
  topExtensions: { ext: string; total: number }[];
  largestFiles: { path: string; size: number }[];
  largestDirs: { path: string; size: number }[];
}

/**
 * The transferable payload. Every field is either a typed array (whose buffer is
 * moved, not copied, across a worker boundary) or a small plain value.
 *
 * Per-node columns cost 26 bytes: size 8, end/parent/nameOff 4 each, extId and
 * domExtId 2 each, depth and flags 1 each.
 */
export interface ScanPayload {
  nodeCount: number;
  /** Always 0 — the root is the first node emitted. */
  rootIndex: number;

  /** Bytes on disk. For a directory, the summed size of its subtree. */
  size: Float64Array;
  /** Exclusive end of this node's subtree range. A leaf has `end[i] === i + 1`. */
  end: Uint32Array;
  /** Parent index. The root is its own parent. */
  parent: Uint32Array;
  /**
   * Start offset of each name in `nameBytes`. Length is `nodeCount + 1` and the
   * values are monotonic, so a name's length is `nameOff[i + 1] - nameOff[i]` and
   * no separate length column is needed. Monotonicity holds precisely because
   * names are appended in index order, i.e. because of pre-order emission.
   */
  nameOff: Uint32Array;
  /** Index into `extTable`; 0 is the empty extension. */
  extId: Uint16Array;
  /** For a directory, the extension of its single largest leaf descendant. */
  domExtId: Uint16Array;
  /** Depth from the root (root = 0), clamped at 255. */
  depth: Uint8Array;
  /** Bitwise OR of `NodeFlag` values. */
  flags: Uint8Array;

  /** All names concatenated as raw UTF-8, still JSON-escaped as emitted. */
  nameBytes: Uint8Array;
  extTable: string[];
  /** Total leaf bytes per extension id. Indexed like `extTable`. */
  extTotals: Float64Array;
  /**
   * Number of leaves carrying each extension id. Index 0 ("") is reserved before
   * parsing starts, so a zero total cannot by itself tell "no leaf had this
   * extension" apart from "the leaves that had it were empty" — this can.
   */
  extCounts: Uint32Array;

  /**
   * Hard links, as a sparse side table — only a few percent of nodes are hard
   * linked, so a dense per-node column would be mostly zeroes. `linkNode` is
   * ascending (a consequence of pre-order emission), so it is binary-searchable
   * without ever being sorted.
   */
  linkNode: Uint32Array;
  linkId: Uint32Array;
  linkNlink: Uint16Array;
  /** Node indices grouped by link id — the "also linked at" lookup. */
  byLinkId: Uint32Array;
  /** Group offsets into `byLinkId`; length is `distinctLinks + 1`. */
  byLinkOff: Uint32Array;

  meta: ScanMeta;
  stats: ScanStats;
  digest: ScanDigest;
}

/**
 * Every backing buffer in a payload, for use as a `postMessage` transfer list.
 *
 * Without this the payload crosses the worker boundary by structured clone —
 * serialized in the worker and deserialized on the main thread, synchronously,
 * producing a second full copy of everything. Transferring moves the buffers
 * instead, so the main thread receives pointers and does no work.
 *
 * Each buffer must appear exactly once; listing one twice throws DataCloneError.
 */
export function payloadTransferables(p: ScanPayload): Transferable[] {
  const buffers = [
    p.size.buffer,
    p.end.buffer,
    p.parent.buffer,
    p.nameOff.buffer,
    p.extId.buffer,
    p.domExtId.buffer,
    p.depth.buffer,
    p.flags.buffer,
    p.nameBytes.buffer,
    p.extTotals.buffer,
    p.extCounts.buffer,
    p.linkNode.buffer,
    p.linkId.buffer,
    p.linkNlink.buffer,
    p.byLinkId.buffer,
    p.byLinkOff.buffer,
  ];
  // A SharedArrayBuffer cannot be transferred; narrowing here keeps the list valid
  // without an assertion, and we never allocate shared buffers anyway.
  return buffers.filter((b): b is ArrayBuffer => b instanceof ArrayBuffer);
}

const decoder = new TextDecoder();

/**
 * Read-only accessors over a `ScanPayload`.
 *
 * Deliberately *not* a per-node cursor/proxy object. A cursor exposing
 * `.children` would let any generic tree walker (d3-hierarchy being the obvious
 * one) materialize an object per node and reinstate exactly the memory blow-up
 * this representation exists to remove. Callers work with numeric indices.
 */
export class ScanTable {
  /** Memoized decoded names. Cleared wholesale rather than evicted per entry. */
  private nameCache = new Map<number, string>();

  constructor(readonly p: ScanPayload) {}

  get rootIndex(): number {
    return this.p.rootIndex;
  }
  get nodeCount(): number {
    return this.p.nodeCount;
  }
  get meta(): ScanMeta {
    return this.p.meta;
  }
  get stats(): ScanStats {
    return this.p.stats;
  }
  get digest(): ScanDigest {
    return this.p.digest;
  }

  /** Drop memoized names (call when the focus changes and the working set shifts). */
  clearNameCache(): void {
    this.nameCache.clear();
  }

  nameOf(i: number): string {
    const hit = this.nameCache.get(i);
    if (hit !== undefined) return hit;
    const { nameBytes, nameOff, flags } = this.p;
    const raw = decoder.decode(nameBytes.subarray(nameOff[i], nameOff[i + 1]));
    // Escaped names are rare (a handful in millions), so the slow path is lazy.
    // Wrapping in quotes makes the stored bytes valid JSON string content, which
    // gets \uXXXX and surrogate pairs right for free.
    let name = raw;
    if ((flags[i] & NodeFlag.NAME_ESCAPED) !== 0) {
      try {
        const decoded: unknown = JSON.parse(`"${raw}"`);
        if (typeof decoded === "string") name = decoded;
      } catch {
        // Malformed escape — keep the raw bytes rather than losing the name.
      }
    }
    this.nameCache.set(i, name);
    return name;
  }

  sizeOf(i: number): number {
    return this.p.size[i];
  }
  depthOf(i: number): number {
    return this.p.depth[i];
  }
  parentOf(i: number): number {
    return this.p.parent[i];
  }
  subtreeEnd(i: number): number {
    return this.p.end[i];
  }
  /** Node count of the subtree rooted at `i`, including `i` itself. */
  subtreeCount(i: number): number {
    return this.p.end[i] - i;
  }
  isDir(i: number): boolean {
    return (this.p.flags[i] & NodeFlag.DIR) !== 0;
  }
  isDupHardlink(i: number): boolean {
    return (this.p.flags[i] & NodeFlag.DUP_HARDLINK) !== 0;
  }
  hasChildren(i: number): boolean {
    return this.p.end[i] > i + 1;
  }

  extIdOf(i: number): number {
    return this.p.extId[i];
  }
  /** Extension id to color a cell by: a directory uses its dominant leaf's. */
  displayExtIdOf(i: number): number {
    return this.isDir(i) ? this.p.domExtId[i] : this.p.extId[i];
  }
  extOf(i: number): string {
    return this.p.extTable[this.displayExtIdOf(i)] ?? "";
  }

  childCount(i: number): number {
    const end = this.p.end;
    let n = 0;
    for (let j = i + 1; j < end[i]; j = end[j]) n++;
    return n;
  }

  /** Direct children of `i`, in emission order. */
  *children(i: number): IterableIterator<number> {
    const end = this.p.end;
    for (let j = i + 1; j < end[i]; j = end[j]) yield j;
  }

  /** Root-to-`i` index chain, inclusive at both ends. */
  pathIndices(i: number): number[] {
    const parent = this.p.parent;
    const out: number[] = [];
    let cur = i;
    for (;;) {
      out.push(cur);
      const up = parent[cur];
      if (up === cur) break;
      cur = up;
    }
    out.reverse();
    return out;
  }

  pathSegments(i: number): string[] {
    return this.pathIndices(i).map((idx) => this.nameOf(idx));
  }

  pathOf(i: number): string {
    return joinSegments(this.pathSegments(i));
  }

  /**
   * Hard-link details for `i`, or null if it is not hard linked. `otherPaths`
   * lists the in-tree paths sharing the inode, excluding `i` itself.
   */
  linkInfoOf(i: number): { nlink: number; otherPaths: string[] } | null {
    const { flags, linkNode, linkId, linkNlink, byLinkId, byLinkOff } = this.p;
    if ((flags[i] & NodeFlag.HAS_LINK) === 0) return null;
    const row = binarySearch(linkNode, i);
    if (row < 0) return null;
    const id = linkId[row];
    const otherPaths: string[] = [];
    for (let k = byLinkOff[id]; k < byLinkOff[id + 1]; k++) {
      const node = byLinkId[k];
      if (node !== i) otherPaths.push(this.pathOf(node));
    }
    return { nlink: linkNlink[row], otherPaths };
  }
}

/** Index of `value` in an ascending Uint32Array, or -1. */
function binarySearch(arr: Uint32Array, value: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = arr[mid];
    if (v === value) return mid;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
