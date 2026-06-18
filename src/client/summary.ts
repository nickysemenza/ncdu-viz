import type { ParseResult } from "../shared/ncdu";
import { flattenLeaves, summarize, topDirs } from "../shared/ncdu";
import { buildExtColors } from "../shared/color";
import { SummaryResponseSchema, type SummaryDigest } from "../shared/dto";

const TOP = 15;

/** Build the compact digest the summary endpoint needs from a parsed scan. */
export function buildDigest(slug: string, scan: ParseResult): SummaryDigest {
  const { root, meta } = scan;
  const stats = summarize(root);
  const { legend } = buildExtColors(root);
  return {
    slug,
    root: meta.root,
    totalSize: stats.totalSize,
    files: stats.files,
    dirs: stats.dirs,
    topExtensions: legend.slice(0, TOP).map((e) => ({ ext: e.ext, total: e.total })),
    largestFiles: flattenLeaves(root, [meta.root])
      .slice(0, TOP)
      .map((l) => ({ path: l.path, size: l.size })),
    largestDirs: topDirs(root, TOP).map((d) => ({ path: d.path, size: d.size })),
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
