import { z } from "zod";
import type { ScanMeta, ScanNode } from "./types";
import { joinSegments } from "./path";

/**
 * Defensive, hand-rolled parser for the ncdu `-o` JSON export.
 *
 * Design notes:
 * - We do NOT schema-validate every tree node (a real scan is hundreds of
 *   thousands to millions of nodes). Zod is used ONLY at the boundary: the
 *   4-element header tuple + metadata object — a cheap "is this really ncdu"
 *   check. Everything below is walked by a recursive parser that guards on
 *   array-vs-object, tolerates missing/extra fields, and never throws on a
 *   single bad node.
 *
 * Format (decoded):
 *   [ MAJOR, MINOR, { progname:"ncdu", progver, timestamp }, ROOT ]
 *   Directory: [ {name, asize, dev}, <child>, <child>, ... ]
 *   File:      { name, asize, dsize?, ino?, hlnkc?, nlink? }
 *
 * Hard links: ncdu emits `ino` only for hard-linked files and flags *every*
 * instance with `hlnkc:true` (there is no unmarked "primary"). We dedupe by
 * (dev, ino) during the walk — the first instance keeps its size, later ones
 * are zeroed and flagged `dupHardlink` — so each inode's blocks are counted
 * once, matching ncdu's own totals. See `parseNcdu`.
 */

/** Metadata object at index 2 of the export. Extra keys are stripped, not rejected. */
const MetaSchema = z.object({
  progname: z.literal("ncdu"),
  progver: z.string().optional(),
  timestamp: z.number().optional(),
});

/** The 4-element top-level tuple. ROOT is left as `unknown` for the defensive walk. */
const HeaderSchema = z.tuple([z.number(), z.number(), MetaSchema, z.unknown()]);

export interface ParseResult {
  root: ScanNode;
  meta: ScanMeta;
}

/**
 * Effective on-disk size of a leaf: prefer `dsize` (actual block allocation),
 * else fall back to `asize`, else 0.
 */
function leafSize(obj: Record<string, unknown>): number {
  const dsize = obj["dsize"];
  if (typeof dsize === "number" && Number.isFinite(dsize)) return dsize;
  const asize = obj["asize"];
  if (typeof asize === "number" && Number.isFinite(asize)) return asize;
  return 0;
}

/** Lowercased extension without the leading dot; "" for no extension or dotfiles. */
export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return ""; // no dot, or leading-dot dotfile (e.g. ".bashrc")
  return name.slice(dot + 1).toLowerCase();
}

/** Narrow an unknown JSON value to a plain (non-array) object, or null. */
function asObject(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  // Narrowing untrusted JSON to an indexable record at the parse boundary.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return v as Record<string, unknown>;
}

/** Read a string field defensively, defaulting to "". */
function stringField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

/** Read a finite-number field defensively, or null if absent/invalid. */
function numberField(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Per-walk dedupe state. `seen` holds the `${dev}:${ino}` keys of hard-linked
 * inodes already counted; `dev` is the device id of the current subtree
 * (inherited from the nearest ancestor that declared one).
 */
interface ParseCtx {
  seen: Set<string>;
  dev: number;
}

/** Recursively normalize one raw ncdu item. Returns null for an unparseable node. */
function parseItem(item: unknown, ctx: ParseCtx): ScanNode | null {
  // Directory: a non-empty array whose first element is the dir's info object.
  if (Array.isArray(item)) {
    const info = asObject(item[0]);
    const name = info ? stringField(info, "name") : "";
    // ncdu emits `dev` when a directory crosses a filesystem boundary; inherit
    // it so inode keys are scoped to the right device.
    const dev = info ? numberField(info, "dev") : null;
    const childCtx: ParseCtx = dev === null ? ctx : { seen: ctx.seen, dev };
    const children: ScanNode[] = [];
    let size = 0;
    // A directory's size is the sum of its children; the info object's own
    // `asize` (the dir inode) is intentionally ignored.
    for (let i = 1; i < item.length; i++) {
      const child = parseItem(item[i], childCtx);
      if (child) {
        children.push(child);
        size += child.size;
      }
    }
    return { name, size, isDir: true, children };
  }

  // File: a plain object.
  const obj = asObject(item);
  if (obj) {
    const name = stringField(obj, "name");
    const node: ScanNode = { name, size: leafSize(obj), isDir: false, ext: extOf(name) };
    // Hard link: ncdu only sets `ino` on multiply-linked files. Count the first
    // occurrence of each inode at full size; zero out and flag the rest so the
    // shared blocks aren't double-counted (matches ncdu's own totals).
    const ino = numberField(obj, "ino");
    if (ino !== null) {
      const key = `${ctx.dev}:${ino}`;
      node.linkKey = key;
      if (ctx.seen.has(key)) {
        node.size = 0;
        node.dupHardlink = true;
      } else {
        ctx.seen.add(key);
        const nlink = numberField(obj, "nlink");
        if (nlink !== null && nlink > 1) node.nlink = nlink;
      }
    }
    return node;
  }

  // Anything else (string, number, null) is a malformed node — skip it.
  return null;
}

/**
 * Parse a fully-decoded ncdu JSON value into a normalized tree + metadata.
 * Throws only if the value is not a recognizable ncdu export (the boundary
 * check); never throws on individual malformed nodes within the tree.
 */
export function parseNcdu(raw: unknown): ParseResult {
  const header = HeaderSchema.parse(raw);
  const meta = header[2];
  const root = parseItem(header[3], { seen: new Set(), dev: 0 });
  if (!root || !root.isDir) {
    throw new Error("ncdu root is not a directory");
  }
  return {
    root,
    meta: {
      root: root.name,
      scannedAt: meta.timestamp,
      totalSize: root.size,
    },
  };
}

export interface ScanStats {
  totalSize: number;
  files: number;
  dirs: number;
  /** Max edges from the root (root = depth 0). */
  maxDepth: number;
  largestLeaf: { name: string; size: number } | null;
}

export interface LeafEntry {
  name: string;
  size: number;
  ext: string;
  /** Absolute path from the scan root. */
  path: string;
  /** Hard-link count, if this file is hard-linked (nlink > 1). */
  nlink?: number;
  /**
   * Other in-tree paths that share this file's inode (the dropped hard-link
   * instances). Present only on the kept row of a hard-linked inode.
   */
  links?: string[];
}

/**
 * Collect every leaf under `focus`, sorted by size descending. `focusSegments`
 * is the absolute path chain to `focus` (inclusive) so each entry gets a full
 * path. Used by the "Files" list view.
 */
export function flattenLeaves(focus: ScanNode, focusSegments: string[]): LeafEntry[] {
  const out: LeafEntry[] = [];
  // linkKey -> every in-tree path sharing that inode (kept + dropped instances),
  // plus the kept entries awaiting their sibling paths once the walk completes.
  const pathsByKey = new Map<string, string[]>();
  const pending: { entry: LeafEntry; key: string }[] = [];
  const walk = (node: ScanNode, segs: string[]): void => {
    if (node.isDir) {
      for (const child of node.children ?? []) walk(child, [...segs, node.name]);
      return;
    }
    const path = joinSegments([...segs, node.name]);
    if (node.linkKey) {
      const arr = pathsByKey.get(node.linkKey);
      if (arr) arr.push(path);
      else pathsByKey.set(node.linkKey, [path]);
    }
    // Dropped hard-link dups still contribute their path above, but aren't rows.
    if (node.dupHardlink) return;
    const entry: LeafEntry = {
      name: node.name,
      size: node.size,
      ext: node.ext ?? "",
      path,
      ...(node.nlink ? { nlink: node.nlink } : {}),
    };
    out.push(entry);
    if (node.linkKey) pending.push({ entry, key: node.linkKey });
  };
  // `focusSegments` already ends at focus.name, so descend into its children.
  if (focus.isDir) {
    for (const child of focus.children ?? []) walk(child, focusSegments);
  } else {
    out.push({
      name: focus.name,
      size: focus.size,
      ext: focus.ext ?? "",
      path: joinSegments(focusSegments),
    });
  }
  // Attach each kept hard link's sibling paths (the dropped instances).
  for (const { entry, key } of pending) {
    const others = (pathsByKey.get(key) ?? []).filter((p) => p !== entry.path);
    if (others.length > 0) entry.links = others;
  }
  out.sort((a, b) => b.size - a.size);
  return out;
}

export interface DirEntry {
  name: string;
  size: number;
  /** Absolute path from the scan root. */
  path: string;
}

/** The `limit` largest directories under `root` (excluding root itself), by size. */
export function topDirs(root: ScanNode, limit: number): DirEntry[] {
  const out: DirEntry[] = [];
  const walk = (node: ScanNode, segs: string[]): void => {
    if (!node.isDir) return;
    const next = [...segs, node.name];
    out.push({ name: node.name, size: node.size, path: joinSegments(next) });
    for (const child of node.children ?? []) walk(child, next);
  };
  for (const child of root.children ?? []) walk(child, [root.name]);
  out.sort((a, b) => b.size - a.size);
  return out.slice(0, limit);
}

/** Walk a normalized tree and compute summary stats (used by tests + the UI header). */
export function summarize(root: ScanNode): ScanStats {
  let files = 0;
  let dirs = 0;
  let maxDepth = 0;
  let largestLeaf: { name: string; size: number } | null = null;

  const walk = (node: ScanNode, depth: number): void => {
    if (depth > maxDepth) maxDepth = depth;
    if (node.isDir) {
      dirs++;
      for (const child of node.children ?? []) walk(child, depth + 1);
    } else if (!node.dupHardlink) {
      // Secondary hard links are zeroed dups of an already-counted inode — skip
      // them so file counts and the largest-leaf reflect unique files.
      files++;
      if (!largestLeaf || node.size > largestLeaf.size) {
        largestLeaf = { name: node.name, size: node.size };
      }
    }
  };
  walk(root, 0);

  return { totalSize: root.size, files, dirs, maxDepth, largestLeaf };
}
