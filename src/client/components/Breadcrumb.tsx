import { Fragment } from "react";
import type { ScanNode } from "../../shared/types";

interface Props {
  /** Focus chain from scan root to current focus, inclusive. */
  path: ScanNode[];
  onJump: (index: number) => void;
}

/** Show only the basename of an absolute root path so crumbs stay compact. */
function crumbLabel(node: ScanNode, isRoot: boolean): string {
  if (!isRoot) return node.name || "/";
  const trimmed = node.name.replace(/\/+$/, "");
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return base || node.name || "/";
}

export function Breadcrumb({ path, onJump }: Props) {
  return (
    <nav className="flex items-center gap-1 overflow-x-auto px-3 py-2 font-mono text-sm whitespace-nowrap">
      {path.map((node, i) => {
        const last = i === path.length - 1;
        return (
          <Fragment key={i}>
            {i > 0 && <span className="text-graphite-700">/</span>}
            <button
              type="button"
              onClick={() => onJump(i)}
              disabled={last}
              title={node.name}
              className={
                last
                  ? "cursor-default font-medium text-zinc-100"
                  : "text-zinc-400 hover:text-sky-300"
              }
            >
              {crumbLabel(node, i === 0)}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}
