package hub

import "github.com/shiroha-document/agentbus/internal/adapter"

// Wire types from docs/design/hub-api.md §1. Nullable fields are pointers;
// times are Unix milliseconds.

type Member struct {
	ID            string  `json:"id"`
	Kind          string  `json:"kind"`
	Role          string  `json:"role"`
	Name          string  `json:"name"`
	DisplayName   string  `json:"display_name"`
	AvatarURL     *string `json:"avatar_url"`
	Email         *string `json:"email"`
	CLI           *string `json:"cli"`
	WakeMode      *string `json:"wake_mode"`
	WakeIntervalS *int64  `json:"wake_interval_s"`
	Owner         *string `json:"owner"`
	Machine       *string `json:"machine"`
	ClientVersion *string `json:"client_version"`
	Status        string  `json:"status"`
	Paused        bool    `json:"paused"`
	PauseReason   *string `json:"pause_reason"`
	PausedUntil   *int64  `json:"paused_until"`
	Online        bool    `json:"online"`
	LastSeenAt    *int64  `json:"last_seen_at"`
	CreatedAt     int64   `json:"created_at"`
}

type ThreadCounts struct {
	Open   int `json:"open"`
	Done   int `json:"done"`
	Closed int `json:"closed"`
}

type Workspace struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Goal         string       `json:"goal"`
	Repo         *string      `json:"repo"`
	Branch       *string      `json:"branch"`
	Brief        string       `json:"brief"`
	Status       string       `json:"status"`
	UpdatedBy    string       `json:"updated_by"`
	UpdatedAt    int64        `json:"updated_at"`
	CreatedAt    int64        `json:"created_at"`
	ThreadCounts ThreadCounts `json:"thread_counts"`
}

type Thread struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspace_id"`
	Title       string   `json:"title"`
	Status      string   `json:"status"`
	AssigneeID  *string  `json:"assignee_id"`
	Labels      []string `json:"labels"`
	State       string   `json:"state"`
	LeaseHolder *string  `json:"lease_holder"`
	LeaseUntil  *int64   `json:"lease_until"`
	AutoPaused  bool     `json:"auto_paused"`
	Version     int64    `json:"version"`
	LastPostAt  int64    `json:"last_post_at"`
	CreatedBy   string   `json:"created_by"`
	CreatedAt   int64    `json:"created_at"`
	UpdatedAt   int64    `json:"updated_at"`
}

type Reaction struct {
	Emoji     string   `json:"emoji"`
	MemberIDs []string `json:"member_ids"`
}

type Confirmation struct {
	ID          string  `json:"id"`
	ThreadID    string  `json:"thread_id"`
	PostID      string  `json:"post_id"`
	RequesterID string  `json:"requester_id"`
	Question    string  `json:"question"`
	Status      string  `json:"status"`
	DecidedBy   *string `json:"decided_by"`
	DecidedAt   *int64  `json:"decided_at"`
	Note        *string `json:"note"`
}

type Post struct {
	ID           string         `json:"id"`
	ThreadID     string         `json:"thread_id"`
	AuthorID     string         `json:"author_id"`
	ReplyTo      *string        `json:"reply_to"`
	Body         string         `json:"body"`
	Kind         string         `json:"kind"`
	Mentions     []string       `json:"mentions"`
	Redacted     bool           `json:"redacted"`
	Usage        *adapter.Usage `json:"usage"`
	Reactions    []Reaction     `json:"reactions"`
	Confirmation *Confirmation  `json:"confirmation"`
	CreatedAt    int64          `json:"created_at"`
	// v0.6
	Model       *string      `json:"model"`
	CLI         *string      `json:"cli"`
	EditedAt    *int64       `json:"edited_at"`
	Revisions   int          `json:"revisions"`
	Attachments []Attachment `json:"attachments"`
}

type Delivery struct {
	ID       string `json:"id"`
	ThreadID string `json:"thread_id"`
	PostID   string `json:"post_id"`
	Reason   string `json:"reason"`
	Attempts int    `json:"attempts"`
}

// Run is one round's record (POST /agent/runs).
type Run struct {
	ID           string   `json:"id"`
	MemberID     string   `json:"member_id"`
	ThreadID     *string  `json:"thread_id"`
	StartedAt    int64    `json:"started_at"`
	EndedAt      int64    `json:"ended_at"`
	ExitCode     int      `json:"exit_code"`
	CLI          string   `json:"cli"`
	Model        *string  `json:"model"`
	Input        int64    `json:"input"`
	CacheWrite   int64    `json:"cache_write"`
	CacheRead    int64    `json:"cache_read"`
	Output       int64    `json:"output"`
	Reasoning    int64    `json:"reasoning"`
	CostUSD      *float64 `json:"cost_usd_est"`
	ErrorSummary *string  `json:"error_summary"`
}

type QuotaRule struct {
	MemberID   string  `json:"member_id,omitempty"`
	Provider   string  `json:"provider"`
	Window     string  `json:"window"`
	PauseAtPct float64 `json:"pause_at_pct"`
}

type Budget struct {
	MemberID    string   `json:"member_id"`
	DailyTokens *int64   `json:"daily_tokens"`
	MonthlyUSD  *float64 `json:"monthly_usd"`
}

type StateConfig struct {
	LeaseS          int `json:"lease_s"`
	ContextPosts    int `json:"context_posts"`
	MaxClaimThreads int `json:"max_claim_threads"`
}

// State is GET /agent/state.
type State struct {
	Member           Member      `json:"member"`
	Team             TeamRef     `json:"team"`
	GlobalPause      bool        `json:"global_pause"`
	MinClientVersion string      `json:"min_client_version"`
	ServerVersion    string      `json:"server_version"`
	Config           StateConfig `json:"config"`
	QuotaRules       []QuotaRule `json:"quota_rules"`
	Budget           *Budget     `json:"budget"`
	Pending          int         `json:"pending"`
}

type ClaimedThread struct {
	ThreadID    string     `json:"thread_id"`
	WorkspaceID string     `json:"workspace_id"`
	LeaseUntil  int64      `json:"lease_until"`
	Deliveries  []Delivery `json:"deliveries"`
}

type ClaimResp struct {
	Threads []ClaimedThread `json:"threads"`
	Paused  bool            `json:"paused"`
}

// Context is GET /agent/context.
type Context struct {
	Workspace  Workspace  `json:"workspace"`
	Thread     Thread     `json:"thread"`
	Posts      []Post     `json:"posts"`
	HasMore    bool       `json:"has_more"`
	Deliveries []Delivery `json:"deliveries"`
	Members    []Member   `json:"members"`
	Me         Member     `json:"me"`
}

type PostsResp struct {
	Posts   []Post `json:"posts"`
	HasMore bool   `json:"has_more"`
}

// NewPost is the body of POST /agent/posts (reply in a thread, or a new
// thread when WorkspaceID+Title are set).
type NewPost struct {
	ThreadID       string         `json:"thread_id,omitempty"`
	WorkspaceID    string         `json:"workspace_id,omitempty"`
	Title          string         `json:"title,omitempty"`
	Assignee       string         `json:"assignee,omitempty"`
	Body           string         `json:"body"`
	Kind           string         `json:"kind,omitempty"`
	ReplyTo        string         `json:"reply_to,omitempty"`
	IdempotencyKey string         `json:"idempotency_key"`
	Usage          *adapter.Usage `json:"usage,omitempty"`
	// v0.6
	Model       string   `json:"model,omitempty"`
	CLI         string   `json:"cli,omitempty"`
	Attachments []string `json:"attachments,omitempty"`
}

type PostResp struct {
	Post      Post     `json:"post"`
	Thread    Thread   `json:"thread"`
	Duplicate bool     `json:"duplicate"`
	Redacted  []string `json:"redacted"`
	Collapsed bool     `json:"collapsed"`
}

// ThreadPatch is PATCH /agent/threads/:id.
type ThreadPatch struct {
	State    *string  `json:"state,omitempty"`
	Assignee *string  `json:"assignee,omitempty"`
	Status   *string  `json:"status,omitempty"`
	Labels   []string `json:"labels,omitempty"`
	Title    *string  `json:"title,omitempty"`
	Version  *int64   `json:"version,omitempty"`
}

type QuotaResp struct {
	Paused      bool    `json:"paused"`
	PauseReason *string `json:"pause_reason"`
	PausedUntil *int64  `json:"paused_until"`
}

// JoinReq is POST /agent/join.
type JoinReq struct {
	JoinCode      string `json:"join_code"` // abj_… from the hub web UI (Settings → Agent 加入码)
	Name          string `json:"name"`
	DisplayName   string `json:"display_name,omitempty"`
	CLI           string `json:"cli"`
	WakeMode      string `json:"wake_mode"`
	WakeIntervalS int64  `json:"wake_interval_s"`
	Owner         string `json:"owner"`
	Machine       string `json:"machine"`
	PublicKey     string `json:"public_key"`
	ClientVersion string `json:"client_version"`
	TriggerURL    string `json:"trigger_url,omitempty"`
}

type JoinResp struct {
	MemberID string  `json:"member_id"`
	Status   string  `json:"status"`
	Team     TeamRef `json:"team"`
}

// TeamRef is the team a member belongs to (the hub's isolation boundary).
type TeamRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type WorkspaceReq struct {
	Name   *string `json:"name,omitempty"`
	Goal   *string `json:"goal,omitempty"`
	Repo   *string `json:"repo,omitempty"`
	Branch *string `json:"branch,omitempty"`
	Brief  *string `json:"brief,omitempty"`
	Status *string `json:"status,omitempty"`
}
