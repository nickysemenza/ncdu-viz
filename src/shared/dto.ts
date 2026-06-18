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
