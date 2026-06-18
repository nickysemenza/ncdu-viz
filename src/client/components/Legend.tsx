import { useState } from "react";
import type { ExtEntry } from "../../shared/color";
import { humanBytes } from "../../shared/format";

interface Props {
  legend: ExtEntry[];
}

export function Legend({ legend }: Props) {
  const [open, setOpen] = useState(true);

  return (
    <aside className="flex h-full flex-col border-l border-graphite-700 bg-graphite-900">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between px-3 py-2 text-xs font-medium tracking-wide text-zinc-400 uppercase hover:text-zinc-200"
      >
        <span>Extensions</span>
        <span className="font-mono">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <ul className="flex-1 overflow-y-auto px-2 pb-3">
          {legend.map((e) => (
            <li key={e.ext} className="flex items-center gap-2 px-1 py-1 text-sm">
              <span
                className="h-3 w-3 shrink-0 rounded-[2px]"
                style={{ backgroundColor: e.color }}
                aria-hidden
              />
              <span className="flex-1 truncate font-mono text-zinc-300">{e.label}</span>
              <span className="font-mono text-xs text-zinc-500 tabular-nums">
                {humanBytes(e.total)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
