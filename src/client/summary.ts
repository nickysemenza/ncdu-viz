import type { ScanTable } from "../shared/scanTable";
import { SummaryResponseSchema, type SummaryDigest } from "../shared/dto";

const TOP = 15;

/**
 * Assemble the digest the summary endpoint needs.
 *
 * This used to run four full-tree walks on the main thread — `summarize`,
 * `buildExtColors`, `flattenLeaves` and `topDirs` — of which `flattenLeaves`
 * materialized one object and one joined path string per leaf and sorted the
 * lot, to keep fifteen. On a multi-million-node scan that alone was the single
 * largest stall in loading a shared scan. All of it is now computed in the parse
 * worker as the bytes stream past, so this is pure field shuffling.
 */
export function buildDigest(slug: string, table: ScanTable): SummaryDigest {
  const { meta, stats, digest } = table;
  return {
    slug,
    root: meta.root,
    totalSize: stats.totalSize,
    files: stats.files,
    dirs: stats.dirs,
    topExtensions: digest.topExtensions.slice(0, TOP).map((e) => ({ ext: e.ext, total: e.total })),
    largestFiles: digest.largestFiles.slice(0, TOP).map((f) => ({ path: f.path, size: f.size })),
    largestDirs: digest.largestDirs.slice(0, TOP).map((d) => ({ path: d.path, size: d.size })),
  };
}

/** POST a digest to /api/summary and return the generated summary text. */
export async function requestSummary(digest: SummaryDigest): Promise<string> {
  const res = await fetch("/api/summary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(digest),
  });
  if (!res.ok) throw new Error((await res.text()).trim() || `summary failed (${res.status})`);
  return SummaryResponseSchema.parse(await res.json()).summary;
}
