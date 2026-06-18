import { useCallback, useEffect, useMemo, useState } from "react";
import type { ParseResult } from "../../shared/ncdu";
import { flattenLeaves, summarize } from "../../shared/ncdu";
import { buildExtColors } from "../../shared/color";
import { humanBytes } from "../../shared/format";
import type { ScanNode } from "../../shared/types";
import { Header } from "./Header";
import { Breadcrumb } from "./Breadcrumb";
import { Legend } from "./Legend";
import { StatusBar } from "./StatusBar";
import { FilesList } from "./FilesList";
import { TreemapCanvas, type HoverInfo } from "./TreemapCanvas";

type View = "treemap" | "files";

interface Props {
  scan: ParseResult;
}

export function Viewer({ scan }: Props) {
  const { root, meta } = scan;
  const stats = useMemo(() => summarize(root), [root]);
  const colors = useMemo(() => buildExtColors(root), [root]);

  const [focusPath, setFocusPath] = useState<ScanNode[]>([root]);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [view, setView] = useState<View>("treemap");

  // Reset focus + hover when a new scan is loaded.
  useEffect(() => {
    setFocusPath([root]);
    setHover(null);
  }, [root]);

  const focus = focusPath[focusPath.length - 1] ?? root;
  const focusSegments = useMemo(() => focusPath.map((n) => n.name), [focusPath]);

  // Only flatten when the Files view is active (cheap to skip for big trees).
  const leaves = useMemo(
    () => (view === "files" ? flattenLeaves(focus, focusSegments) : []),
    [view, focus, focusSegments],
  );

  const onDrill = useCallback((child: ScanNode) => {
    setFocusPath((p) => [...p, child]);
  }, []);
  const onJump = useCallback((i: number) => {
    setFocusPath((p) => p.slice(0, i + 1));
  }, []);

  return (
    <div className="flex h-dvh flex-col bg-graphite-950 text-zinc-200">
      <Header meta={meta} fileCount={stats.files} dirCount={stats.dirs} />
      <div className="flex items-center justify-between border-b border-graphite-700 bg-graphite-900 pr-3">
        <Breadcrumb path={focusPath} onJump={onJump} />
        <ViewToggle view={view} onChange={setView} />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          {view === "treemap" ? (
            <TreemapCanvas
              focus={focus}
              focusSegments={focusSegments}
              colorFor={colors.colorFor}
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
