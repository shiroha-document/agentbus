// Mirrors docs/design/hub-api.md §1 and the /api/v1/web/* response shapes (§6).
// All *_at / *_until fields are Unix milliseconds.

export type MemberKind = "human" | "agent";
export type MemberRole = "admin" | "manager" | "agent";
export type MemberStatus = "pending" | "active" | "revoked";
export type WakeMode = "poll" | "trigger";

export interface Member {
  id: string;
  kind: MemberKind;
  role: MemberRole;
  name: string;
  display_name: string;
  avatar_url: string | null;
  email: string | null;
  cli: string | null;
  wake_mode: WakeMode | null;
  wake_interval_s: number | null;
  owner: string | null;
  machine: string | null;
  client_version: string | null;
  status: MemberStatus;
  paused: boolean;
  pause_reason: string | null;
  paused_until: number | null;
  online: boolean;
  last_seen_at: number | null;
  created_at: number;
}

export type WorkspaceStatus = "active" | "archived";

export interface Workspace {
  id: string;
  name: string;
  goal: string;
  repo: string | null;
  branch: string | null;
  brief: string;
  status: WorkspaceStatus;
  updated_by: string;
  updated_at: number;
  created_at: number;
  thread_counts: { open: number; done: number; closed: number };
}

export type ThreadStatus = "open" | "done" | "closed";

export interface Thread {
  id: string;
  workspace_id: string;
  title: string;
  status: ThreadStatus;
  assignee_id: string | null;
  labels: string[];
  state: string;
  lease_holder: string | null;
  lease_until: number | null;
  auto_paused: boolean;
  version: number;
  last_post_at: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export type PostKind = "msg" | "progress" | "confirm" | "system";

export interface Usage {
  input: number;
  cache_write: number;
  cache_read: number;
  output: number;
  reasoning: number;
  cost_usd_est: number | null;
  duration_ms: number;
  model: string | null;
}

export interface Reaction {
  emoji: string;
  member_ids: string[];
}

export type ConfirmationStatus = "pending" | "approved" | "rejected";

export interface Confirmation {
  id: string;
  thread_id: string;
  post_id: string;
  requester_id: string;
  question: string;
  status: ConfirmationStatus;
  decided_by: string | null;
  decided_at: number | null;
  note: string | null;
}

export interface Post {
  id: string;
  thread_id: string;
  author_id: string;
  reply_to: string | null;
  body: string;
  kind: PostKind;
  mentions: string[];
  redacted: boolean;
  usage: Usage | null;
  reactions: Reaction[];
  confirmation: Confirmation | null;
  created_at: number;
}

export interface Run {
  id: string;
  member_id: string;
  thread_id: string | null;
  started_at: number;
  ended_at: number;
  exit_code: number;
  cli: string;
  model: string | null;
  input: number;
  cache_write: number;
  cache_read: number;
  output: number;
  reasoning: number;
  cost_usd_est: number | null;
  error_summary: string | null;
}

export type QuotaSource = "native" | "magpie";

export interface QuotaReading {
  provider: string;
  account: string | null;
  plan: string | null;
  window: string;
  used_pct: number | null;
  resets_at: number | null;
  balance: { amount: number; currency: string } | null;
  source: QuotaSource;
  read_at: number;
  error: string | null;
}

export interface QuotaRule {
  member_id: string;
  provider: string;
  window: string;
  pause_at_pct: number;
}

export interface Budget {
  member_id: string;
  daily_tokens: number | null;
  monthly_usd: number | null;
}

// ---------------------------------------------------------------- responses

export interface MeResponse {
  member: Member;
  admin: true;
}

export interface HeatmapDay {
  day: string; // YYYY-MM-DD
  count: number;
}

export interface DashboardResponse {
  active_threads: Thread[];
  pending_joins: Member[];
  pending_confirmations: Confirmation[];
  heatmap: HeatmapDay[];
  stats: {
    agents_online: number;
    agents_total: number;
    posts_today: number;
    tokens_today: number;
    cost_today: number;
  };
}

export interface FeedItem {
  post: Post;
  thread: { id: string; title: string };
  workspace: { id: string; name: string };
}

export interface FeedResponse {
  items: FeedItem[];
  has_more: boolean;
}

export interface WorkspacesResponse {
  workspaces: Workspace[];
}

export interface WorkspaceDetailResponse {
  workspace: Workspace;
  threads: Thread[];
}

export interface ThreadsResponse {
  threads: Thread[];
}

export interface ThreadDetailResponse {
  thread: Thread;
  workspace: Workspace;
  posts: Post[];
  members: Member[];
}

export interface MemberWithStats extends Member {
  quota: QuotaReading[];
  last_run: Run | null;
  today: { tokens: number; cost: number };
}

export interface MembersResponse {
  members: MemberWithStats[];
}

export interface UsageSeriesItem {
  key: string;
  label: string;
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
  cost: number;
  runs: number;
  failed: number;
}

export type UsageTotals = Omit<UsageSeriesItem, "key" | "label">;

export interface MemberDetailResponse {
  member: Member;
  keys: { created_at: number; expires_at: number | null }[];
  quota: QuotaReading[];
  quota_rules: QuotaRule[];
  budget: Budget | null;
  runs: Run[];
  /** Shape is not pinned by the contract; the UI accepts a day series or totals. */
  usage_7d: UsageSeriesItem[] | { tokens: number; cost: number } | null;
  /** Not in the contract (yet): manager workspace scopes, if the worker returns them. */
  scopes?: string[];
}

export type UsageGroup = "day" | "agent" | "thread";

export interface UsageResponse {
  series: UsageSeriesItem[];
  totals: UsageTotals;
  baseline: { member_id: string; tokens: number }[];
}

export interface RunsResponse {
  runs: Run[];
  has_more: boolean;
}

export type NotifyKind =
  | "join_request"
  | "confirm_request"
  | "agent_offline"
  | "agent_unresponsive"
  | "delivery_dead"
  | "quota_paused"
  | "flood_blocked"
  | "secret_redacted"
  | "run_failures"
  | "email_change";

export interface SettingsResponse {
  notify_email_masked: string | null;
  notify_kinds: Partial<Record<NotifyKind | string, boolean>>;
  global_pause: boolean;
  default_pause_pct: number;
  merge_window_min: number;
  min_client_version: string;
}

export type SettingsPatch = Partial<Omit<SettingsResponse, "notify_email_masked">>;

export interface SearchResult {
  post: Post;
  thread: { id: string; title: string; status?: ThreadStatus; workspace_id?: string };
  snippet: string;
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface AuditEntry {
  id?: string | number;
  actor_id: string;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: number;
}

export interface AuditResponse {
  entries: AuditEntry[];
  has_more: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string; upgrade?: string };
}
