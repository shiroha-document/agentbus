import type {
  ApiErrorBody,
  AuditResponse,
  Budget,
  DashboardResponse,
  FeedResponse,
  MeResponse,
  Member,
  MemberDetailResponse,
  MembersResponse,
  Post,
  QuotaRule,
  Reaction,
  RunsResponse,
  SearchResponse,
  SettingsPatch,
  SettingsResponse,
  Thread,
  ThreadDetailResponse,
  ThreadStatus,
  ThreadsResponse,
  UsageGroup,
  UsageResponse,
  Workspace,
  WorkspaceDetailResponse,
  WorkspacesResponse,
} from "./types";

export const API_BASE = "/api/v1/web";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface RawResponse {
  status: number;
  data: unknown;
}

/** Dev-only transport override (see src/mock.ts). */
export type Transport = (method: string, path: string, body: unknown) => Promise<RawResponse>;

let transport: Transport | null = null;
export function setTransport(t: Transport | null): void {
  transport = t;
}

// ---- 401 broadcast: the app shell renders a full-page login notice.
type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
let unauthorized = false;
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}
export function isUnauthorized(): boolean {
  return unauthorized;
}
function markUnauthorized(): void {
  if (unauthorized) return;
  unauthorized = true;
  unauthorizedListeners.forEach((fn) => fn());
}

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    sp.set(k, v === true ? "1" : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function rawRequest(method: string, path: string, body?: unknown): Promise<RawResponse> {
  if (transport) return transport(method, path, body);
  const init: RequestInit = {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  };
  if (body !== undefined) {
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(API_BASE + path, init);
  } catch {
    throw new ApiError(0, "network", "网络连接失败，请检查网络后重试");
  }
  if (res.status === 304 || res.status === 204) return { status: res.status, data: null };
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { status: res.status, data };
}

export function errorFrom(status: number, data: unknown): ApiError {
  const err = (data as Partial<ApiErrorBody> | null)?.error;
  const code = err?.code ?? (status === 401 ? "unauthorized" : "internal");
  const message = err?.message ?? `请求失败（HTTP ${status}）`;
  return new ApiError(status, code, message);
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { status, data } = await rawRequest(method, path, body);
  if (status === 401) {
    markUnauthorized();
    throw errorFrom(status, data);
  }
  if (status < 200 || status >= 300) throw errorFrom(status, data);
  return data as T;
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body: unknown = {}) => request<T>("POST", path, body);
const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
const put = <T>(path: string, body: unknown) => request<T>("PUT", path, body);
const del = <T>(path: string) => request<T>("DELETE", path);
const enc = encodeURIComponent;

export interface ThreadPatch {
  state?: string;
  assignee?: string | null;
  status?: ThreadStatus;
  labels?: string[];
  title?: string;
  version?: number;
  auto_paused?: false;
}

export const api = {
  me: () => get<MeResponse>("/me"),
  updateMe: (body: { display_name?: string; avatar_url?: string }) => patch<MeResponse>("/me", body),

  /** Returns the new seq, or null when nothing changed (HTTP 304). */
  changes: async (since: number | null): Promise<number | null> => {
    const { status, data } = await rawRequest("GET", `/changes${qs({ since: since ?? 0 })}`);
    if (status === 304) return null;
    if (status === 401) {
      markUnauthorized();
      throw errorFrom(status, data);
    }
    if (status < 200 || status >= 300) throw errorFrom(status, data);
    return (data as { seq: number }).seq;
  },

  dashboard: () => get<DashboardResponse>("/dashboard"),
  feed: (before?: string, limit = 30) => get<FeedResponse>(`/feed${qs({ before, limit })}`),

  workspaces: () => get<WorkspacesResponse>("/workspaces"),
  workspace: (id: string) => get<WorkspaceDetailResponse>(`/workspaces/${enc(id)}`),
  createWorkspace: (body: { name: string; goal: string; repo?: string; branch?: string; brief?: string }) =>
    post<{ workspace: Workspace }>("/workspaces", body),
  updateWorkspace: (
    id: string,
    body: Partial<Pick<Workspace, "name" | "goal" | "repo" | "branch" | "brief" | "status">>,
  ) => patch<{ workspace: Workspace }>(`/workspaces/${enc(id)}`, body),

  threads: (p: { workspace?: string; status?: ThreadStatus | ""; assignee?: string }) =>
    get<ThreadsResponse>(`/threads${qs(p)}`),
  createThread: (body: { workspace_id: string; title: string; body: string; assignee?: string }) =>
    post<{ thread: Thread; post: Post }>("/threads", body),
  thread: (id: string) => get<ThreadDetailResponse>(`/threads/${enc(id)}`),
  updateThread: (id: string, body: ThreadPatch) => patch<{ thread: Thread }>(`/threads/${enc(id)}`, body),

  createPost: (body: { thread_id: string; body: string; reply_to?: string }) =>
    post<{ post: Post; redacted: string[] }>("/posts", body),
  react: (postId: string, emoji: string) => post<{ reactions: Reaction[] }>(`/posts/${enc(postId)}/reactions`, { emoji }),
  decide: (confirmationId: string, decision: "approve" | "reject", note?: string) =>
    post<unknown>(`/confirmations/${enc(confirmationId)}`, note ? { decision, note } : { decision }),

  members: () => get<MembersResponse>("/members"),
  member: (id: string) => get<MemberDetailResponse>(`/members/${enc(id)}`),
  updateMember: (
    id: string,
    body: { display_name?: string; role?: "agent" | "manager"; wake_interval_s?: number; owner?: string },
  ) => patch<{ member: Member }>(`/members/${enc(id)}`, body),
  approveMember: (id: string) => post<unknown>(`/members/${enc(id)}/approve`),
  rejectMember: (id: string) => post<unknown>(`/members/${enc(id)}/reject`),
  pauseMember: (id: string, reason: string, until?: number) =>
    post<unknown>(`/members/${enc(id)}/pause`, until ? { reason, until } : { reason }),
  resumeMember: (id: string) => post<unknown>(`/members/${enc(id)}/resume`),
  revokeMember: (id: string) => post<unknown>(`/members/${enc(id)}/revoke`),
  deleteMember: (id: string) => del<unknown>(`/members/${enc(id)}`),
  putQuotaRules: (id: string, rules: Omit<QuotaRule, "member_id">[]) =>
    put<unknown>(`/members/${enc(id)}/quota-rules`, { rules }),
  putBudget: (id: string, body: Omit<Budget, "member_id">) => put<unknown>(`/members/${enc(id)}/budget`, body),
  putScopes: (id: string, workspace_ids: string[]) => put<unknown>(`/managers/${enc(id)}/scopes`, { workspace_ids }),

  usage: (group: UsageGroup, days = 30) => get<UsageResponse>(`/usage${qs({ days, group })}`),
  runs: (p: { member?: string; failed?: boolean; before?: string }) => get<RunsResponse>(`/runs${qs(p)}`),

  settings: () => get<SettingsResponse>("/settings"),
  updateSettings: (body: SettingsPatch) => patch<SettingsResponse>("/settings", body),
  changeEmail: (email: string) => post<unknown>("/settings/email", { email }),
  testNotify: () => post<unknown>("/notify/test"),

  search: (p: { q: string; member?: string; status?: string; workspace?: string }) =>
    get<SearchResponse>(`/search${qs(p)}`),
  audit: (before?: string) => get<AuditResponse>(`/audit${qs({ before })}`),
};

export { qs as buildQuery };
