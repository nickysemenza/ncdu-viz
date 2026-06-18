import { useCallback, useRef, useState } from "react";
import type { ParseResult } from "../../shared/ncdu";
import { parseScan, type ParseProgress } from "../parseClient";
import { uploadScan } from "../upload";
import type { UploadResponse } from "../../shared/dto";
import { Viewer } from "./Viewer";
import { ParseOverlay } from "./ParseOverlay";
import { CurlRecipe } from "./CurlRecipe";

type Busy = { kind: "parsing"; progress: ParseProgress | null } | { kind: "uploading" } | null;

export function Landing() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [localScan, setLocalScan] = useState<ParseResult | null>(null);
  const [share, setShare] = useState<UploadResponse | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setFile(null);
    setBusy(null);
    setError(null);
    setLocalScan(null);
    setShare(null);
  }, []);

  const onPick = (f: File | undefined): void => {
    if (!f) return;
    setError(null);
    setShare(null);
    setFile(f);
  };

  const viewLocally = async (): Promise<void> => {
    if (!file) return;
    setError(null);
    setBusy({ kind: "parsing", progress: null });
    try {
      const result = await parseScan(file, (p) => setBusy({ kind: "parsing", progress: p }));
      setLocalScan(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not parse scan");
      setBusy(null);
    }
  };

  const loadExample = async (): Promise<void> => {
    setError(null);
    setBusy({ kind: "parsing", progress: null });
    try {
      const res = await fetch("/example.json");
      if (!res.ok) throw new Error(`example unavailable (${res.status})`);
      const blob = await res.blob();
      const result = await parseScan(blob, (p) => setBusy({ kind: "parsing", progress: p }));
      setLocalScan(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load example");
      setBusy(null);
    }
  };

  const uploadAndShare = async (): Promise<void> => {
    if (!file) return;
    setError(null);
    setBusy({ kind: "uploading" });
    try {
      setShare(await uploadScan(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setBusy(null);
    }
  };

  if (localScan) {
    return (
      <div className="flex h-dvh flex-col">
        <Viewer scan={localScan} />
        <BackBar onBack={reset} label="parsed locally · nothing uploaded" />
      </div>
    );
  }

  if (busy?.kind === "parsing") {
    return <ParseOverlay progress={busy.progress} error={null} />;
  }

  return (
    <div className="min-h-dvh bg-graphite-950 px-6 py-12 text-zinc-200">
      <div className="mx-auto flex max-w-2xl flex-col gap-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">ncdu-viz</h1>
          <p className="font-mono text-sm text-zinc-400">
            Explore an <span className="text-zinc-200">ncdu -o</span> scan as a drill-down cushion
            treemap.
          </p>
        </header>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            onPick(e.dataTransfer.files[0]);
          }}
          onClick={() => inputRef.current?.click()}
          className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
            dragOver
              ? "border-sky-500 bg-sky-500/5"
              : "border-graphite-700 bg-graphite-900 hover:border-graphite-700/80"
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".json,.gz,application/json,application/gzip"
            className="hidden"
            onChange={(e) => onPick(e.target.files?.[0])}
          />
          {file ? (
            <p className="font-mono text-sm text-zinc-200">{file.name}</p>
          ) : (
            <p className="font-mono text-sm text-zinc-500">
              drop a <span className="text-zinc-300">file.json</span> (or .gz) here, or click to
              browse
            </p>
          )}
        </div>

        {!file && (
          <p className="-mt-4 text-center font-mono text-xs text-zinc-600">
            or{" "}
            <button
              type="button"
              onClick={() => void loadExample()}
              className="text-sky-400 hover:underline"
            >
              explore an example scan
            </button>{" "}
            (ncdu-viz's node_modules)
          </p>
        )}

        {file && (
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void viewLocally()}
              className="rounded-md bg-graphite-800 px-4 py-2 text-sm font-medium text-zinc-100 ring-1 ring-graphite-700 hover:bg-graphite-700"
            >
              View locally
              <span className="ml-2 text-xs text-zinc-500">private — nothing uploaded</span>
            </button>
            <button
              type="button"
              onClick={() => void uploadAndShare()}
              disabled={busy?.kind === "uploading"}
              className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {busy?.kind === "uploading" ? "Uploading…" : "Upload & share"}
            </button>
            <button
              type="button"
              onClick={reset}
              className="px-2 py-2 text-sm text-zinc-500 hover:text-zinc-300"
            >
              clear
            </button>
          </div>
        )}

        {error && <p className="font-mono text-sm text-rose-400">{error}</p>}
        {share && <SharePanel share={share} />}

        <CurlRecipe origin={window.location.origin} />

        <p className="text-xs leading-relaxed text-zinc-600">
          Anyone with the link can view an uploaded scan; scans auto-delete after 7 days. Don't
          upload anything sensitive — paths reveal usernames and directory structure. Use{" "}
          <span className="text-zinc-400">View locally</span> to keep a scan entirely in your
          browser.
        </p>
      </div>
    </div>
  );
}

function SharePanel({ share }: { share: UploadResponse }) {
  const [copied, setCopied] = useState(false);
  const expires = new Date(share.expiresAt).toISOString().slice(0, 10);
  return (
    <div className="space-y-2 rounded-lg border border-sky-700/40 bg-sky-500/5 p-4">
      <p className="text-sm text-zinc-300">Shareable link (expires {expires}):</p>
      <div className="flex items-center gap-2">
        <a
          href={`/v/${share.slug}`}
          className="flex-1 truncate font-mono text-sm text-sky-300 hover:underline"
        >
          {share.url}
        </a>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(share.url).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="rounded-md bg-graphite-800 px-3 py-1.5 text-xs text-zinc-200 ring-1 ring-graphite-700 hover:bg-graphite-700"
        >
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
    </div>
  );
}

function BackBar({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <div className="flex items-center gap-3 border-t border-graphite-700 bg-graphite-900 px-3 py-1.5">
      <button
        type="button"
        onClick={onBack}
        className="font-mono text-xs text-sky-300 hover:underline"
      >
        ← new scan
      </button>
      <span className="font-mono text-xs text-zinc-600">{label}</span>
    </div>
  );
}
