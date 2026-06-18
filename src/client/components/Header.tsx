import type { ScanMeta } from "../../shared/types";
import { humanBytes } from "../../shared/format";

interface Props {
  meta: ScanMeta;
  fileCount?: number;
  dirCount?: number;
}

function formatDate(unixSeconds?: number): string | null {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function Header({ meta, fileCount, dirCount }: Props) {
  const date = formatDate(meta.scannedAt);
  return (
    <header className="flex items-baseline gap-4 border-b border-graphite-700 bg-graphite-900 px-3 py-2">
      <span className="font-semibold tracking-tight text-zinc-100">ncdu-viz</span>
      <span className="flex-1 truncate font-mono text-sm text-zinc-400" title={meta.root}>
        {meta.root}
      </span>
      {fileCount !== undefined && dirCount !== undefined && (
        <span className="hidden font-mono text-xs text-zinc-500 tabular-nums sm:inline">
          {fileCount.toLocaleString()} files · {dirCount.toLocaleString()} dirs
        </span>
      )}
      {date && <span className="font-mono text-xs text-zinc-500">{date}</span>}
      <span className="font-mono text-sm text-zinc-200 tabular-nums">
        {humanBytes(meta.totalSize)}
      </span>
    </header>
  );
}
