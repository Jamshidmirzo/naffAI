"""
Watchdog: scan heartbeats, alert owner on stale/missing services.

Design:
- Reads `apps.common.health.health_snapshot()`.
- For every service NOT ``status == "ok"``, pushes an alert via
  `apps.common.alerts.alert_owner` with a stable per-service code
  (`hb_<service>`). The alert layer handles rate-limit (10 min
  window per code), so starting / stopping a dead container only
  fires one alert per 10 min even if the watchdog ticks 60 times.
- Writes its own `hb:watchdog` heartbeat at the end so the
  `/healthz` endpoint can 503 if the watchdog itself dies.

Loop management: this command runs ONE snapshot per invocation and
exits. The outer loop is a plain `while :; do python manage.py
watchdog; sleep 60; done` in docker-compose — matches the pattern
every other watcher in the stack uses (see sheet-sync, hot-sheet-sync).
Keeping the command one-shot means it's easy to invoke manually
(e.g. for the deploy-time smoke test) and the process restart on
exception is handled by docker's restart policy.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand

from apps.common.alerts import alert_owner
from apps.common.health import health_snapshot, record_heartbeat


class Command(BaseCommand):
    help = (
        "Scan heartbeats, alert owner on stale/missing services. "
        "Runs one iteration and exits — wrap in a shell loop."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Only print the snapshot — don't push alerts.",
        )

    def handle(self, *args, **opts):
        dry = bool(opts.get("dry_run"))
        snapshot = health_snapshot()

        ok_n = sum(1 for s in snapshot if s["status"] == "ok")
        stale_n = sum(1 for s in snapshot if s["status"] == "stale")
        missing_n = sum(1 for s in snapshot if s["status"] == "missing")

        self.stdout.write(
            f"[watchdog] ok={ok_n} stale={stale_n} missing={missing_n} "
            f"(total={len(snapshot)})"
        )

        for s in snapshot:
            if s["status"] == "ok":
                continue
            service = s["service"]
            # Watchdog alerting about watchdog is pointless — /healthz
            # catches that case (503 → external uptime monitor).
            if service == "watchdog":
                continue
            if s["status"] == "missing":
                severity = "critical"
                message = (
                    f"{service} never ticked (no hb:{service} key). "
                    f"Expected tick ≤ {s['max_age_s']}s."
                )
            else:
                # stale
                severity = (
                    "critical" if s["age_s"] > 3 * s["max_age_s"] else "warn"
                )
                age_min = round(s["age_s"] / 60, 1)
                max_min = round(s["max_age_s"] / 60, 1)
                message = (
                    f"{service} stale: last heartbeat {age_min} min ago "
                    f"(limit {max_min} min)."
                )

            self.stdout.write(
                f"[watchdog] alert code=hb_{service} severity={severity} — {message}"
            )
            if not dry:
                alert_owner(code=f"hb_{service}", message=message, severity=severity)

        # Record our own heartbeat LAST, so a mid-snapshot exception
        # leaves hb:watchdog stale and surfaces to /healthz.
        record_heartbeat("watchdog")
