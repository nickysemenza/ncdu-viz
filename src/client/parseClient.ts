import * as Comlink from "comlink";
import type { ParseResult } from "../shared/ncdu";
import type { ParseProgress, ProgressFn } from "../shared/decode";
import type { ParseApi } from "./parse.worker";

export type { ParseProgress } from "../shared/decode";

/**
 * Run decompression + parsing in a dedicated Web Worker so large scans never
 * block the main thread. A fresh worker per call keeps memory bounded (the
 * worker is terminated once its tree has been transferred back).
 */
export async function parseScan(
  source: Blob,
  onProgress?: (p: ParseProgress) => void,
): Promise<ParseResult> {
  const worker = new Worker(new URL("./parse.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    const api = Comlink.wrap<ParseApi>(worker);
    const progress: ProgressFn | undefined = onProgress ? Comlink.proxy(onProgress) : undefined;
    return await api.parse(source, progress);
  } finally {
    worker.terminate();
  }
}
