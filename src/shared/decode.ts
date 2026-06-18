import { parseNcdu, type ParseResult } from "./ncdu";

export interface ParseProgress {
  phase: "reading" | "parsing" | "building";
  /** Decompressed bytes read so far. */
  bytes: number;
  /** Source byte size (compressed, if gzipped), for a rough fraction. */
  sourceBytes: number;
}

export type ProgressFn = (p: ParseProgress) => void;

/** First two bytes of a gzip stream. */
function isGzip(head: Uint8Array): boolean {
  return head[0] === 0x1f && head[1] === 0x8b;
}

/**
 * Decompress (if gzipped) and parse an ncdu export from a Blob.
 *
 * The gzip magic bytes are sniffed so this handles both cases: a plain
 * `ncdu -o file.json` and a `… | gzip` blob. (The /api/scan path arrives
 * already inflated by the browser, so it lands here as plain JSON.)
 *
 * Kept runtime-agnostic (Blob, DecompressionStream, TextDecoder are available
 * in browsers, Workers, and Node ≥18) so it can be unit-tested directly.
 */
export async function decodeScan(source: Blob, onProgress?: ProgressFn): Promise<ParseResult> {
  const sourceBytes = source.size;
  const head = new Uint8Array(await source.slice(0, 2).arrayBuffer());

  let stream: ReadableStream<Uint8Array> = source.stream();
  if (isGzip(head)) {
    // TS lib types DecompressionStream's writable as the wider BufferSource,
    // which trips pipeThrough's invariant pair type under TS6 typed-array
    // generics. Runtime is correct; narrow the pair type explicitly.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const gunzip = new DecompressionStream("gzip") as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >;
    stream = stream.pipeThrough(gunzip);
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      bytes += value.byteLength;
      chunks.push(decoder.decode(value, { stream: true }));
      onProgress?.({ phase: "reading", bytes, sourceBytes });
    }
  }
  chunks.push(decoder.decode());

  onProgress?.({ phase: "parsing", bytes, sourceBytes });
  const json: unknown = JSON.parse(chunks.join(""));

  onProgress?.({ phase: "building", bytes, sourceBytes });
  return parseNcdu(json);
}
