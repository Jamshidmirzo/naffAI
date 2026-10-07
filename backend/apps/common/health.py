"""
Health & heartbeat infra.

Two concerns, one file:

1. `HealthCheckView` — public `/healthz` endpoint. Returns 200 ok / 503
   error with lightweight DB + sheets freshness + TG session ratio
   signals. **Also** returns 503 when the `watchdog` service's own
   heartbeat is stale (>3 min), so an external uptime monitor catches
   the case where the watchdog itself dies.

2. Heartbeat helpers (`record_heartbeat`, `read_heartbeat`,
   `health_snapshot`) + `EXPECTED_INTERVALS` config. Every critical
   long-running / periodic service calls `record_heartbeat("<name>")`
   on each successful tick; the `watchdog` management command reads
   these and alerts the owner via `apps.common.alerts.alert_owner`
   when a key goes missing or stale.

   Heartbeat keys are **raw** `hb:<service>` in Redis (not prefixed
   via django_redis / KEY_PREFIX), so operations teams can inspect
   with `redis-cli KEYS 'hb:*'` without needing to know the prefix.

Design decisions:

- Heartbeat writes are fire-and-forget: any Redis / connection error is
  swallowed with a `logger.warning` — a Redis blip must never abort a
  management command's main work.
- `health_snapshot` only reports keys declared in `EXPECTED_INTERVALS`.
  Services added later must register themselves there — this is
  intentional: it's the one list that defines "what we care about",
  and new silent services aren't automatically monitored.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone as _tz

from django.conf import settings
from django.db import connection
from django.utils import timezone
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

logger = logging.getLogger("common.health")

# Max age (seconds) of each service's heartbeat before we flag it.
# Values are intentionally generous — most watchers tick once per minute
# but we accept 3-10 min slack to avoid cry-wolf alerts on slow docker
# starts. Daily / periodic commands get hours.
EXPECTED_INTERVALS: dict[str, int] = {
    # Sheet sync — hot sheets every 60s; alert if >3 min stale.
    "hot_sheet_sync": 3 * 60,
    # Normal sheet sync — every 300s; alert if >10 min stale.
    "sheet_sync": 10 * 60,
    # Distribute watcher — every 300s (5 min).
    "distribute_watcher": 10 * 60,
    # TG dialog analyzer — every 15 min.
    "scheduler": 20 * 60,
    # Hot leads escalation — every 60s.
    "hot_leads_watch": 3 * 60,
    # qimmatlik_qildi retry — every 10 min.
    "qimmatlik_retry_watch": 15 * 60,
    # Nightly writeback reconcile — 22:00 UTC. Allow 26h slack.
    "writeback_reconcile": 26 * 3600,
    # Late-arrival in-app watcher — every 5 min.
    "attendance_late_watch": 10 * 60,
    # 9-hour shift reminder — every 15 min.
    "attendance_nine_hour_watch": 20 * 60,
    # Nightly ops cron (release stale + daily report). Allow 26h slack.
    "ops_nightly": 26 * 3600,
    # Daily lesson generator — loop sleeps 6h.
    "lesson_generator": 7 * 3600,
    # BotReport scheduler — every 60s.
    "reports_scheduler": 3 * 60,
    # Morning distribute — once per day at 08:30 TSH. 26h slack.
    "morning_splitter": 26 * 3600,
    # TG bot — tick heartbeat inside middleware on each update. If no TG
    # traffic for 5 min we accept — slow nights happen. Watchdog alerts
    # only if >5 min of total silence, which usually means dead.
    "tg_bot": 5 * 60,
    # Telethon user-client — ticks every SYNC_INTERVAL_SEC (default ~120s)
    # inside the main loop.
    "userclient": 10 * 60,
    # Watchdog itself — ticks every 60s. If stale, /healthz 503s.
    "watchdog": 3 * 60,
}


def _redis_client():
    """Return a raw `redis.Redis` client or None if unavailable.

    We use raw redis-py (not django cache) because:
      - Need SETNX for alert rate-limit.
      - Need `KEYS hb:*` scan + raw string keys without KEY_PREFIX.
      - Need TTL + SCORE on sorted sets.
    """
    url = getattr(settings, "REDIS_URL", "") or ""
    if not url:
        return None
    try:
        import redis  # type: ignore[import-not-found]
    except Exception:  # pragma: no cover — defensive
        return None
    try:
        client = redis.Redis.from_url(
            url, socket_connect_timeout=3, socket_timeout=3
        )
        return client
    except Exception as exc:  # pragma: no cover — defensive
        logger.warning("redis client build failed: %s", exc)
        return None


def record_heartbeat(service: str) -> None:
    """Write `hb:<service>` → now-iso-timestamp, TTL 24h.

    Fire-and-forget: all exceptions are swallowed. Heartbeat failing
    MUST NOT abort the caller — the caller's main work is more
    important than its own uptime signal.
    """
    client = _redis_client()
    if client is None:
        return
    try:
        now_iso = timezone.now().astimezone(_tz.utc).isoformat()
        client.set(f"hb:{service}", now_iso, ex=24 * 3600)
    except Exception as exc:  # pragma: no cover — tolerance by design
        logger.warning("record_heartbeat(%s) failed: %s", service, exc)


def read_heartbeat(service: str) -> datetime | None:
    """Return the last-recorded heartbeat for `service`, or None."""
    client = _redis_client()
    if client is None:
        return None
    try:
        raw = client.get(f"hb:{service}")
        if not raw:
            return None
        text = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_tz.utc)
        return dt
    except Exception as exc:  # pragma: no cover — defensive
        logger.warning("read_heartbeat(%s) failed: %s", service, exc)
        return None


def health_snapshot() -> list[dict]:
    """
    Snapshot every service declared in `EXPECTED_INTERVALS`.

    Returns a list of dicts, one per service:
      {service, last_ok_iso, age_s, max_age_s, status}

    status:
      - "ok"       — heartbeat present and age <= max_age_s
      - "stale"    — heartbeat present but age > max_age_s
      - "missing"  — no heartbeat key at all (service never ticked)
    """
    now = timezone.now()
    out: list[dict] = []
    for service, max_age in sorted(EXPECTED_INTERVALS.items()):
        last = read_heartbeat(service)
        if last is None:
            out.append({
                "service": service,
                "last_ok_iso": None,
                "age_s": None,
                "max_age_s": max_age,
                "status": "missing",
            })
            continue
        age = int((now - last).total_seconds())
        status = "ok" if age <= max_age else "stale"
        out.append({
            "service": service,
            "last_ok_iso": last.isoformat(),
            "age_s": age,
            "max_age_s": max_age,
            "status": status,
        })
    return out


class HealthCheckView(APIView):
    """Public `/healthz` — DB + sheets + TG sessions + watchdog freshness."""

    permission_classes = [AllowAny]

    def get(self, request):
        from apps.leads.models import SheetSource
        from apps.operators.models import Operator
        from apps.tg_bot.models import BotSubscription
        from apps.tg_userclient.models import TgAiInsight, TgSession

        checks: dict[str, dict] = {}
        overall = "ok"

        # 1. DB connection check
        try:
            connection.ensure_connection()
            checks["db"] = {"status": "ok"}
        except Exception as e:
            checks["db"] = {"status": "error", "detail": str(e)}
            overall = "error"

        # 2. Google Sheets sync freshness (via SheetSource.last_synced_at,
        # independent of the Redis heartbeat — this is a safety fallback).
        try:
            latest = (
                SheetSource.objects.filter(active=True)
                .order_by("-last_synced_at")
                .first()
            )
            if latest and latest.last_synced_at:
                age_min = (
                    timezone.now() - latest.last_synced_at
                ).total_seconds() / 60.0
                checks["sheets_sync"] = {
                    "status": "warning" if age_min > 5 else "ok",
                    "age_min": round(age_min, 1),
                }
                if age_min > 5 and overall == "ok":
                    overall = "warning"
        except Exception as e:
            checks["sheets_sync"] = {"status": "warning", "detail": str(e)}

        # 3. TG sessions active ratio
        try:
            total_ops = Operator.objects.filter(status="active").count()
            active_sess = TgSession.objects.filter(status="active").count()
            ratio = active_sess / total_ops if total_ops else 1.0
            checks["tg_sessions"] = {
                "status": "warning" if ratio < 0.5 else "ok",
                "active": active_sess,
                "total": total_ops,
            }
            if ratio < 0.5 and overall == "ok":
                overall = "warning"
        except Exception as e:
            checks["tg_sessions"] = {"status": "warning", "detail": str(e)}

        # 4. AI insights freshness
        try:
            latest_ai = TgAiInsight.objects.order_by("-created_at").first()
            if latest_ai and latest_ai.created_at:
                age_h = (
                    timezone.now() - latest_ai.created_at
                ).total_seconds() / 3600.0
                checks["ai_insights"] = {
                    "status": "warning" if age_h > 2 else "ok",
                    "age_h": round(age_h, 1),
                }
                if age_h > 2 and overall == "ok":
                    overall = "warning"
        except Exception as e:
            checks["ai_insights"] = {"status": "warning", "detail": str(e)}

        # 5. DM-blocked count
        try:
            blocked = BotSubscription.objects.filter(
                blocked_at__isnull=False
            ).count()
            checks["tg_bot_blocked_dms"] = {
                "status": "ok" if blocked < 3 else "warning",
                "count": blocked,
            }
        except Exception:
            pass

        # 6. Watchdog freshness. If the watchdog is dead, 503 so an
        # external uptime monitor fires — nothing inside the system can
        # alert about the alerter being down.
        #
        # Only evaluated when REDIS_URL is configured: in dev / test
        # (locmem cache, no Redis) heartbeats aren't persisted and this
        # check would always warn. Prod has REDIS_URL set.
        if getattr(settings, "REDIS_URL", "") or "":
            try:
                last_watchdog = read_heartbeat("watchdog")
                if last_watchdog is None:
                    checks["watchdog"] = {"status": "warning", "detail": "no heartbeat yet"}
                    if overall == "ok":
                        overall = "warning"
                else:
                    age_s = int((timezone.now() - last_watchdog).total_seconds())
                    limit = EXPECTED_INTERVALS["watchdog"]
                    if age_s > limit:
                        checks["watchdog"] = {
                            "status": "error",
                            "age_s": age_s,
                            "max_s": limit,
                        }
                        overall = "error"
                    else:
                        checks["watchdog"] = {"status": "ok", "age_s": age_s}
            except Exception as e:
                checks["watchdog"] = {"status": "warning", "detail": str(e)}

        http_status = 200 if overall != "error" else 503
        return Response({"status": overall, "checks": checks}, status=http_status)
