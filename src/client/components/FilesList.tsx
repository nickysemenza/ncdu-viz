import { memo } from "react";
import type { LeafEntry } from "../../shared/types";
import { humanBytes } from "../../shared/format";

interface Props {
  /** Already limited to the rows worth rendering, largest first. */
  leaves: LeafEntry[];
  /** Every non-duplicate file under the current focus, for the "of N" count. */
  totalFiles: number;
  colorFor: (ext: string | undefined) => string;
}

/** Last two path segments — "<parent>/<name>" — enough context without the deep prefix. */
function tail(path: string): { parent: string; name: string } {
  const segs = path.split("/").filter(Boolean);
  const name = segs[segs.length - 1] ?? path;
  const parent = segs.length > 1 ? segs[segs.length - 2] : "";
  return { parent: parent ?? "", name };
}

/** Tooltip for the "H" badge — names the other paths sharing this inode's bytes. */
function hardlinkTitle(leaf: LeafEntry): string {
  const head = `Hard link (${leaf.nlink} links) — bytes counted once here.`;
  if (leaf.links && leaf.links.length > 0) {
    return `${head}\nAlso linked at:\n${leaf.links.join("\n")}`;
  }
  return `${head}\nOther links are outside this scan.`;
}

export const FilesList = memo(function FilesList({ leaves, totalFiles, colorFor }: Props) {
  // Selection is bounded upstream now, so there is nothing left to slice here.
  const shown = leaves;

  return (
    <div className="flex h-full min-w-0 flex-col bg-graphite-950">
      <div className="flex-1 overflow-x-hidden overflow-y-auto font-mono text-sm">
        {shown.map((leaf, i) => {
          const { parent, name } = tail(leaf.path);
          return (
            <div
              key={`${leaf.path}-${i}`}
              title={leaf.path}
              className="flex items-center gap-2 border-b border-graphite-900 px-3 py-1.5 hover:bg-graphite-900"
            >
              <span className="w-8 shrink-0 text-right text-xs text-zinc-600 tabular-nums">
                {i + 1}
              </span>
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ backgroundColor: colorFor(leaf.ext) }}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">
                {parent && <span className="text-zinc-600">{parent}/</span>}
                <span className="text-zinc-200">{name}</span>
                {leaf.nlink ? (
                  <span
                    className="ml-1.5 rounded-[2px] bg-graphite-700 px-1 text-[10px] text-zinc-400"
                    title={hardlinkTitle(leaf)}
                  >
                    H{leaf.nlink}
                  </span>
                ) : null}
              </span>
              <span className="w-20 shrink-0 text-right text-zinc-300 tabular-nums">
                {humanBytes(leaf.size)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="border-t border-graphite-700 px-3 py-1.5 font-mono text-xs text-zinc-600">
        {totalFiles > shown.length
          ? `showing the ${shown.length.toLocaleString()} largest of ${totalFiles.toLocaleString()} files`
          : `${totalFiles.toLocaleString()} files, largest first`}
      </div>
    </div>
  );
});
