// page.view tracking (contract §5): the ROUTE PATTERN only (`/threads/$id`), never a concrete id.
import { track } from "./telemetry";

interface MatchLike {
  routeId: string;
  fullPath?: string;
}

/** The leaf route pattern of a resolved location; unmatched paths collapse to "/404". */
export function routePattern(matches: readonly MatchLike[]): string {
  const leaf = matches[matches.length - 1];
  if (!leaf || leaf.routeId === "__root__") return "/404";
  const p = leaf.fullPath || leaf.routeId;
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

interface RouterLike {
  state: { matches: readonly MatchLike[] };
  subscribe(event: "onResolved", fn: (ev: { pathChanged: boolean }) => void): () => void;
}

/** Tracks one page.view per resolved path change (search/hash-only changes are ignored). */
export function installPageViews(router: RouterLike): () => void {
  let last = "";
  return router.subscribe("onResolved", (ev) => {
    const path = routePattern(router.state.matches);
    if (!ev.pathChanged && path === last) return;
    last = path;
    track("page.view", { path });
  });
}
