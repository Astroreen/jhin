-- T81 upgrade capture: AFTER the kernel boot (v2 schema)
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
, pinned INT DEFAULT 0, pinned_order INT, settled_at INT, snoozed_until INT, archived_at INT, auto_settle INT DEFAULT 1, sort_order INT, settled_reason TEXT, auto_settle_suppressed INT DEFAULT 0);
-- rows:
s-1|alice|alpha|/w/1|m1|p1|active|1000|1001|0|||||1|||0
s-2|alice|beta|/w/2|||active|2000|2001|0|||||1|||0
s-3|bob|gamma|/w/3|m2|p2|active|3000|3001|0|||||1|||0
-- plugin schema bookkeeping:
jhin.sessions|1
jhin.sessions|2
