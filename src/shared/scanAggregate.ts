/**
 * Aggregate-only pass over an ncdu export: totals and top-N, no table.
 *
 * This exists because a Cloudflare Worker has a hard 128 MB per-isolate memory
 * limit, and the flat table for a real scan is larger than that — so the server
 * can never build one. What it can do is stream the same bytes through the same
 * scanner while keeping only:
 *
 *   - a stack bounded by directory depth (a name and a running size per level)
 *   - per-extension totals (a few thousand entries)
 *   - two fixed-size top-N buffers
 *   - a set of hard-linked inodes, to avoid counting shared blocks twice
 *
 * Memory is therefore independent of scan size, and the numbers are identical to
 * what the full parser produces — `scanAggregate.test.ts` asserts that directly.
 */

import { joinSegments } from "./path";
import { Scanner, readFields, decodeNameRange, extFromRange, type ScanSink } from "./scanParse";
import type { ScanDigest } from "./scanTable";
import type { ScanMeta, ScanStats } from "./types";

export interface ScanSummary {
  meta: ScanMeta;
  stats: ScanStats;
  digest: ScanDigest;
}

const TOP_N = 15;

interface TopEntry {
  path: string;
  size: number;
}

/**
 * Strict `>` insertion, so ties resolve in pre-order — matching a stable sort of
 * the full list, which is what the reference implementation produces.
 */
function insertTop(buf: TopEntry[], entry: TopEntry, limit: number): void {
  if (buf.length === limit && entry.size <= buf[limit - 1].size) return;
  let pos = buf.length;
  for (let k = 0; k < buf.length; k++) {
    if (entry.size > buf[k].size) {
      pos = k;
      break;
    }
  }
  buf.splice(pos, 0, entry);
  if (buf.length > limit) buf.length = limit;
}

export class ScanAggregator implements ScanSink {
  private readonly scanner = new Scanner(this);
  private readonly topN: number;

  // One entry per open directory — the only structure that grows with the input,
  // and it is bounded by tree depth rather than node count.
  private stackName: string[] = [];
  private stackSize: number[] = [];
  private stackDev: number[] = [];
  private stackNeedInfo: boolean[] = [];

  private extTotals = new Map<string, number>();
  private seenInodes = new Map<number, Set<number>>();

  private rootName = "";
  private rootSize = 0;
  private timestamp: number | undefined;

  private files = 0;
  private dirs = 0;
  private maxDepth = 0;
  private largestLeaf: { name: string; size: number } | null = null;
  private topFiles: TopEntry[] = [];
  private topDirs: TopEntry[] = [];
  private finished = false;

  constructor(opts: { topN?: number } = {}) {
    this.topN = opts.topN ?? TOP_N;
  }

  push(chunk: Uint8Array): void {
    if (this.finished) throw new Error("ScanAggregator: push after finish");
    this.scanner.push(chunk);
  }

  finish(): ScanSummary {
    if (this.finished) throw new Error("ScanAggregator: finish called twice");
    this.scanner.flush();
    this.finished = true;
    if (this.dirs === 0) throw new Error("not an ncdu export (no root directory)");

    const extOrder = [...this.extTotals.entries()]
      .map(([ext, total]) => ({ ext, total }))
      .sort((a, b) => b.total - a.total);

    return {
      meta: {
        root: this.rootName,
        ...(this.timestamp !== undefined ? { scannedAt: this.timestamp } : {}),
        totalSize: this.rootSize,
      },
      stats: {
        totalSize: this.rootSize,
        files: this.files,
        dirs: this.dirs,
        maxDepth: this.maxDepth,
        largestLeaf: this.largestLeaf,
      },
      digest: {
        topExtensions: extOrder.slice(0, this.topN),
        largestFiles: this.topFiles.map((e) => ({ path: e.path, size: e.size })),
        largestDirs: this.topDirs.map((e) => ({ path: e.path, size: e.size })),
      },
    };
  }

  // ---- ScanSink ----

  skipValue(): void {
    const top = this.stackNeedInfo.length - 1;
    if (top >= 0 && this.stackNeedInfo[top]) this.stackNeedInfo[top] = false;
  }

  openDir(): void {
    const dev = this.stackDev.length > 0 ? this.stackDev[this.stackDev.length - 1] : 0;
    this.stackName.push("");
    this.stackSize.push(0);
    this.stackDev.push(dev);
    this.stackNeedInfo.push(true);
    this.dirs++;
    const depth = this.stackName.length - 1;
    if (depth > this.maxDepth) this.maxDepth = depth;
  }

  closeDir(): void {
    const depth = this.stackName.length - 1;
    if (depth < 0) return;
    const size = this.stackSize[depth];
    // Build the path before popping — the stack still holds this directory.
    if (depth > 0) {
      const path = joinSegments(this.stackName);
      insertTop(this.topDirs, { path, size }, this.topN);
    } else {
      this.rootName = this.stackName[0];
      this.rootSize = size;
    }
    this.stackName.pop();
    this.stackSize.pop();
    this.stackDev.pop();
    this.stackNeedInfo.pop();
    if (this.stackSize.length > 0) this.stackSize[this.stackSize.length - 1] += size;
  }

  object(data: Uint8Array, start: number, end: number): void {
    const top = this.stackNeedInfo.length - 1;
    if (top < 0) {
      this.readMeta(data, start, end);
      return;
    }

    const f = readFields(data, start, end);

    if (this.stackNeedInfo[top]) {
      this.stackNeedInfo[top] = false;
      this.stackName[top] = decodeNameRange(data, f.nameStart, f.nameEnd, f.nameEscaped);
      if (f.dev !== null) this.stackDev[top] = f.dev;
      return;
    }

    // A file sits one level below the directory holding it, and the deepest node
    // in a scan is usually a file rather than a directory.
    const fileDepth = top + 1;
    if (fileDepth > this.maxDepth) this.maxDepth = fileDepth;

    let size = f.dsize !== null ? f.dsize : f.asize !== null ? f.asize : 0;
    let dup = false;

    if (f.ino !== null) {
      const dev = this.stackDev[top];
      let inodes = this.seenInodes.get(dev);
      if (inodes === undefined) {
        inodes = new Set<number>();
        this.seenInodes.set(dev, inodes);
      }
      if (inodes.has(f.ino)) {
        // Secondary hard link: the blocks were counted at the first instance.
        size = 0;
        dup = true;
      } else {
        inodes.add(f.ino);
      }
    }

    this.stackSize[top] += size;

    const ext = extFromRange(data, f.nameStart, f.nameEnd, f.nameEscaped);
    this.extTotals.set(ext, (this.extTotals.get(ext) ?? 0) + size);

    if (dup) return;
    this.files++;

    // Names and paths are only built for entries that make the cut, so the common
    // case is a single size comparison.
    if (this.largestLeaf === null || size > this.largestLeaf.size) {
      this.largestLeaf = {
        name: decodeNameRange(data, f.nameStart, f.nameEnd, f.nameEscaped),
        size,
      };
    }
    if (this.topFiles.length < this.topN || size > this.topFiles[this.topFiles.length - 1].size) {
      const name = decodeNameRange(data, f.nameStart, f.nameEnd, f.nameEscaped);
      insertTop(this.topFiles, { path: joinSegments([...this.stackName, name]), size }, this.topN);
    }
  }

  private readMeta(data: Uint8Array, start: number, end: number): void {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(data.subarray(start, end)));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const ts: unknown = Reflect.get(parsed, "timestamp");
        if (typeof ts === "number") this.timestamp = ts;
      }
    } catch {
      // A malformed header object is not fatal.
    }
  }
}

/** Aggregate a whole in-memory export. Convenience wrapper used by tests. */
export function aggregateScanBytes(bytes: Uint8Array, chunkSize = bytes.length): ScanSummary {
  const agg = new ScanAggregator();
  for (let i = 0; i < bytes.length; i += chunkSize) {
    agg.push(bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return agg.finish();
}
