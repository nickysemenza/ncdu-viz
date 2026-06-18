import type { Context } from "hono";
import { inspectHead } from "../shared/signature";
import { randomSlug } from "../shared/slug";
import type { UploadResponse } from "../shared/dto";

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB (gzipped)
export const EXPIRY_DAYS = 7;
const HEAD_TARGET = 64 * 1024; // signature peek window
const PART_SIZE = 8 * 1024 * 1024; // R2 multipart part size (> 5 MiB minimum)

type Ctx = Context<{ Bindings: Env }>;

class OversizeError extends Error {}

/** Effective size cap — overridable via a MAX_UPLOAD_BYTES var (ops knob / tests). */
function capFor(env: Env): number {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const raw = (env as unknown as { MAX_UPLOAD_BYTES?: string | number }).MAX_UPLOAD_BYTES;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : MAX_UPLOAD_BYTES;
}

/** Concatenate buffered chunks into a single Uint8Array of known length. */
function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * POST /api/upload — stream an ncdu scan into R2.
 *
 * Pipeline (never buffers the whole body):
 *  1. rate-limit by client IP
 *  2. peek the first ~64 KB, gzip-sniff by magic bytes, validate the ncdu
 *     signature + extract root/timestamp (415 on non-ncdu)
 *  3. multipart-upload the body to R2 with a counting size cap (413 on overflow,
 *     aborting the multipart so no partial object lingers)
 *  4. return the viewer URL (text/plain for curl, JSON for Accept: json)
 */
export async function handleUpload(c: Ctx): Promise<Response> {
  const env = c.env;
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";

  // 1. Rate limit (binding may be absent in some local dev setups — guard it).
  const limiter = env.UPLOAD_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: ip });
    if (!success) return c.text("rate limited — slow down and try again shortly\n", 429);
  }

  const cap = capFor(env);

  // Early best-effort reject (the curl pipe sends no Content-Length).
  const contentLength = Number(c.req.header("Content-Length") ?? "0");
  if (contentLength > cap) {
    return c.text("scan too large (200 MB max)\n", 413);
  }

  const body = c.req.raw.body;
  if (!body) return c.text("empty body\n", 400);
  const reader = body.getReader();

  // 2. Gather the head for signature validation (bytes are retained for storage).
  const headChunks: Uint8Array[] = [];
  let headLen = 0;
  let bodyDone = false;
  while (headLen < HEAD_TARGET) {
    const r = await reader.read();
    if (r.done) {
      bodyDone = true;
      break;
    }
    if (r.value) {
      headChunks.push(r.value);
      headLen += r.value.byteLength;
    }
  }
  const head = concat(headChunks, headLen);
  // Detect gzip by magic bytes (authoritative — robust to edge (de)compression
  // or a lying Content-Encoding header).
  const gzipped = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;

  const info = await inspectHead(head, gzipped);
  if (!info.ok) return c.text("not an ncdu export (expected `ncdu -o` JSON)\n", 415);

  // 3. Stream into R2 via multipart upload.
  const slug = randomSlug();
  const customMetadata: Record<string, string> = {
    created: new Date().toISOString(),
    root: info.root.slice(0, 1024),
    enc: gzipped ? "gzip" : "identity",
  };
  if (info.scannedAt !== undefined) customMetadata["scannedAt"] = String(info.scannedAt);

  const mpu = await env.SCANS.createMultipartUpload(slug, {
    httpMetadata: {
      contentType: "application/json",
      ...(gzipped ? { contentEncoding: "gzip" } : {}),
    },
    customMetadata,
  });

  const parts: R2UploadedPart[] = [];
  let partNumber = 1;
  let total = 0;
  let pending: Uint8Array[] = [];
  let pendingLen = 0;

  const flush = async (): Promise<void> => {
    if (pendingLen === 0) return;
    const buf = concat(pending, pendingLen);
    pending = [];
    pendingLen = 0;
    parts.push(await mpu.uploadPart(partNumber++, buf));
  };
  const add = async (chunk: Uint8Array): Promise<void> => {
    total += chunk.byteLength;
    if (total > cap) throw new OversizeError();
    pending.push(chunk);
    pendingLen += chunk.byteLength;
    if (pendingLen >= PART_SIZE) await flush();
  };

  try {
    for (const ch of headChunks) await add(ch);
    if (!bodyDone) {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        if (r.value) await add(r.value);
      }
    }
    await flush();
    if (parts.length === 0) {
      await mpu.abort();
      return c.text("empty body\n", 400);
    }
    await mpu.complete(parts);
  } catch (e) {
    await mpu.abort().catch(() => {});
    if (e instanceof OversizeError) return c.text("scan too large (200 MB max)\n", 413);
    throw e;
  }

  // 4. Respond with the viewer URL.
  const origin = new URL(c.req.url).origin;
  const viewerUrl = `${origin}/v/${slug}`;
  const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 86_400_000).toISOString();

  if ((c.req.header("Accept") ?? "").includes("application/json")) {
    return c.json({ url: viewerUrl, slug, expiresAt } satisfies UploadResponse);
  }
  return c.text(`${viewerUrl}\n`);
}
