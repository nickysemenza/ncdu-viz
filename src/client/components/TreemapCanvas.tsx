import { useEffect, useMemo, useRef, useState } from "react";
import type { ScanNode } from "../../shared/types";
import { layoutTreemap, type TreemapRect } from "../../shared/treemap";
import { chainAt, drawTreemap } from "../treemapRender";

export interface HoverInfo {
  /** Absolute path segments from scan root to the hovered node. */
  segments: string[];
  node: ScanNode;
}

interface Props {
  focus: ScanNode;
  /** Absolute name chain from scan root to `focus`, inclusive. */
  focusSegments: string[];
  colorFor: (ext: string | undefined) => string;
  onHover: (info: HoverInfo | null) => void;
  onDrill: (child: ScanNode) => void;
}

export function TreemapCanvas({ focus, focusSegments, colorFor, onHover, onDrill }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoverChain, setHoverChain] = useState<TreemapRect[] | null>(null);

  // Track container size for a crisp, responsive canvas.
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

  // Reset hover whenever the focused subtree changes.
  useEffect(() => {
    setHoverChain(null);
    onHover(null);
  }, [focus, onHover]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.w * dpr);
    canvas.height = Math.floor(size.h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTreemap(ctx, layout, {
      colorFor,
      width: size.w,
      height: size.h,
      hoverChain: hoverChain ?? undefined,
    });
  }, [layout, size, colorFor, hoverChain]);

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
    const chain = chainAt(layout, p.x, p.y);
    if (chain.length === 0) {
      setHoverChain(null);
      onHover(null);
      return;
    }
    setHoverChain(chain);
    const leaf = chain[chain.length - 1];
    if (leaf) {
      // focusSegments already ends at `focus` (== chain[0]); append the rest.
      const segments = [...focusSegments, ...chain.slice(1).map((c) => c.node.name)];
      onHover({ segments, node: leaf.node });
    }
  };

  const handleLeave = (): void => {
    setHoverChain(null);
    onHover(null);
  };

  const handleClick = (e: React.MouseEvent): void => {
    if (!layout) return;
    const p = pointFromEvent(e);
    if (!p) return;
    const group = chainAt(layout, p.x, p.y).find((r) => r.depth === 1);
    if (group?.node.isDir && (group.node.children?.length ?? 0) > 0) {
      onDrill(group.node);
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
