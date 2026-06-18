import { describe, expect, it } from "vitest";
import { base62, randomSlug } from "./slug";

describe("base62", () => {
  it("encodes known byte sequences", () => {
    expect(base62(new Uint8Array([0]))).toBe("0");
    expect(base62(new Uint8Array([61]))).toBe("z");
    expect(base62(new Uint8Array([62]))).toBe("10");
  });
});

describe("randomSlug", () => {
  it("produces ~22 url-safe chars for 128 bits", () => {
    const slug = randomSlug(16);
    expect(slug).toMatch(/^[0-9A-Za-z]+$/);
    expect(slug.length).toBeGreaterThanOrEqual(18);
    expect(slug.length).toBeLessThanOrEqual(22);
  });

  it("is collision-free across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(randomSlug());
    expect(seen.size).toBe(5000);
  });
});
