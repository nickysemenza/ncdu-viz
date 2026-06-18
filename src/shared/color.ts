import type { ScanNode } from "./types";

/** Neutral bucket for extensions outside the top-N. */
export const OTHER_COLOR = "#64748b"; // slate-500
export const OTHER_LABEL = "other";
export const DIR_COLOR = "#3f3f46"; // zinc-700, for empty/unknown leaves

/**
 * 16 distinct hues chosen to stay legible on a dark (graphite) background —
 * mid-to-bright saturation, no near-blacks. Order is roughly rainbow so adjacent
 * legend entries read as different.
 */
const PALETTE = [
  "#60a5fa", // blue
  "#f472b6", // pink
  "#34d399", // emerald
  "#fbbf24", // amber
  "#a78bfa", // violet
  "#22d3ee", // cyan
  "#fb7185", // rose
  "#a3e635", // lime
  "#f59e0b", // orange
  "#4ade80", // green
  "#e879f9", // fuchsia
  "#2dd4bf", // teal
  "#fca5a5", // red-300
  "#c084fc", // purple
  "#facc15", // yellow
  "#38bdf8", // sky
];

export const MAX_LEGEND_EXTS = PALETTE.length;

export interface ExtEntry {
  ext: string;
  label: string;
  color: string;
  total: number;
}

export interface ExtColors {
  /** ext → color. Extensions not in the top-N resolve to OTHER_COLOR via colorFor(). */
  map: Map<string, string>;
  /** Legend rows (top-N extensions + an "other" aggregate), sorted by total desc. */
  legend: ExtEntry[];
  colorFor: (ext: string | undefined) => string;
}

/**
 * Map each directory node to the extension of its single largest leaf
 * descendant — used to color a collapsed/aggregated directory cell so it still
 * reads as "mostly <type>". One O(n) post-order pass.
 */
export function largestLeafExt(root: ScanNode): Map<ScanNode, string> {
  const map = new Map<ScanNode, string>();
  const walk = (n: ScanNode): { ext: string; size: number } => {
    if (!n.isDir) return { ext: n.ext ?? "", size: n.size };
    let best = { ext: "", size: -1 };
    for (const child of n.children ?? []) {
      const r = walk(child);
      if (r.size > best.size) best = r;
    }
    map.set(n, best.ext);
    return best;
  };
  walk(root);
  return map;
}

/** Aggregate leaf sizes per extension and assign the top-N a palette color. */
export function buildExtColors(root: ScanNode): ExtColors {
  const totals = new Map<string, number>();
  const walk = (n: ScanNode): void => {
    if (n.isDir) {
      n.children?.forEach(walk);
    } else {
      const ext = n.ext ?? "";
      totals.set(ext, (totals.get(ext) ?? 0) + n.size);
    }
  };
  walk(root);

  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, MAX_LEGEND_EXTS);

  const map = new Map<string, string>();
  const legend: ExtEntry[] = top.map(([ext, total], i) => {
    const color = PALETTE[i] ?? OTHER_COLOR;
    map.set(ext, color);
    return { ext, label: ext === "" ? "(no ext)" : ext, color, total };
  });

  const otherTotal = sorted.slice(MAX_LEGEND_EXTS).reduce((s, [, t]) => s + t, 0);
  if (otherTotal > 0) {
    legend.push({ ext: OTHER_LABEL, label: OTHER_LABEL, color: OTHER_COLOR, total: otherTotal });
  }

  const colorFor = (ext: string | undefined): string => map.get(ext ?? "") ?? OTHER_COLOR;

  return { map, legend, colorFor };
}
