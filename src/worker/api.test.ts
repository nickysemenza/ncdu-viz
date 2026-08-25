// Test doubles use boundary casts (mock R2, Env stub, json() results) — expected in tests.
// oxlint-disable typescript/no-unsafe-type-assertion
import { describe, expect, it, vi } from "vitest";
import app from "./index";

// ── In-memory R2 mock (multipart) ────────────────────────────────────────────
// Exercises the real handler logic: multipart sequencing, the counting size cap
// + abort, signature gate, enc metadata, and the gzip serve path.
interface StoredObject {
  body: Uint8Array;
  customMetadata: Record<string, string>;
}

function fakeR2() {
  const store = new Map<string, StoredObject>();
  let aborted = false;
  const bucket = {
    aborts: () => aborted,
    objects: store,
    async createMultipartUpload(key: string, opts: { customMetadata: Record<string, string> }) {
      const parts: Uint8Array[] = [];
      return {
        async uploadPart(n: number, data: Uint8Array) {
          parts[n - 1] = new Uint8Array(data);
          return { partNumber: n, etag: String(n) };
        },
        async complete() {
          const total = parts.reduce((s, p) => s + (p?.byteLength ?? 0), 0);
          const body = new Uint8Array(total);
          let o = 0;
          for (const p of parts) {
            body.set(p, o);
            o += p.byteLength;
          }
          store.set(key, { body, customMetadata: opts.customMetadata });
        },
        async abort() {
          aborted = true;
        },
      };
    },
    async get(key: string) {
      const e = store.get(key);
      if (!e) return null;
      return {
        body: new Blob([e.body]).stream(),
        customMetadata: e.customMetadata,
        text: async () => new TextDecoder().decode(e.body),
      };
    },
    async put(key: string, value: string | ArrayBuffer | Uint8Array) {
      const body =
        typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
      store.set(key, { body, customMetadata: {} });
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
  return bucket;
}

function makeEnv(overrides: Partial<Record<string, unknown>> = {}): Env {
  return {
    SCANS: fakeR2(),
    UPLOAD_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    SUMMARY_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    AI: { run: vi.fn(async () => ({ response: "Mostly video files (~860 GB)." })) },
    ...overrides,
    // The handlers only touch SCANS / limiters / AI; cast covers the rest.
  } as unknown as Env;
}

const DIGEST = {
  slug: "abc123def456ghi",
  root: "/srv",
  totalSize: 1_000_000,
  files: 3,
  dirs: 1,
  topExtensions: [{ ext: "bin", total: 50 }],
  largestFiles: [{ path: "/srv/b.bin", size: 50 }],
  largestDirs: [{ path: "/srv/sub", size: 50 }],
};

const postSummary = (env: Env, body: unknown = DIGEST): Promise<Response> =>
  app.request(
    "/api/summary",
    { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
    env,
  );

const NCDU =
  '[1,2,{"progname":"ncdu","timestamp":42},\n[{"name":"/srv","asize":4096},{"name":"a.txt","dsize":100},{"name":"b.bin","dsize":50}]]';

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([new TextEncoder().encode(text)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const upload = (env: Env, body: BodyInit, headers?: Record<string, string>): Promise<Response> =>
  app.request("/api/upload", { method: "POST", body, headers }, env);
// The response body is two lines (viewer URL, then report URL), so parse the
// first line specifically rather than splitting the whole body.
const slugOf = async (res: Response): Promise<string> => {
  const firstLine = (await res.text()).split("\n")[0] ?? "";
  return firstLine.trim().split("/v/")[1] ?? "";
};

describe("POST /api/upload + GET /api/scan", () => {
  it("multipart-stores a gzipped upload and serves it back as a single gzip stream", async () => {
    const env = makeEnv();
    const gz = await gzip(NCDU);
    const up = await upload(env, gz, { "Content-Encoding": "gzip" });
    expect(up.status).toBe(200);
    const slug = await slugOf(up);
    expect(slug.length).toBeGreaterThan(10);

    const scan = await app.request(`/api/scan/${slug}`, {}, env);
    expect(scan.status).toBe(200);
    expect(scan.headers.get("content-encoding")).toBe("gzip");
    expect(scan.headers.get("x-scan-root")).toBe("/srv");

    // Body is the stored gzip bytes verbatim (encodeBody:"manual" passthrough intent).
    const raw = new Uint8Array(await scan.arrayBuffer());
    expect([raw[0], raw[1]]).toEqual([0x1f, 0x8b]);
    const text = await new Response(
      new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).text();
    expect(JSON.parse(text)[3][0].name).toBe("/srv");
  });

  it("stores a plain upload as identity and serves it without Content-Encoding", async () => {
    const env = makeEnv();
    const slug = await slugOf(await upload(env, NCDU));
    const scan = await app.request(`/api/scan/${slug}`, {}, env);
    expect(scan.headers.get("content-encoding")).toBeNull();
    expect(JSON.parse(await scan.text())[3][0].name).toBe("/srv");
  });

  it("rejects a non-ncdu body with 415 (the anti-abuse gate)", async () => {
    const env = makeEnv();
    expect((await upload(env, '{"not":"ncdu"}')).status).toBe(415);
  });

  it("aborts the multipart upload and returns 413 when streaming past the size cap", async () => {
    const env = makeEnv({ MAX_UPLOAD_BYTES: 64 });
    const bucket = env.SCANS as unknown as { aborts: () => boolean };
    // A chunked (no Content-Length) body so the streaming counter — not the
    // early Content-Length check — trips the cap. NCDU is ~120 bytes > 64.
    const body = new Blob([new TextEncoder().encode(NCDU)]).stream();
    const res = await app.request(
      "/api/upload",
      { method: "POST", body, duplex: "half" } as RequestInit,
      env,
    );
    expect(res.status).toBe(413);
    expect(bucket.aborts()).toBe(true);
  });

  it("returns JSON when Accept: application/json", async () => {
    const env = makeEnv();
    const up = await upload(env, NCDU, { Accept: "application/json" });
    expect(up.headers.get("content-type")).toContain("application/json");
    const body = (await up.json()) as { url: string; slug: string; expiresAt: string };
    expect(body.url).toContain("/v/");
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("rate-limits when the limiter denies", async () => {
    const env = makeEnv({
      UPLOAD_LIMITER: { limit: vi.fn(async () => ({ success: false })) },
    });
    expect((await upload(env, NCDU)).status).toBe(429);
  });

  it("404s for an unknown slug", async () => {
    const env = makeEnv();
    expect((await app.request("/api/scan/nope", {}, env)).status).toBe(404);
  });

  it("generates a summary, then serves it from cache without re-running inference", async () => {
    const env = makeEnv();
    const ai = (env as unknown as { AI: { run: ReturnType<typeof vi.fn> } }).AI.run;

    const first = await postSummary(env);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { summary: string }).summary).toContain("video");
    expect(ai).toHaveBeenCalledTimes(1);

    // Second request for the same slug hits the R2 cache.
    const second = await postSummary(env);
    expect(second.status).toBe(200);
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it("rate-limits summary generation on a cache miss", async () => {
    const env = makeEnv({ SUMMARY_LIMITER: { limit: vi.fn(async () => ({ success: false })) } });
    const ai = (env as unknown as { AI: { run: ReturnType<typeof vi.fn> } }).AI.run;
    expect((await postSummary(env)).status).toBe(429);
    expect(ai).not.toHaveBeenCalled();
  });

  it("rejects an invalid digest with 400", async () => {
    expect((await postSummary(makeEnv(), { nope: true })).status).toBe(400);
  });

  it("exposes an X-Scan-Expires header (created + 7 days)", async () => {
    const env = makeEnv();
    const slug = await slugOf(await upload(env, NCDU));
    const scan = await app.request(`/api/scan/${slug}`, {}, env);
    const expires = scan.headers.get("x-scan-expires");
    expect(expires).toBeTruthy();
    expect(Date.parse(expires ?? "")).toBeGreaterThan(Date.now());
  });

  it("DELETE removes the scan (subsequent GET → 404)", async () => {
    const env = makeEnv();
    const slug = await slugOf(await upload(env, NCDU));
    expect((await app.request(`/api/scan/${slug}`, {}, env)).status).toBe(200);
    const del = await app.request(`/api/scan/${slug}`, { method: "DELETE" }, env);
    expect(del.status).toBe(204);
    expect((await app.request(`/api/scan/${slug}`, {}, env)).status).toBe(404);
  });
});

describe("POST /api/upload — response shape", () => {
  it("keeps the viewer URL alone on line 1 so existing pipelines still work", async () => {
    const env = makeEnv();
    const body = await (await upload(env, NCDU)).text();
    const [first, second] = body.split("\n");
    expect(first).toMatch(/^https?:\/\/[^\s]+\/v\/[A-Za-z0-9]+$/);
    expect(second).toBe(`${first}.txt`);
  });
});

describe("GET /v/:slug.txt (plain-text report)", () => {
  const report = (env: Env, slug: string): Promise<Response> =>
    app.request(`/v/${slug}.txt`, {}, env);

  it("renders a report for a gzipped scan and caches it in R2", async () => {
    const env = makeEnv();
    const slug = await slugOf(await upload(env, await gzip(NCDU), { "Content-Encoding": "gzip" }));

    const res = await report(env, slug);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("/srv");
    expect(text).toContain("LARGEST FILES");
    expect(text).toContain("a.txt");

    // The sidecar is written so repeat requests never re-parse the scan.
    const bucket = env.SCANS as unknown as ReturnType<typeof fakeR2>;
    expect(bucket.objects.has(`reports/${slug}`)).toBe(true);
  });

  it("serves the cached copy without touching the scan again", async () => {
    const env = makeEnv();
    const slug = await slugOf(await upload(env, NCDU));
    await report(env, slug);

    // Drop the scan itself; a cache hit must still succeed.
    const bucket = env.SCANS as unknown as ReturnType<typeof fakeR2>;
    bucket.objects.delete(slug);
    const res = await report(env, slug);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("LARGEST FILES");
  });

  it("works for an identity (non-gzipped) upload", async () => {
    const env = makeEnv();
    const slug = await slugOf(await upload(env, NCDU));
    const res = await report(env, slug);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("b.bin");
  });

  it("404s for a slug that expired or never existed", async () => {
    const res = await report(makeEnv(), "doesnotexist123");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("expired");
  });

  it("rate limits cache misses", async () => {
    const env = makeEnv({ SUMMARY_LIMITER: { limit: vi.fn(async () => ({ success: false })) } });
    const slug = await slugOf(await upload(env, NCDU));
    const res = await report(env, slug);
    expect(res.status).toBe(429);
  });

  it("hands non-.txt /v/ requests back to the static assets (the SPA)", async () => {
    const assets = { fetch: vi.fn(async () => new Response("<!doctype html>index")) };
    const env = makeEnv({ ASSETS: assets });
    const res = await app.request("/v/abc123", {}, env);
    expect(assets.fetch).toHaveBeenCalled();
    expect(await res.text()).toContain("index");
  });
});

describe("DELETE /api/scan/:slug — derived sidecars", () => {
  it("removes the cached report and summary, not just the scan", async () => {
    const env = makeEnv();
    const slug = await slugOf(await upload(env, NCDU));
    const bucket = env.SCANS as unknown as ReturnType<typeof fakeR2>;

    // Generate both sidecars.
    await app.request(`/v/${slug}.txt`, {}, env);
    await postSummary(env, { ...DIGEST, slug });
    expect(bucket.objects.has(`reports/${slug}`)).toBe(true);
    expect(bucket.objects.has(`summaries/${slug}`)).toBe(true);

    await app.request(`/api/scan/${slug}`, { method: "DELETE" }, env);

    // The report quotes real paths out of the scan, so it must not outlive it.
    expect(bucket.objects.has(slug)).toBe(false);
    expect(bucket.objects.has(`reports/${slug}`)).toBe(false);
    expect(bucket.objects.has(`summaries/${slug}`)).toBe(false);
    expect((await app.request(`/v/${slug}.txt`, {}, env)).status).toBe(404);
  });
});
