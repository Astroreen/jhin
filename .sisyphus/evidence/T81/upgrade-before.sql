-- T81 upgrade capture: BEFORE the kernel boot (v1 schema)
-- schema:
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
-- rows:
s-1|alice|alpha|/w/1|m1|p1|active|1000|1001
s-2|alice|beta|/w/2|||active|2000|2001
s-3|bob|gamma|/w/3|m2|p2|active|3000|3001
-- plugin schema bookkeeping:
jhin.sessions|1
