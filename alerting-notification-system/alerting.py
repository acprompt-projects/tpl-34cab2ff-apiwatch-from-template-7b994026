import json
import logging
import sqlite3
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

import httpx

logger = logging.getLogger("alerting")

SCHEMA_PATH = "alerting-notification-system/schema.sql"


class RuleType(str, Enum):
    CONSECUTIVE_FAILURES = "consecutive_failures"
    LATENCY_SPIKE = "latency_spike"
    STATUS_CHANGE = "status_change"


class CheckResult:
    __slots__ = ("endpoint_id", "status_code", "latency_ms", "success", "timestamp")

    def __init__(self, endpoint_id: str, status_code: Optional[int],
                 latency_ms: float, success: bool, timestamp: Optional[str] = None):
        self.endpoint_id = endpoint_id
        self.status_code = status_code
        self.latency_ms = latency_ms
        self.success = success
        self.timestamp = timestamp or datetime.now(timezone.utc).isoformat()


class AlertEngine:
    def __init__(self, db_path: str = "alerting.db"):
        self.db_path = db_path
        self._init_db()
        self._http = httpx.Client(timeout=10.0)

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            with open(SCHEMA_PATH, "r") as f:
                conn.executescript(f.read())

    def _get_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    # ── State tracking ──────────────────────────────────────────────

    def _update_state(self, conn: sqlite3.Connection, result: CheckResult) -> dict:
        row = conn.execute(
            "SELECT consecutive_failures, last_status_code, last_latency_ms "
            "FROM check_state WHERE endpoint_id = ?", (result.endpoint_id,)
        ).fetchone()

        prev = dict(row) if row else {
            "consecutive_failures": 0, "last_status_code": None, "last_latency_ms": None
        }

        failures = prev["consecutive_failures"]
        if result.success:
            failures = 0
        else:
            failures += 1

        conn.execute(
            "INSERT INTO check_state (endpoint_id, consecutive_failures, last_status_code, last_latency_ms) "
            "VALUES (?, ?, ?, ?) ON CONFLICT(endpoint_id) DO UPDATE SET "
            "consecutive_failures=excluded.consecutive_failures, "
            "last_status_code=excluded.last_status_code, "
            "last_latency_ms=excluded.last_latency_ms",
            (result.endpoint_id, failures, result.status_code, result.latency_ms)
        )
        conn.commit()
        return prev

    # ── Rule evaluation ─────────────────────────────────────────────

    def evaluate(self, result: CheckResult) -> list[dict]:
        conn = self._get_conn()
        try:
            prev = self._update_state(conn, result)
            rules = conn.execute(
                "SELECT r.id, r.rule_type, r.threshold FROM alert_rule r "
                "WHERE r.endpoint_id = ? AND r.enabled = 1", (result.endpoint_id,)
            ).fetchall()

            fired: list[dict] = []
            for rule in rules:
                alert_msg = self._check_rule(rule, result, prev)
                if alert_msg:
                    channels = conn.execute(
                        "SELECT c.* FROM alert_channel c "
                        "JOIN alert_rule_channel rc ON rc.channel_id = c.id "
                        "WHERE rc.rule_id = ? AND c.enabled = 1", (rule["id"],)
                    ).fetchall()

                    event_id = self._persist_event(conn, result, rule, alert_msg)

                    fired.append({
                        "event_id": event_id, "rule_id": rule["id"],
                        "rule_type": rule["rule_type"], "message": alert_msg,
                        "channels": [dict(c) for c in channels]
                    })
            return fired
        finally:
            conn.close()

    def _check_rule(self, rule: sqlite3.Row, result: CheckResult, prev: dict) -> Optional[str]:
        rtype = rule["rule_type"]
        threshold = rule["threshold"]

        if rtype == RuleType.CONSECUTIVE_FAILURES:
            cur = prev["consecutive_failures"] + (0 if result.success else 1)
            if cur >= int(threshold) and not result.success:
                return (f"Endpoint {result.endpoint_id} has {cur} consecutive failures "
                        f"(threshold: {int(threshold)})")

        elif rtype == RuleType.LATENCY_SPIKE:
            if result.latency_ms > threshold:
                return (f"Endpoint {result.endpoint_id} latency {result.latency_ms:.0f}ms "
                        f"exceeds threshold {threshold:.0f}ms")

        elif rtype == RuleType.STATUS_CHANGE:
            prev_code = prev.get("last_status_code")
            if prev_code is not None and result.status_code != prev_code:
                return (f"Endpoint {result.endpoint_id} status changed "
                        f"{prev_code} -> {result.status_code}")
        return None

    def _persist_event(self, conn: sqlite3.Connection, result: CheckResult,
                       rule: sqlite3.Row, message: str) -> int:
        cur = conn.execute(
            "INSERT INTO alert_event (endpoint_id, rule_type, rule_id, message, fired_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (result.endpoint_id, rule["rule_type"], rule["id"],
             message, result.timestamp)
        )
        conn.commit()
        return cur.lastrowid  # type: ignore[return-value]

    # ── Notification dispatch ───────────────────────────────────────

    def dispatch(self, alert: dict) -> list[dict]:
        results: list[dict] = []
        for ch in alert.get("channels", []):
            payload = self._build_payload(ch["channel_type"], alert)
            headers = json.loads(ch.get("headers") or "{}")
            headers["Content-Type"] = "application/json"
            ok = self._send_webhook(ch["url"], headers, payload)
            results.append({"channel": ch["name"], "type": ch["channel_type"], "sent": ok})
        return results

    @staticmethod
    def _build_payload(channel_type: str, alert: dict) -> dict:
        msg = alert["message"]
        if channel_type == "slack":
            return {"text": f"⚠️ APIWatch Alert: {msg}"}
        if channel_type == "discord":
            return {"content": f"⚠️ **APIWatch Alert**: {msg}"}
        return {"alert": msg, "rule_type": alert["rule_type"],
                "rule_id": alert["rule_id"], "event_id": alert["event_id"]}

    def _send_webhook(self, url: str, headers: dict, payload: dict) -> bool:
        try:
            resp = self._http.post(url, json=payload, headers=headers)
            if resp.status_code < 400:
                logger.info("Webhook sent to %s (%d)", url, resp.status_code)
                return True
            logger.warning("Webhook failed to %s: %d", url, resp.status_code)
        except httpx.HTTPError as exc:
            logger.error("Webhook error to %s: %s", url, exc)
        return False

    # ── Public API helpers ──────────────────────────────────────────

    def process(self, result: CheckResult) -> list[dict]:
        """Evaluate a check result, fire notifications, return dispatch results."""
        alerts = self.evaluate(result)
        dispatch_results = []
        for alert in alerts:
            dispatch_results.extend(self.dispatch(alert))
        return dispatch_results

    def get_alert_history(self, endpoint_id: Optional[str] = None,
                          limit: int = 50) -> list[dict]:
        conn = self._get_conn()
        try:
            if endpoint_id:
                rows = conn.execute(
                    "SELECT * FROM alert_event WHERE endpoint_id = ? "
                    "ORDER BY fired_at DESC LIMIT ?", (endpoint_id, limit)
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM alert_event ORDER BY fired_at DESC LIMIT ?",
                    (limit,)
                ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    def acknowledge_alert(self, event_id: int) -> bool:
        conn = self._get_conn()
        try:
            cur = conn.execute(
                "UPDATE alert_event SET acknowledged = 1 WHERE id = ?", (event_id,)
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()

    def add_rule(self, endpoint_id: str, rule_type: str,
                 threshold: float, channel_ids: Optional[list[int]] = None) -> int:
        conn = self._get_conn()
        try:
            cur = conn.execute(
                "INSERT INTO alert_rule (endpoint_id, rule_type, threshold) VALUES (?, ?, ?)",
                (endpoint_id, rule_type, threshold)
            )
            rule_id = cur.lastrowid
            if channel_ids:
                for cid in channel_ids:
                    conn.execute(
                        "INSERT INTO alert_rule_channel (rule_id, channel_id) VALUES (?, ?)",
                        (rule_id, cid)
                    )
            conn.commit()
            return rule_id  # type: ignore[return-value]
        finally:
            conn.close()

    def add_channel(self, name: str, channel_type: str,
                    url: str, headers: Optional[dict] = None) -> int:
        conn = self._get_conn()
        try:
            cur = conn.execute(
                "INSERT INTO alert_channel (name, channel_type, url, headers) "
                "VALUES (?, ?, ?, ?)",
                (name, channel_type, url, json.dumps(headers or {}))
            )
            conn.commit()
            return cur.lastrowid  # type: ignore[return-value]
        finally:
            conn.close()

    def close(self):
        self._http.close()