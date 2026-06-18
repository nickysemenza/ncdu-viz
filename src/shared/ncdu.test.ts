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

describe("parseNcdu — hard-link dedupe", () => {
  // Two dirs each hold a hard link to the same inode (both flagged hlnkc:true,
  // nlink:2, shared ino) plus two *distinct* same-named files with no ino.
  const payload = [
    1,
    2,
    { progname: "ncdu", timestamp: 1 },
    [
      { name: "/root", asize: 4096, dev: 1 },
      [
        { name: "a" },
        { name: "linked.bin", dsize: 1000, ino: 42, hlnkc: true, nlink: 2 },
        { name: "copy.txt", dsize: 500 }, // distinct file, no ino
      ],
      [
        { name: "b" },
        { name: "linked.bin", dsize: 1000, ino: 42, hlnkc: true, nlink: 2 },
        { name: "copy.txt", dsize: 500 }, // distinct file, no ino
      ],
    ],
  ];
  const { root, meta } = parseNcdu(payload);
  const stats = summarize(root);

  it("counts a hard-linked inode's bytes once, not per link", () => {
    // 1000 (inode once) + 500 + 500 (two distinct copies) = 2000, not 2500.
    expect(stats.totalSize).toBe(2000);
    expect(meta.totalSize).toBe(2000);
  });

  it("excludes the secondary hard link from the file count", () => {
    // linked.bin (1) + copy.txt (2) = 3 unique files; the dup is not counted.
    expect(stats.files).toBe(3);
  });

  it("lists each inode once but keeps genuinely distinct files", () => {
    const leaves = flattenLeaves(root, [meta.root]);
    expect(leaves.filter((l) => l.name === "linked.bin").length).toBe(1);
    // regression guard: same-named files with no shared inode are NOT deduped.
    expect(leaves.filter((l) => l.name === "copy.txt").length).toBe(2);
  });

  it("surfaces nlink on the surviving hard link for the UI badge", () => {
    const leaves = flattenLeaves(root, [meta.root]);
    expect(leaves.find((l) => l.name === "linked.bin")?.nlink).toBe(2);
    expect(leaves.find((l) => l.name === "copy.txt")?.nlink).toBeUndefined();
  });

  it("names the dropped sibling path(s) on the kept hard link", () => {
    const leaves = flattenLeaves(root, [meta.root]);
    const kept = leaves.find((l) => l.name === "linked.bin");
    // the kept row is /root/a/linked.bin; its sibling is /root/b/linked.bin.
    expect(kept?.links).toEqual(["/root/b/linked.bin"]);
    expect(kept?.path).toBe("/root/a/linked.bin");
    // non-hard-linked files carry no links.
    expect(leaves.find((l) => l.name === "copy.txt")?.links).toBeUndefined();
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
