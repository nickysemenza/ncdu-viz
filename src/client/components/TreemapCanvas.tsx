import { useEffect, useMemo, useRef, useState } from "react";
import type { ScanNode } from "../../shared/types";
import { layoutTreemap, type TreemapRect } from "../../shared/treemap";
import { drawTreemap, frontier, frontierAt } from "../treemapRender";

export interface HoverInfo {
  /** Absolute path segments from scan root to the hovered cell. */
  segments: string[];
  node: ScanNode;
}

interface Props {
  focus: ScanNode;
  /** Absolute name chain from scan root to `focus`, inclusive. */
  focusSegments: string[];
  /** Max render depth relative to focus (focus = 0); deeper dirs are collapsed. */
  maxDepth: number;
  colorOf: (node: ScanNode) => string;
  onHover: (info: HoverInfo | null) => void;
  /** Append this path of directories (focus→…→target) to the focus chain. */
  onDrill: (path: ScanNode[]) => void;
}

interface HoverState {
  cell: TreemapRect;
  group: TreemapRect | undefined;
}

export function TreemapCanvas({
  focus,
  focusSegments,
  maxDepth,
  colorOf,
  onHover,
  onDrill,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<HoverState | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ w: Math.floor(box.width), h: Math.floor(box.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (size.w < 2 || size.h < 2) return null;
    return layoutTreemap(focus, size.w, size.h, { paddingInner: 1 });
  }, [focus, size]);

  // The drawn cells (frontier) only change with layout/depth, not on hover.
  const cells = useMemo(() => (layout ? frontier(layout, maxDepth) : []), [layout, maxDepth]);

  // Reset hover when the focused subtree or depth changes.
  useEffect(() => {
    setHover(null);
    onHover(null);
  }, [focus, maxDepth, onHover]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.w * dpr);
    canvas.height = Math.floor(size.h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTreemap(ctx, cells, {
      colorOf,
      width: size.w,
      height: size.h,
      hover: hover ?? undefined,
    });
  }, [cells, layout, size, colorOf, hover]);

  const pointFromEvent = (e: React.MouseEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handleMove = (e: React.MouseEvent): void => {
    if (!layout) return;
    const p = pointFromEvent(e);
    if (!p) return;
    const { chain, cell } = frontierAt(layout, maxDepth, p.x, p.y);
    if (!cell) {
      setHover(null);
      onHover(null);
      return;
    }
    const group = chain.find((r) => r.depth === 1);
    setHover({ cell, group });
    const ancestors = chain.filter((r) => r.depth <= cell.depth);
    const segments = [...focusSegments, ...ancestors.slice(1).map((c) => c.node.name)];
    onHover({ segments, node: cell.node });
  };

  const handleLeave = (): void => {
    setHover(null);
    onHover(null);
  };

  const handleClick = (e: React.MouseEvent): void => {
    if (!layout) return;
    const p = pointFromEvent(e);
    if (!p) return;
    const { chain } = frontierAt(layout, maxDepth, p.x, p.y);
    // Drill into the deepest visible directory under the cursor, appending the
    // full intermediate path (depth 1..target) so the breadcrumb stays complete.
    const target = chain
      .filter(
        (r) =>
          r.node.isDir && r.depth >= 1 && r.depth <= maxDepth && (r.node.children?.length ?? 0) > 0,
      )
      .pop();
    if (target) {
      const path = chain.filter((r) => r.depth >= 1 && r.depth <= target.depth).map((r) => r.node);
      onDrill(path);
    }
  };

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h }}
        className="block cursor-pointer"
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        onClick={handleClick}
      />
    </div>
  );
}
