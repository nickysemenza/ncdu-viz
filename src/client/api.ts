import { hc } from "hono/client";
import type { AppType } from "../worker";

/** End-to-end typed API client derived from the Worker's Hono app (no codegen). */
export const api = hc<AppType>("/");
