import { describe, expect, it } from "vitest";
import { inspectHead } from "./signature";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const cs = new CompressionStream("gzip") as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const ncduHead =
  '[1,2,{"progname":"ncdu","progver":"2.9.2","timestamp":1781799785},\n[{"name":"/home/me","asize":4096},{"name":"a.txt","dsize":100}]]';

describe("inspectHead", () => {
  it("validates a plain ncdu head and extracts root + timestamp", async () => {
    const info = await inspectHead(enc(ncduHead), false);
    expect(info.ok).toBe(true);
    expect(info.root).toBe("/home/me");
    expect(info.scannedAt).toBe(1781799785);
  });

  it("validates a gzipped ncdu head", async () => {
    const info = await inspectHead(await gzip(enc(ncduHead)), true);
    expect(info.ok).toBe(true);
    expect(info.root).toBe("/home/me");
  });

  it("rejects non-ncdu payloads", async () => {
    expect((await inspectHead(enc('{"hello":"world"}'), false)).ok).toBe(false);
    expect((await inspectHead(enc('[1,2,{"progname":"du"}]'), false)).ok).toBe(false);
  });

  it("validates a TRUNCATED gzip head of a large scan", async () => {
    // High-entropy filler so the gzip genuinely exceeds 64 KB (repetitive data
    // would compress away). The root info sits first, so the inflated prefix of
    // the first 64 KB still carries it.
    const rnd = new Uint8Array(300_000);
    for (let o = 0; o < rnd.length; o += 65536) {
      crypto.getRandomValues(rnd.subarray(o, Math.min(o + 65536, rnd.length)));
    }
    const filler = [...rnd].map((b) => b.toString(16).padStart(2, "0")).join("");
    const big = `[1,2,{"progname":"ncdu","timestamp":42},\n[{"name":"/srv/data","asize":4096},{"name":"f.bin","dsize":1},{"name":"${filler}","dsize":2}]]`;
    const gz = await gzip(enc(big));
    const head = gz.slice(0, 64 * 1024);
    expect(head.byteLength).toBeLessThan(gz.byteLength); // genuinely truncated
    const info = await inspectHead(head, true);
    expect(info.ok).toBe(true);
    expect(info.root).toBe("/srv/data");
    expect(info.scannedAt).toBe(42);
  });
});
