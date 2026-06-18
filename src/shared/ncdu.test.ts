import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extOf, flattenLeaves, parseNcdu, summarize, topDirs } from "./ncdu";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), "utf8"),
  );

describe("parseNcdu — real ncdu 2.9.2 fixture", () => {
  // fixtures/sample.json: a controlled tree generated with `ncdu -o`.
  // Expected values were computed independently from the raw JSON (dsize-preferred):
  //   files: b.log, photo.jpg, sub/deep/noext, sub/deep/d.bin, sub/c.txt, a.txt
  //   dirs : root, empty, sub, deep
  const { root, meta } = parseNcdu(fixture("sample.json"));
  const stats = summarize(root);

  it("sums dsize-preferred leaf sizes (dir asize ignored)", () => {
    expect(stats.totalSize).toBe(57344);
    expect(meta.totalSize).toBe(57344);
  });

  it("counts files and directories", () => {
    expect(stats.files).toBe(6);
    expect(stats.dirs).toBe(4);
  });

  it("computes max depth (root = 0; deepest leaf is sub/deep/d.bin)", () => {
    expect(stats.maxDepth).toBe(3);
  });

  it("finds the largest leaf", () => {
    expect(stats.largestLeaf).toEqual({ name: "photo.jpg", size: 20480 });
  });

  it("extracts root path + scan timestamp from the header", () => {
    expect(meta.root).toBe("/private/tmp/ncdu-fix");
    expect(meta.scannedAt).toBe(1781799785);
  });

  it("flattens all leaves sorted by size desc with absolute paths", () => {
    const leaves = flattenLeaves(root, [meta.root]);
    expect(leaves.length).toBe(6);
    expect(leaves[0]).toMatchObject({ name: "photo.jpg", size: 20480 });
    expect(leaves[0]?.path).toBe("/private/tmp/ncdu-fix/photo.jpg");
    // sorted descending
    const sizes = leaves.map((l) => l.size);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    // nested path is preserved
    expect(leaves.find((l) => l.name === "d.bin")?.path).toBe(
      "/private/tmp/ncdu-fix/sub/deep/d.bin",
    );
  });

  it("lists the largest directories (excluding root), by size", () => {
    const dirs = topDirs(root, 10);
    // sub = deep(12288) + c.txt(4096) = 16384 > deep 12288 > empty 0
    expect(dirs.map((d) => d.name)).toEqual(["sub", "deep", "empty"]);
    expect(dirs[0]).toMatchObject({ name: "sub", size: 16384, path: "/private/tmp/ncdu-fix/sub" });
    expect(topDirs(root, 1).length).toBe(1); // respects the limit
  });

  it("derives lowercased extensions, with an empty bucket for no-ext files", () => {
    const exts = new Map<string, number>();
    const collect = (n: typeof root): void => {
      if (n.isDir) n.children?.forEach(collect);
      else exts.set(n.ext ?? "", (exts.get(n.ext ?? "") ?? 0) + n.size);
    };
    collect(root);
    expect(exts.get("txt")).toBe(16384); // a.txt 12288 + c.txt 4096
    expect(exts.get("jpg")).toBe(20480);
    expect(exts.get("")).toBe(4096); // the `noext` file
  });
});

describe("parseNcdu — defensive behavior", () => {
  it("rejects a non-ncdu payload at the boundary", () => {
    expect(() => parseNcdu({ not: "ncdu" })).toThrow();
    expect(() => parseNcdu([1, 2, { progname: "du" }, []])).toThrow();
  });

  it("tolerates malformed child nodes without throwing", () => {
    const payload = [
      1,
      2,
      { progname: "ncdu", timestamp: 1 },
      [
        { name: "root", asize: 4096 },
        { name: "good.txt", dsize: 100 },
        "garbage-node", // skipped
        null, // skipped
        [{ name: "child" }, { name: "nested.bin", asize: 50 }],
      ],
    ];
    const { root } = parseNcdu(payload);
    const stats = summarize(root);
    expect(stats.totalSize).toBe(150); // 100 + 50; garbage skipped
    expect(stats.files).toBe(2);
    expect(stats.dirs).toBe(2); // root + child
  });

  it("handles dotfiles and multi-dot names in extOf", () => {
    expect(extOf("photos.zip")).toBe("zip");
    expect(extOf("archive.tar.gz")).toBe("gz");
    expect(extOf(".bashrc")).toBe("");
    expect(extOf("Makefile")).toBe("");
    expect(extOf("IMG_001.JPG")).toBe("jpg");
  });
});

// Optional: if the user drops their real test.json (the ~30 GB scan) at
// fixtures/test.json, assert the documented totals. Skipped if absent.
const bigPath = fileURLToPath(new URL("../../fixtures/test.json", import.meta.url));
describe.skipIf(!existsSync(bigPath))("parseNcdu — large test.json", () => {
  it("matches the documented totals", () => {
    const { root } = parseNcdu(fixture("test.json"));
    const stats = summarize(root);
    expect(stats.totalSize).toBe(30063550528);
    expect(stats.files).toBe(4305);
    expect(stats.dirs).toBe(440);
    expect(stats.maxDepth).toBe(11);
    expect(stats.largestLeaf?.name).toBe("photos.zip");
  });
});
