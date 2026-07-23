"""
Selectors for tg_bot models (HackSoft pattern).
"""

from __future__ import annotations

from django.db.models import QuerySet

from .models import BotSubscription


def subscriptions_ready_for_dm() -> QuerySet[BotSubscription]:
    """Return subscriptions active and not blocked by user."""
    return BotSubscription.objects.filter(is_active=True, blocked_at__isnull=True)
