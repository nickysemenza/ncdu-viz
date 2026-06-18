import { Hono } from "hono";
import { handleUpload } from "./upload";
import { handleScan, handleDelete } from "./scan";
import { handleSummary } from "./summary";

const app = new Hono<{ Bindings: Env }>();

// Chained route definitions so the inferred type flows into the Hono RPC client (`hc`).
const routes = app
  .get("/api/health", (c) => c.json({ ok: true, service: "ncdu-viz" } as const))
  .post("/api/upload", handleUpload)
  .get("/api/scan/:slug", handleScan)
  .delete("/api/scan/:slug", handleDelete)
  .post("/api/summary", handleSummary);

export type AppType = typeof routes;
export default app;
