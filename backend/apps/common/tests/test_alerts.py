"""
alert_owner — rate-limit & resilience.

We mock out both the Redis client and `httpx.post`:
- Rate-limit = Redis SETNX; test that the second same-code call within
  the window is suppressed, while a different code goes through.
- Redis down => never block the send (resilience rule in docstring).
- httpx failure => swallowed, no raise.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from apps.common import alerts


@pytest.fixture(autouse=True)
def _force_tg_token(settings):
    """Non-empty token so the httpx branch is exercised in every test.
    httpx.post itself is mocked per-test — the real endpoint is never hit.
    """
    settings.TELEGRAM_BOT_TOKEN = "test:bot-token"


class _FakeRedis:
    """Minimal in-memory redis-stub for `set(..., nx=True, ex=...)` + zadd."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.zset: dict[str, dict[str, float]] = {}
        self.set_calls: list[tuple] = []

    def set(self, key, value, ex=None, nx=False):  # noqa: D401 - mirrors redis API
        self.set_calls.append((key, value, ex, nx))
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    def zadd(self, name, mapping):
        self.zset.setdefault(name, {}).update(mapping)
        return len(mapping)

    def zremrangebyrank(self, name, start, stop):
        return 0

    def zrevrange(self, name, start, stop, withscores=False):
        items = sorted(self.zset.get(name, {}).items(), key=lambda kv: kv[1], reverse=True)
        hi = stop + 1 if stop >= 0 else None
        return [(k, s) for k, s in items[start:hi]]


def _patch_redis(fake):
    return patch.object(alerts, "_redis_client", return_value=fake)


def _patch_tg_ok():
    """Return a context manager that no-ops Telegram HTTP."""
    return patch.object(alerts.httpx, "post", return_value=MagicMock())


def test_alert_owner_sends_once_per_code_in_rate_limit_window():
    fake = _FakeRedis()
    with _patch_redis(fake), _patch_tg_ok() as mock_post:
        for _ in range(10):
            alerts.alert_owner("test_code_a", "spam", "warn")

    assert mock_post.call_count == 1
    # SETNX stored the key with TTL=600 (10 min window from the plan).
    nx_calls = [c for c in fake.set_calls if c[0] == "alert:test_code_a" and c[3] is True]
    assert nx_calls, "expected a SETNX call on the rate-limit key"
    _, _, ex, _ = nx_calls[0]
    assert ex == alerts._RATE_LIMIT_SECONDS == 600


def test_alert_owner_distinct_codes_both_fire():
    fake = _FakeRedis()
    with _patch_redis(fake), _patch_tg_ok() as mock_post:
        alerts.alert_owner("code_x", "msg1", "warn")
        alerts.alert_owner("code_y", "msg2", "critical")

    assert mock_post.call_count == 2


def test_alert_owner_redis_down_still_sends():
    """Rate-limit check falls through on Redis error — alert must go out."""
    with patch.object(alerts, "_redis_client", return_value=None), _patch_tg_ok() as mock_post:
        alerts.alert_owner("code_without_redis", "spam", "critical")
        alerts.alert_owner("code_without_redis", "spam again", "critical")
    # Both pass through without rate-limit (no Redis to track dedup).
    assert mock_post.call_count == 2


def test_alert_owner_tg_failure_swallowed():
    fake = _FakeRedis()
    with _patch_redis(fake), patch.object(
        alerts.httpx, "post", side_effect=RuntimeError("TG down")
    ):
        # Must not raise, even though httpx.post is a hard-fail.
        alerts.alert_owner("boom", "msg", "warn")


def test_alert_owner_appends_to_log_ring():
    fake = _FakeRedis()
    with _patch_redis(fake), _patch_tg_ok():
        alerts.alert_owner("c1", "first", "warn")
        alerts.alert_owner("c2", "second", "critical")

    log = fake.zset.get("alerts:log", {})
    assert len(log) == 2


def test_recent_alerts_newest_first():
    fake = _FakeRedis()
    with _patch_redis(fake), _patch_tg_ok():
        alerts.alert_owner("c1", "first", "warn")
        alerts.alert_owner("c2", "second", "critical")

    with _patch_redis(fake):
        got = alerts.recent_alerts(limit=10)

    assert len(got) == 2
    # c2 was pushed later, score higher → first.
    assert got[0]["code"] == "c2"
    assert got[0]["severity"] == "critical"
    assert got[1]["code"] == "c1"


def test_alert_owner_never_raises_on_internal_error():
    """Last-resort guard — a bug inside alerts.py must not break callers."""
    with patch.object(alerts, "_redis_client", side_effect=RuntimeError("boom")):
        # Must still return normally, no exception bubbling up.
        alerts.alert_owner("buggy", "something", "critical")
