import { Landing } from "./components/Landing";
import { ScanView } from "./components/ScanView";

/** Minimal routing: `/v/:slug` → shared scan viewer, everything else → landing. */
export function App() {
  const match = /^\/v\/([^/]+)\/?$/.exec(window.location.pathname);
  if (match?.[1]) return <ScanView slug={decodeURIComponent(match[1])} />;
  return <Landing />;
}
