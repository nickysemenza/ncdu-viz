import { describe, expect, it } from "vitest";
import { humanBytes, relativeExpiry } from "./format";
import { buildExtColors, largestLeafExt, OTHER_LABEL } from "./color";
import type { ScanNode } from "./types";

describe("humanBytes", () => {
  it("formats decimal (SI) units like ncdu", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(1000)).toBe("1.0 KB");
    expect(humanBytes(20480)).toBe("20.5 KB");
    expect(humanBytes(30063550528)).toBe("30.1 GB");
    expect(humanBytes(4_900_000_000)).toBe("4.9 GB");
  });
});

describe("relativeExpiry", () => {
  const now = Date.parse("2026-06-18T00:00:00Z");
  it("formats days/hours and minutes remaining", () => {
    expect(relativeExpiry("2026-06-24T22:00:00Z", now)).toBe("expires in 6d 22h");
    expect(relativeExpiry("2026-06-18T05:30:00Z", now)).toBe("expires in 5h 30m");
    expect(relativeExpiry("2026-06-18T00:45:00Z", now)).toBe("expires in 45m");
  });
  it("reports expired once past", () => {
    expect(relativeExpiry("2026-06-17T00:00:00Z", now)).toBe("expired");
  });
});

describe("buildExtColors", () => {
  const leaf = (name: string, size: number, ext: string): ScanNode => ({
    name,
    size,
    isDir: false,
    ext,
  });
  const root: ScanNode = {
    name: "/",
    size: 0,
    isDir: true,
    children: [
      leaf("a.jpg", 100, "jpg"),
      leaf("b.jpg", 50, "jpg"),
      leaf("c.txt", 30, "txt"),
      leaf("noext", 5, ""),
    ],
  };

  it("aggregates leaf sizes per extension, sorted desc", () => {
    const { legend } = buildExtColors(root);
    expect(legend[0]).toMatchObject({ ext: "jpg", total: 150 });
    expect(legend[1]).toMatchObject({ ext: "txt", total: 30 });
    expect(legend.map((e) => e.ext)).toContain("");
  });

  it("assigns distinct colors and falls back to OTHER for unknown ext", () => {
    const { colorFor, map } = buildExtColors(root);
    expect(colorFor("jpg")).toBe(map.get("jpg"));
    expect(colorFor("jpg")).not.toBe(colorFor("txt"));
    expect(colorFor("never-seen")).toBe(colorFor("also-never")); // both OTHER
  });

  it("maps each directory to its largest-leaf extension (largestLeafExt)", () => {
    const deep: ScanNode = {
      name: "deep",
      size: 0,
      isDir: true,
      children: [leaf("big.zip", 9999, "zip")],
    };
    const tree: ScanNode = {
      name: "/",
      size: 0,
      isDir: true,
      children: [leaf("a.jpg", 100, "jpg"), deep],
    };
    const map = largestLeafExt(tree);
    expect(map.get(tree)).toBe("zip"); // big.zip is the largest leaf overall
    expect(map.get(deep)).toBe("zip");
  });

  it("buckets extensions beyond the top-N into 'other'", () => {
    const many: ScanNode = {
      name: "/",
      size: 0,
      isDir: true,
      children: Array.from({ length: 20 }, (_, i) => leaf(`f${i}.e${i}`, 100 - i, `e${i}`)),
    };
    const { legend } = buildExtColors(many);
    expect(legend.at(-1)?.ext).toBe(OTHER_LABEL);
    expect(legend.length).toBeLessThanOrEqual(17); // 16 palette + 1 other
  });
});
