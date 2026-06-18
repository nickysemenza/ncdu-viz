/** Join absolute path segments, collapsing duplicate slashes (root may be "/abs/path"). */
export function joinSegments(segments: string[]): string {
  return segments.join("/").replace(/\/{2,}/g, "/");
}

/** Split segments into a directory prefix (with trailing slash) and a basename. */
export function splitPath(segments: string[]): { dir: string; name: string } {
  const name = segments[segments.length - 1] ?? "";
  const dirSegs = segments.slice(0, -1);
  const dir = dirSegs.length > 0 ? `${joinSegments(dirSegs)}/` : "";
  return { dir, name };
}
