"""
Selectors for tg_bot models (HackSoft pattern).
"""

from __future__ import annotations

from django.db.models import QuerySet

from .models import BotSubscription


def subscriptions_ready_for_dm() -> QuerySet[BotSubscription]:
    """Return subscriptions active and not blocked by user."""
    return BotSubscription.objects.filter(is_active=True, blocked_at__isnull=True)


def bot_broadcast_recipients() -> QuerySet[BotSubscription]:
    """
    Return subscriptions cleared to receive manager broadcasts
    (3-hour leaderboard, daily digest, etc.).

    Filter is 3-legged so a manager can pause a chat WITHOUT losing the
    linked_operator/phone metadata:
      1) `is_active=True`   — /subscribe not undone by /unsubscribe;
      2) `blocked_at__isnull=True` — user didn't block the bot itself;
      3) `receives_broadcasts=True` — manager toggle in the UI.

    Both blanket-subscribers (a manager subscribes via /subscribe → we
    then flip broadcasts on for them in the UI) and phone-linked
    subscribers (operator sent contact via /start → manager may opt them
    IN or leave off) pass through the same gate.
    """
    return BotSubscription.objects.filter(
        is_active=True,
        blocked_at__isnull=True,
        receives_broadcasts=True,
    )


def bot_subscribers_all() -> QuerySet[BotSubscription]:
    """
    All bot subscribers regardless of is_active / broadcast state — used
    by the manager UI which needs to show inactive/blocked rows so the
    manager can re-invite them or verify why messages aren't going out.
    """
    return BotSubscription.objects.select_related(
        "linked_operator", "linked_profile__user"
    ).all()
