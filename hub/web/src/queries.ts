import { QueryClient, useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, ApiError } from "./api";
import { toast } from "./components/ui/Toast";
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
export function useAction<TArgs, TResult>(fn: (a: TArgs) => Promise<TResult>, opts?: { success?: string; invalidate?: QueryKey[] }) {
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
