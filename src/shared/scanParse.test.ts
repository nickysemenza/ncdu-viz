import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseNcdu } from "./ncdu";
import { generateNcdu } from "./ncduGen";
import { parseScanBytes } from "./scanParse";
import { ScanTable, type ScanPayload } from "./scanTable";
import type { ScanNode } from "./types";

const enc = new TextEncoder();
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

interface Row {
  name: string;
  size: number;
  isDir: boolean;
  ext: string;
  dup: boolean;
  depth: number;
}

/** Pre-order flatten of the reference tree — the order the table should match. */
function flattenTree(root: ScanNode): Row[] {
  const out: Row[] = [];
  const walk = (n: ScanNode, depth: number): void => {
    out.push({
      name: n.name,
      size: n.size,
      isDir: n.isDir,
      ext: n.ext ?? "",
      dup: n.dupHardlink === true,
      depth,
    });
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}

function flattenTable(p: ScanPayload): Row[] {
  const t = new ScanTable(p);
  const out: Row[] = [];
  for (let i = 0; i < p.nodeCount; i++) {
    out.push({
      name: t.nameOf(i),
      size: p.size[i],
      isDir: t.isDir(i),
      ext: t.isDir(i) ? "" : (p.extTable[p.extId[i]] ?? ""),
      dup: t.isDupHardlink(i),
      depth: p.depth[i],
    });
  }
  return out;
}

/** The core claim: the streaming parser agrees with the reference, node for node. */
function expectAgreement(text: string, chunkSize?: number): ScanPayload {
  const payload = parseScanBytes(enc.encode(text), chunkSize);
  const reference = parseNcdu(JSON.parse(text));
  expect(flattenTable(payload)).toEqual(flattenTree(reference.root));
  expect(payload.stats.totalSize).toBe(reference.root.size);
  expect(payload.meta.root).toBe(reference.meta.root);
  expect(payload.meta.scannedAt).toBe(reference.meta.scannedAt);
  return payload;
}

describe("scanParse — agreement with the reference parser", () => {
  it("handles the pretty-printed repo fixture", () => {
    const p = expectAgreement(read("../../fixtures/sample.json"));
    expect(p.stats.totalSize).toBe(57344);
    expect(p.stats.files).toBe(6);
    expect(p.stats.dirs).toBe(4);
    expect(p.stats.maxDepth).toBe(3);
    expect(p.stats.largestLeaf).toEqual({ name: "photo.jpg", size: 20480 });
  });

  it("handles the single-line bundled example", () => {
    const p = expectAgreement(read("../../public/example.json"));
    expect(p.nodeCount).toBeGreaterThan(1000);
  });

  it.each([1, 2, 3, 5, 8, 13, 21])("agrees on generated tree seed %i", (seed) => {
    const g = generateNcdu({ seed, targetNodes: 600 });
    expectAgreement(g.compact);
    expectAgreement(g.pretty);
    expectAgreement(g.oneLine);
  });

  it("agrees on a hard-link heavy tree", () => {
    const g = generateNcdu({ seed: 99, targetNodes: 1500, hardlinkChance: 0.5 });
    const p = expectAgreement(g.compact);
    expect(p.linkNode.length).toBeGreaterThan(0);
  });

  it("agrees on a malformed-entry heavy tree", () => {
    const g = generateNcdu({ seed: 77, targetNodes: 800, malformedChance: 0.25 });
    expectAgreement(g.compact);
  });
});

describe("scanParse — chunk boundaries", () => {
  it("produces identical output for every possible split point", () => {
    const text = read("../../fixtures/sample.json");
    const bytes = enc.encode(text);
    const whole = flattenTable(parseScanBytes(bytes));
    for (let cut = 1; cut < bytes.length; cut++) {
      const split = flattenTable(parseScanBytes(bytes, cut));
      expect(split, `split at byte ${cut}`).toEqual(whole);
    }
  });

  it("survives byte-at-a-time feeding of a generated tree", () => {
    const g = generateNcdu({ seed: 4, targetNodes: 300 });
    const bytes = enc.encode(g.compact);
    expect(flattenTable(parseScanBytes(bytes, 1))).toEqual(flattenTable(parseScanBytes(bytes)));
  });

  it("splits multi-byte UTF-8 names without corrupting them", () => {
    const g = generateNcdu({ seed: 12, targetNodes: 200 });
    const bytes = enc.encode(g.oneLine);
    for (const size of [1, 2, 3, 7, 64]) {
      expectAgreement(g.oneLine, size);
      expect(parseScanBytes(bytes, size).nodeCount).toBe(parseScanBytes(bytes).nodeCount);
    }
  });
});

describe("scanParse — derived data", () => {
  it("computes subtree ranges that match child counts", () => {
    const g = generateNcdu({ seed: 31, targetNodes: 900 });
    const p = parseScanBytes(enc.encode(g.compact));
    const t = new ScanTable(p);
    const ref = parseNcdu(g.raw);
    const counts: number[] = [];
    const walk = (n: ScanNode): void => {
      counts.push((n.children ?? []).length);
      for (const c of n.children ?? []) walk(c);
    };
    walk(ref.root);
    for (let i = 0; i < p.nodeCount; i++) expect(t.childCount(i)).toBe(counts[i]);
    // Every subtree range must be well formed and nested inside its parent's.
    for (let i = 1; i < p.nodeCount; i++) {
      expect(p.end[i]).toBeGreaterThan(i);
      expect(p.end[i]).toBeLessThanOrEqual(p.end[p.parent[i]]);
    }
  });

  it("reconstructs absolute paths", () => {
    const p = parseScanBytes(enc.encode(read("../../fixtures/sample.json")));
    const t = new ScanTable(p);
    const paths: string[] = [];
    for (let i = 0; i < p.nodeCount; i++) paths.push(t.pathOf(i));
    expect(paths[0]).toBe("/private/tmp/ncdu-fix");
    expect(paths.some((x) => x.endsWith("/photo.jpg"))).toBe(true);
  });

  it("totals extension sizes to the same total as the leaves", () => {
    const g = generateNcdu({ seed: 8, targetNodes: 700 });
    const p = parseScanBytes(enc.encode(g.compact));
    let sum = 0;
    for (let i = 0; i < p.extTotals.length; i++) sum += p.extTotals[i];
    expect(sum).toBe(p.stats.totalSize);
  });

  it("picks the same top files and dirs as the reference implementation", async () => {
    const { flattenLeaves, topDirs } = await import("./ncdu");
    const g = generateNcdu({ seed: 21, targetNodes: 2000 });
    const p = parseScanBytes(enc.encode(g.compact));
    const ref = parseNcdu(g.raw);
    const expectedFiles = flattenLeaves(ref.root, [ref.meta.root])
      .slice(0, 15)
      .map((l) => ({ path: l.path, size: l.size }));
    const expectedDirs = topDirs(ref.root, 15).map((d) => ({ path: d.path, size: d.size }));
    expect(p.digest.largestFiles).toEqual(expectedFiles);
    expect(p.digest.largestDirs).toEqual(expectedDirs);
  });

  it("groups hard links so each inode's other paths are discoverable", () => {
    const g = generateNcdu({ seed: 99, targetNodes: 1500, hardlinkChance: 0.5 });
    const p = parseScanBytes(enc.encode(g.compact));
    const t = new ScanTable(p);
    let checked = 0;
    for (let i = 0; i < p.nodeCount; i++) {
      const info = t.linkInfoOf(i);
      if (!info) continue;
      checked++;
      for (const other of info.otherPaths) expect(other).not.toBe(t.pathOf(i));
    }
    expect(checked).toBe(p.linkNode.length);
  });
});

/**
 * Opt-in guard against the real thing. Point NCDU_BIG_FIXTURE at an uncompressed
 * `ncdu -o` export to run it:
 *
 *   NCDU_BIG_FIXTURE=/path/to/scan.json pnpm test scanParse
 *
 * Deliberately env-gated rather than a checked-in fixture — the scans worth
 * testing here are hundreds of megabytes.
 */
const bigFixture = process.env["NCDU_BIG_FIXTURE"] ?? "";
describe.skipIf(bigFixture === "" || !existsSync(bigFixture))("scanParse — real large scan", () => {
  it("parses within the time and memory the design assumes", () => {
    const bytes = readFileSync(bigFixture);
    const started = performance.now();
    // 1 MiB chunks, matching what the worker coalesces to before pushing.
    const payload = parseScanBytes(new Uint8Array(bytes), 1 << 20);
    const elapsed = performance.now() - started;

    const retained =
      payload.size.byteLength +
      payload.end.byteLength +
      payload.parent.byteLength +
      payload.nameOff.byteLength +
      payload.extId.byteLength +
      payload.domExtId.byteLength +
      payload.depth.byteLength +
      payload.flags.byteLength +
      payload.nameBytes.byteLength;

    // eslint-disable-next-line no-console
    console.log(
      `\n  nodes ${payload.nodeCount.toLocaleString()} · dirs ${payload.stats.dirs.toLocaleString()}` +
        ` · depth ${payload.stats.maxDepth}\n` +
        `  parse ${elapsed.toFixed(0)} ms · retained ${(retained / 1048576).toFixed(0)} MB` +
        ` (${(retained / payload.nodeCount).toFixed(1)} B/node)\n` +
        `  total ${payload.stats.totalSize.toLocaleString()} bytes · exts ${payload.extTable.length.toLocaleString()}\n`,
    );

    expect(payload.nodeCount).toBeGreaterThan(1_000_000);
    // The whole point of the rewrite: parsing must not be the bottleneck.
    expect(elapsed).toBeLessThan(30_000);
    // Well under the old 623 MB tree, and nowhere near the 2.2 GB peak.
    expect(retained / payload.nodeCount).toBeLessThan(70);
  }, 120_000);
});
