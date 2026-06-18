import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseNcdu } from "./ncdu";
import { depthStats, layoutTreemap, type TreemapRect } from "./treemap";

const W = 1000;
const H = 700;

const sample = parseNcdu(
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../../fixtures/sample.json", import.meta.url)), "utf8"),
  ),
).root;

const area = (r: TreemapRect): number => (r.x1 - r.x0) * (r.y1 - r.y0);
const overlaps = (a: TreemapRect, b: TreemapRect): boolean =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

describe("layoutTreemap — geometry sanity (no padding)", () => {
  const { leaves, nodes } = layoutTreemap(sample, W, H, { paddingInner: 0 });

  it("leaf rects tile the full canvas (coverage ≈ 1.0)", () => {
    const covered = leaves.reduce((s, r) => s + area(r), 0);
    expect(covered / (W * H)).toBeCloseTo(1.0, 5);
  });

  it("leaf areas are proportional to node size", () => {
    const totalSize = leaves.reduce((s, r) => s + r.node.size, 0);
    for (const r of leaves) {
      if (r.node.size === 0) continue;
      const areaFrac = area(r) / (W * H);
      const sizeFrac = r.node.size / totalSize;
      expect(areaFrac).toBeCloseTo(sizeFrac, 3);
    }
  });

  it("every rect stays within the canvas bounds", () => {
    for (const r of nodes) {
      expect(r.x0).toBeGreaterThanOrEqual(-1e-6);
      expect(r.y0).toBeGreaterThanOrEqual(-1e-6);
      expect(r.x1).toBeLessThanOrEqual(W + 1e-6);
      expect(r.y1).toBeLessThanOrEqual(H + 1e-6);
    }
  });

  it("leaf rects do not overlap each other", () => {
    const drawn = leaves.filter((r) => area(r) > 1e-6);
    for (let i = 0; i < drawn.length; i++) {
      for (let j = i + 1; j < drawn.length; j++) {
        const a = drawn[i];
        const b = drawn[j];
        if (!a || !b) continue;
        expect(overlaps(a, b), `${a.node.name} overlaps ${b.node.name}`).toBe(false);
      }
    }
  });

  it("computes depth range and an adaptive default", () => {
    // sample tree: max relative depth 3 (root→sub→deep→d.bin).
    expect(depthStats(sample).maxDepth).toBe(3);
    // small tree fits any target → full depth suggested.
    expect(depthStats(sample).suggested).toBe(3);
    // tight target forces a shallower default (collapse deeper dirs).
    expect(depthStats(sample, 5).suggested).toBeLessThan(3);
  });

  it("directory groups enclose their children", () => {
    // The largest dir group (sub) should bound its descendant leaves.
    const subGroup = nodes.find((n) => n.node.isDir && n.node.name === "sub");
    expect(subGroup).toBeDefined();
    const subLeaves = leaves.filter((l) => ["c.txt", "d.bin", "noext"].includes(l.node.name));
    for (const leaf of subLeaves) {
      expect(leaf.x0).toBeGreaterThanOrEqual((subGroup?.x0 ?? 0) - 1e-6);
      expect(leaf.y0).toBeGreaterThanOrEqual((subGroup?.y0 ?? 0) - 1e-6);
      expect(leaf.x1).toBeLessThanOrEqual((subGroup?.x1 ?? 0) + 1e-6);
      expect(leaf.y1).toBeLessThanOrEqual((subGroup?.y1 ?? 0) + 1e-6);
    }
  });
});
