import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseNcdu } from "./ncdu";
import { generateNcdu } from "./ncduGen";
import { parseScanBytes } from "./scanParse";
import { ScanTable } from "./scanTable";
import { cellAt, layoutTreemap, type Cell } from "./scanLayout";
import { depthStats } from "./scanQuery";
import { layoutTreemap as d3Layout } from "./treemap";
import type { ScanNode } from "./types";

const enc = new TextEncoder();
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const W = 1000;
const H = 700;

/** Build both representations from one source so rects can be compared per node. */
function pair(text: string): { t: ScanTable; root: ScanNode } {
  return {
    t: new ScanTable(parseScanBytes(enc.encode(text))),
    root: parseNcdu(JSON.parse(text)).root,
  };
}

/** Pre-order index of every ScanNode, matching the table's index assignment. */
function preorder(root: ScanNode): ScanNode[] {
  const out: ScanNode[] = [];
  const walk = (n: ScanNode): void => {
    out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

const SOURCES: [string, () => string][] = [
  ["sample fixture", () => read("../../fixtures/sample.json")],
  ["bundled example", () => read("../../public/example.json")],
  ["generated seed 3", () => generateNcdu({ seed: 3, targetNodes: 1500 }).compact],
  ["generated seed 44", () => generateNcdu({ seed: 44, targetNodes: 2500 }).compact],
];

describe("scanLayout — geometry identical to the d3 layout", () => {
  it.each(SOURCES)("matches d3 rect-for-rect on %s", (_label, load) => {
    const { t, root } = pair(load());
    const nodes = preorder(root);

    for (const paddingInner of [0, 1, 3]) {
      const d3 = d3Layout(root, W, H, { paddingInner });
      const byNode = new Map(d3.nodes.map((r) => [r.node, r]));

      // No depth or area limit: the pruned layout should reproduce d3 exactly.
      const mine = layoutTreemap(t, t.rootIndex, W, H, { paddingInner });
      expect(mine.cells.length).toBeGreaterThan(0);

      for (const cell of mine.cells) {
        const ref = byNode.get(nodes[cell.index]);
        expect(ref, `node ${cell.index} missing from d3 layout`).toBeDefined();
        if (!ref) continue;
        expect(cell.x0).toBe(ref.x0);
        expect(cell.y0).toBe(ref.y0);
        expect(cell.x1).toBe(ref.x1);
        expect(cell.y1).toBe(ref.y1);
        expect(cell.depth).toBe(ref.depth);
      }
    }
  });

  it.each(SOURCES)("matches d3 at each detail depth on %s", (_label, load) => {
    const { t, root } = pair(load());
    const nodes = preorder(root);
    const d3 = d3Layout(root, W, H, { paddingInner: 1 });
    const byNode = new Map(d3.nodes.map((r) => [r.node, r]));

    for (const maxDepth of [1, 2, 3, 5]) {
      for (const cell of layoutTreemap(t, t.rootIndex, W, H, { paddingInner: 1, maxDepth }).cells) {
        const ref = byNode.get(nodes[cell.index]);
        if (!ref) continue;
        // A collapsed directory keeps the very rect d3 gives it; only its
        // children are absent. That is what makes pruning a subset, not an
        // approximation.
        expect([cell.x0, cell.y0, cell.x1, cell.y1]).toEqual([ref.x0, ref.y0, ref.x1, ref.y1]);
      }
    }
  });
});

describe("scanLayout — tiling invariants", () => {
  const area = (c: Cell): number => (c.x1 - c.x0) * (c.y1 - c.y0);

  it.each(SOURCES)("covers the canvas at every depth on %s", (_label, load) => {
    const { t } = pair(load());
    for (const maxDepth of [1, 2, 3, 6, Infinity]) {
      const { cells } = layoutTreemap(t, t.rootIndex, W, H, { paddingInner: 0, maxDepth });
      const covered = cells.reduce((s, c) => s + area(c), 0);
      expect(covered / (W * H)).toBeCloseTo(1.0, 5);
    }
  });

  it("produces no overlapping cells", () => {
    const { t } = pair(read("../../fixtures/sample.json"));
    const { cells } = layoutTreemap(t, t.rootIndex, W, H, { paddingInner: 0, maxDepth: 3 });
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i];
        const b = cells[j];
        const overlap =
          Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
          Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
        expect(overlap).toBeCloseTo(0, 6);
      }
    }
  });

  it("gives cell area proportional to size", () => {
    const { t } = pair(read("../../public/example.json"));
    const { cells } = layoutTreemap(t, t.rootIndex, W, H, { paddingInner: 0, maxDepth: 1 });
    const total = t.sizeOf(t.rootIndex);
    for (const c of cells) {
      if (t.sizeOf(c.index) === 0) continue;
      expect(area(c) / (W * H)).toBeCloseTo(t.sizeOf(c.index) / total, 4);
    }
  });

  it("reveals every leaf at full depth", () => {
    const { t } = pair(read("../../fixtures/sample.json"));
    const { cells } = layoutTreemap(t, t.rootIndex, W, H, { paddingInner: 0, maxDepth: 3 });
    expect(cells.filter((c) => !t.isDir(c.index))).toHaveLength(6);
  });

  it("collapses directories at the detail limit into one cell each", () => {
    const { t } = pair(read("../../fixtures/sample.json"));
    const { cells } = layoutTreemap(t, t.rootIndex, W, H, { paddingInner: 0, maxDepth: 1 });
    const names = cells.map((c) => t.nameOf(c.index)).sort();
    expect(names).toEqual(["a.txt", "b.log", "empty", "photo.jpg", "sub"].sort());
    const sub = cells.find((c) => t.nameOf(c.index) === "sub");
    expect(sub?.collapsed).toBe(true);
  });
});

describe("scanLayout — pruning and hit testing", () => {
  it("bounds cell count by area regardless of detail depth", () => {
    // The bundled example, not a generated tree: this assertion needs a subtree
    // deep enough that pruning actually has something to collapse.
    const { t } = pair(read("../../public/example.json"));
    // paddingInner: 0 so the coverage check below is not eaten by inter-cell gaps.
    const opts = { paddingInner: 0, maxDepth: Infinity };
    const deep = layoutTreemap(t, t.rootIndex, W, H, { ...opts, minArea: 0 });
    expect(deep.cells.length).toBeGreaterThan(100);
    const pruned = layoutTreemap(t, t.rootIndex, W, H, { ...opts, minArea: 64 });
    expect(pruned.cells.length).toBeLessThan(deep.cells.length);
    // Still a complete tiling — pruning collapses, it never drops area.
    const covered = pruned.cells.reduce((s, c) => s + (c.x1 - c.x0) * (c.y1 - c.y0), 0);
    expect(covered / (W * H)).toBeCloseTo(1.0, 3);
  });

  it("finds the cell under a point, and only one", () => {
    const { t } = pair(read("../../public/example.json"));
    const layout = layoutTreemap(t, t.rootIndex, W, H, { paddingInner: 0, maxDepth: 2 });
    const probes: [number, number][] = [
      [1, 1],
      [W / 2, H / 2],
      [W - 2, H - 2],
      [W / 3, (H * 2) / 3],
    ];
    for (const [x, y] of probes) {
      const hit = cellAt(layout, x, y);
      expect(hit, `no cell at ${x},${y}`).toBeDefined();
      const all = layout.cells.filter((c) => x >= c.x0 && x < c.x1 && y >= c.y0 && y < c.y1);
      expect(all).toHaveLength(1);
    }
  });

  it("returns undefined outside the canvas", () => {
    const { t } = pair(read("../../fixtures/sample.json"));
    const layout = layoutTreemap(t, t.rootIndex, W, H, {});
    expect(cellAt(layout, -1, 5)).toBeUndefined();
    expect(cellAt(layout, W + 5, 5)).toBeUndefined();
  });
});

/** Opt-in: NCDU_BIG_FIXTURE=/path/to/scan.json pnpm test scanLayout */
const bigFixture = process.env["NCDU_BIG_FIXTURE"] ?? "";
describe.skipIf(bigFixture === "" || !existsSync(bigFixture))(
  "scanLayout — real large scan",
  () => {
    it("lays out and hit-tests in interactive time", () => {
      const t = new ScanTable(parseScanBytes(new Uint8Array(readFileSync(bigFixture)), 1 << 20));
      const { suggested, maxDepth } = depthStats(t, t.rootIndex);

      const t0 = performance.now();
      const layout = layoutTreemap(t, t.rootIndex, 1600, 900, {
        paddingInner: 1,
        maxDepth: suggested,
        minArea: 1,
      });
      const layoutMs = performance.now() - t0;

      // 200 hit tests, i.e. roughly three seconds of continuous mouse movement.
      const t1 = performance.now();
      for (let i = 0; i < 200; i++) cellAt(layout, 200 + (i % 1200), 100 + (i % 700));
      const perMove = (performance.now() - t1) / 200;

      // eslint-disable-next-line no-console
      console.log(
        `\n  nodes ${t.nodeCount.toLocaleString()} · depth range 1..${maxDepth} · default ${suggested}\n` +
          `  cells ${layout.cells.length.toLocaleString()} · layout ${layoutMs.toFixed(1)} ms` +
          ` · hit test ${perMove.toFixed(3)} ms/move\n`,
      );

      // Was ~6 s of d3 hierarchy building on every drill and every resize.
      expect(layoutMs).toBeLessThan(250);
      // Was 462 ms per mousemove; the frame budget at 60fps is 16.7 ms.
      expect(perMove).toBeLessThan(1);
    }, 120_000);
  },
);
