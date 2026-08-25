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
  /** Color per extension id, for coloring cells straight off the table. */
  extColor: string[];
}

/**
 * Assign palette colors from precomputed per-extension totals.
 *
 * Previously this walked the whole tree to aggregate leaf sizes. The parser now
 * accumulates those totals as it goes, so this is a sort of a few thousand
 * entries with no traversal at all.
 *
 * `extCounts` distinguishes an extension no leaf ever had from one whose leaves
 * were all empty — index 0 ("") is reserved before parsing begins, so it would
 * otherwise show up in the legend on scans that have no extension-less files.
 */
export function buildExtColors(
  extTable: readonly string[],
  extTotals: ArrayLike<number>,
  extCounts: ArrayLike<number>,
): ExtColors {
  const used: [string, number][] = [];
  for (let id = 0; id < extTable.length; id++) {
    if (extCounts[id] === 0) continue;
    used.push([extTable[id] ?? "", extTotals[id]]);
  }
  // Stable sort over first-seen order, matching a pre-order walk of the leaves.
  const sorted = used.sort((a, b) => b[1] - a[1]);
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

  // Indexed by extension id so a cell's fill is an array read, not a Map lookup
  // on a string that would have to be decoded first.
  const extColor: string[] = [];
  for (let id = 0; id < extTable.length; id++) extColor.push(colorFor(extTable[id]));

  return { map, legend, colorFor, extColor };
}
