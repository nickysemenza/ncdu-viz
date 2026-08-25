import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScanTable } from "../../shared/scanTable";
import { cellAt, groupAt, layoutTreemap, type Cell } from "../../shared/scanLayout";
import { drawHover, drawTreemap } from "../treemapRender";

export interface HoverInfo {
  /** Absolute path segments from scan root to the hovered cell. */
  segments: string[];
  index: number;
  isDir: boolean;
  size: number;
}

interface Props {
  table: ScanTable;
  focus: number;
  /** Max render depth relative to focus (focus = 0); deeper dirs are collapsed. */
  maxDepth: number;
  colorOf: (index: number) => string;
  onHover: (info: HoverInfo | null) => void;
  /** Append this path of directories (focus→…→target) to the focus chain. */
  onDrill: (path: number[]) => void;
}

/**
 * Cells below this many px² are not subdivided further. Matches the drawing
 * threshold in `treemapRender`, so nothing that would have been painted is lost —
 * it just stops the layout from recursing into invisible territory, which is what
 * keeps the cell count bounded when the detail slider is dragged deep.
 */
const MIN_CELL_AREA = 1;

/**
 * Memoized: hover state lives in a ref and is painted imperatively, so this
 * component does not re-render on mousemove at all. Every prop is already
 * reference-stable from `Viewer`.
 */
export const TreemapCanvas = memo(function TreemapCanvas({
  table,
  focus,
  maxDepth,
  colorOf,
  onHover,
  onDrill,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // Hover is a ref, not state: it changes at pointer-event rate and only ever
  // affects two stroked rectangles on a separate canvas.
  const hoverRef = useRef<{ cell: Cell; group: Cell | undefined } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      const w = Math.floor(box.width);
      const h = Math.floor(box.height);
      // ResizeObserver reports fractional rects that floor to the same pixel
      // size; without this every observation would mint a new object and force a
      // relayout and a canvas clear.
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (size.w < 2 || size.h < 2) return null;
    return layoutTreemap(table, focus, size.w, size.h, {
      paddingInner: 1,
      maxDepth,
      minArea: MIN_CELL_AREA,
    });
  }, [table, focus, size, maxDepth]);

  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

  /** Size a canvas to the container in device pixels and return a CSS-px context. */
  const prepare = useCallback(
    (canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null => {
      if (!canvas) return null;
      canvas.width = Math.floor(size.w * dpr);
      canvas.height = Math.floor(size.h * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return ctx;
    },
    [size, dpr],
  );

  // Base layer: repaints only when the cells, the size, or the palette change.
  useEffect(() => {
    if (!layout) return;
    const ctx = prepare(baseRef.current);
    if (!ctx) return;
    drawTreemap(ctx, layout.cells, { colorOf, width: size.w, height: size.h });
  }, [layout, size, colorOf, prepare]);

  // Overlay layer: cleared and resized alongside the base, then drawn on hover.
  useEffect(() => {
    hoverRef.current = null;
    onHover(null);
    prepare(overlayRef.current);
  }, [layout, focus, maxDepth, onHover, prepare]);

  const paintHover = useCallback((): void => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, size.w, size.h);
    const h = hoverRef.current;
    if (h) drawHover(ctx, h.cell, h.group);
  }, [size]);

  const pointFromEvent = (e: React.MouseEvent): { x: number; y: number } | null => {
    const canvas = baseRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handleMove = (e: React.MouseEvent): void => {
    if (!layout) return;
    const p = pointFromEvent(e);
    if (!p) return;
    const cell = cellAt(layout, p.x, p.y);
    if (!cell) {
      if (hoverRef.current !== null) {
        hoverRef.current = null;
        paintHover();
        onHover(null);
      }
      return;
    }
    if (hoverRef.current?.cell === cell) return;
    hoverRef.current = { cell, group: groupAt(layout, p.x, p.y) };
    paintHover();
    // The path comes from the table's parent chain, not from a geometric search.
    const chain = table.pathIndices(cell.index);
    onHover({
      segments: chain.map((i) => table.nameOf(i)),
      index: cell.index,
      isDir: table.isDir(cell.index),
      size: table.sizeOf(cell.index),
    });
  };

  const handleLeave = (): void => {
    hoverRef.current = null;
    paintHover();
    onHover(null);
  };

  const handleClick = (e: React.MouseEvent): void => {
    if (!layout) return;
    const p = pointFromEvent(e);
    if (!p) return;
    const cell = cellAt(layout, p.x, p.y);
    if (!cell) return;
    // Drill to the deepest visible directory under the cursor: the cell itself if
    // it is a collapsed directory, otherwise the directory containing it.
    const target =
      table.isDir(cell.index) && table.hasChildren(cell.index)
        ? cell.index
        : table.parentOf(cell.index);
    if (target === focus) return;
    const chain = table.pathIndices(target);
    const from = chain.indexOf(focus);
    if (from < 0) return;
    const path = chain.slice(from + 1);
    if (path.length > 0) onDrill(path);
  };

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={baseRef}
        style={{ width: size.w, height: size.h }}
        className="block cursor-pointer"
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        onClick={handleClick}
      />
      <canvas
        ref={overlayRef}
        style={{ width: size.w, height: size.h }}
        className="pointer-events-none absolute top-0 left-0 block"
      />
    </div>
  );
});
