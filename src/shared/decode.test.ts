import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeScan, type ParseProgress } from "./decode";
import { summarize } from "./ncdu";

const sampleBytes = readFileSync(
  fileURLToPath(new URL("../../fixtures/sample.json", import.meta.url)),
);

/** gzip a buffer using the platform CompressionStream (Node ≥18 / browsers). */
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  // Same typed-array generics friction as decode.ts; narrow the pair type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const cs = new CompressionStream("gzip") as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("decodeScan", () => {
  it("parses a plain (uncompressed) ncdu blob", async () => {
    const result = await decodeScan(new Blob([sampleBytes]));
    expect(summarize(result.root).totalSize).toBe(57344);
    expect(result.meta.root).toBe("/private/tmp/ncdu-fix");
  });

  it("sniffs gzip magic bytes and inflates a gzipped blob to the same tree", async () => {
    const gz = await gzip(sampleBytes);
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    const result = await decodeScan(new Blob([gz]));
    const stats = summarize(result.root);
    expect(stats.totalSize).toBe(57344);
    expect(stats.files).toBe(6);
  });

  it("reports progress phases", async () => {
    const phases: ParseProgress["phase"][] = [];
    await decodeScan(new Blob([sampleBytes]), (p) => phases.push(p.phase));
    expect(phases).toContain("reading");
    expect(phases).toContain("parsing");
    expect(phases.at(-1)).toBe("building");
  });
});
