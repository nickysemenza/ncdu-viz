import * as Comlink from "comlink";
import type { ParseProgress, ProgressFn, ScanSource } from "../shared/decode";
import { ScanTable } from "../shared/scanTable";
import type { ParseApi } from "./parse.worker";

export type { ParseProgress, ScanSource } from "../shared/decode";

/**
 * Decompress, parse and index a scan in a dedicated Web Worker, returning a
 * `ScanTable` view over the transferred buffers.
 *
 * A fresh worker per call keeps memory bounded: it is terminated as soon as the
 * payload has been transferred out, so the parser's transient allocations go
 * with it. Nothing is copied on the way back — see `parse.worker.ts`.
 */
export async function parseScan(
  source: ScanSource,
  onProgress?: (p: ParseProgress) => void,
): Promise<ScanTable> {
  const worker = new Worker(new URL("./parse.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    const api = Comlink.wrap<ParseApi>(worker);
    const progress: ProgressFn | undefined = onProgress ? Comlink.proxy(onProgress) : undefined;
    const payload = await api.parse(source, progress);
    return new ScanTable(payload);
  } finally {
    worker.terminate();
  }
}
