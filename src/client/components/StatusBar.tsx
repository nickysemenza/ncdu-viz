import { humanBytes } from "../../shared/format";
import { splitPath } from "../../shared/path";
import type { HoverInfo } from "./TreemapCanvas";

interface Props {
  hover: HoverInfo | null;
  /** Shown when nothing is hovered. */
  placeholder: string;
}

export function StatusBar({ hover, placeholder }: Props) {
  const path = hover ? splitPath(hover.segments) : null;
  return (
    <div className="flex items-center gap-3 border-t border-graphite-700 bg-graphite-900 px-3 py-1.5 font-mono text-xs">
      {hover && path ? (
        <>
          <span className="flex-1 truncate">
            <span className="text-zinc-600">{path.dir}</span>
            <span className="text-zinc-100">{path.name}</span>
            {hover.node.isDir && <span className="text-zinc-600">/</span>}
          </span>
          {hover.node.isDir && (
            <span className="shrink-0 text-zinc-600">dir · click to drill in</span>
          )}
          <span className="shrink-0 text-zinc-300 tabular-nums">{humanBytes(hover.node.size)}</span>
        </>
      ) : (
        <span className="text-zinc-600">{placeholder}</span>
      )}
    </div>
  );
}
