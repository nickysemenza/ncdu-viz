import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeScan, type ParseProgress } from "./decode";

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
    const payload = await decodeScan({ blob: new Blob([sampleBytes]) });
    expect(payload.stats.totalSize).toBe(57344);
    expect(payload.meta.root).toBe("/private/tmp/ncdu-fix");
  });

  it("sniffs gzip magic bytes and inflates a gzipped blob to the same tree", async () => {
    const gz = await gzip(sampleBytes);
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    const payload = await decodeScan({ blob: new Blob([gz]) });
    expect(payload.stats.totalSize).toBe(57344);
    expect(payload.stats.files).toBe(6);
  });

  it("reports progress, ending with the build phase", async () => {
    const phases: ParseProgress["phase"][] = [];
    await decodeScan({ blob: new Blob([sampleBytes]) }, (p) => phases.push(p.phase));
    // Reading and parsing are one pass now, so "building" is the only guaranteed
    // report on a small input — a big scan also emits throttled "reading" ticks.
    expect(phases.at(-1)).toBe("building");
  });

  it("surfaces node counts through progress", async () => {
    let last: ParseProgress | null = null;
    await decodeScan({ blob: new Blob([sampleBytes]) }, (p) => {
      last = p;
    });
    expect(last).not.toBeNull();
    expect(last!.nodes).toBe(10);
    expect(last!.sourceBytes).toBe(sampleBytes.byteLength);
  });

  it("rejects a body that is not an ncdu export", async () => {
    await expect(decodeScan({ blob: new Blob(["not json at all"]) })).rejects.toThrow();
  });
});
