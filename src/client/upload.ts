import { UploadResponseSchema, type UploadResponse } from "../shared/dto";

/**
 * Upload a scan to /api/upload, gzipping client-side (unless the file is already
 * gzipped) to keep the transfer + R2 storage compact. Returns the shareable URL.
 */
export async function uploadScan(file: Blob): Promise<UploadResponse> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const alreadyGz = head[0] === 0x1f && head[1] === 0x8b;

  let body: Blob;
  if (alreadyGz) {
    body = file instanceof Blob ? file : new Blob([file]);
  } else {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const cs = new CompressionStream("gzip") as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >;
    body = await new Response(file.stream().pipeThrough(cs)).blob();
  }

  const res = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Encoding": "gzip", Accept: "application/json" },
    body,
  });
  if (!res.ok) {
    throw new Error((await res.text()).trim() || `upload failed (${res.status})`);
  }
  return UploadResponseSchema.parse(await res.json());
}
