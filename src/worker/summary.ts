import type { Context } from "hono";
import { SummaryDigestSchema, type SummaryDigest, type SummaryResponse } from "../shared/dto";
import { humanBytes } from "../shared/format";

type Ctx = Context<{ Bindings: Env }>;

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const SYSTEM_PROMPT =
  "You are a concise disk-usage analyst. Given a summary of a directory scan " +
  "(totals, the biggest file types, and the largest files and directories), write " +
  "2-3 short plain-English sentences for the person who ran the scan: what is using " +
  "the most space, only the 2-3 most dominant file types (never list them all), and " +
  "one practical cleanup note if something stands out. Use the human-readable sizes " +
  "given. Only use facts present in the data — never invent paths or numbers. No " +
  "preamble, no bullet points, no markdown.";

/** Render the numeric digest into a human-readable prompt (so the model needn't do byte math). */
function formatDigest(d: SummaryDigest): string {
  const exts = d.topExtensions
    .map((e) => `${e.ext || "(no ext)"} ${humanBytes(e.total)}`)
    .join(", ");
  const dirs = d.largestDirs.map((x) => `${x.path} (${humanBytes(x.size)})`).join("\n");
  const files = d.largestFiles.map((x) => `${x.path} (${humanBytes(x.size)})`).join("\n");
  return [
    `Scan root: ${d.root}`,
    `Total: ${humanBytes(d.totalSize)} across ${d.files.toLocaleString()} files in ${d.dirs.toLocaleString()} directories.`,
    `Top file types by size: ${exts}`,
    `Largest directories:\n${dirs}`,
    `Largest files:\n${files}`,
  ].join("\n\n");
}

function extractResponse(res: unknown): string {
  if (res instanceof ReadableStream || typeof res !== "object" || res === null) return "";
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const r = (res as { response?: unknown }).response;
  return typeof r === "string" ? r.trim() : "";
}

/**
 * POST /api/summary — an LLM summary of a scan (shared scans only).
 *
 * The result is cached in R2 keyed by slug (the scan is immutable, and the
 * bucket's 7-day lifecycle expires the sidecar too), so the common case —
 * viewing an existing/older scan — never re-runs inference. The rate limit
 * therefore only applies to genuinely new summaries (cache misses).
 */
export async function handleSummary(c: Ctx): Promise<Response> {
  const env = c.env;

  const parsed = SummaryDigestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.text("invalid digest\n", 400);
  const digest = parsed.data;

  const cacheKey = `summaries/${digest.slug}`;
  const cached = await env.SCANS.get(cacheKey);
  if (cached) {
    return c.json({ summary: await cached.text() } satisfies SummaryResponse);
  }

  const limiter = env.SUMMARY_LIMITER;
  if (limiter) {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const { success } = await limiter.limit({ key: ip });
    if (!success) return c.text("rate limited — try again shortly\n", 429);
  }

  let summary: string;
  try {
    const res = await env.AI.run(MODEL, {
      max_tokens: 300,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: formatDigest(digest) },
      ],
    });
    summary = extractResponse(res);
  } catch {
    return c.text("summary unavailable\n", 502);
  }
  if (!summary) return c.text("summary unavailable\n", 502);

  await env.SCANS.put(cacheKey, summary);
  return c.json({ summary } satisfies SummaryResponse);
}
