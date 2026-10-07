"""
Heartbeat helpers + snapshot. Redis is mocked; Django settings don't need
a real REDIS_URL for the tests to exercise the status logic.
"""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

from django.utils import timezone

from apps.common import health


class _FakeRedis:
    """Tiny GET/SET stub matching the subset of redis-py the module uses."""

    def __init__(self):
        self.store: dict[str, str] = {}

    def set(self, key, value, ex=None):
        self.store[key] = value
        return True

    def get(self, key):
        v = self.store.get(key)
        return v.encode("utf-8") if v is not None else None


def _patch_redis(fake):
    return patch.object(health, "_redis_client", return_value=fake)


def test_record_and_read_heartbeat_roundtrip():
    fake = _FakeRedis()
    with _patch_redis(fake):
        health.record_heartbeat("svc_x")
        got = health.read_heartbeat("svc_x")

    assert got is not None
    # Written as ISO-UTC, parsed back aware.
    assert got.tzinfo is not None


def test_record_heartbeat_swallows_redis_errors():
    """Fire-and-forget contract: Redis blip must not raise."""

    class _Boom:
        def set(self, *_a, **_kw):
            raise RuntimeError("boom")

    with _patch_redis(_Boom()):
        # No exception = contract honoured.
        health.record_heartbeat("some_service")


def test_health_snapshot_missing_vs_stale_vs_ok():
    """
    Three cases: never ticked (missing), ticked recently (ok), ticked
    too long ago (stale). All three must coexist in a single snapshot.
    """
    fake = _FakeRedis()
    now = timezone.now()

    # ok — ticked 10s ago, max_age for sheet_sync is 10 min.
    fresh = (now - timedelta(seconds=10)).astimezone().isoformat()
    fake.store["hb:sheet_sync"] = fresh

    # stale — ticked 2 hours ago, max_age for hot_leads_watch is 3 min.
    stale = (now - timedelta(hours=2)).astimezone().isoformat()
    fake.store["hb:hot_leads_watch"] = stale

    # watchdog, scheduler, ... — missing entirely.

    with _patch_redis(fake):
        snap = health.health_snapshot()

    by_svc = {s["service"]: s for s in snap}
    assert by_svc["sheet_sync"]["status"] == "ok"
    assert by_svc["hot_leads_watch"]["status"] == "stale"
    assert by_svc["watchdog"]["status"] == "missing"


def test_health_snapshot_contains_all_registered_services():
    """
    Snapshot MUST include every entry from EXPECTED_INTERVALS, even
    those with no heartbeat (status=missing) — otherwise the UI
    silently drops services and we can't tell "never ticked" from
    "not monitored".
    """
    fake = _FakeRedis()
    with _patch_redis(fake):
        snap = health.health_snapshot()
    seen = {s["service"] for s in snap}
    assert seen == set(health.EXPECTED_INTERVALS.keys())
