import { Hono } from "hono";
import { handleUpload } from "./upload";
import { handleScan, handleDelete } from "./scan";
import { handleSummary } from "./summary";
import { handleReport } from "./report";

const app = new Hono<{ Bindings: Env }>();

// Chained route definitions so the inferred type flows into the Hono RPC client (`hc`).
const routes = app
  .get("/api/health", (c) => c.json({ ok: true, service: "ncdu-viz" } as const))
  .post("/api/upload", handleUpload)
  .get("/api/scan/:slug", handleScan)
  .delete("/api/scan/:slug", handleDelete)
  .post("/api/summary", handleSummary)
  .get("/api/report/:slug", (c) => handleReport(c, c.req.param("slug")))
  /**
   * `/v/:slug.txt` serves the plain-text report so a headless box can read a scan
   * back the same way it piped one up. `run_worker_first` sends every `/v/*`
   * request here, so anything that is not a `.txt` has to be handed back to the
   * static assets — which is where the SPA lives.
   */
  .get("/v/:slug", (c) => {
    const slug = c.req.param("slug");
    if (slug.endsWith(".txt")) return handleReport(c, slug.slice(0, -4));
    return c.env.ASSETS.fetch(c.req.raw);
  });

export type AppType = typeof routes;
export default app;
