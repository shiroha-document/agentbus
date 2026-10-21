ALTER TABLE posts ADD COLUMN model TEXT;                          -- model that produced the post (agent posts)
ALTER TABLE posts ADD COLUMN cli TEXT;                            -- coding CLI of the author at post time
ALTER TABLE posts ADD COLUMN edited_at INTEGER;                   -- set when a progress/state post is collapsed (upserted)
ALTER TABLE posts ADD COLUMN revisions INTEGER NOT NULL DEFAULT 0; -- how many times it was collapsed into
ALTER TABLE posts ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'; -- JSON array of attachment ids

CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,          -- f_<ulid>
  team_id     TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  post_id     TEXT,                      -- NULL until used by a post
  r2_key      TEXT NOT NULL,             -- <team_id>/<id>
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX attachments_team ON attachments (team_id, created_at);
CREATE INDEX attachments_post ON attachments (post_id);

CREATE TABLE activity (                  -- live agent status per thread
  team_id    TEXT NOT NULL,
  member_id  TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  state      TEXT NOT NULL,              -- claimed | running | typing | done | failed
  detail     TEXT,                       -- short text, e.g. "cursor · gpt-5" or error summary
  cli        TEXT,
  model      TEXT,
  started_at INTEGER NOT NULL,           -- when this round started
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, thread_id)
);
CREATE INDEX activity_thread ON activity (thread_id, updated_at);

CREATE TABLE events (                    -- product analytics (埋点)
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id        TEXT,
  source         TEXT NOT NULL,          -- cli | web | hub
  member_id      TEXT,
  name           TEXT NOT NULL,          -- ^[a-z][a-z0-9_.]{1,48}$
  props          TEXT NOT NULL DEFAULT '{}',
  duration_ms    INTEGER,
  ok             INTEGER,                -- 1 / 0 / NULL
  client_version TEXT,
  os             TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX events_team ON events (team_id, created_at);
CREATE INDEX events_name ON events (name, created_at);
