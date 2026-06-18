import type { Context } from "hono";
import { StoredMetaSchema } from "../shared/dto";
import { EXPIRY_DAYS } from "./upload";

type Ctx = Context<{ Bindings: Env }>;

/**
 * GET /api/scan/:slug — stream the stored blob back to the browser.
 *
 * If the blob was stored gzipped we set `Content-Encoding: gzip` together with
 * `encodeBody: "manual"` — without "manual", workerd silently re-gzips the body,
 * delivering gzip-in-gzip that the client can't inflate. A missing object means
 * the scan expired (R2 lifecycle) or never existed → friendly 404.
 */
export async function handleScan(c: Ctx): Promise<Response> {
  const slug = c.req.param("slug");
  if (!slug) return c.text("not found\n", 404);
  const object = await c.env.SCANS.get(slug);
  if (!object) {
    return c.text("this scan expired or never existed\n", 404);
  }

  const parsed = StoredMetaSchema.safeParse(object.customMetadata ?? {});
  const enc = parsed.success ? parsed.data.enc : "identity";

  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  if (parsed.success) {
    headers.set("X-Scan-Root", parsed.data.root);
    headers.set("X-Scan-Enc", parsed.data.enc);
    const created = Date.parse(parsed.data.created);
    if (Number.isFinite(created)) {
      headers.set("X-Scan-Expires", new Date(created + EXPIRY_DAYS * 86_400_000).toISOString());
    }
  }

  if (enc === "gzip") {
    headers.set("Content-Encoding", "gzip");
    return new Response(object.body, { encodeBody: "manual", headers });
  }
  return new Response(object.body, { headers });
}

/**
 * DELETE /api/scan/:slug — remove a scan immediately. No auth: anyone with the
 * link can already view it, so anyone with the link may delete it (idempotent).
 */
export async function handleDelete(c: Ctx): Promise<Response> {
  const slug = c.req.param("slug");
  if (!slug) return c.text("not found\n", 404);
  await c.env.SCANS.delete(slug);
  return c.body(null, 204);
}
