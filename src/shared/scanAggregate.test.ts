import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateNcdu } from "./ncduGen";
import { aggregateScanBytes } from "./scanAggregate";
import { parseScanBytes } from "./scanParse";

const enc = new TextEncoder();
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * The aggregate pass and the full parser must not drift: the server renders its
 * plaintext report from one and the browser renders the UI from the other, and a
 * disagreement would show up as the two describing the same scan differently.
 */
function expectAgreement(text: string, chunkSize?: number): void {
  const bytes = enc.encode(text);
  const summary = aggregateScanBytes(bytes, chunkSize);
  const payload = parseScanBytes(bytes);

  expect(summary.meta).toEqual(payload.meta);
  expect(summary.stats).toEqual(payload.stats);
  expect(summary.digest.largestFiles).toEqual(payload.digest.largestFiles);
  expect(summary.digest.largestDirs).toEqual(payload.digest.largestDirs);
  expect(summary.digest.topExtensions).toEqual(payload.digest.topExtensions);
}

const SOURCES: [string, () => string][] = [
  ["pretty-printed fixture", () => read("../../fixtures/sample.json")],
  ["single-line example", () => read("../../public/example.json")],
  ["generated seed 2", () => generateNcdu({ seed: 2, targetNodes: 1500 }).compact],
  ["generated seed 33", () => generateNcdu({ seed: 33, targetNodes: 2500 }).compact],
  [
    "hard-link heavy",
    () => generateNcdu({ seed: 5, targetNodes: 2000, hardlinkChance: 0.5 }).compact,
  ],
  [
    "malformed heavy",
    () => generateNcdu({ seed: 77, targetNodes: 1200, malformedChance: 0.25 }).compact,
  ],
];

describe("scanAggregate — agrees with the full parser", () => {
  it.each(SOURCES)("matches on %s", (_label, load) => expectAgreement(load()));

  it("matches regardless of chunk boundaries", () => {
    const text = read("../../fixtures/sample.json");
    for (const size of [1, 2, 3, 7, 64, 512]) expectAgreement(text, size);
  });

  it("reports the documented totals for the sample fixture", () => {
    const s = aggregateScanBytes(enc.encode(read("../../fixtures/sample.json")));
    expect(s.stats.totalSize).toBe(57344);
    expect(s.stats.files).toBe(6);
    expect(s.stats.dirs).toBe(4);
    expect(s.meta.root).toBe("/private/tmp/ncdu-fix");
  });

  it("rejects input that is not an ncdu export", () => {
    expect(() => aggregateScanBytes(enc.encode("{}"))).toThrow(/not an ncdu export/);
  });
});

/** Opt-in: NCDU_BIG_FIXTURE=/path/to/scan.json pnpm test scanAggregate */
const bigFixture = process.env["NCDU_BIG_FIXTURE"] ?? "";
describe.skipIf(bigFixture === "" || !existsSync(bigFixture))(
  "scanAggregate — real large scan",
  () => {
    it("stays within a Worker's memory budget", () => {
      const bytes = new Uint8Array(readFileSync(bigFixture));
      if (globalThis.gc) globalThis.gc();
      const before = process.memoryUsage().heapUsed;
      const started = performance.now();
      const summary = aggregateScanBytes(bytes, 1 << 20);
      const elapsed = performance.now() - started;
      const usedMb = (process.memoryUsage().heapUsed - before) / 1048576;

      // eslint-disable-next-line no-console
      console.log(
        `\n  aggregate ${elapsed.toFixed(0)} ms · heap +${usedMb.toFixed(0)} MB` +
          ` · ${summary.stats.files.toLocaleString()} files · ${summary.stats.dirs.toLocaleString()} dirs\n` +
          `  root ${summary.meta.root} · total ${summary.stats.totalSize.toLocaleString()} bytes\n`,
      );

      expect(summary.stats.files).toBeGreaterThan(1_000_000);
      // The whole reason this pass exists: a Worker isolate caps at 128 MB.
      expect(usedMb).toBeLessThan(100);
    }, 120_000);
  },
);
