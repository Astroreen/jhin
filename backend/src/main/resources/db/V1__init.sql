CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE devices (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL,
  last_seen TEXT, last_ip TEXT, revoked INT NOT NULL DEFAULT 0);
CREATE TABLE enrollment_codes (code_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at TEXT NOT NULL, used INT NOT NULL DEFAULT 0);
CREATE TABLE sessions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  title TEXT NOT NULL, workdir TEXT NOT NULL, model TEXT, provider_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE events (session_id TEXT NOT NULL, seq INT NOT NULL, ts TEXT NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq));
CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  status TEXT NOT NULL, -- RUNNING|DONE|CANCELLED|ERROR|INTERRUPTED
  model TEXT, provider_id TEXT, usage_json TEXT, error TEXT,
  started_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE providers (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL, format TEXT NOT NULL, -- anthropic|openai|gemini
  base_url TEXT, api_key TEXT NOT NULL, model TEXT NOT NULL, is_default INT NOT NULL DEFAULT 0);
CREATE TABLE workers (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
  last_heartbeat TEXT); -- ШОВ под будущих воркеров. MVP: hub сам регистрирует строку 'local'
