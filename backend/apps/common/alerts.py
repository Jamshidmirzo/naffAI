"""
`alert_owner(code, message, severity)` — single-entrypoint TG push to
the shop owner (chat_id 88938071).

Design notes:

- **Rate limit** per `code` via Redis SETNX with EX=600 (10 min). This
  collapses storms of the same incident (e.g. 50 writeback failures in
  a row during a Google quota hit) into one alert per 10 min window.
- **Fallback through on Redis down**: if the SETNX call raises, we send
  the TG message anyway. A duplicate alert is strictly better than a
  silently-swallowed one; the owner can mute, the system cannot
  un-break if nobody tells.
- **Transport = Telegram Bot API via httpx**. We deliberately do NOT
  go through aiogram here because `alert_owner` can be called from
  sync code (management commands, services, views) and we don't want
  to drag event loops into those paths. One sync `httpx.post` is
  cheap, reliable, and matches the pattern used by
  `writeback_reconcile_srm`.
- **Recent-alerts log** (Redis sorted set `alerts:log`) keeps the last
  1000 events with score=epoch so `/api/system/health/` can show a
  "recent 24h" table. Trimming happens inline on every push.
- **TG errors don't propagate**. "Alerting about alerting failing"
  loops; worst case we log.exception and move on. Owner will notice
  Redis down via other means (/healthz 503, missing watchdog HB).
"""

from __future__ import annotations

import json
import logging
import time
from typing import Literal

import httpx
from django.conf import settings

logger = logging.getLogger("common.alerts")

OWNER_TG_CHAT_ID = 88938071
"""Shop owner — chat ID that receives every alert. Hard-coded (same
value as `hot_leads_escalation.OWNER_TG_CHAT_ID`); single-tenant tool."""

Severity = Literal["info", "warn", "critical"]

_SEVERITY_PREFIX = {
    "info": "ℹ️",
    "warn": "🟡",
    "critical": "🔴",
}

# Rate-limit window: one alert per `code` per 10 minutes. Redis TTL.
_RATE_LIMIT_SECONDS = 600

# How many alerts to keep in the ring buffer for the /system-health page.
_ALERT_LOG_CAP = 1000


def _redis_client():
    """Raw redis-py client — same pattern as apps.common.health."""
    url = getattr(settings, "REDIS_URL", "") or ""
    if not url:
        return None
    try:
        import redis  # type: ignore[import-not-found]
    except Exception:
        return None
    try:
        return redis.Redis.from_url(
            url, socket_connect_timeout=3, socket_timeout=3
        )
    except Exception as exc:
        logger.warning("alerts: redis client build failed: %s", exc)
        return None


def _should_fire(redis_client, code: str) -> bool:
    """
    Rate-limit: SETNX `alert:<code>` with TTL=600s. First caller gets
    True; subsequent calls in the next 10 min get False.

    On Redis error — return True (prefer duplicate alert over silent
    drop). See module docstring for rationale.
    """
    if redis_client is None:
        return True
    try:
        acquired = redis_client.set(
            f"alert:{code}", "1", ex=_RATE_LIMIT_SECONDS, nx=True
        )
        return bool(acquired)
    except Exception as exc:
        logger.warning("alert_owner rate-limit check failed, firing anyway: %s", exc)
        return True


def _append_to_log(redis_client, code: str, message: str, severity: Severity) -> None:
    """Append this alert to Redis sorted set for the UI history view."""
    if redis_client is None:
        return
    try:
        payload = json.dumps({
            "code": code,
            "message": message,
            "severity": severity,
            "ts": int(time.time()),
        }, ensure_ascii=False)
        now = time.time()
        redis_client.zadd("alerts:log", {payload: now})
        # Trim: keep the newest 1000 only. ZREMRANGEBYRANK removes by
        # rank ascending, so to drop the oldest we remove 0..-cap-1.
        redis_client.zremrangebyrank("alerts:log", 0, -(_ALERT_LOG_CAP + 1))
    except Exception as exc:
        logger.warning("alerts log append failed: %s", exc)


def _send_telegram(body: str) -> None:
    """
    POST to Telegram Bot API. HTML parse mode. Silent on failure.

    Uses httpx sync (short timeout) so this works from both management
    commands and WSGI request handlers without async machinery.
    """
    token = getattr(settings, "TELEGRAM_BOT_TOKEN", "") or ""
    if not token:
        logger.warning("alert_owner: TELEGRAM_BOT_TOKEN empty, dropping alert")
        return
    try:
        httpx.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={
                "chat_id": OWNER_TG_CHAT_ID,
                "text": body,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            },
            timeout=10.0,
        )
    except Exception:
        # Alerting about alerting is a tar pit — swallow and log only.
        logger.exception("alert_owner: TG send failed")


def alert_owner(code: str, message: str, severity: Severity = "warn") -> None:
    """
    Push a one-liner alert to the shop owner's Telegram.

    Args:
        code: machine-readable dedup key (e.g. ``writeback_failed``).
              All invocations with the same ``code`` collapse within a
              10-minute window.
        message: human-readable body shown in TG. Keep it short — this
              is a push, not a report.
        severity: ``info`` / ``warn`` / ``critical`` → emoji prefix.

    Resilience:
        * Redis down → rate-limit check is bypassed and the alert is sent
          anyway. We prefer a duplicate TG message over losing the signal.
        * Telegram API down → logged, swallowed. The alert is appended to
          the recent-alerts ring (if Redis is up) so the /system-health
          UI still surfaces it.

    This function is fire-and-forget. It never raises. Safe to call from
    anywhere, including inside ``except`` handlers.
    """
    try:
        client = _redis_client()
        if not _should_fire(client, code):
            return
        _append_to_log(client, code, message, severity)
        prefix = _SEVERITY_PREFIX.get(severity, "🟡")
        body = f"{prefix} <b>{code}</b>\n{message}"
        _send_telegram(body)
    except Exception:
        # Last-resort guard — never let alerting break the caller.
        logger.exception("alert_owner unexpected failure (code=%s)", code)


def recent_alerts(limit: int = 50) -> list[dict]:
    """Read back the last `limit` alerts (newest first) for the UI."""
    client = _redis_client()
    if client is None:
        return []
    try:
        # ZREVRANGE 0 limit-1 WITHSCORES — newest first.
        raw = client.zrevrange("alerts:log", 0, max(0, limit - 1), withscores=True)
        out: list[dict] = []
        for member, score in raw:
            text = member.decode("utf-8") if isinstance(member, bytes) else str(member)
            try:
                payload = json.loads(text)
            except Exception:
                continue
            payload.setdefault("ts", int(score))
            out.append(payload)
        return out
    except Exception as exc:
        logger.warning("recent_alerts fetch failed: %s", exc)
        return []
