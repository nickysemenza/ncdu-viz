/** A normalized disk-usage tree node, runtime-agnostic (shared by Worker + client). */
export interface ScanNode {
  name: string;
  /** Size in bytes. For directories, the summed size of all descendants. */
  size: number;
  isDir: boolean;
  children?: ScanNode[];
  /** Lowercased extension without the leading dot; "" for no extension. Leaves only. */
  ext?: string;
  /**
   * Set on a leaf that is a *secondary* hard link to an inode already counted
   * elsewhere in the tree. Its `size` is forced to 0 (the bytes are attributed
   * to the first occurrence) and list/stat views skip it. See `parseNcdu`.
   */
  dupHardlink?: boolean;
  /** Hard-link count (`nlink`) for a leaf that is hard-linked (nlink > 1); else undefined. */
  nlink?: number;
  /**
   * `${dev}:${ino}` identity for a hard-linked leaf, set on *every* instance
   * (primary + dups) so views can group the paths that share an inode. Absent
   * for non-hard-linked files.
   */
  linkKey?: string;
}

/** Metadata about a scan, surfaced in the viewer header. */
export interface ScanMeta {
  /** Absolute path of the scanned root (the root node's name). */
  root: string;
  /** ncdu scan timestamp (unix seconds), if present in the export. */
  scannedAt?: number;
  /** Total size in bytes. */
  totalSize: number;
}
