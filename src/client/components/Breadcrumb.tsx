import { Fragment, memo } from "react";

interface Props {
  /** Focus chain labels from scan root to current focus, inclusive. */
  labels: string[];
  onJump: (index: number) => void;
}

/** Show only the basename of an absolute root path so crumbs stay compact. */
function crumbLabel(name: string, isRoot: boolean): string {
  if (!isRoot) return name || "/";
  const trimmed = name.replace(/\/+$/, "");
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return base || name || "/";
}

export const Breadcrumb = memo(function Breadcrumb({ labels, onJump }: Props) {
  return (
    <nav className="flex items-center gap-1 overflow-x-auto px-3 py-2 font-mono text-sm whitespace-nowrap">
      {labels.map((name, i) => {
        const last = i === labels.length - 1;
        return (
          <Fragment key={i}>
            {i > 0 && <span className="text-graphite-700">/</span>}
            <button
              type="button"
              onClick={() => onJump(i)}
              disabled={last}
              title={name}
              className={
                last
                  ? "cursor-default font-medium text-zinc-100"
                  : "text-zinc-400 hover:text-sky-300"
              }
            >
              {crumbLabel(name, i === 0)}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
});
