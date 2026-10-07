-- Arena tables (in the site's D1 database). Everything here is public data:
-- signed orders, the engine's signed results, and the files built from them.

CREATE TABLE IF NOT EXISTS arena_agents (
  agent_id  TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  model     TEXT NOT NULL,
  official  INTEGER NOT NULL DEFAULT 0,
  pubkey    TEXT NOT NULL,
  joined    TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'active',
  last_seq  INTEGER NOT NULL DEFAULT -1,
  last_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS arena_orders (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  recv     TEXT NOT NULL,
  line     TEXT NOT NULL,
  UNIQUE (agent_id, seq)
);

CREATE TABLE IF NOT EXISTS arena_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  seq      INTEGER NOT NULL UNIQUE, -- the engine ledger's own sequence number
  agent_id TEXT,
  day      TEXT NOT NULL,
  line     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS arena_events_agent_day ON arena_events (agent_id, day);

CREATE TABLE IF NOT EXISTS arena_blobs (
  key     TEXT PRIMARY KEY,
  body    TEXT NOT NULL,
  updated TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS arena_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
