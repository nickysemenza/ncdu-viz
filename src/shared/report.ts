/**
 * Plain-text scan report.
 *
 * The point of this app's curl recipe is that a headless box can pipe a scan up
 * without a browser; the report closes that loop by letting the same box read
 * the findings back the same way. Kept as a pure function (no R2, no Response)
 * so it unit-tests directly and could back a "copy as text" button later.
 */

import { humanBytes } from "./format";
import type { ScanSummary } from "./scanAggregate";

/** Width of the extension histogram, in characters. */
const BAR_WIDTH = 20;
const ROWS = 10;

/** Trim the scan root off an absolute path so lines stay readable. */
function relativize(path: string, root: string): string {
  if (root !== "" && path.startsWith(root)) {
    const rest = path.slice(root.length).replace(/^\/+/, "");
    return rest === "" ? "." : rest;
  }
  return path;
}

/**
 * Drop directories that add nothing over one already listed.
 *
 * A deep tree usually has long pass-through chains — `node_modules`, its
 * `.pnpm`, and the one package inside it can all be within a rounding error of
 * each other — so a plain top-N spends most of its rows restating the same
 * bytes at different depths. Keeping only the first of each near-identical
 * ancestor/descendant chain leaves the rows pointing at genuinely distinct
 * places. Only the report does this; the digest fed to the AI summary keeps the
 * raw ranking.
 */
function collapseChains(rows: { path: string; size: number }[]): { path: string; size: number }[] {
  const kept: { path: string; size: number }[] = [];
  for (const row of rows) {
    const redundant = kept.some((k) => {
      const related = isWithin(row.path, k.path) || isWithin(k.path, row.path);
      if (!related) return false;
      const bigger = Math.max(row.size, k.size);
      // "Essentially all of" — the smaller accounts for ~95%+ of the larger.
      return bigger > 0 && Math.min(row.size, k.size) >= bigger * 0.95;
    });
    if (!redundant) kept.push(row);
  }
  return kept;
}

/** True when `inner` is `outer` or sits beneath it. */
function isWithin(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);
}

function numbered(rows: { path: string; size: number }[], root: string, limit: number): string[] {
  return rows.slice(0, limit).map((r, i) => {
    const n = `${i + 1}.`.padStart(4);
    return `${n} ${humanBytes(r.size).padStart(9)}  ${relativize(r.path, root)}`;
  });
}

export interface ReportOptions {
  /** Shown in the footer so a piped report says where it came from. */
  url?: string;
  /** ISO timestamp after which the scan is deleted. */
  expiresAt?: string;
  rows?: number;
}

/** Render a scan summary as fixed-width text suitable for a terminal. */
export function renderReport(summary: ScanSummary, opts: ReportOptions = {}): string {
  const { meta, stats, digest } = summary;
  const limit = opts.rows ?? ROWS;
  const out: string[] = [];

  const scanned =
    meta.scannedAt !== undefined
      ? new Date(meta.scannedAt * 1000).toISOString().slice(0, 10)
      : "unknown";

  out.push(`${meta.root}  ${humanBytes(stats.totalSize)}`);
  out.push(
    `scanned ${scanned} · ${stats.files.toLocaleString()} files · ` +
      `${stats.dirs.toLocaleString()} dirs · depth ${stats.maxDepth}`,
  );

  if (digest.largestDirs.length > 0) {
    out.push("", "LARGEST DIRECTORIES");
    out.push(...numbered(collapseChains(digest.largestDirs), meta.root, limit));
  }

  if (digest.largestFiles.length > 0) {
    out.push("", "LARGEST FILES");
    out.push(...numbered(digest.largestFiles, meta.root, limit));
  }

  const exts = digest.topExtensions.filter((e) => e.total > 0).slice(0, limit);
  if (exts.length > 0) {
    out.push("", "BY EXTENSION");
    const max = exts[0].total;
    const width = Math.max(...exts.map((e) => (e.ext === "" ? 9 : e.ext.length + 1)));
    for (const e of exts) {
      const label = (e.ext === "" ? "(no ext)" : `.${e.ext}`).padEnd(width);
      // Always show at least one block, so a listed extension is never invisible.
      const filled = max > 0 ? Math.max(1, Math.round((e.total / max) * BAR_WIDTH)) : 0;
      out.push(`  ${label} ${humanBytes(e.total).padStart(9)}  ${"#".repeat(filled)}`);
    }
  }

  if (opts.expiresAt !== undefined || opts.url !== undefined) {
    out.push("");
    if (opts.url !== undefined) out.push(opts.url);
    if (opts.expiresAt !== undefined) {
      out.push(`this scan is deleted after ${opts.expiresAt.slice(0, 10)}`);
    }
  }

  return `${out.join("\n")}\n`;
}
