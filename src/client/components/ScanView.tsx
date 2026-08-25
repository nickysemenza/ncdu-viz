import { useCallback, useEffect, useState } from "react";
import type { ScanTable } from "../../shared/scanTable";
import { parseScan, type ParseProgress } from "../parseClient";
import { Viewer } from "./Viewer";
import { ParseOverlay } from "./ParseOverlay";

interface Props {
  slug: string;
}

/** Fetch a shared scan from /api/scan/:slug, parse it in the worker, and view it. */
export function ScanView({ slug }: Props) {
  const [scan, setScan] = useState<ScanTable | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<ParseProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const url = `/api/scan/${encodeURIComponent(slug)}`;
        // A HEAD first for the expiry header: the body is streamed and parsed
        // inside the worker, so the main thread never holds the download.
        const head = await fetch(url, { method: "HEAD" });
        if (head.status === 404) throw new Error("this scan expired or never existed");
        const expires = head.headers.get("X-Scan-Expires");
        const result = await parseScan({ url }, (p) => {
          if (alive) setProgress(p);
        });
        if (alive) {
          if (expires) setExpiresAt(expires);
          setScan(result);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "failed to load scan");
      }
    })();
    return () => {
      alive = false;
    };
  }, [slug]);

  const onDelete = useCallback(async () => {
    await fetch(`/api/scan/${encodeURIComponent(slug)}`, { method: "DELETE" });
    window.location.href = "/";
  }, [slug]);

  if (scan) return <Viewer scan={scan} slug={slug} expiresAt={expiresAt} onDelete={onDelete} />;
  return <ParseOverlay progress={progress} error={error} />;
}
