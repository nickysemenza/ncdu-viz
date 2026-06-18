import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseNcdu } from "../shared/ncdu";
import { layoutTreemap, type TreemapRect } from "../shared/treemap";
import { frontier } from "./treemapRender";

const root = parseNcdu(
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../../fixtures/sample.json", import.meta.url)), "utf8"),
  ),
).root;

const area = (r: TreemapRect): number => (r.x1 - r.x0) * (r.y1 - r.y0);

describe("frontier (depth-limited cells)", () => {
  const layout = layoutTreemap(root, 1000, 700, { paddingInner: 0 });

  it("collapses directories at the depth limit into single cells", () => {
    // At depth 1: the leaves directly under root + `sub` collapsed into one cell.
    const cells = frontier(layout, 1);
    const names = cells.map((c) => c.node.name).sort();
    expect(names).toEqual(["a.txt", "b.log", "empty", "photo.jpg", "sub"].sort());
    // `sub` is a directory drawn as one aggregated cell.
    expect(cells.find((c) => c.node.name === "sub")?.node.isDir).toBe(true);
  });

  it("still tiles the whole canvas after collapsing (no gaps)", () => {
    const covered = frontier(layout, 1).reduce((s, c) => s + area(c), 0);
    expect(covered / (1000 * 700)).toBeCloseTo(1.0, 5);
  });

  it("reveals all leaves at full depth", () => {
    const cells = frontier(layout, 3);
    const leaves = cells.filter((c) => !c.node.isDir);
    expect(leaves.length).toBe(6);
  });
});
