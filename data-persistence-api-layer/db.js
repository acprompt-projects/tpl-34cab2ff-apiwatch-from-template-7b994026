const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'apiwatch.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initSchema() {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'GET',
      expected_status INTEGER NOT NULL DEFAULT 200,
      check_interval_seconds INTEGER NOT NULL DEFAULT 60,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint_id INTEGER NOT NULL,
      status_code INTEGER,
      response_time_ms INTEGER,
      is_up INTEGER NOT NULL,
      error_message TEXT,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (endpoint_id) REFERENCES endpoints(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint_id INTEGER NOT NULL,
      alert_type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      acknowledged INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_checks_endpoint_time ON checks(endpoint_id, checked_at);
    CREATE INDEX IF NOT EXISTS idx_checks_endpoint_up ON checks(endpoint_id, is_up);
    CREATE INDEX IF NOT EXISTS idx_alerts_endpoint ON alerts(endpoint_id, created_at);
  `);
  return d;
}

function insertEndpoint({ name, url, method = 'GET', expected_status = 200, check_interval_seconds = 60 }) {
  return getDb().prepare(
    `INSERT INTO endpoints (name, url, method, expected_status, check_interval_seconds) VALUES (?, ?, ?, ?, ?)`
  ).run(name, url, method, expected_status, check_interval_seconds);
}

function getEndpoints(activeOnly = false) {
  const sql = activeOnly ? 'SELECT * FROM endpoints WHERE is_active = 1' : 'SELECT * FROM endpoints';
  return getDb().prepare(sql).all();
}

function getEndpoint(id) {
  return getDb().prepare('SELECT * FROM endpoints WHERE id = ?').get(id);
}

function updateEndpoint(id, fields) {
  const allowed = ['name', 'url', 'method', 'expected_status', 'check_interval_seconds', 'is_active'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  }
  if (!sets.length) return { changes: 0 };
  vals.push(id);
  return getDb().prepare(`UPDATE endpoints SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function deleteEndpoint(id) {
  return getDb().prepare('DELETE FROM endpoints WHERE id = ?').run(id);
}

function insertCheck({ endpoint_id, status_code, response_time_ms, is_up, error_message }) {
  return getDb().prepare(
    `INSERT INTO checks (endpoint_id, status_code, response_time_ms, is_up, error_message) VALUES (?, ?, ?, ?, ?)`
  ).run(endpoint_id, status_code, response_time_ms, is_up ? 1 : 0, error_message || null);
}

function getChecks(endpoint_id, { limit = 100, since } = {}) {
  if (since) {
    return getDb().prepare(
      'SELECT * FROM checks WHERE endpoint_id = ? AND checked_at >= ? ORDER BY checked_at DESC LIMIT ?'
    ).all(endpoint_id, since, limit);
  }
  return getDb().prepare(
    'SELECT * FROM checks WHERE endpoint_id = ? ORDER BY checked_at DESC LIMIT ?'
  ).all(endpoint_id, limit);
}

function getMetrics(endpoint_id, hours = 24) {
  return getDb().prepare(`
    SELECT
      COUNT(*) AS total_checks,
      SUM(CASE WHEN is_up = 1 THEN 1 ELSE 0 END) AS up_count,
      AVG(response_time_ms) AS avg_response_ms,
      MIN(response_time_ms) AS min_response_ms,
      MAX(response_time_ms) AS max_response_ms,
      ROUND(100.0 * SUM(CASE WHEN is_up = 1 THEN 1 ELSE 0 END) / COUNT(*), 2) AS uptime_pct
    FROM checks
    WHERE endpoint_id = ? AND checked_at >= datetime('now', '-' || ? || ' hours')
  `).get(endpoint_id, hours);
}

function insertAlert({ endpoint_id, alert_type, message }) {
  return getDb().prepare(
    'INSERT INTO alerts (endpoint_id, alert_type, message) VALUES (?, ?, ?)'
  ).run(endpoint_id, alert_type, message);
}

function getAlerts({ endpoint_id, acknowledged, limit = 50 } = {}) {
  let sql = 'SELECT a.*, e.name AS endpoint_name FROM alerts a JOIN endpoints e ON a.endpoint_id = e.id WHERE 1=1';
  const params = [];
  if (endpoint_id) { sql += ' AND a.endpoint_id = ?'; params.push(endpoint_id); }
  if (acknowledged !== undefined) { sql += ' AND a.acknowledged = ?'; params.push(acknowledged ? 1 : 0); }
  sql += ' ORDER BY a.created_at DESC LIMIT ?';
  params.push(limit);
  return getDb().prepare(sql).all(...params);
}

function acknowledgeAlert(id) {
  return getDb().prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(id);
}

function getDashboardSummary() {
  const endpoints = getEndpoints(true);
  const summary = endpoints.map(ep => {
    const metrics = getMetrics(ep.id, 24);
    const lastCheck = getDb().prepare(
      'SELECT * FROM checks WHERE endpoint_id = ? ORDER BY checked_at DESC LIMIT 1'
    ).get(ep.id);
    return { ...ep, metrics, last_check: lastCheck || null };
  });
  const unacknowledgedAlerts = getDb().prepare(
    'SELECT COUNT(*) AS count FROM alerts WHERE acknowledged = 0'
  ).get().count;
  return { endpoints: summary, unacknowledged_alerts: unacknowledgedAlerts };
}

module.exports = {
  initSchema, insertEndpoint, getEndpoints, getEndpoint, updateEndpoint, deleteEndpoint,
  insertCheck, getChecks, getMetrics, insertAlert, getAlerts, acknowledgeAlert, getDashboardSummary
};