import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aggregateScanBytes } from "./scanAggregate";
import { renderReport } from "./report";

const sample = aggregateScanBytes(
  readFileSync(fileURLToPath(new URL("../../fixtures/sample.json", import.meta.url))),
);

describe("renderReport", () => {
  const text = renderReport(sample);
  const lines = text.split("\n");

  it("leads with the root and the total", () => {
    expect(lines[0]).toContain("/private/tmp/ncdu-fix");
    expect(lines[0]).toContain("57.3 KB");
  });

  it("summarizes counts on the second line", () => {
    expect(lines[1]).toMatch(/scanned \d{4}-\d{2}-\d{2} · 6 files · 4 dirs · depth 3/);
  });

  it("includes the three sections", () => {
    expect(text).toContain("LARGEST DIRECTORIES");
    expect(text).toContain("LARGEST FILES");
    expect(text).toContain("BY EXTENSION");
  });

  it("shows paths relative to the scan root so lines stay short", () => {
    expect(text).toContain("sub/deep/d.bin");
    expect(text).not.toContain("/private/tmp/ncdu-fix/sub/deep/d.bin");
    // The root itself still appears once, as the heading.
    expect(text.split("/private/tmp/ncdu-fix")).toHaveLength(2);
  });

  it("draws a histogram whose longest bar is the largest extension", () => {
    const bars = text
      .split("\n")
      .filter((l) => l.includes("#"))
      .map((l) => l.length - l.indexOf("#"));
    expect(bars.length).toBeGreaterThan(0);
    expect(bars[0]).toBe(Math.max(...bars));
    // Every listed extension gets at least one block, never an invisible row.
    expect(Math.min(...bars)).toBeGreaterThan(0);
  });

  it("ends with a trailing newline so it pipes cleanly", () => {
    expect(text.endsWith("\n")).toBe(true);
  });

  it("appends the viewer URL and expiry when given", () => {
    const withUrl = renderReport(sample, {
      url: "https://example.test/v/abc",
      expiresAt: "2026-09-01T00:00:00.000Z",
    });
    expect(withUrl).toContain("https://example.test/v/abc");
    expect(withUrl).toContain("deleted after 2026-09-01");
  });

  it("honours the row limit", () => {
    const short = renderReport(sample, { rows: 1 });
    expect(short.split("\n").filter((l) => /^\s+1\./.test(l))).toHaveLength(2); // dirs + files
    expect(short.split("\n").filter((l) => /^\s+2\./.test(l))).toHaveLength(0);
  });
});

describe("renderReport — directory chain collapsing", () => {
  const summary = {
    meta: { root: "/r", totalSize: 1000 },
    stats: { totalSize: 1000, files: 3, dirs: 5, maxDepth: 4, largestLeaf: null },
    digest: {
      topExtensions: [],
      largestFiles: [],
      // A pass-through chain (all ~the same bytes) plus one genuinely separate dir.
      largestDirs: [
        { path: "/r/node_modules", size: 1000 },
        { path: "/r/node_modules/.pnpm", size: 990 },
        { path: "/r/node_modules/.pnpm/pkg", size: 985 },
        { path: "/r/other", size: 400 },
      ],
    },
  };

  it("keeps one row per chain, and keeps genuinely distinct directories", () => {
    const lines = renderReport(summary).split("\n");
    const dirs = lines
      .slice(lines.indexOf("LARGEST DIRECTORIES") + 1)
      .filter((l) => /^\s+\d+\./.test(l));
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).toContain("node_modules");
    expect(dirs[0]).not.toContain(".pnpm");
    expect(dirs[1]).toContain("other");
  });

  it("does not collapse a child that is only part of its parent", () => {
    const lines = renderReport({
      ...summary,
      digest: {
        ...summary.digest,
        largestDirs: [
          { path: "/r/a", size: 1000 },
          { path: "/r/a/half", size: 500 },
        ],
      },
    }).split("\n");
    const dirs = lines
      .slice(lines.indexOf("LARGEST DIRECTORIES") + 1)
      .filter((l) => /^\s+\d+\./.test(l));
    expect(dirs).toHaveLength(2);
  });
});
