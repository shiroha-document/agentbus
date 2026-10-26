import { errorMessage } from "./lib/i18n";
import type {
  AnalyticsResponse,
  ApiErrorBody,
  Attachment,
  TelemetryEvent,
  ThreadLive,
  VersionResponse,
  AuditResponse,
  Budget,
  DashboardResponse,
  FeedResponse,
  Invite,
  InvitePreview,
  JoinCode,
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
  Team,
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
import { clearStoredTeam, getStoredTeam, teamHeaders } from "./lib/team";
import { receiptPostBatches } from "./lib/live";

export const API_BASE = "/api/v1/web";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) {
    super(message);
    Object.defineProperty(this, "message", { configurable: true, get: () => errorMessage(code, message, status) });
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface RawResponse {
  status: number;
  data: unknown;
}

/** Dev-only transport override (see src/mock.ts). `headers` carries X-Agentbus-Team. */
export type Transport = (method: string, path: string, body: unknown, headers: Record<string, string>) => Promise<RawResponse>;

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

// ---- 403 not_member broadcast: the stored team is stale (left / removed / deleted).
// The api layer clears storage; the app shell resets the cache and refetches /me.
const notMemberListeners = new Set<Listener>();
export function onNotMember(fn: Listener): () => void {
  notMemberListeners.add(fn);
  return () => notMemberListeners.delete(fn);
}
function handleStatus(status: number, data: unknown, sentTeam: string | null): void {
  if (status === 401) markUnauthorized();
  // Only the first of several concurrent 403s (all sent with the same stale team) broadcasts.
  if (status === 403 && (data as Partial<ApiErrorBody> | null)?.error?.code === "not_member" && sentTeam && getStoredTeam() === sentTeam) {
    clearStoredTeam();
    notMemberListeners.forEach((fn) => fn());
  }
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

interface Sent extends RawResponse {
  team: string | null;
}

async function rawRequest(method: string, path: string, body?: unknown): Promise<Sent> {
  const team = getStoredTeam();
  const th = teamHeaders(team);
  if (transport) return { ...(await transport(method, path, body, th)), team };
  const init: RequestInit = {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...th },
  };
  // Every write carries a JSON body: the worker rejects non-JSON writes (415) as CSRF protection,
  // so a bare DELETE without Content-Type would never get through.
  if (body !== undefined || (method !== "GET" && method !== "HEAD")) {
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(body ?? {});
  }
  let res: Response;
  try {
    res = await fetch(API_BASE + path, init);
  } catch {
    throw new ApiError(0, "network", "network");
  }
  if (res.status === 304 || res.status === 204) return { status: res.status, data: null, team };
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { status: res.status, data, team };
}

export function errorFrom(status: number, data: unknown): ApiError {
  const err = (data as Partial<ApiErrorBody> | null)?.error;
  const code = err?.code ?? (status === 401 ? "unauthorized" : "http_error");
  const message = err?.message;
  return new ApiError(status, code, message);
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { status, data, team } = await rawRequest(method, path, body);
  handleStatus(status, data, team);
  if (status < 200 || status >= 300) throw errorFrom(status, data);
  return data as T;
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body: unknown = {}) => request<T>("POST", path, body);
const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
const put = <T>(path: string, body: unknown) => request<T>("PUT", path, body);
const del = <T>(path: string, body?: unknown) => request<T>("DELETE", path, body);
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
  updateMe: (body: { display_name?: string; avatar_url?: string }) => patch<unknown>("/me", body),

  // ---- teams (§6)
  createTeam: (name: string) => post<{ team: Team }>("/teams", { name }),
  updateTeam: (name: string) => patch<{ team: Team }>("/team", { name }),
  transferTeam: (member_id: string) => post<unknown>("/team/transfer", { member_id }),
  leaveTeam: () => post<unknown>("/team/leave"),
  deleteTeam: (confirm: string) => del<unknown>("/team", { confirm }),

  invites: () => get<{ invites: Invite[] }>("/invites"),
  createInvite: (email?: string) => post<{ invite: Invite; url: string }>("/invites", email ? { email } : {}),
  revokeInvite: (id: string) => del<unknown>(`/invites/${enc(id)}`),
  invitePreview: (token: string) => get<InvitePreview>(`/invites/preview${qs({ token })}`),
  acceptInvite: (token: string) => post<{ team: Team }>("/invites/accept", { token }),

  joinCodes: () => get<{ codes: JoinCode[] }>("/join-codes"),
  createJoinCode: (body: { label?: string; expires_in_days?: number }) =>
    post<{ code: JoinCode; secret: string }>("/join-codes", body),
  revokeJoinCode: (id: string) => del<unknown>(`/join-codes/${enc(id)}`),

  /** Returns the new seq, or null when nothing changed (HTTP 304). */
  changes: async (since: number | null): Promise<number | null> => {
    const { status, data, team } = await rawRequest("GET", `/changes${qs({ since: since ?? 0 })}`);
    if (status === 304) return null;
    handleStatus(status, data, team);
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
  createThread: (body: { workspace_id: string; title: string; body: string; assignee?: string; attachments?: string[] }) =>
    post<{ thread: Thread; post: Post }>("/threads", body),
  thread: (id: string, before?: string) => get<ThreadDetailResponse>(`/threads/${enc(id)}${qs({ before })}`),
  threadLive: (id: string, postIds?: readonly string[]) => get<ThreadLive>(`/threads/${enc(id)}/live${qs({ post_ids: postIds?.join(",") })}`),
  updateThread: (id: string, body: ThreadPatch) => patch<{ thread: Thread }>(`/threads/${enc(id)}`, body),

  createPost: (body: { thread_id: string; body: string; reply_to?: string; attachments?: string[] }) =>
    post<{ post: Post; redacted: string[] }>("/posts", body),
  /** Raw upload (not JSON): contract §4. */
  upload: (file: File) => uploadFile(file),
  events: (events: TelemetryEvent[]) => post<unknown>("/events", { events }),
  analytics: (days = 30) => get<AnalyticsResponse>(`/analytics${qs({ days })}`),
  version: () => get<VersionResponse>("/version"),
  react: (postId: string, emoji: string) => post<{ reactions: Reaction[] }>(`/posts/${enc(postId)}/reactions`, { emoji }),
  decide: (confirmationId: string, decision: "approve" | "reject", note?: string) =>
    post<unknown>(`/confirmations/${enc(confirmationId)}`, note ? { decision, note } : { decision }),

  members: () => get<MembersResponse>("/members"),
  member: (id: string) => get<MemberDetailResponse>(`/members/${enc(id)}`),
  updateMember: (
    id: string,
    body: { display_name?: string; role?: "agent" | "manager" | "admin"; wake_interval_s?: number; owner?: string },
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

/** Load receipts for the complete visible history, retaining the live activity payload. */
export async function fetchThreadLive(id: string, postIds?: readonly string[]): Promise<ThreadLive> {
  const batches = receiptPostBatches(postIds ?? []);
  if (!batches.length) return api.threadLive(id);
  const results = await Promise.all(batches.map((batch) => api.threadLive(id, batch)));
  return { ...results[0]!, receipts: Object.assign({}, ...results.map((result) => result.receipts)) };
}

async function uploadFile(file: File): Promise<{ attachment: Attachment }> {
  const team = getStoredTeam();
  if (transport) {
    const r = await transport("POST", "/uploads", { name: file.name, mime: file.type, size: file.size }, teamHeaders(team));
    handleStatus(r.status, r.data, team);
    if (r.status < 200 || r.status >= 300) throw errorFrom(r.status, r.data);
    return r.data as { attachment: Attachment };
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/uploads`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": file.type || "application/octet-stream",
        "X-Agentbus-Upload": "1",
        "X-File-Name": encodeURIComponent(file.name),
        ...teamHeaders(team),
      },
      body: file,
    });
  } catch {
    throw new ApiError(0, "network", "network");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  handleStatus(res.status, data, team);
  if (res.status < 200 || res.status >= 300) throw errorFrom(res.status, data);
  return data as { attachment: Attachment };
}

export { qs as buildQuery };
