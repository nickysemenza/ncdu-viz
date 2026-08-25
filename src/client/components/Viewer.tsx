import { useCallback, useEffect, useMemo, useState } from "react";
import type { ScanTable } from "../../shared/scanTable";
import { buildExtColors } from "../../shared/color";
import { depthStats, topLeaves } from "../../shared/scanQuery";
import { humanBytes } from "../../shared/format";
import { buildDigest, requestSummary } from "../summary";
import { Header } from "./Header";
import { Breadcrumb } from "./Breadcrumb";
import { Legend } from "./Legend";
import { StatusBar } from "./StatusBar";
import { FilesList } from "./FilesList";
import { TreemapCanvas, type HoverInfo } from "./TreemapCanvas";

type View = "treemap" | "files";

/** Rows the Files list will render; also the cap on what gets materialized. */
const MAX_FILE_ROWS = 1000;

interface Props {
  scan: ScanTable;
  /** Shared scans only: slug enables the auto-generated AI summary banner. */
  slug?: string;
  /** Shared scans only: expiry timestamp + delete action (omitted for local view). */
  expiresAt?: string;
  onDelete?: () => Promise<void>;
}

export function Viewer({ scan, slug, expiresAt, onDelete }: Props) {
  const table = scan;
  const { meta, stats } = table;
  // Totals and per-extension sizes arrive precomputed from the parse worker, so
  // none of this walks the tree.
  const colors = useMemo(
    () => buildExtColors(table.p.extTable, table.p.extTotals, table.p.extCounts),
    [table],
  );

  const [focusPath, setFocusPath] = useState<number[]>([table.rootIndex]);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [view, setView] = useState<View>("treemap");
  const [depth, setDepth] = useState(1);
  const [summary, setSummary] = useState<{ text: string | null; loading: boolean }>({
    text: null,
    loading: false,
  });
  const [summaryOpen, setSummaryOpen] = useState(true);

  // Reset focus + hover when a new scan is loaded.
  useEffect(() => {
    setFocusPath([table.rootIndex]);
    setHover(null);
  }, [table]);

  // Shared scans: auto-generate the AI summary on load (cached server-side by slug,
  // so viewing an existing/older scan returns instantly without re-running inference).
  useEffect(() => {
    if (!slug) return undefined;
    let alive = true;
    setSummary({ text: null, loading: true });
    void requestSummary(buildDigest(slug, scan))
      .then((text) => alive && setSummary({ text, loading: false }))
      .catch(() => alive && setSummary({ text: null, loading: false }));
    return () => {
      alive = false;
    };
  }, [slug, scan]);

  const focus = focusPath[focusPath.length - 1] ?? table.rootIndex;
  const crumbs = useMemo(() => focusPath.map((i) => table.nameOf(i)), [focusPath, table]);

  // Depth range + adaptive default per focus; re-default the slider on drill.
  // A linear scan over the focus's contiguous index range, not a tree walk.
  const { maxDepth, suggested } = useMemo(() => depthStats(table, focus), [table, focus]);
  useEffect(() => {
    setDepth(suggested);
  }, [suggested]);
  const clampedDepth = Math.min(depth, maxDepth);

  // Collapsed directory cells are colored by their dominant (largest-leaf) ext,
  // which the parser precomputed into a column — so this is an array read.
  const colorOf = useCallback(
    (index: number) => colors.extColor[table.displayExtIdOf(index)] ?? colors.colorFor(undefined),
    [colors, table],
  );

  // Bounded selection: only the rows the list can show are materialized, rather
  // than every leaf in the subtree.
  const files = useMemo(
    () => (view === "files" ? topLeaves(table, focus, MAX_FILE_ROWS) : null),
    [view, table, focus],
  );

  const onDrill = useCallback((path: number[]) => {
    if (path.length > 0) setFocusPath((p) => [...p, ...path]);
  }, []);
  const onJump = useCallback((i: number) => {
    setFocusPath((p) => p.slice(0, i + 1));
  }, []);

  return (
    <div className="flex h-dvh flex-col bg-graphite-950 text-zinc-200">
      <Header
        meta={meta}
        fileCount={stats.files}
        dirCount={stats.dirs}
        expiresAt={expiresAt}
        onDelete={onDelete}
      />
      <div className="flex items-center justify-between gap-4 border-b border-graphite-700 bg-graphite-900 pr-3">
        <Breadcrumb labels={crumbs} onJump={onJump} />
        <div className="flex shrink-0 items-center gap-4">
          {view === "treemap" && maxDepth >= 2 && (
            <DepthSlider value={clampedDepth} max={maxDepth} onChange={setDepth} />
          )}
          <ViewToggle view={view} onChange={setView} />
        </div>
      </div>
      {slug && (summary.loading || summary.text) && (
        <div className="border-b border-graphite-700 bg-graphite-900/50 px-3 py-2">
          <button
            type="button"
            onClick={() => setSummaryOpen((o) => !o)}
            className="flex items-center gap-2 text-xs font-medium text-sky-400/90"
          >
            <span>✨ Summary</span>
            {summary.loading && <span className="animate-pulse text-zinc-500">generating…</span>}
            {summary.text && <span className="text-graphite-700">{summaryOpen ? "▾" : "▸"}</span>}
          </button>
          {summaryOpen && summary.text && (
            <p className="mt-1 max-w-4xl text-sm leading-relaxed text-zinc-300">{summary.text}</p>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          {view === "treemap" ? (
            <TreemapCanvas
              table={table}
              focus={focus}
              maxDepth={clampedDepth}
              colorOf={colorOf}
              onHover={setHover}
              onDrill={onDrill}
            />
          ) : (
            <FilesList
              leaves={files?.rows ?? []}
              totalFiles={files?.totalFiles ?? 0}
              colorFor={colors.colorFor}
            />
          )}
        </div>
        <div className="w-56 shrink-0">
          <Legend legend={colors.legend} />
        </div>
      </div>
      <StatusBar
        hover={hover}
        placeholder={
          view === "treemap"
            ? `${humanBytes(table.sizeOf(focus))} · ${stats.files.toLocaleString()} files · click a region to drill in`
            : `${humanBytes(table.sizeOf(focus))} · largest files first`
        }
      />
    </div>
  );
}

function DepthSlider({
  value,
  max,
  onChange,
}: {
  value: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex shrink-0 items-center gap-2 text-xs text-zinc-500">
      <span className="hidden sm:inline">Detail</span>
      <input
        type="range"
        min={1}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-24 cursor-pointer accent-sky-500"
        title={`Depth ${value} of ${max}`}
      />
      <span className="w-8 font-mono tabular-nums text-zinc-400">
        {value}/{max}
      </span>
    </label>
  );
}

function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const tab = (v: View, label: string) => (
    <button
      type="button"
      onClick={() => onChange(v)}
      className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
        view === v ? "bg-graphite-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex shrink-0 items-center gap-1 rounded-md bg-graphite-850 p-0.5 ring-1 ring-graphite-700">
      {tab("treemap", "Treemap")}
      {tab("files", "Files")}
    </div>
  );
}
