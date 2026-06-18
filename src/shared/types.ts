/** A normalized disk-usage tree node, runtime-agnostic (shared by Worker + client). */
export interface ScanNode {
  name: string;
  /** Size in bytes. For directories, the summed size of all descendants. */
  size: number;
  isDir: boolean;
  children?: ScanNode[];
  /** Lowercased extension without the leading dot; "" for no extension. Leaves only. */
  ext?: string;
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
