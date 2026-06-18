import { humanBytes } from "../../shared/format";
import type { ParseProgress } from "../parseClient";

interface Props {
  progress: ParseProgress | null;
  error: string | null;
}

const PHASE_LABEL: Record<ParseProgress["phase"], string> = {
  reading: "Decompressing & reading",
  parsing: "Parsing JSON",
  building: "Building tree",
};

export function ParseOverlay({ progress, error }: Props) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-graphite-950 font-mono text-sm">
      {error ? (
        <span className="text-rose-400">{error}</span>
      ) : (
        <>
          <div className="h-1 w-48 overflow-hidden rounded-full bg-graphite-800">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-sky-500" />
          </div>
          <span className="text-zinc-400">
            {progress ? PHASE_LABEL[progress.phase] : "Loading…"}
          </span>
          {progress && progress.bytes > 0 && (
            <span className="text-zinc-600 tabular-nums">{humanBytes(progress.bytes)} read</span>
          )}
        </>
      )}
    </div>
  );
}
