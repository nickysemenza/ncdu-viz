import { useState } from "react";
import type { ScanMeta } from "../../shared/types";
import { humanBytes, relativeExpiry } from "../../shared/format";
import { GithubLink } from "./GithubLink";

interface Props {
  meta: ScanMeta;
  fileCount?: number;
  dirCount?: number;
  /** Shared scans only: ISO expiry timestamp + a delete action. */
  expiresAt?: string;
  onDelete?: () => Promise<void>;
}

function formatDate(unixSeconds?: number): string | null {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function Header({ meta, fileCount, dirCount, expiresAt, onDelete }: Props) {
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
      {date && <span className="hidden font-mono text-xs text-zinc-500 sm:inline">{date}</span>}
      <span className="font-mono text-sm text-zinc-200 tabular-nums">
        {humanBytes(meta.totalSize)}
      </span>
      {expiresAt && (
        <span
          className="font-mono text-xs whitespace-nowrap text-amber-500/80"
          title={`Auto-deletes ${new Date(expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC`}
        >
          {relativeExpiry(expiresAt)}
        </span>
      )}
      {onDelete && <DeleteButton onDelete={onDelete} />}
      <GithubLink className="self-center" />
    </header>
  );
}

function DeleteButton({ onDelete }: { onDelete: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const click = (): void => {
    if (busy) return;
    if (
      !window.confirm("Delete this scan now? Anyone with the link will immediately lose access.")
    ) {
      return;
    }
    setBusy(true);
    void onDelete().catch(() => setBusy(false));
  };
  return (
    <button
      type="button"
      onClick={click}
      disabled={busy}
      className="rounded px-2 py-0.5 font-mono text-xs text-rose-400/90 ring-1 ring-rose-500/30 hover:bg-rose-500/10 disabled:opacity-50"
    >
      {busy ? "deleting…" : "delete"}
    </button>
  );
}
