/**
 * Streaming parser that turns an `ncdu -o` export into a flat `ScanPayload`.
 *
 * ## Why this is a byte scanner and not a line splitter
 *
 * Real `ncdu -o` puts one JSON value per line, which is tempting to exploit —
 * but the exports this app actually has to read come in three whitespace styles:
 * `fixtures/sample.json` is pretty-printed across 21 indented lines,
 * `public/example.json` has no newlines at all, and real scans are one value per
 * line. So nesting is tracked structurally, by bracket depth, and whitespace is
 * simply skipped. Correctness does not depend on ncdu's line discipline.
 *
 * ## Why it works in bytes rather than decoded text
 *
 * The old pipeline concatenated the whole export into one JS string and called
 * `JSON.parse` on it. On a real scan that string is ~750 MB (V8 stores it
 * two-byte because a few hundred of the millions of filenames are non-ASCII),
 * the resulting object graph another ~820 MB, and the normalized tree another
 * ~620 MB — all live at once. Above ~9M nodes it stops working outright, because
 * V8 caps strings at 536,870,888 characters and the concatenation throws.
 *
 * Working in bytes removes all of that: names are `memcpy`'d into one packed
 * buffer and never become JS strings during parsing, and a UTF-8 sequence split
 * across a chunk boundary is just bytes copied verbatim — there is no decoder
 * state on the hot path.
 *
 * ## Size roll-up needs no extra bookkeeping
 *
 * A leaf's size is added to its parent immediately, and a directory's total is
 * added to *its* parent when its closing `]` is seen. The parse stack we already
 * maintain to track nesting is therefore also the summation stack.
 */

import { extOf, joinSegments } from "./path";
import { NodeFlag, type ScanPayload } from "./scanTable";

/** Bytes that separate values and carry no meaning for us. */
function isSkippable(b: number): boolean {
  // space, tab, newline, carriage return, comma, colon
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x2c || b === 0x3a;
}

const CH = {
  QUOTE: 0x22,
  BACKSLASH: 0x5c,
  LBRACE: 0x7b,
  RBRACE: 0x7d,
  LBRACKET: 0x5b,
  RBRACKET: 0x5d,
  DOT: 0x2e,
} as const;

/** Guard against a single unterminated record eating memory on hostile input. */
const MAX_CARRY = 1 << 20;

const TOP_N = 15;

export interface ScanParserOptions {
  /** Decompressed byte estimate, used to size the initial allocations. */
  estimatedBytes?: number;
  /** How many entries to keep for the digest's largest-files/dirs lists. */
  topN?: number;
}

/** Measured on a real 6.7M-node scan; used only to pick initial capacities. */
const BYTES_PER_NODE = 58.6;
const BYTES_PER_NAME_BYTE = 2.97;

interface TopEntry {
  index: number;
  size: number;
}

/**
 * What the byte scanner reports as it walks an export.
 *
 * Splitting this out lets two very different consumers share one loop: the full
 * parser, which builds a flat table, and the aggregate-only pass used
 * server-side, which keeps nothing but a depth-bounded stack and a few counters.
 * That second mode exists because a Cloudflare Worker has a hard 128 MB isolate
 * limit and the table for a real scan is larger than that.
 */
export interface ScanSink {
  /** A `[` opening a directory. */
  openDir(): void;
  /** The matching `]`. */
  closeDir(): void;
  /** A complete `{...}` spanning [start, end). */
  object(data: Uint8Array, start: number, end: number): void;
  /** Any other value: a bare literal or string, which carries no tree meaning. */
  skipValue(): void;
}

/**
 * Structural byte scanner for `ncdu -o` output.
 *
 * Tracks nesting by bracket depth and skips whitespace, so it is indifferent to
 * how the export is line-wrapped — real scans put one value per line, the repo's
 * sample fixture is pretty-printed, and the bundled example has no newlines at
 * all. It also never decodes text: names are handed to the sink as byte ranges,
 * so a UTF-8 sequence straddling a chunk boundary needs no special handling.
 */
export class Scanner {
  private carry: Uint8Array | null = null;
  private sawOuter = false;
  private openDirs = 0;

  constructor(private readonly sink: ScanSink) {}

  push(chunk: Uint8Array): void {
    let data = chunk;
    if (this.carry !== null && this.carry.length > 0) {
      const merged = new Uint8Array(this.carry.length + chunk.length);
      merged.set(this.carry, 0);
      merged.set(chunk, this.carry.length);
      data = merged;
      this.carry = null;
    }
    const consumed = this.scan(data, false);
    if (consumed < data.length) {
      const rest = data.length - consumed;
      if (rest > MAX_CARRY) throw new Error("malformed ncdu export: unterminated record");
      this.carry = data.slice(consumed);
    }
  }

  /** Consume any carried bytes, then close directories left open by a truncated export. */
  flush(): void {
    if (this.carry !== null && this.carry.length > 0) {
      this.scan(this.carry, true);
      this.carry = null;
    }
    while (this.openDirs > 0) {
      this.sink.closeDir();
      this.openDirs--;
    }
  }

  /**
   * Consume as much of `data` as forms complete tokens, returning the number of
   * bytes consumed; the remainder is carried into the next chunk. With `atEof`
   * set, a trailing partial literal is accepted rather than carried.
   */
  private scan(data: Uint8Array, atEof: boolean): number {
    const len = data.length;
    let i = 0;
    while (i < len) {
      const b = data[i];

      if (isSkippable(b)) {
        i++;
        continue;
      }

      if (b === CH.LBRACKET) {
        if (!this.sawOuter) {
          // The outer 4-element tuple: [major, minor, {meta}, ROOT]
          this.sawOuter = true;
        } else {
          this.sink.openDir();
          this.openDirs++;
        }
        i++;
        continue;
      }

      if (b === CH.RBRACKET) {
        if (this.openDirs > 0) {
          this.sink.closeDir();
          this.openDirs--;
        }
        i++;
        continue;
      }

      if (b === CH.LBRACE) {
        const objEnd = findObjectEnd(data, i);
        if (objEnd < 0) return atEof ? len : i;
        this.sink.object(data, i, objEnd);
        i = objEnd;
        continue;
      }

      if (b === CH.QUOTE) {
        // A bare string in value position: a malformed child entry, which the
        // reference parser skips.
        const strEnd = findStringEnd(data, i);
        if (strEnd < 0) return atEof ? len : i;
        this.sink.skipValue();
        i = strEnd;
        continue;
      }

      // number / true / false / null — the header's version ints land here too.
      const litEnd = findLiteralEnd(data, i);
      if (litEnd < 0) {
        if (!atEof) return i;
        this.sink.skipValue();
        return len;
      }
      this.sink.skipValue();
      i = litEnd;
    }
    return len;
  }
}

export class ScanParser implements ScanSink {
  // ---- per-node columns (grown by doubling, trimmed to exact length in finish) ----
  private size: Float64Array;
  private end: Uint32Array;
  private parent: Uint32Array;
  private nameOff: Uint32Array;
  private extId: Uint16Array;
  private depth: Uint8Array;
  private flags: Uint8Array;
  private nameBytes: Uint8Array;

  private nodeCount = 0;
  private nameLen = 0;

  // ---- extension interning ----
  private extTable: string[] = [""];
  private extIndex = new Map<string, number>([["", 0]]);
  private extTotals: number[] = [0];
  private extCounts: number[] = [0];

  // ---- hard links: dev -> ino -> linkId ----
  private linkLookup = new Map<number, Map<number, number>>();
  private linkNode: number[] = [];
  private linkIdOf: number[] = [];
  private linkNlink: number[] = [];
  private linkCount = 0;

  // ---- parse stack ----
  private stackIdx: number[] = [];
  private stackNeedInfo: boolean[] = [];
  private stackDev: number[] = [];

  private meta: { progname?: string; progver?: string; timestamp?: number } = {};
  private finished = false;
  private readonly scanner = new Scanner(this);

  // ---- running aggregates, so nothing has to walk the tree afterwards ----
  private files = 0;
  private dirs = 0;
  private maxDepth = 0;
  private largestLeafIdx = -1;
  private largestLeafSize = -1;
  private topFiles: TopEntry[] = [];
  private topDirs: TopEntry[] = [];
  private readonly topN: number;

  constructor(opts: ScanParserOptions = {}) {
    const est = opts.estimatedBytes ?? 1 << 20;
    this.topN = opts.topN ?? TOP_N;
    const n = Math.max(1024, Math.ceil(est / BYTES_PER_NODE));
    const nb = Math.max(4096, Math.ceil(est / BYTES_PER_NAME_BYTE));
    this.size = new Float64Array(n);
    this.end = new Uint32Array(n);
    this.parent = new Uint32Array(n);
    this.nameOff = new Uint32Array(n + 1);
    this.extId = new Uint16Array(n);
    this.depth = new Uint8Array(n);
    this.flags = new Uint8Array(n);
    this.nameBytes = new Uint8Array(nb);
  }

  get count(): number {
    return this.nodeCount;
  }

  /** Feed the next chunk of decompressed bytes. */
  push(chunk: Uint8Array): void {
    if (this.finished) throw new Error("ScanParser: push after finish");
    this.scanner.push(chunk);
  }

  /** Flush any carried bytes and materialize the payload. */
  finish(): ScanPayload {
    if (this.finished) throw new Error("ScanParser: finish called twice");
    this.scanner.flush();
    this.finished = true;
    if (this.nodeCount === 0) throw new Error("not an ncdu export (no root directory)");
    return this.build();
  }

  // ------------------------------------------------------------------
  // ScanSink
  // ------------------------------------------------------------------

  /**
   * A directory's first element is its info object. If some other kind of value
   * turns up there instead, the reference parser leaves the directory unnamed —
   * mirror that by marking the slot used without recording a name.
   */
  skipValue(): void {
    const top = this.stackNeedInfo.length - 1;
    if (top >= 0 && this.stackNeedInfo[top]) this.stackNeedInfo[top] = false;
  }

  openDir(): void {
    const parentIdx = this.stackIdx.length > 0 ? this.stackIdx[this.stackIdx.length - 1] : -1;
    const dev = this.stackDev.length > 0 ? this.stackDev[this.stackDev.length - 1] : 0;
    const idx = this.allocNode(parentIdx);
    this.flags[idx] |= NodeFlag.DIR;
    this.dirs++;
    this.stackIdx.push(idx);
    this.stackNeedInfo.push(true);
    this.stackDev.push(dev);
  }

  closeDir(): void {
    const idx = this.stackIdx.pop();
    this.stackNeedInfo.pop();
    this.stackDev.pop();
    if (idx === undefined) return;
    this.end[idx] = this.nodeCount;
    // The root's parent is itself; adding there would double the total.
    if (this.stackIdx.length > 0) this.size[this.parent[idx]] += this.size[idx];
    this.considerTopDir(idx);
  }

  /** Handle a `{...}` spanning [start, end) — metadata, directory info, or a file. */
  object(data: Uint8Array, start: number, end: number): void {
    const stackTop = this.stackIdx.length - 1;

    if (stackTop < 0) {
      // Before any directory is open this can only be the header metadata.
      this.readMeta(data, start, end);
      return;
    }

    const fields = readFields(data, start, end);

    if (this.stackNeedInfo[stackTop]) {
      this.stackNeedInfo[stackTop] = false;
      const dirIdx = this.stackIdx[stackTop];
      this.writeName(dirIdx, data, fields.nameStart, fields.nameEnd, fields.nameEscaped);
      if (fields.dev !== null) this.stackDev[stackTop] = fields.dev;
      return;
    }

    this.addFile(data, fields, this.stackIdx[stackTop], this.stackDev[stackTop]);
  }

  private addFile(data: Uint8Array, f: Fields, parentIdx: number, dev: number): void {
    const idx = this.allocNode(parentIdx);
    this.end[idx] = idx + 1;
    this.writeName(idx, data, f.nameStart, f.nameEnd, f.nameEscaped);

    // dsize (actual block allocation) wins over asize, matching the reference.
    let size = f.dsize !== null ? f.dsize : f.asize !== null ? f.asize : 0;

    if (f.ino !== null) {
      this.flags[idx] |= NodeFlag.HAS_LINK;
      let byIno = this.linkLookup.get(dev);
      if (byIno === undefined) {
        byIno = new Map<number, number>();
        this.linkLookup.set(dev, byIno);
      }
      const existing = byIno.get(f.ino);
      if (existing !== undefined) {
        // Secondary instance: the inode's blocks are already counted elsewhere.
        size = 0;
        this.flags[idx] |= NodeFlag.DUP_HARDLINK;
        this.pushLink(idx, existing, f.nlink ?? 0);
      } else {
        const id = this.linkCount++;
        byIno.set(f.ino, id);
        this.pushLink(idx, id, f.nlink !== null && f.nlink > 1 ? f.nlink : 0);
      }
    }

    this.size[idx] = size;
    this.size[parentIdx] += size;

    const ext = this.internExt(idx, data, f.nameStart, f.nameEnd, f.nameEscaped);
    this.extTotals[ext] += size;

    if ((this.flags[idx] & NodeFlag.DUP_HARDLINK) === 0) {
      this.files++;
      if (size > this.largestLeafSize) {
        this.largestLeafSize = size;
        this.largestLeafIdx = idx;
      }
      this.considerTopFile(idx, size);
    }
  }

  private pushLink(node: number, id: number, nlink: number): void {
    this.linkNode.push(node);
    this.linkIdOf.push(id);
    this.linkNlink.push(nlink);
  }

  private readMeta(data: Uint8Array, start: number, end: number): void {
    // One tiny object per export, so correctness beats speed: let JSON do it.
    try {
      const text = new TextDecoder().decode(data.subarray(start, end));
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const progname: unknown = Reflect.get(parsed, "progname");
        const progver: unknown = Reflect.get(parsed, "progver");
        const timestamp: unknown = Reflect.get(parsed, "timestamp");
        if (typeof progname === "string") this.meta.progname = progname;
        if (typeof progver === "string") this.meta.progver = progver;
        if (typeof timestamp === "number") this.meta.timestamp = timestamp;
      }
    } catch {
      // A malformed header object is not fatal; the signature check already ran.
    }
  }

  // ------------------------------------------------------------------
  // storage
  // ------------------------------------------------------------------

  private allocNode(parentIdx: number): number {
    const idx = this.nodeCount++;
    if (idx >= this.size.length) this.growNodes();
    const d = parentIdx < 0 ? 0 : Math.min(255, this.depth[parentIdx] + 1);
    this.depth[idx] = d;
    if (d > this.maxDepth) this.maxDepth = d;
    this.parent[idx] = parentIdx < 0 ? idx : parentIdx;
    this.size[idx] = 0;
    this.end[idx] = idx + 1;
    this.extId[idx] = 0;
    this.flags[idx] = 0;
    this.nameOff[idx] = this.nameLen;
    this.nameOff[idx + 1] = this.nameLen;
    return idx;
  }

  private writeName(
    idx: number,
    data: Uint8Array,
    start: number,
    end: number,
    escaped: boolean,
  ): void {
    const n = end - start;
    if (n > 0) {
      this.ensureNameCapacity(n);
      this.nameBytes.set(data.subarray(start, end), this.nameLen);
      this.nameLen += n;
    }
    this.nameOff[idx + 1] = this.nameLen;
    if (escaped) this.flags[idx] |= NodeFlag.NAME_ESCAPED;
  }

  private growNodes(): void {
    const next = this.size.length * 2;
    this.size = growF64(this.size, next);
    this.end = growU32(this.end, next);
    this.parent = growU32(this.parent, next);
    this.nameOff = growU32(this.nameOff, next + 1);
    this.extId = growU16(this.extId, next);
    this.depth = growU8(this.depth, next);
    this.flags = growU8(this.flags, next);
  }

  private ensureNameCapacity(extra: number): void {
    let cap = this.nameBytes.length;
    if (this.nameLen + extra <= cap) return;
    while (this.nameLen + extra > cap) cap *= 2;
    this.nameBytes = growU8(this.nameBytes, cap);
  }

  // ------------------------------------------------------------------
  // extensions
  // ------------------------------------------------------------------

  /** Resolve the extension id for a name, interning it on first sight. */
  private internExt(
    idx: number,
    data: Uint8Array,
    start: number,
    end: number,
    escaped: boolean,
  ): number {
    const ext = extFromRange(data, start, end, escaped);

    let id = this.extIndex.get(ext);
    if (id === undefined) {
      if (this.extTable.length >= 65535) return 0; // documented ceiling; buckets as ""
      id = this.extTable.length;
      this.extTable.push(ext);
      this.extTotals.push(0);
      this.extCounts.push(0);
      this.extIndex.set(ext, id);
    }
    this.extId[idx] = id;
    this.extCounts[id]++;
    return id;
  }

  // ------------------------------------------------------------------
  // bounded top-N (no full materialization, no global sort)
  // ------------------------------------------------------------------

  private considerTopFile(index: number, size: number): void {
    insertTop(this.topFiles, index, size, this.topN);
  }

  private considerTopDir(index: number): void {
    // The root is not a candidate, matching the reference `topDirs`.
    if (this.parent[index] === index) return;
    insertTop(this.topDirs, index, this.size[index], this.topN);
  }

  // ------------------------------------------------------------------
  // payload assembly
  // ------------------------------------------------------------------

  private build(): ScanPayload {
    const n = this.nodeCount;
    const size = this.size.slice(0, n);
    const end = this.end.slice(0, n);
    const parent = this.parent.slice(0, n);
    const nameOff = this.nameOff.slice(0, n + 1);
    const extId = this.extId.slice(0, n);
    const depth = this.depth.slice(0, n);
    const flags = this.flags.slice(0, n);
    const nameBytes = this.nameBytes.slice(0, this.nameLen);

    // Dominant extension per directory. Children always have a higher index than
    // their parent (pre-order), so one reverse pass propagates the largest leaf
    // upward with no recursion and no per-node Map.
    const domExtId = new Uint16Array(n);
    const domSize = new Float64Array(n);
    for (let i = 0; i < n; i++) domSize[i] = -1;
    for (let i = n - 1; i >= 1; i--) {
      const isDir = (flags[i] & NodeFlag.DIR) !== 0;
      const candExt = isDir ? domExtId[i] : extId[i];
      const candSize = isDir ? domSize[i] : size[i];
      const p = parent[i];
      if (candSize > domSize[p]) {
        domSize[p] = candSize;
        domExtId[p] = candExt;
      }
    }

    const extTotals = Float64Array.from(this.extTotals);
    const extCounts = Uint32Array.from(this.extCounts);

    // Hard-link groups, bucketed by link id. linkNode is already ascending
    // because nodes are appended in pre-order, so no sort is needed.
    const linkRows = this.linkNode.length;
    const linkNode = Uint32Array.from(this.linkNode);
    const linkId = Uint32Array.from(this.linkIdOf);
    const linkNlink = Uint16Array.from(this.linkNlink);
    const byLinkOff = new Uint32Array(this.linkCount + 1);
    for (let r = 0; r < linkRows; r++) byLinkOff[linkId[r] + 1]++;
    for (let k = 0; k < this.linkCount; k++) byLinkOff[k + 1] += byLinkOff[k];
    const byLinkId = new Uint32Array(linkRows);
    const cursor = Uint32Array.from(byLinkOff.subarray(0, this.linkCount));
    for (let r = 0; r < linkRows; r++) byLinkId[cursor[linkId[r]]++] = linkNode[r];

    // Names are decoded only now, and only for the handful of entries that need
    // them (the root, the largest leaf, and the digest's top entries).
    const nameAt = (i: number): string => {
      const raw = nameDecoder.decode(nameBytes.subarray(nameOff[i], nameOff[i + 1]));
      if ((flags[i] & NodeFlag.NAME_ESCAPED) === 0) return raw;
      try {
        const decoded: unknown = JSON.parse(`"${raw}"`);
        if (typeof decoded === "string") return decoded;
      } catch {
        // Malformed escape — keep the raw bytes rather than losing the name.
      }
      return raw;
    };
    const pathAt = (i: number): string => {
      const segs: string[] = [];
      let cur = i;
      for (;;) {
        segs.push(nameAt(cur));
        const up = parent[cur];
        if (up === cur) break;
        cur = up;
      }
      segs.reverse();
      return joinSegments(segs);
    };

    const extOrder = this.extTable
      .map((ext, id) => ({ ext, total: extTotals[id], count: extCounts[id] }))
      // Index 0 ("") is reserved up-front, so drop extensions no leaf ever had.
      .filter((e) => e.count > 0)
      .map((e) => ({ ext: e.ext, total: e.total }))
      .sort((a, b) => b.total - a.total);

    return {
      nodeCount: n,
      rootIndex: 0,
      size,
      end,
      parent,
      nameOff,
      extId,
      domExtId,
      depth,
      flags,
      nameBytes,
      extTable: this.extTable,
      extTotals,
      extCounts,
      linkNode,
      linkId,
      linkNlink,
      byLinkId,
      byLinkOff,
      meta: {
        root: nameAt(0),
        ...(this.meta.timestamp !== undefined ? { scannedAt: this.meta.timestamp } : {}),
        totalSize: size[0],
      },
      stats: {
        totalSize: size[0],
        files: this.files,
        dirs: this.dirs,
        maxDepth: this.maxDepth,
        largestLeaf:
          this.largestLeafIdx >= 0
            ? { name: nameAt(this.largestLeafIdx), size: this.largestLeafSize }
            : null,
      },
      digest: {
        topExtensions: extOrder.slice(0, this.topN),
        largestFiles: this.topFiles.map((e) => ({ path: pathAt(e.index), size: e.size })),
        largestDirs: this.topDirs.map((e) => ({ path: pathAt(e.index), size: e.size })),
      },
    };
  }
}

// ----------------------------------------------------------------------
// field extraction
// ----------------------------------------------------------------------

export interface Fields {
  nameStart: number;
  nameEnd: number;
  nameEscaped: boolean;
  asize: number | null;
  dsize: number | null;
  ino: number | null;
  nlink: number | null;
  dev: number | null;
}

/**
 * Pull the fields we care about out of an object spanning [start, end).
 * Unknown keys (`hlnkc`, `notreg`, `excluded`, `err`, ...) are skipped
 * structurally, including nested objects and arrays, so new ncdu fields cannot
 * break this.
 */
export function readFields(data: Uint8Array, start: number, end: number): Fields {
  const f: Fields = {
    nameStart: 0,
    nameEnd: 0,
    nameEscaped: false,
    asize: null,
    dsize: null,
    ino: null,
    nlink: null,
    dev: null,
  };
  let i = start + 1; // skip '{'
  while (i < end) {
    const b = data[i];
    if (isSkippable(b) || b === CH.RBRACE) {
      i++;
      continue;
    }
    if (b !== CH.QUOTE) {
      i++;
      continue;
    }
    const keyStart = i + 1;
    const keyEnd = findStringEnd(data, i) - 1; // exclusive of closing quote
    if (keyEnd < keyStart) break;
    i = keyEnd + 1;
    // advance to the value
    while (i < end && (isSkippable(data[i]) || data[i] === 0x3a)) i++;
    if (i >= end) break;

    const key = asciiKey(data, keyStart, keyEnd);
    const v = data[i];

    if (v === CH.QUOTE) {
      const vEnd = findStringEnd(data, i);
      if (vEnd < 0) break;
      if (key === "name") {
        f.nameStart = i + 1;
        f.nameEnd = vEnd - 1;
        f.nameEscaped = hasBackslash(data, f.nameStart, f.nameEnd);
      }
      i = vEnd;
      continue;
    }
    if (v === CH.LBRACE) {
      const vEnd = findObjectEnd(data, i);
      i = vEnd < 0 ? end : vEnd;
      continue;
    }
    if (v === CH.LBRACKET) {
      const vEnd = findArrayEnd(data, i);
      i = vEnd < 0 ? end : vEnd;
      continue;
    }
    const vEnd = findLiteralEnd(data, i, end);
    const stop = vEnd < 0 ? end : vEnd;
    switch (key) {
      case "asize":
        f.asize = parseNumber(data, i, stop);
        break;
      case "dsize":
        f.dsize = parseNumber(data, i, stop);
        break;
      case "ino":
        f.ino = parseNumber(data, i, stop);
        break;
      case "nlink":
        f.nlink = parseNumber(data, i, stop);
        break;
      case "dev":
        f.dev = parseNumber(data, i, stop);
        break;
      default:
        break;
    }
    i = stop;
  }
  return f;
}

/** Decode a name byte range, unescaping only if the parser flagged it. */
export function decodeNameRange(
  data: Uint8Array,
  start: number,
  end: number,
  escaped: boolean,
): string {
  const raw = new TextDecoder().decode(data.subarray(start, end));
  if (!escaped) return raw;
  try {
    const decoded: unknown = JSON.parse(`"${raw}"`);
    if (typeof decoded === "string") return decoded;
  } catch {
    // Malformed escape — keep the raw bytes rather than losing the name.
  }
  return raw;
}

/**
 * Extension for a name byte range, matching `extOf` exactly.
 *
 * Escaped names are rare enough to afford decoding and deferring to the shared
 * implementation; everything else is derived straight from the bytes, since `.`
 * is ASCII and UTF-8 is self-synchronizing.
 */
export function extFromRange(
  data: Uint8Array,
  start: number,
  end: number,
  escaped: boolean,
): string {
  if (escaped) return extOf(decodeNameRange(data, start, end, true));
  let dot = -1;
  for (let i = end - 1; i > start; i--) {
    if (data[i] === CH.DOT) {
      dot = i;
      break;
    }
  }
  // `dot === start` means a leading-dot dotfile, which has no extension.
  return dot > start ? extFromBytes(data, dot + 1, end) : "";
}

/** ncdu's keys are short and ASCII, so this avoids a TextDecoder per field. */
function asciiKey(data: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(data[i]);
  return s;
}

function hasBackslash(data: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (data[i] === CH.BACKSLASH) return true;
  return false;
}

/**
 * Build a lowercased extension from raw bytes. Pure-ASCII is the overwhelmingly
 * common case and avoids allocating a decoder; anything else falls back so that
 * non-ASCII extensions match the reference implementation exactly.
 */
function extFromBytes(data: Uint8Array, start: number, end: number): string {
  let ascii = true;
  for (let i = start; i < end; i++) {
    if (data[i] >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (!ascii) return new TextDecoder().decode(data.subarray(start, end)).toLowerCase();
  let s = "";
  for (let i = start; i < end; i++) {
    const c = data[i];
    s += String.fromCharCode(c >= 0x41 && c <= 0x5a ? c + 32 : c);
  }
  return s;
}

function parseNumber(data: Uint8Array, start: number, end: number): number | null {
  let i = start;
  let neg = false;
  if (i < end && data[i] === 0x2d) {
    neg = true;
    i++;
  }
  let v = 0;
  let digits = 0;
  let simple = true;
  for (; i < end; i++) {
    const c = data[i];
    if (c >= 0x30 && c <= 0x39) {
      v = v * 10 + (c - 0x30);
      digits++;
    } else {
      simple = false;
      break;
    }
  }
  if (!simple) {
    // Exponent or fraction — hand it to Number rather than getting it subtly wrong.
    const text = new TextDecoder().decode(data.subarray(start, end));
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (digits === 0) return null;
  return neg ? -v : v;
}

// ----------------------------------------------------------------------
// token boundary helpers — all return an exclusive end, or -1 if incomplete
// ----------------------------------------------------------------------

/** End of the string starting at the quote `start`, exclusive of the closing quote. */
function findStringEnd(data: Uint8Array, start: number): number {
  for (let i = start + 1; i < data.length; i++) {
    const c = data[i];
    if (c === CH.BACKSLASH) {
      i++;
      continue;
    }
    if (c === CH.QUOTE) return i + 1;
  }
  return -1;
}

function findObjectEnd(data: Uint8Array, start: number): number {
  return findBalanced(data, start, CH.LBRACE, CH.RBRACE);
}

function findArrayEnd(data: Uint8Array, start: number): number {
  return findBalanced(data, start, CH.LBRACKET, CH.RBRACKET);
}

function findBalanced(data: Uint8Array, start: number, open: number, close: number): number {
  let depth = 0;
  for (let i = start; i < data.length; i++) {
    const c = data[i];
    if (c === CH.QUOTE) {
      const e = findStringEnd(data, i);
      if (e < 0) return -1;
      i = e - 1;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** End of a bare literal (number/true/false/null), or -1 if it runs off the end. */
function findLiteralEnd(data: Uint8Array, start: number, limit?: number): number {
  const end = limit ?? data.length;
  for (let i = start; i < end; i++) {
    const c = data[i];
    if (isSkippable(c) || c === CH.RBRACE || c === CH.RBRACKET) return i;
  }
  return limit !== undefined ? end : -1;
}

// ----------------------------------------------------------------------
// misc
// ----------------------------------------------------------------------

/**
 * Keep the `limit` largest entries. Insertion uses a strict `>` so that ties
 * resolve in pre-order — matching a stable sort of the full list, which is what
 * the reference implementation's `sort` + `slice` produces.
 */
function insertTop(arr: TopEntry[], index: number, size: number, limit: number): void {
  if (arr.length === limit && size <= arr[limit - 1].size) return;
  let pos = arr.length;
  for (let k = 0; k < arr.length; k++) {
    if (size > arr[k].size) {
      pos = k;
      break;
    }
  }
  arr.splice(pos, 0, { index, size });
  if (arr.length > limit) arr.length = limit;
}

const nameDecoder = new TextDecoder();

function growF64(src: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n);
  out.set(src);
  return out;
}
function growU32(src: Uint32Array, n: number): Uint32Array {
  const out = new Uint32Array(n);
  out.set(src);
  return out;
}
function growU16(src: Uint16Array, n: number): Uint16Array {
  const out = new Uint16Array(n);
  out.set(src);
  return out;
}
function growU8(src: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  out.set(src);
  return out;
}

/** Parse a whole in-memory export. Convenience wrapper used by tests. */
export function parseScanBytes(bytes: Uint8Array, chunkSize = bytes.length): ScanPayload {
  const parser = new ScanParser({ estimatedBytes: bytes.length });
  for (let i = 0; i < bytes.length; i += chunkSize) {
    parser.push(bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return parser.finish();
}
