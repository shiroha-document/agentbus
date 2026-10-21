-- agentbus hub 0.5.0: multi-team isolation. Contract: docs/design/hub-api.md §0.1
-- Every data row belongs to exactly one team (team_id, or via a member/thread/post parent).
-- Legacy single-tenant data is moved into one team "默认团队" when any human member exists.

CREATE TABLE teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  change_seq INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE team_settings (
  team_id TEXT NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (team_id, key)
);

CREATE TABLE join_codes (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  code_hash    TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  revoked_at   INTEGER,
  uses         INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER
);
CREATE INDEX join_codes_team ON join_codes (team_id, created_at);

CREATE TABLE invites (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  email       TEXT,
  role        TEXT NOT NULL DEFAULT 'admin',
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  accepted_by TEXT,
  accepted_at INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX invites_team ON invites (team_id, created_at);

-- members: name/email become unique per team -> rebuild.
CREATE TABLE members_new (
  id              TEXT PRIMARY KEY,
  team_id         TEXT,                           -- NULL only for m_system
  kind            TEXT NOT NULL,                  -- human | agent | system
  role            TEXT NOT NULL DEFAULT 'agent',  -- owner | admin | manager | agent
  name            TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  avatar_url      TEXT,
  email           TEXT,
  cli             TEXT,
  wake_mode       TEXT,
  wake_interval_s INTEGER,
  owner           TEXT,
  machine         TEXT,
  client_version  TEXT,
  status          TEXT NOT NULL,                  -- pending | active | revoked | system
  paused          INTEGER NOT NULL DEFAULT 0,
  pause_kind      TEXT,
  pause_reason    TEXT,
  paused_until    INTEGER,
  last_seen_at    INTEGER,
  offline_notified INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  UNIQUE (team_id, name),
  UNIQUE (team_id, email)
);
INSERT INTO members_new (id, team_id, kind, role, name, display_name, avatar_url, email, cli, wake_mode, wake_interval_s,
  owner, machine, client_version, status, paused, pause_kind, pause_reason, paused_until, last_seen_at, offline_notified, created_at)
SELECT id, NULL, kind, role, name, display_name, avatar_url, email, cli, wake_mode, wake_interval_s,
  owner, machine, client_version, status, paused, pause_kind, pause_reason, paused_until, last_seen_at, offline_notified, created_at
FROM members;
DROP TABLE members;
ALTER TABLE members_new RENAME TO members;
CREATE INDEX members_team ON members (team_id, kind, status);
CREATE INDEX members_email ON members (email) WHERE email IS NOT NULL;

ALTER TABLE workspaces ADD COLUMN team_id TEXT;
ALTER TABLE threads ADD COLUMN team_id TEXT;
ALTER TABLE posts ADD COLUMN team_id TEXT;
ALTER TABLE deliveries ADD COLUMN team_id TEXT;
ALTER TABLE confirmations ADD COLUMN team_id TEXT;
ALTER TABLE runs ADD COLUMN team_id TEXT;
ALTER TABLE notifications ADD COLUMN team_id TEXT;
ALTER TABLE audit_log ADD COLUMN team_id TEXT;
ALTER TABLE email_changes ADD COLUMN team_id TEXT;

-- Legacy data -> one team, only if a human ever logged in.
-- Owner: the earliest active admin; real people (not the e2e service identity, *.invalid) win.
INSERT INTO teams (id, name, owner_id, change_seq, created_at)
SELECT 'o_0000000000000000000000000l', '默认团队',
  COALESCE(
    (SELECT id FROM members WHERE kind = 'human' AND role = 'admin' AND status = 'active'
      ORDER BY COALESCE(email, '') LIKE '%.invalid', created_at, id LIMIT 1),
    (SELECT id FROM members WHERE kind = 'human' ORDER BY COALESCE(email, '') LIKE '%.invalid', created_at, id LIMIT 1)),
  COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'change_seq'), 1),
  COALESCE((SELECT MIN(created_at) FROM members WHERE kind = 'human'), 0)
WHERE EXISTS (SELECT 1 FROM members WHERE kind = 'human');

UPDATE members SET team_id = (SELECT id FROM teams LIMIT 1) WHERE kind <> 'system';
UPDATE members SET role = CASE WHEN id = (SELECT owner_id FROM teams LIMIT 1) THEN 'owner' ELSE 'admin' END
  WHERE kind = 'human' AND team_id IS NOT NULL;
UPDATE workspaces SET team_id = (SELECT id FROM teams LIMIT 1);
UPDATE threads SET team_id = (SELECT id FROM teams LIMIT 1);
UPDATE posts SET team_id = (SELECT id FROM teams LIMIT 1);
UPDATE deliveries SET team_id = (SELECT id FROM teams LIMIT 1);
UPDATE confirmations SET team_id = (SELECT id FROM teams LIMIT 1);
UPDATE runs SET team_id = (SELECT id FROM teams LIMIT 1);
UPDATE notifications SET team_id = (SELECT id FROM teams LIMIT 1);
UPDATE audit_log SET team_id = (SELECT id FROM teams LIMIT 1);
UPDATE email_changes SET team_id = (SELECT id FROM teams LIMIT 1);

INSERT INTO team_settings (team_id, key, value)
SELECT t.id, s.key, s.value FROM teams t, settings s
WHERE s.key IN ('notify_email', 'notify_kinds', 'global_pause', 'default_pause_pct', 'merge_window_min');

-- Global settings keep only platform keys.
DELETE FROM settings WHERE key IN ('notify_email', 'notify_kinds', 'global_pause', 'default_pause_pct', 'merge_window_min', 'change_seq');
INSERT OR REPLACE INTO settings (key, value) VALUES ('min_client_version', '0.5.0');

CREATE INDEX workspaces_team ON workspaces (team_id, status);
CREATE INDEX threads_team ON threads (team_id, status, last_post_at);
CREATE INDEX posts_team ON posts (team_id, id);
CREATE INDEX deliveries_team ON deliveries (team_id, state);
CREATE INDEX confirmations_team ON confirmations (team_id, status);
CREATE INDEX runs_team ON runs (team_id, started_at);
CREATE INDEX audit_team ON audit_log (team_id, id);
DROP INDEX notifications_unsent;
CREATE INDEX notifications_unsent ON notifications (sent_at, team_id, kind);
DROP INDEX notifications_dedupe;
CREATE UNIQUE INDEX notifications_dedupe ON notifications (team_id, kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND sent_at IS NULL;
