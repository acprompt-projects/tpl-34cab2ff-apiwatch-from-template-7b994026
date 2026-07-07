CREATE TABLE IF NOT EXISTS alert_rule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint_id TEXT NOT NULL,
    rule_type TEXT NOT NULL CHECK (rule_type IN ('consecutive_failures', 'latency_spike', 'status_change')),
    threshold REAL NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(endpoint_id, rule_type)
);

CREATE TABLE IF NOT EXISTS alert_channel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    channel_type TEXT NOT NULL CHECK (channel_type IN ('slack', 'discord', 'generic')),
    url TEXT NOT NULL,
    headers TEXT DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alert_rule_channel (
    rule_id INTEGER NOT NULL REFERENCES alert_rule(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES alert_channel(id) ON DELETE CASCADE,
    PRIMARY KEY (rule_id, channel_id)
);

CREATE TABLE IF NOT EXISTS alert_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint_id TEXT NOT NULL,
    rule_type TEXT NOT NULL,
    rule_id INTEGER NOT NULL REFERENCES alert_rule(id),
    message TEXT NOT NULL,
    fired_at TEXT NOT NULL DEFAULT (datetime('now')),
    acknowledged INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_alert_event_endpoint ON alert_event(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_alert_event_fired ON alert_event(fired_at DESC);

CREATE TABLE IF NOT EXISTS check_state (
    endpoint_id TEXT PRIMARY KEY,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_status_code INTEGER,
    last_latency_ms REAL
);