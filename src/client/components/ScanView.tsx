import { useCallback, useEffect, useState } from "react";
import type { ParseResult } from "../../shared/ncdu";
import { parseScan, type ParseProgress } from "../parseClient";
import { Viewer } from "./Viewer";
import { ParseOverlay } from "./ParseOverlay";

interface Props {
  slug: string;
}

/** Fetch a shared scan from /api/scan/:slug, parse it in the worker, and view it. */
export function ScanView({ slug }: Props) {
  const [scan, setScan] = useState<ParseResult | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<ParseProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/scan/${encodeURIComponent(slug)}`);
        if (res.status === 404) throw new Error("this scan expired or never existed");
        if (!res.ok) throw new Error(`failed to load scan (${res.status})`);
        const expires = res.headers.get("X-Scan-Expires");
        const blob = await res.blob();
        const result = await parseScan(blob, (p) => {
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

  if (scan) return <Viewer scan={scan} expiresAt={expiresAt} onDelete={onDelete} />;
  return <ParseOverlay progress={progress} error={error} />;
}
