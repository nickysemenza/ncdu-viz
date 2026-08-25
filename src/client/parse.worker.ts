import * as Comlink from "comlink";
import { decodeScan, type ProgressFn, type ScanSource } from "../shared/decode";
import { payloadTransferables, type ScanPayload } from "../shared/scanTable";

/**
 * Worker-side parse entry point.
 *
 * The worker takes a source descriptor rather than a Blob so the *fetch* happens
 * here too: for a shared scan the main thread would otherwise buffer the whole
 * download before handing it over. Now its only involvement is receiving the
 * finished buffers.
 *
 * The result is explicitly transferred. Comlink honours `transfer()` on return
 * values, so the payload's buffers move to the main thread instead of being
 * structured-cloned — which for a large scan is the difference between a
 * pointer handoff and duplicating a few hundred megabytes on the main thread's
 * blocking deserialization path.
 */
async function parse(source: ScanSource, onProgress?: ProgressFn): Promise<ScanPayload> {
  const payload = await decodeScan(source, onProgress);
  return Comlink.transfer(payload, payloadTransferables(payload));
}

export const parseApi = { parse };
export type ParseApi = typeof parseApi;

Comlink.expose(parseApi);
