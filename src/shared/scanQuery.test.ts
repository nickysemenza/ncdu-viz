import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { flattenLeaves, parseNcdu, topDirs as refTopDirs } from "./ncdu";
import { depthStats as refDepthStats } from "./treemap";
import { generateNcdu } from "./ncduGen";
import { parseScanBytes } from "./scanParse";
import { ScanTable } from "./scanTable";
import { depthStats, topDirs, topLeaves } from "./scanQuery";
import type { ScanNode } from "./types";

const enc = new TextEncoder();
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Table + reference tree built from the same source, for side-by-side assertions. */
function pair(text: string): { t: ScanTable; root: ScanNode; rootPath: string } {
  const t = new ScanTable(parseScanBytes(enc.encode(text)));
  const ref = parseNcdu(JSON.parse(text));
  return { t, root: ref.root, rootPath: ref.meta.root };
}

const SOURCES: [string, () => string][] = [
  ["sample fixture", () => read("../../fixtures/sample.json")],
  ["bundled example", () => read("../../public/example.json")],
  ["generated seed 21", () => generateNcdu({ seed: 21, targetNodes: 2000 }).compact],
  [
    "generated hard-link heavy",
    () => generateNcdu({ seed: 99, targetNodes: 1500, hardlinkChance: 0.5 }).compact,
  ],
];

describe("scanQuery — parity with the reference implementations", () => {
  it.each(SOURCES)("depthStats matches on %s", (_label, load) => {
    const { t, root } = pair(load());
    expect(depthStats(t, t.rootIndex)).toEqual(refDepthStats(root));
    // The adaptive default must respond to the target the same way too.
    for (const target of [1, 10, 100, 5000]) {
      expect(depthStats(t, t.rootIndex, target)).toEqual(refDepthStats(root, target));
    }
  });

  it.each(SOURCES)("topLeaves matches flattenLeaves on %s", (_label, load) => {
    const { t, root, rootPath } = pair(load());
    const reference = flattenLeaves(root, [rootPath]);
    for (const limit of [1, 15, 1000]) {
      expect(topLeaves(t, t.rootIndex, limit).rows).toEqual(reference.slice(0, limit));
    }
    expect(topLeaves(t, t.rootIndex, 1).totalFiles).toBe(reference.length);
  });

  it.each(SOURCES)("topDirs matches on %s", (_label, load) => {
    const { t, root } = pair(load());
    for (const limit of [1, 15, 500]) {
      expect(topDirs(t, t.rootIndex, limit)).toEqual(refTopDirs(root, limit));
    }
  });
});

describe("scanQuery — focused subtrees", () => {
  it("matches the reference when focused below the root", () => {
    const text = read("../../public/example.json");
    const { t, root, rootPath } = pair(text);

    // Walk both structures to the same directory: the first child directory.
    const childIdx = [...t.children(t.rootIndex)].find((i) => t.isDir(i));
    const childNode = (root.children ?? []).find((c) => c.isDir);
    expect(childIdx).toBeDefined();
    expect(childNode).toBeDefined();
    if (childIdx === undefined || !childNode) return;

    expect(t.nameOf(childIdx)).toBe(childNode.name);
    expect(t.sizeOf(childIdx)).toBe(childNode.size);
    expect(depthStats(t, childIdx)).toEqual(refDepthStats(childNode));

    const reference = flattenLeaves(childNode, [rootPath, childNode.name]);
    expect(topLeaves(t, childIdx, 50).rows).toEqual(reference.slice(0, 50));
    expect(topLeaves(t, childIdx, 1).totalFiles).toBe(reference.length);
  });

  it("reports subtree ranges consistent with the reference node counts", () => {
    const { t, root } = pair(generateNcdu({ seed: 6, targetNodes: 1200 }).compact);
    const counts: number[] = [];
    const walk = (n: ScanNode): number => {
      const at = counts.length;
      counts.push(0);
      let total = 1;
      for (const c of n.children ?? []) total += walk(c);
      counts[at] = total;
      return total;
    };
    walk(root);
    for (let i = 0; i < t.nodeCount; i++) expect(t.subtreeCount(i)).toBe(counts[i]);
  });
});

describe("scanQuery — bounded output", () => {
  it("keeps only `limit` rows regardless of subtree size", () => {
    const { t } = pair(generateNcdu({ seed: 15, targetNodes: 3000 }).compact);
    const { rows, totalFiles } = topLeaves(t, t.rootIndex, 10);
    expect(rows).toHaveLength(10);
    expect(totalFiles).toBeGreaterThan(10);
    // Descending by size, which is what the Files list relies on.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].size).toBeGreaterThanOrEqual(rows[i].size);
    }
  });

  it("surfaces hard-link siblings on the kept row", () => {
    const { t, root, rootPath } = pair(
      generateNcdu({ seed: 99, targetNodes: 1500, hardlinkChance: 0.5 }).compact,
    );
    const withLinks = topLeaves(t, t.rootIndex, 5000).rows.filter((r) => r.links !== undefined);
    const refWithLinks = flattenLeaves(root, [rootPath]).filter((r) => r.links !== undefined);
    expect(withLinks.length).toBe(refWithLinks.length);
    expect(withLinks.length).toBeGreaterThan(0);
    // The injected pair: one row kept at full size, the other's bytes not counted twice.
    const pairRow = withLinks.find((r) => r.name === "linked-a.bin");
    expect(pairRow?.links).toEqual([expect.stringContaining("linked-b.bin")]);
  });
});
