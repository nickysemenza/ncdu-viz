import { z } from "zod";

/** JSON response from POST /api/upload (when Accept: application/json). */
export const UploadResponseSchema = z.object({
  url: z.string(),
  slug: z.string(),
  expiresAt: z.string(),
});
export type UploadResponse = z.infer<typeof UploadResponseSchema>;

/**
 * R2 customMetadata stored alongside each blob. Stored data is untrusted input,
 * so this is validated on READ (R2 metadata values are always strings).
 */
export const StoredMetaSchema = z.object({
  created: z.string(),
  root: z.string(),
  enc: z.enum(["gzip", "identity"]),
  scannedAt: z.string().optional(),
});
export type StoredMeta = z.infer<typeof StoredMetaSchema>;

const sizedPath = z.object({ path: z.string().max(512), size: z.number() });

/**
 * Compact digest POSTed to /api/summary — everything the model needs without the
 * full tree. Array + string lengths are capped to bound prompt size/cost.
 */
export const SummaryDigestSchema = z.object({
  slug: z.string().min(1).max(64),
  root: z.string().max(1024),
  totalSize: z.number(),
  files: z.number(),
  dirs: z.number(),
  topExtensions: z.array(z.object({ ext: z.string().max(64), total: z.number() })).max(20),
  largestFiles: z.array(sizedPath).max(20),
  largestDirs: z.array(sizedPath).max(20),
});
export type SummaryDigest = z.infer<typeof SummaryDigestSchema>;

export const SummaryResponseSchema = z.object({ summary: z.string() });
export type SummaryResponse = z.infer<typeof SummaryResponseSchema>;
