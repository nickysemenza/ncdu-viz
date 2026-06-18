import { z } from "zod";
import type { ScanMeta, ScanNode } from "./types";

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
 *
 * TODO(hardlinks): ncdu marks hard links with `hlnkc: true` and a shared `ino`.
 * v1 sums sizes as-is (ncdu already counts each inode once within a scan tree).
 * A later pass could dedupe by `ino` across the whole tree.
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

/** Recursively normalize one raw ncdu item. Returns null for an unparseable node. */
function parseItem(item: unknown): ScanNode | null {
  // Directory: a non-empty array whose first element is the dir's info object.
  if (Array.isArray(item)) {
    const info = asObject(item[0]);
    const name = info ? stringField(info, "name") : "";
    const children: ScanNode[] = [];
    let size = 0;
    // A directory's size is the sum of its children; the info object's own
    // `asize` (the dir inode) is intentionally ignored.
    for (let i = 1; i < item.length; i++) {
      const child = parseItem(item[i]);
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
    return { name, size: leafSize(obj), isDir: false, ext: extOf(name) };
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
  const root = parseItem(header[3]);
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
    } else {
      files++;
      if (!largestLeaf || node.size > largestLeaf.size) {
        largestLeaf = { name: node.name, size: node.size };
      }
    }
  };
  walk(root, 0);

  return { totalSize: root.size, files, dirs, maxDepth, largestLeaf };
}
