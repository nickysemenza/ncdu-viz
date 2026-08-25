/**
 * Test-only generator for synthetic `ncdu -o` exports.
 *
 * The streaming parser in `scanParse.ts` is hand-written over raw bytes, so the
 * thing most worth testing is that it agrees with the reference `parseNcdu`
 * implementation on inputs neither was tuned for. This produces deterministic
 * pseudo-random trees exercising the awkward cases — hard links, escaped and
 * non-ASCII names, absent `dsize`, empty directories, malformed child entries —
 * and serializes them in both whitespace styles real exports come in.
 *
 * Not imported by application code; it is tree-shaken out of the bundle.
 */

/** Deterministic PRNG (mulberry32) — no dependency, and reproducible failures. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Junk entries in child position, which the reference parser skips. */
const MALFORMED: unknown[] = [null, 42, "junk", true];

/** Names chosen to cover ASCII, dotfiles, spaces, unicode, and JSON escapes. */
const NAME_POOL = [
  "index.js",
  "README.md",
  "photo.JPG",
  "archive.tar.gz",
  ".bashrc",
  "no-extension",
  "with space.txt",
  "café.txt",
  "日本語.dat",
  "emoji-🎉.bin",
  'quote".txt',
  "back\\slash.txt",
  "tab\there.txt",
  "newline\nhere.txt",
  "UPPER.TXT",
];

export interface GenOptions {
  seed?: number;
  /** Approximate number of nodes to emit. */
  targetNodes?: number;
  maxDepth?: number;
  /** Chance a generated file participates in a hard-link group. */
  hardlinkChance?: number;
  /** Chance of emitting a malformed (non-object, non-array) child entry. */
  malformedChance?: number;
}

/** A generated export plus the facts a test needs to assert against. */
export interface Generated {
  /** The raw ncdu structure, ready for `JSON.stringify` or `parseNcdu`. */
  raw: unknown;
  /** One JSON value per line, as real `ncdu -o` emits. */
  compact: string;
  /** `JSON.stringify(raw, null, 2)` — as `fixtures/sample.json` is stored. */
  pretty: string;
  /** Entire export on a single line, as `public/example.json` is stored. */
  oneLine: string;
}

/**
 * Build a synthetic export. `dev` is emitted on the root only, so hard-link
 * identity is scoped the same way a real single-filesystem scan scopes it.
 */
export function generateNcdu(opts: GenOptions = {}): Generated {
  const {
    seed = 1,
    targetNodes = 400,
    maxDepth = 6,
    hardlinkChance = 0.12,
    malformedChance = 0.04,
  } = opts;
  const rand = rng(seed);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

  let emitted = 0;
  let counter = 0;
  // Reused inode numbers, so several files genuinely share an inode.
  const inodePool: number[] = [];

  const makeFile = (): Record<string, unknown> => {
    const name = `${pick(NAME_POOL)}~${counter++}`;
    const asize = Math.floor(rand() * 200000);
    const node: Record<string, unknown> = { name, asize };
    // ncdu omits dsize when it equals asize closely enough; cover both branches.
    if (rand() > 0.25) node["dsize"] = Math.ceil(asize / 4096) * 4096;
    if (rand() < hardlinkChance) {
      const reuse = inodePool.length > 0 && rand() < 0.6;
      const ino = reuse ? pick(inodePool) : 1000 + counter;
      if (!reuse) inodePool.push(ino);
      node["ino"] = ino;
      node["hlnkc"] = true;
      node["nlink"] = 2 + Math.floor(rand() * 3);
    }
    emitted++;
    return node;
  };

  const makeDir = (depth: number): unknown[] => {
    const info: Record<string, unknown> = {
      name: depth === 0 ? "/synthetic/root" : `dir~${counter++}`,
      asize: 4096,
    };
    if (depth === 0) info["dev"] = 16777232;
    emitted++;
    const out: unknown[] = [info];

    // Empty directories are a real case and a common off-by-one source.
    if (depth > 0 && rand() < 0.08) return out;

    // Guarantee the awkward shapes rather than hoping the seed produces them:
    // every tree gets an empty directory and a name needing JSON unescaping.
    if (depth === 0) {
      out.push([{ name: "empty~dir", asize: 4096 }]);
      out.push({ name: 'literal"quote\\and\ttab.txt', asize: 7, dsize: 4096 });
      // A guaranteed hard-link group: two paths, one inode. The second instance
      // must be deduped to zero and must list the first as a sibling path.
      out.push({ name: "linked-a.bin", asize: 8192, dsize: 8192, ino: 777, hlnkc: true, nlink: 2 });
      out.push({ name: "linked-b.bin", asize: 8192, dsize: 8192, ino: 777, hlnkc: true, nlink: 2 });
      emitted += 4;
    }

    const width = 1 + Math.floor(rand() * 5);
    for (let i = 0; i < width; i++) {
      // `emitted` is bumped inside makeFile/makeDir, so the budget check lives
      // in the body rather than the loop condition.
      if (emitted >= targetNodes) break;
      if (rand() < malformedChance) {
        // parseNcdu tolerates junk entries; the streaming parser must too.
        out.push(pick(MALFORMED));
        continue;
      }
      if (depth < maxDepth && rand() < 0.35) out.push(makeDir(depth + 1));
      else out.push(makeFile());
    }
    return out;
  };

  const root = makeDir(0);
  const raw: unknown = [1, 2, { progname: "ncdu", progver: "2.9.2", timestamp: 1781799785 }, root];

  return {
    raw,
    compact: toCompactLines(raw),
    pretty: JSON.stringify(raw, null, 2),
    oneLine: JSON.stringify(raw),
  };
}

/**
 * Serialize in ncdu's own style: the header tuple opens on line 1 and every
 * subsequent JSON value sits on its own line, with `[` opening a directory.
 */
export function toCompactLines(raw: unknown): string {
  if (!Array.isArray(raw)) throw new Error("expected the 4-element header tuple");
  const [major, minor, meta, root] = raw;
  const parts: string[] = [
    `[${JSON.stringify(major)},${JSON.stringify(minor)},${JSON.stringify(meta)},`,
  ];

  const walk = (item: unknown, last: boolean): void => {
    if (Array.isArray(item)) {
      parts.push(`[${JSON.stringify(item[0])}`);
      for (let i = 1; i < item.length; i++) {
        parts[parts.length - 1] += ",";
        walk(item[i], i === item.length - 1);
      }
      parts[parts.length - 1] += "]";
    } else {
      parts.push(JSON.stringify(item));
    }
    if (last) return;
  };

  walk(root, true);
  parts[parts.length - 1] += "]";
  return parts.join("\n");
}
