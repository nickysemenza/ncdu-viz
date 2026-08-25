/**
 * Load pipeline: bytes in, `ScanPayload` out.
 *
 * Decompression and parsing are now a single streaming pass. The previous
 * version accumulated the entire decompressed export into a string array,
 * joined it, and handed the result to `JSON.parse` — which meant the source
 * string, the raw object graph and the normalized tree were all resident at
 * once, and which hard-failed above ~9M nodes when the join exceeded V8's
 * 536,870,888-character string cap. Nothing here ever builds a string.
 *
 * Kept runtime-agnostic (`Blob`, `fetch`, `DecompressionStream`, `TextDecoder`
 * are available in browsers, Workers and Node >= 18) so it can run in the parse
 * worker, in a Cloudflare Worker, and in tests unchanged.
 */

import { ScanParser } from "./scanParse";
import type { ScanPayload } from "./scanTable";

export interface ParseProgress {
  /** "reading" covers decompress+parse (one pass); "building" is the post-pass. */
  phase: "reading" | "building";
  /** Decompressed bytes consumed so far. */
  bytes: number;
  /** Source byte size (compressed, if gzipped), for a rough fraction. */
  sourceBytes: number;
  /** Nodes discovered so far — a more meaningful counter than bytes alone. */
  nodes: number;
}

export type ProgressFn = (p: ParseProgress) => void;

/** Where to read a scan from. A URL is fetched by whoever calls this. */
export type ScanSource = { blob: Blob } | { url: string };

/**
 * `DecompressionStream` hands back ~64 KB chunks. Pushing each one separately
 * would mean a carry-copy and loop setup per chunk, so they are coalesced first.
 */
const MIN_PUSH_BYTES = 1 << 20;

/** Progress is proxied across a worker boundary, so it must not fire per chunk. */
const PROGRESS_INTERVAL_MS = 100;

function isGzip(head: Uint8Array): boolean {
  return head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
}

async function openStream(
  source: ScanSource,
): Promise<{ stream: ReadableStream<Uint8Array>; sourceBytes: number }> {
  if ("blob" in source) {
    return { stream: source.blob.stream(), sourceBytes: source.blob.size };
  }
  const res = await fetch(source.url);
  if (res.status === 404) throw new Error("this scan expired or never existed");
  if (!res.ok) throw new Error(`failed to load scan (${res.status})`);
  if (!res.body) throw new Error("empty response");
  const len = Number(res.headers.get("Content-Length") ?? "0");
  return { stream: res.body, sourceBytes: Number.isFinite(len) ? len : 0 };
}

/**
 * Sniff the gzip magic bytes off the front of a stream and hand back a stream
 * that still starts at byte zero. Sniffing by content rather than trusting a
 * header keeps drag-dropped `.gz` files and already-inflated HTTP responses on
 * the same path.
 */
function sniffGzip(
  raw: ReadableStream<Uint8Array>,
): Promise<{ stream: ReadableStream<Uint8Array>; gzipped: boolean }> {
  const reader = raw.getReader();
  return reader.read().then(({ value, done }) => {
    const head = value ?? new Uint8Array(0);
    const gzipped = isGzip(head);
    const restored = new ReadableStream<Uint8Array>({
      start(controller) {
        if (head.length > 0) controller.enqueue(head);
        if (done) controller.close();
      },
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close();
        else if (next.value) controller.enqueue(next.value);
      },
      cancel(reason) {
        void reader.cancel(reason);
      },
    });
    return { stream: restored, gzipped };
  });
}

/** Decompress if needed, parse, and return the flat table payload. */
export async function decodeScan(
  source: ScanSource,
  onProgress?: ProgressFn,
): Promise<ScanPayload> {
  const { stream: raw, sourceBytes } = await openStream(source);
  const { stream: sniffed, gzipped } = await sniffGzip(raw);

  const stream = gzipped
    ? sniffed.pipeThrough(
        // TS types DecompressionStream's writable as the wider BufferSource,
        // which trips pipeThrough's invariant pair type. Runtime is correct.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
      )
    : sniffed;

  // A gzipped source inflates to several times its size; a plain one does not.
  const parser = new ScanParser({ estimatedBytes: gzipped ? sourceBytes * 4 : sourceBytes });
  const reader = stream.getReader();

  let bytes = 0;
  let lastReport = 0;
  let pending: Uint8Array[] = [];
  let pendingLen = 0;

  const flush = (): void => {
    if (pendingLen === 0) return;
    if (pending.length === 1) {
      parser.push(pending[0]);
    } else {
      const merged = new Uint8Array(pendingLen);
      let at = 0;
      for (const c of pending) {
        merged.set(c, at);
        at += c.byteLength;
      }
      parser.push(merged);
    }
    pending = [];
    pendingLen = 0;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    pending.push(value);
    pendingLen += value.byteLength;
    if (pendingLen >= MIN_PUSH_BYTES) {
      flush();
      const now = Date.now();
      if (onProgress && now - lastReport >= PROGRESS_INTERVAL_MS) {
        lastReport = now;
        onProgress({ phase: "reading", bytes, sourceBytes, nodes: parser.count });
      }
    }
  }
  flush();

  onProgress?.({ phase: "building", bytes, sourceBytes, nodes: parser.count });
  return parser.finish();
}
