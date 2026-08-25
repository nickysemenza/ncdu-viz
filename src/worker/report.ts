import type { Context } from "hono";
import { ScanAggregator } from "../shared/scanAggregate";
import { renderReport } from "../shared/report";
import { StoredMetaSchema } from "../shared/dto";
import { EXPIRY_DAYS } from "./upload";

type Ctx = Context<{ Bindings: Env }>;

/**
 * GET /v/:slug.txt — a plain-text report for a scan.
 *
 * Computed with the aggregate-only pass rather than the full table parser: a
 * Worker isolate is capped at 128 MB and the table for a real scan is larger
 * than that, whereas the aggregate keeps only a depth-bounded stack and a few
 * counters (measured at ~8 MB for a 394 MB scan).
 *
 * Rendered lazily and cached in R2 alongside the scan, mirroring the AI summary:
 * the scan is immutable, and the bucket's lifecycle rule expires the sidecar
 * with it. Doing this at upload time instead would mean decompressing and
 * parsing every upload, including the ones nobody ever asks about.
 */
export async function handleReport(c: Ctx, slug: string): Promise<Response> {
  const env = c.env;
  if (!slug) return c.text("not found\n", 404);

  const textHeaders = { "Content-Type": "text/plain; charset=utf-8" };
  const cacheKey = `reports/${slug}`;

  const cached = await env.SCANS.get(cacheKey);
  if (cached) return new Response(cached.body, { headers: textHeaders });

  const object = await env.SCANS.get(slug);
  if (!object) return c.text("this scan expired or never existed\n", 404);

  // Only cache misses do real work, so the limiter only needs to guard those.
  const limiter = env.SUMMARY_LIMITER;
  if (limiter) {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const { success } = await limiter.limit({ key: ip });
    if (!success) return c.text("rate limited — try again shortly\n", 429);
  }

  const parsed = StoredMetaSchema.safeParse(object.customMetadata ?? {});
  const gzipped = parsed.success && parsed.data.enc === "gzip";

  let stream: ReadableStream<Uint8Array> = object.body;
  if (gzipped) {
    // Same typed-array generics friction as the client decoder; runtime is fine.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const gunzip = new DecompressionStream("gzip") as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >;
    stream = stream.pipeThrough(gunzip);
  }

  const aggregator = new ScanAggregator();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) aggregator.push(value);
    }
  } catch {
    return c.text("could not read this scan\n", 500);
  }

  let text: string;
  try {
    const summary = aggregator.finish();
    const origin = new URL(c.req.url).origin;
    const expiresAt =
      parsed.success && Number.isFinite(Date.parse(parsed.data.created))
        ? new Date(Date.parse(parsed.data.created) + EXPIRY_DAYS * 86_400_000).toISOString()
        : undefined;
    text = renderReport(summary, {
      url: `${origin}/v/${slug}`,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });
  } catch {
    return c.text("not an ncdu export\n", 415);
  }

  await env.SCANS.put(cacheKey, text, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  return new Response(text, { headers: textHeaders });
}
