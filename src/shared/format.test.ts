import { describe, expect, it } from "vitest";
import { humanBytes, relativeExpiry } from "./format";
import { buildExtColors, OTHER_LABEL } from "./color";
import { parseScanBytes } from "./scanParse";
import { ScanTable } from "./scanTable";

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

/** Build a table straight from a raw ncdu structure. */
const tableFrom = (raw: unknown): ScanTable =>
  new ScanTable(parseScanBytes(new TextEncoder().encode(JSON.stringify(raw))));

const header = [1, 2, { progname: "ncdu", progver: "2.9.2", timestamp: 1 }];
const file = (name: string, asize: number): Record<string, unknown> => ({ name, asize });

describe("buildExtColors", () => {
  const colorsFor = (raw: unknown) => {
    const t = tableFrom(raw);
    return { t, ...buildExtColors(t.p.extTable, t.p.extTotals, t.p.extCounts) };
  };

  it("aggregates leaf sizes per extension, sorted desc", () => {
    const { legend } = colorsFor([
      ...header,
      [
        { name: "/", asize: 0 },
        file("a.jpg", 100),
        file("b.jpg", 50),
        file("c.txt", 30),
        file("noext", 5),
      ],
    ]);
    expect(legend[0]).toMatchObject({ ext: "jpg", total: 150 });
    expect(legend[1]).toMatchObject({ ext: "txt", total: 30 });
    expect(legend.map((e) => e.ext)).toContain("");
  });

  it("omits the empty extension when no leaf actually lacks one", () => {
    // Index 0 ("") is reserved before parsing starts, so this would leak into the
    // legend if it were driven by totals alone rather than by leaf counts.
    const { legend } = colorsFor([
      ...header,
      [{ name: "/", asize: 0 }, file("a.jpg", 100), file("b.txt", 50)],
    ]);
    expect(legend.map((e) => e.ext)).not.toContain("");
  });

  it("assigns distinct colors and falls back to OTHER for unknown ext", () => {
    const { colorFor, map } = colorsFor([
      ...header,
      [{ name: "/", asize: 0 }, file("a.jpg", 100), file("b.txt", 50)],
    ]);
    expect(colorFor("jpg")).toBe(map.get("jpg"));
    expect(colorFor("jpg")).not.toBe(colorFor("txt"));
    expect(colorFor("never-seen")).toBe(colorFor("also-never")); // both OTHER
  });

  it("colors a directory by its largest leaf's extension", () => {
    // Replaces the old largestLeafExt map: the parser now writes a domExtId
    // column in one reverse pass instead of building a Map keyed by every node.
    const t = tableFrom([
      ...header,
      [
        { name: "/", asize: 0 },
        file("a.jpg", 100),
        [{ name: "deep", asize: 0 }, file("big.zip", 9999)],
      ],
    ]);
    const deep = [...t.children(t.rootIndex)].find((i) => t.isDir(i));
    expect(deep).toBeDefined();
    if (deep === undefined) return;
    expect(t.extOf(t.rootIndex)).toBe("zip"); // big.zip is the largest leaf overall
    expect(t.extOf(deep)).toBe("zip");
  });

  it("buckets extensions beyond the top-N into 'other'", () => {
    const { legend } = colorsFor([
      ...header,
      [
        { name: "/", asize: 0 },
        ...Array.from({ length: 20 }, (_, i) => file(`f${i}.e${i}`, 100 - i)),
      ],
    ]);
    expect(legend.at(-1)?.ext).toBe(OTHER_LABEL);
    expect(legend.length).toBeLessThanOrEqual(17); // 16 palette + 1 other
  });
});
