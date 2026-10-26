import { QueryClient, useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, ApiError } from "./api";
import { toast, type ToastMessage } from "./components/ui/Toast";
import { isLiveActive } from "./lib/live";
import { isAdminRole, isOwnerRole, setStoredTeam } from "./lib/team";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
    mutations: {
      onError: (e) => toast.error(e),
    },
  },
});

export const qk = {
  me: ["me"] as const,
  dashboard: ["dashboard"] as const,
  feed: ["feed"] as const,
  workspaces: ["workspaces"] as const,
  workspace: (id: string) => ["workspace", id] as const,
  threads: (p: object) => ["threads", p] as const,
  thread: (id: string) => ["thread", id] as const,
  threadLive: (id: string) => ["thread-live", id] as const,
  members: ["members"] as const,
  member: (id: string) => ["member", id] as const,
  usage: (g: string, d: number) => ["usage", g, d] as const,
  runs: (p: object) => ["runs", p] as const,
  settings: ["settings"] as const,
  audit: ["audit"] as const,
  invites: ["invites"] as const,
  joinCodes: ["join-codes"] as const,
};

export const useMe = () => useQuery({ queryKey: qk.me, queryFn: api.me, staleTime: 5 * 60_000 });

/** My role in the current team, with the contract's permission shorthands. */
export function useRole() {
  const { data } = useMe();
  const role = data?.role ?? null;
  return {
    role,
    isAdmin: isAdminRole(role),
    isOwner: isOwnerRole(role),
    platformAdmin: data?.identity.platform_admin ?? false,
    team: data?.team ?? null,
  };
}
export const useMembers = () => useQuery({ queryKey: qk.members, queryFn: api.members });
export const useWorkspaces = () => useQuery({ queryKey: qk.workspaces, queryFn: api.workspaces });
export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: api.settings });

/** Mutation helper: runs fn, then invalidates everything (server is the source of truth). */
export function useAction<TArgs, TResult>(fn: (a: TArgs) => Promise<TResult>, opts?: { success?: ToastMessage; invalidate?: QueryKey[] }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      if (opts?.success) toast.success(opts.success);
      if (opts?.invalidate) opts.invalidate.forEach((k) => qc.invalidateQueries({ queryKey: k }));
      else qc.invalidateQueries();
    },
  });
}

// ---------------------------------------------------------------- change polling

let lastSeq: number | null = null;

export function getLastSeq(): number | null {
  return lastSeq;
}

/**
 * Select a team (null = server default) and drop every team-scoped cache entry.
 * /me keeps its data while it refetches so the shell doesn't flash; everything
 * else is reset (active queries refetch with the new X-Agentbus-Team header).
 * Resolves once /me has been refetched for the new team.
 * Callers should navigate to "/" first so the old team's ids aren't requested.
 */
export async function selectTeam(id: string | null): Promise<void> {
  setStoredTeam(id);
  lastSeq = null;
  await queryClient.cancelQueries();
  queryClient.getMutationCache().clear();
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: qk.me }),
    queryClient.resetQueries({ predicate: (q) => q.queryKey[0] !== qk.me[0] }),
  ]);
}

/** Poll GET /web/changes every 10s; on a new seq invalidate all queries. */
export function useChangePolling(intervalMs = 10_000): void {
  const qc = useQueryClient();
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let inflight = false;
    const tick = async () => {
      if (stopped || inflight) return;
      inflight = true;
      if (document.visibilityState === "visible") {
        try {
          const seq = await api.changes(lastSeq);
          if (seq !== null && seq !== lastSeq) {
            const first = lastSeq === null;
            lastSeq = seq;
            if (!first) await qc.invalidateQueries();
          }
        } catch {
          // transient network errors are ignored; 401 is surfaced by the api layer
        }
      }
      inflight = false;
      window.clearTimeout(timer);
      if (!stopped) timer = window.setTimeout(tick, intervalMs);
    };
    void tick();
    const onVis = () => {
      if (document.visibilityState === "visible") {
        window.clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [qc, intervalMs]);
}

// ---------------------------------------------------------------- live status (contract §3)

export const LIVE_FAST_MS = 2_000;
export const LIVE_SLOW_MS = 15_000;

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

/**
 * Poll GET /threads/:id/live: every 2 s while a receipt is sent/received/working or an agent is
 * claimed/running/typing, else every 15 s; only while the tab is visible. When the hub's newest
 * post differs from `newestPostId`, the thread query is invalidated so new posts show up.
 * `boost()` forces fast polling for a short while (e.g. right after I post).
 */
export function useThreadLive(threadId: string, newestPostId: string | null | undefined) {
  const qc = useQueryClient();
  const visible = useDocumentVisible();
  const [boostUntil, setBoostUntil] = useState(0);
  const q = useQuery({
    queryKey: qk.threadLive(threadId),
    queryFn: () => api.threadLive(threadId),
    enabled: visible && !!threadId,
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
    refetchInterval: (query) => (isLiveActive(query.state.data) || Date.now() < boostUntil ? LIVE_FAST_MS : LIVE_SLOW_MS),
    refetchIntervalInBackground: false,
  });
  const next = q.data?.next_post_id ?? null;
  useEffect(() => {
    if (!next || newestPostId === undefined) return;
    if (next !== newestPostId) void qc.invalidateQueries({ queryKey: qk.thread(threadId) });
  }, [next, newestPostId, qc, threadId]);
  const boost = () => {
    setBoostUntil(Date.now() + 20_000);
    void qc.invalidateQueries({ queryKey: qk.threadLive(threadId) });
  };
  return { live: q.data, boost };
}
