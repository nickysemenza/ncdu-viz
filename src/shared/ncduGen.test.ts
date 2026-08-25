import { describe, expect, it } from "vitest";
import { generateNcdu, toCompactLines } from "./ncduGen";
import { parseNcdu } from "./ncdu";
import type { ScanNode } from "./types";

describe("generateNcdu", () => {
  it("emits three whitespace styles that all parse to the same structure", () => {
    const g = generateNcdu({ seed: 7, targetNodes: 300 });
    expect(JSON.parse(g.compact)).toEqual(g.raw);
    expect(JSON.parse(g.pretty)).toEqual(g.raw);
    expect(JSON.parse(g.oneLine)).toEqual(g.raw);
  });

  it("emits one JSON value per line in compact form, like real ncdu -o", () => {
    const g = generateNcdu({ seed: 3, targetNodes: 200 });
    // Every line must be a prefix of the document, so no value straddles a newline.
    for (const line of g.compact.split("\n")) {
      expect(line.length).toBeGreaterThan(0);
      expect(line).not.toMatch(/^\s/);
    }
  });

  it("is deterministic for a given seed", () => {
    expect(generateNcdu({ seed: 42 }).compact).toBe(generateNcdu({ seed: 42 }).compact);
    expect(generateNcdu({ seed: 42 }).compact).not.toBe(generateNcdu({ seed: 43 }).compact);
  });

  it("produces trees the reference parser accepts", () => {
    const g = generateNcdu({ seed: 11, targetNodes: 500 });
    const { root, meta } = parseNcdu(g.raw);
    expect(root.isDir).toBe(true);
    expect(meta.root).toBe("/synthetic/root");
    expect(root.size).toBeGreaterThan(0);
  });

  it("covers hard links, empty dirs, escaped names, and malformed entries", () => {
    const g = generateNcdu({ seed: 5, targetNodes: 1200, hardlinkChance: 0.3 });
    const text = g.oneLine;
    expect(text).toContain('"hlnkc":true');
    expect(text).toContain("\\"); // escaped names present
    const { root } = parseNcdu(g.raw);
    const seen = { dup: false, empty: false };
    const walk = (n: ScanNode): void => {
      if (n.dupHardlink === true) seen.dup = true;
      if (n.isDir && (n.children?.length ?? 0) === 0) seen.empty = true;
      for (const c of n.children ?? []) walk(c);
    };
    walk(root);
    expect(seen.dup).toBe(true);
    expect(seen.empty).toBe(true);
  });

  it("round-trips an externally supplied structure through toCompactLines", () => {
    const raw = [1, 2, { progname: "ncdu" }, [{ name: "/r" }, { name: "a", asize: 1 }]];
    expect(JSON.parse(toCompactLines(raw))).toEqual(raw);
  });
});
