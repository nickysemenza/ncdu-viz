import { humanBytes } from "../../shared/format";
import type { HoverInfo } from "./TreemapCanvas";

interface Props {
  hover: HoverInfo | null;
  /** Shown when nothing is hovered. */
  placeholder: string;
}

/** Join absolute path segments, tolerating a leading-slash root segment. */
function joinPath(segments: string[]): { dir: string; name: string } {
  const name = segments[segments.length - 1] ?? "";
  const dir = segments.slice(0, -1).join("/").replace(/\/+/g, "/");
  return { dir: dir ? `${dir}/` : "", name };
}

export function StatusBar({ hover, placeholder }: Props) {
  return (
    <div className="flex items-center gap-3 border-t border-graphite-700 bg-graphite-900 px-3 py-1.5 font-mono text-xs">
      {hover ? (
        <>
          <span className="flex-1 truncate">
            <span className="text-zinc-600">{joinPath(hover.segments).dir}</span>
            <span className="text-zinc-100">{joinPath(hover.segments).name}</span>
          </span>
          <span className="shrink-0 text-zinc-300 tabular-nums">{humanBytes(hover.node.size)}</span>
        </>
      ) : (
        <span className="text-zinc-600">{placeholder}</span>
      )}
    </div>
  );
}
