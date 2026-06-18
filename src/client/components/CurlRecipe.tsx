import { useState } from "react";

interface Props {
  origin: string;
}

export function CurlRecipe({ origin }: Props) {
  const [copied, setCopied] = useState(false);
  const recipe = `ncdu -o- / | gzip | \\
  curl -s --data-binary @- -H "Content-Encoding: gzip" \\
  ${origin}/api/upload`;

  const copy = (): void => {
    void navigator.clipboard.writeText(recipe).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="rounded-lg border border-graphite-700 bg-graphite-900">
      <div className="flex items-center justify-between border-b border-graphite-700 px-3 py-2">
        <span className="text-xs font-medium tracking-wide text-zinc-400 uppercase">
          Pipe from a headless server
        </span>
        <button
          type="button"
          onClick={copy}
          className="font-mono text-xs text-zinc-400 hover:text-sky-300"
        >
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-3 font-mono text-xs leading-relaxed text-zinc-300">
        {recipe}
      </pre>
    </div>
  );
}
