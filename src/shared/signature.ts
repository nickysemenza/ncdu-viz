/**
 * Anti-abuse signature gate. The /api/upload endpoint only accepts ncdu exports,
 * never arbitrary blobs — so we peek the first ~64 KB of the (possibly gzipped)
 * body, inflate just that head, and confirm it begins with the ncdu export shape.
 * Root path + scan timestamp are extracted from the same head for R2 metadata,
 * avoiding a full server-side parse.
 */

/** Matches `[1,2,{"progname":"ncdu"…` tolerantly (any major/minor, any whitespace). */
const NCDU_SIGNATURE = /^\s*\[\s*\d+\s*,\s*\d+\s*,\s*\{\s*"progname"\s*:\s*"ncdu"/;

/** First `[{"name":"…"}` after the header — the root directory's own info object. */
const ROOT_NAME = /\[\s*\{\s*"name"\s*:\s*"((?:\\.|[^"\\])*)"/;
const TIMESTAMP = /"timestamp"\s*:\s*(\d+)/;

export interface NcduHeadInfo {
  ok: boolean;
  root: string;
  scannedAt?: number;
}

/**
 * Inflate a (possibly truncated) gzip head far enough to read the signature.
 * A 64 KB slice of a larger gzip stream is incomplete, so the final flush throws
 * "unexpected end of input" — we ignore that and keep whatever decompressed
 * prefix we collected, which is all the signature check needs.
 */
async function inflateHead(head: Uint8Array, gzipped: boolean, maxChars = 8192): Promise<string> {
  if (!gzipped) return new TextDecoder().decode(head);

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const ds = new DecompressionStream("gzip") as unknown as {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  const writer = ds.writable.getWriter();
  // Fire-and-forget; truncated tail rejects these — intentionally swallowed.
  void writer.write(head).catch(() => {});
  void writer.close().catch(() => {});

  const reader = ds.readable.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        text += decoder.decode(value, { stream: true });
        if (text.length >= maxChars) break;
      }
    }
  } catch {
    // Truncated gzip tail — we already have the prefix we need.
  }
  return text;
}

/** Validate the ncdu signature and extract root path + timestamp from a head buffer. */
export async function inspectHead(head: Uint8Array, gzipped: boolean): Promise<NcduHeadInfo> {
  const text = await inflateHead(head, gzipped);
  if (!NCDU_SIGNATURE.test(text)) return { ok: false, root: "" };

  const rootMatch = ROOT_NAME.exec(text);
  const tsMatch = TIMESTAMP.exec(text);
  const root = rootMatch?.[1] ? rootMatch[1].replace(/\\(.)/g, "$1") : "";
  const scannedAt = tsMatch?.[1] ? Number(tsMatch[1]) : undefined;
  return { ok: true, root, scannedAt };
}
