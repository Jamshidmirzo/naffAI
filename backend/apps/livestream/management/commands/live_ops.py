"""
Live upkeep loop (`live-ops` service).

Each tick (default every 30s):
  * reconcile LIVE sessions with LiveKit's participant list — ghosts are
    closed, publishers whose webhooks were lost appear;
  * recording (LIVEKIT_RECORDING_ENABLED): settle egresses LiveKit no
    longer runs, stop chunks older than LIVEKIT_RECORDING_ROTATE_MINUTES,
    start an egress for every live camera track that has none;
  * hourly: mark recordings past retention deleted, prune webhook events.

Does nothing (but heartbeat) when LIVEKIT_API_URL is empty.
`--once` runs one tick and prints the counters.
"""

from __future__ import annotations

import logging
import time

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import connections

logger = logging.getLogger("livestream.live_ops")

# Alert the owner if LiveKit stays unreachable this long.
DOWN_ALERT_AFTER_S = 5 * 60


def live_ops_tick(*, housekeeping: bool = False) -> dict:
    from apps.common.health import record_heartbeat
    from apps.livestream import services
    from apps.livestream.livekit_api import get_livekit_client

    stats: dict = {"configured": False}
    client = get_livekit_client()
    if client is not None:
        stats["configured"] = True
        participants = client.list_participants(services.room_name())
        stats["participants"] = len(participants)
        stats["reconcile"] = services.sessions_reconcile(participants=participants)
        if services.recording_enabled():
            stats["synced"] = services.recordings_sync_active()
            stats["rotated"] = services.recordings_rotate(
                max_age_minutes=settings.LIVEKIT_RECORDING_ROTATE_MINUTES
            )
            stats["started"] = services.recordings_ensure()
    if housekeeping:
        stats["expired"] = services.recordings_expire(
            retention_days=settings.LIVEKIT_RECORDING_RETENTION_DAYS
        )
        stats["pruned"] = services.webhook_events_prune(
            older_than_days=settings.LIVEKIT_WEBHOOK_EVENT_RETENTION_DAYS
        )
    record_heartbeat("live_ops")
    return stats


class Command(BaseCommand):
    help = "Reconcile live sessions with LiveKit and run hourly recording chunks."

    def add_arguments(self, parser) -> None:
        parser.add_argument("--once", action="store_true", help="Run one tick and exit.")
        parser.add_argument("--interval", type=float, default=30.0)

    def handle(self, *args, **opts) -> None:
        if opts["once"]:
            self.stdout.write(str(live_ops_tick(housekeeping=True)))
            return

        from apps.common.alerts import alert_owner

        self.stdout.write("live-ops worker started")
        last_housekeeping = 0.0
        failing_since: float | None = None
        while True:
            housekeeping = time.monotonic() - last_housekeeping > 3600
            try:
                stats = live_ops_tick(housekeeping=housekeeping)
                if housekeeping:
                    last_housekeeping = time.monotonic()
                if any(stats.get(k) for k in ("synced", "rotated", "started", "expired", "pruned")) or any(
                    (stats.get("reconcile") or {}).values()
                ):
                    logger.info("live ops %s", stats)
                failing_since = None
            except Exception:
                logger.exception("live-ops tick failed")
                # Fresh DB connection next tick (e.g. started before migrate).
                connections.close_all()
                now = time.monotonic()
                if failing_since is None:
                    failing_since = now
                elif now - failing_since > DOWN_ALERT_AFTER_S:
                    try:
                        alert_owner("live_ops_failing", "live-ops: LiveKit/БД недоступны больше 5 минут")
                    except Exception:
                        logger.warning("alert_owner failed", exc_info=True)
                    failing_since = now
            time.sleep(opts["interval"])
