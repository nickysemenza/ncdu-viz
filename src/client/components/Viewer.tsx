import { useCallback, useEffect, useMemo, useState } from "react";
import type { ParseResult } from "../../shared/ncdu";
import { flattenLeaves, summarize } from "../../shared/ncdu";
import { buildExtColors, largestLeafExt } from "../../shared/color";
import { depthStats } from "../../shared/treemap";
import { humanBytes } from "../../shared/format";
import type { ScanNode } from "../../shared/types";
import { buildDigest, requestSummary } from "../summary";
import { Header } from "./Header";
import { Breadcrumb } from "./Breadcrumb";
import { Legend } from "./Legend";
import { StatusBar } from "./StatusBar";
import { FilesList } from "./FilesList";
import { TreemapCanvas, type HoverInfo } from "./TreemapCanvas";

type View = "treemap" | "files";

interface Props {
  scan: ParseResult;
  /** Shared scans only: slug enables the auto-generated AI summary banner. */
  slug?: string;
  /** Shared scans only: expiry timestamp + delete action (omitted for local view). */
  expiresAt?: string;
  onDelete?: () => Promise<void>;
}

export function Viewer({ scan, slug, expiresAt, onDelete }: Props) {
  const { root, meta } = scan;
  const stats = useMemo(() => summarize(root), [root]);
  const colors = useMemo(() => buildExtColors(root), [root]);
  const domExt = useMemo(() => largestLeafExt(root), [root]);

  const [focusPath, setFocusPath] = useState<ScanNode[]>([root]);
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
    setFocusPath([root]);
    setHover(null);
  }, [root]);

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

  const focus = focusPath[focusPath.length - 1] ?? root;
  const focusSegments = useMemo(() => focusPath.map((n) => n.name), [focusPath]);

  // Depth range + adaptive default per focus; re-default the slider on drill.
  const { maxDepth, suggested } = useMemo(() => depthStats(focus), [focus]);
  useEffect(() => {
    setDepth(suggested);
  }, [suggested]);
  const clampedDepth = Math.min(depth, maxDepth);

  // Collapsed directory cells are colored by their dominant (largest-leaf) ext.
  const colorOf = useCallback(
    (node: ScanNode) => colors.colorFor(node.isDir ? domExt.get(node) : node.ext),
    [colors, domExt],
  );

  // Only flatten when the Files view is active (cheap to skip for big trees).
  const leaves = useMemo(
    () => (view === "files" ? flattenLeaves(focus, focusSegments) : []),
    [view, focus, focusSegments],
  );

  const onDrill = useCallback((path: ScanNode[]) => {
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
        <Breadcrumb path={focusPath} onJump={onJump} />
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
              focus={focus}
              focusSegments={focusSegments}
              maxDepth={clampedDepth}
              colorOf={colorOf}
              onHover={setHover}
              onDrill={onDrill}
            />
          ) : (
            <FilesList leaves={leaves} colorFor={colors.colorFor} />
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
            ? `${humanBytes(focus.size)} · ${stats.files.toLocaleString()} files · click a region to drill in`
            : `${humanBytes(focus.size)} · largest files first`
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
