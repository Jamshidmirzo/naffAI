"""
Watchdog command — fresh / stale / missing scenarios.

We mock out the Redis client via patch.object(health._redis_client) so
no live Redis is required.
"""

from __future__ import annotations

from datetime import timedelta
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.utils import timezone

from apps.common import alerts, health


class _FakeRedis:
    def __init__(self):
        self.store: dict[str, str] = {}
        self.zset: dict[str, dict[str, float]] = {}

    def get(self, key):
        v = self.store.get(key)
        return v.encode("utf-8") if v is not None else None

    def set(self, key, value, ex=None, nx=False):
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    def zadd(self, name, mapping):
        self.zset.setdefault(name, {}).update(mapping)
        return len(mapping)

    def zremrangebyrank(self, *a, **kw):
        return 0


def test_watchdog_dry_run_prints_summary_and_lists_missing_services():
    """Fresh env (no heartbeats) → every service is "missing"."""
    fake = _FakeRedis()
    with patch.object(health, "_redis_client", return_value=fake), \
            patch.object(alerts, "_redis_client", return_value=fake):
        out = StringIO()
        call_command("watchdog", "--dry-run", stdout=out)

    text = out.getvalue()
    assert "ok=" in text
    assert "missing=" in text
    # Several registered services get called out by code.
    assert "hb_sheet_sync" in text
    assert "hb_tg_bot" in text


def test_watchdog_does_not_alert_about_itself():
    """
    `watchdog` service is in EXPECTED_INTERVALS but the command must
    never alert about itself — self-alerting is pointless (nobody would
    receive it) and /healthz handles the dead-watchdog case.
    """
    fake = _FakeRedis()
    with patch.object(health, "_redis_client", return_value=fake), \
            patch.object(alerts, "_redis_client", return_value=fake):
        out = StringIO()
        call_command("watchdog", "--dry-run", stdout=out)

    assert "hb_watchdog" not in out.getvalue()


def test_watchdog_fresh_hb_counts_as_ok(settings):
    """Any service with a recent heartbeat should NOT trigger an alert."""
    fake = _FakeRedis()
    # Pre-populate `sheet_sync` with a fresh heartbeat.
    now = timezone.now()
    fake.store["hb:sheet_sync"] = (now - timedelta(seconds=5)).astimezone().isoformat()
    # Need a token so alert_owner doesn't early-exit.
    settings.TELEGRAM_BOT_TOKEN = "test:token"

    with patch.object(health, "_redis_client", return_value=fake), \
            patch.object(alerts, "_redis_client", return_value=fake), \
            patch.object(alerts.httpx, "post") as mock_post:
        out = StringIO()
        call_command("watchdog", stdout=out)

    # sheet_sync must NOT appear in alerts (it's fresh).
    sent_bodies = [c.kwargs.get("json", {}).get("text", "") for c in mock_post.call_args_list]
    sent_text = "\n".join(sent_bodies)
    assert "hb_sheet_sync" not in sent_text


def test_watchdog_stale_hb_fires_alert(settings):
    """Service with heartbeat older than max_age → alert sent."""
    fake = _FakeRedis()
    now = timezone.now()
    # hot_leads_watch max_age = 180s. 10 min stale → should alert.
    fake.store["hb:hot_leads_watch"] = (
        (now - timedelta(minutes=10)).astimezone().isoformat()
    )
    settings.TELEGRAM_BOT_TOKEN = "test:token"

    with patch.object(health, "_redis_client", return_value=fake), \
            patch.object(alerts, "_redis_client", return_value=fake), \
            patch.object(alerts.httpx, "post") as mock_post:
        out = StringIO()
        call_command("watchdog", stdout=out)

    sent_bodies = [c.kwargs.get("json", {}).get("text", "") for c in mock_post.call_args_list]
    sent_text = "\n".join(sent_bodies)
    assert "hb_hot_leads_watch" in sent_text


def test_watchdog_records_own_heartbeat():
    """watchdog ticks `hb:watchdog` on every successful run."""
    fake = _FakeRedis()
    with patch.object(health, "_redis_client", return_value=fake), \
            patch.object(alerts, "_redis_client", return_value=fake):
        out = StringIO()
        call_command("watchdog", "--dry-run", stdout=out)

    assert "hb:watchdog" in fake.store
