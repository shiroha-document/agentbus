-- agentbus hub v3 initial schema. All *_at / *_until columns are Unix milliseconds.
-- Contract: docs/design/hub-api.md

CREATE TABLE members (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,                  -- human | agent | system
  role            TEXT NOT NULL DEFAULT 'agent',  -- admin | manager | agent
  name            TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  avatar_url      TEXT,
  email           TEXT UNIQUE,
  cli             TEXT,
  wake_mode       TEXT,                           -- poll | trigger
  wake_interval_s INTEGER,
  owner           TEXT,
  machine         TEXT,
  client_version  TEXT,
  status          TEXT NOT NULL,                  -- pending | active | revoked | system
  paused          INTEGER NOT NULL DEFAULT 0,
  pause_kind      TEXT,                           -- manual | quota | budget
  pause_reason    TEXT,
  paused_until    INTEGER,
  last_seen_at    INTEGER,
  offline_notified INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE TABLE member_keys (
  member_id  TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (member_id, public_key)
);

CREATE TABLE triggers (
  member_id      TEXT PRIMARY KEY,
  url_ciphertext TEXT NOT NULL,
  iv             TEXT NOT NULL,
  last_called_at INTEGER
);

CREATE TABLE manager_scopes (
  manager_id   TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (manager_id, workspace_id)
);

CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  goal       TEXT NOT NULL DEFAULT '',
  repo       TEXT,
  branch     TEXT,
  brief      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'active',
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE threads (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',      -- open | done | closed
  assignee_id  TEXT,
  labels       TEXT NOT NULL DEFAULT '[]',
  state        TEXT NOT NULL DEFAULT '',
  lease_holder TEXT,
  lease_until  INTEGER,
  auto_paused  INTEGER NOT NULL DEFAULT 0,
  flood_reset_at INTEGER,
  version      INTEGER NOT NULL DEFAULT 1,
  last_post_at INTEGER,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX threads_ws ON threads (workspace_id, status);
CREATE INDEX threads_lease ON threads (lease_until) WHERE lease_holder IS NOT NULL;

CREATE TABLE thread_members (
  thread_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, member_id)
);

CREATE TABLE posts (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL,
  author_id       TEXT NOT NULL,
  reply_to        TEXT,
  body            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'msg',     -- msg | progress | confirm | system
  mentions        TEXT NOT NULL DEFAULT '[]',
  idempotency_key TEXT,
  redacted        INTEGER NOT NULL DEFAULT 0,
  usage_json      TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (author_id, idempotency_key)
);
CREATE INDEX posts_thread ON posts (thread_id, id);
CREATE INDEX posts_created ON posts (created_at);

CREATE TABLE reactions (
  post_id   TEXT NOT NULL,
  member_id TEXT NOT NULL,
  emoji     TEXT NOT NULL,
  PRIMARY KEY (post_id, member_id, emoji)
);

CREATE TABLE deliveries (
  id          TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  post_id     TEXT NOT NULL,
  reason      TEXT NOT NULL,                       -- mention | assign | reply | event
  state       TEXT NOT NULL DEFAULT 'pending',     -- pending | leased | done | dead
  lease_until INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  alerted     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (member_id, post_id)
);
CREATE INDEX deliveries_member ON deliveries (member_id, state, thread_id);
CREATE INDEX deliveries_state ON deliveries (state, lease_until);

CREATE TABLE confirmations (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  post_id      TEXT NOT NULL UNIQUE,
  requester_id TEXT NOT NULL,
  question     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  decided_by   TEXT,
  decided_at   INTEGER,
  note         TEXT
);
CREATE INDEX confirmations_status ON confirmations (status);

CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL,
  thread_id     TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER NOT NULL,
  exit_code     INTEGER NOT NULL DEFAULT 0,
  cli           TEXT,
  model         TEXT,
  input         INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  output        INTEGER NOT NULL DEFAULT 0,
  reasoning     INTEGER NOT NULL DEFAULT 0,
  cost_usd_est  REAL,
  error_summary TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX runs_member ON runs (member_id, started_at);
CREATE INDEX runs_started ON runs (started_at);

CREATE TABLE quota_readings (
  member_id    TEXT NOT NULL,
  provider     TEXT NOT NULL,
  account      TEXT NOT NULL DEFAULT '',
  window       TEXT NOT NULL,
  source       TEXT NOT NULL,
  plan         TEXT,
  used_pct     REAL,
  resets_at    INTEGER,
  balance_json TEXT,
  read_at      INTEGER NOT NULL,
  error        TEXT,
  PRIMARY KEY (member_id, provider, account, window, source)
);

CREATE TABLE quota_rules (
  member_id    TEXT NOT NULL,
  provider     TEXT NOT NULL,
  window       TEXT NOT NULL,
  pause_at_pct REAL NOT NULL DEFAULT 100,
  PRIMARY KEY (member_id, provider, window)
);

CREATE TABLE budgets (
  member_id    TEXT PRIMARY KEY,
  daily_tokens INTEGER,
  monthly_usd  REAL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE email_changes (
  token_hash TEXT PRIMARY KEY,
  new_email  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  dedupe_key TEXT,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,
  error      TEXT
);
CREATE INDEX notifications_unsent ON notifications (sent_at, kind);
CREATE UNIQUE INDEX notifications_dedupe ON notifications (kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND sent_at IS NULL;

CREATE TABLE nonces (
  member_id  TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, nonce)
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);

INSERT INTO members (id, kind, role, name, display_name, status, created_at)
VALUES ('m_system', 'system', 'agent', 'system', '系统', 'system', 0);

INSERT INTO settings (key, value) VALUES
  ('change_seq', '1'),
  ('global_pause', '0'),
  ('default_pause_pct', '100'),
  ('merge_window_min', '15'),
  ('min_client_version', '0.4.0'),
  ('notify_kinds', '{}');
