CREATE TABLE IF NOT EXISTS _jhin_kernel_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS _jhin_plugin_schema (
  plugin_id  TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, version)
);

CREATE TABLE IF NOT EXISTS _jhin_seeded_plugins (
  jar_name  TEXT PRIMARY KEY,
  sha256    TEXT    NOT NULL,
  seeded_at INTEGER NOT NULL
);
