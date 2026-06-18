import { useCallback, useEffect, useMemo, useState } from "react";
import type { ParseResult } from "../../shared/ncdu";
import { summarize } from "../../shared/ncdu";
import { buildExtColors } from "../../shared/color";
import { humanBytes } from "../../shared/format";
import type { ScanNode } from "../../shared/types";
import { Header } from "./Header";
import { Breadcrumb } from "./Breadcrumb";
import { Legend } from "./Legend";
import { StatusBar } from "./StatusBar";
import { TreemapCanvas, type HoverInfo } from "./TreemapCanvas";

interface Props {
  scan: ParseResult;
}

export function Viewer({ scan }: Props) {
  const { root, meta } = scan;
  const stats = useMemo(() => summarize(root), [root]);
  const colors = useMemo(() => buildExtColors(root), [root]);

  const [focusPath, setFocusPath] = useState<ScanNode[]>([root]);
  const [hover, setHover] = useState<HoverInfo | null>(null);

  // Reset focus + hover when a new scan is loaded.
  useEffect(() => {
    setFocusPath([root]);
    setHover(null);
  }, [root]);

  const focus = focusPath[focusPath.length - 1] ?? root;
  const focusSegments = useMemo(() => focusPath.map((n) => n.name), [focusPath]);

  const onDrill = useCallback((child: ScanNode) => {
    setFocusPath((p) => [...p, child]);
  }, []);
  const onJump = useCallback((i: number) => {
    setFocusPath((p) => p.slice(0, i + 1));
  }, []);

  return (
    <div className="flex h-dvh flex-col bg-graphite-950 text-zinc-200">
      <Header meta={meta} fileCount={stats.files} dirCount={stats.dirs} />
      <Breadcrumb path={focusPath} onJump={onJump} />
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1">
          <TreemapCanvas
            focus={focus}
            focusSegments={focusSegments}
            colorFor={colors.colorFor}
            onHover={setHover}
            onDrill={onDrill}
          />
        </div>
        <div className="w-56 shrink-0">
          <Legend legend={colors.legend} />
        </div>
      </div>
      <StatusBar
        hover={hover}
        placeholder={`${humanBytes(focus.size)} · ${stats.files.toLocaleString()} files · click a region to drill in`}
      />
    </div>
  );
}
