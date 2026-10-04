-- _jhin_plugin_schema
CREATE TABLE _jhin_plugin_schema(
    plugin_id TEXT,
    version INT,
    applied_at INT,
    PRIMARY KEY(plugin_id, version)
);

-- jhin_sessions_events
CREATE TABLE jhin_sessions_events(
    session_id TEXT,
    seq INT,
    ts INT,
    type TEXT,
    payload TEXT,
    PRIMARY KEY(session_id, seq)
);

-- jhin_sessions_events_ts_idx
CREATE INDEX jhin_sessions_events_ts_idx ON jhin_sessions_events(ts);

-- jhin_sessions_runs
CREATE TABLE jhin_sessions_runs(
    id TEXT PRIMARY KEY,
    session_id TEXT,
    status TEXT,
    started_at INT,
    ended_at INT,
    error TEXT
);

-- jhin_sessions_runs_session_idx
CREATE INDEX jhin_sessions_runs_session_idx ON jhin_sessions_runs(session_id);

-- jhin_sessions_sessions
CREATE TABLE jhin_sessions_sessions(
    id TEXT PRIMARY KEY,
    account_id TEXT,
    title TEXT,
    workdir TEXT,
    model TEXT,
    provider_id TEXT,
    status TEXT,
    created_at INT,
    updated_at INT
);

