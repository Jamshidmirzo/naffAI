"""
Read-side helpers for the mobile app.

Delegates to domain selectors (`apps.leads.selectors`, `apps.calls.selectors`)
whenever possible — this module only reshapes their output into the compact
payload the Flutter client expects.
"""

from __future__ import annotations

from typing import Any

from django.db.models import QuerySet

from apps.calls.selectors import call_attempts_metrics_for_operator
from apps.leads.models import Lead
from apps.leads.selectors import leads_for_operator
from apps.operators.models import Operator


def sip_credentials_for_operator(operator: Operator | None) -> dict | None:
    """
    Returns None if SIP is not provisioned yet (default state — mobile app
    then hides the softphone UI). Host/port pulled from Django settings so
    the same operator record can be used across environments.
    """
    if operator is None or not operator.sip_username or not operator.sip_password:
        return None
    from django.conf import settings

    return {
        "username": operator.sip_username,
        "password": operator.sip_password,
        "host": getattr(settings, "SIP_HOST", "") or "",
        "port": int(getattr(settings, "SIP_PORT", 0) or 0),
    }


def mobile_me_payload(user) -> dict[str, Any]:
    """Compose GET /api/mobile/me/ response."""
    profile = getattr(user, "profile", None)
    operator = profile.operator if profile and profile.operator_id else None

    metrics: dict[str, Any]
    if operator is not None:
        metrics = call_attempts_metrics_for_operator(operator, days=1)
    else:
        metrics = {"period_days": 1, "total": 0, "avg_duration_seconds": None, "by_outcome": {}}

    return {
        "user_id": user.id,
        "username": user.username,
        "role": profile.role if profile else "team_lead",
        "operator": operator,  # serializer handles None / Operator
        "preferred_language": (
            getattr(profile, "preferred_language", None) or "uz"
        ),
        "metrics_today": metrics,
        "sip_credentials": sip_credentials_for_operator(operator),
    }


def mobile_leads_for_operator_page(
    *,
    operator: Operator,
    cursor: int | None,
    limit: int,
    view: str = "active",
) -> tuple[list[Lead], int | None]:
    """
    Simple id-desc cursor pagination.

    We piggyback on `leads_for_operator(view=view)` (which already applies
    the "active/postponed/closed" filter used in the web CRM) and just cap
    it by `id < cursor`. This is intentionally not perfect ordering-wise
    (the server-side sort is `-updated_at` for active views) but it's stable
    on ids and enough for the mobile "load more" UX. If we later need
    time-based paging we can switch to updated_at composite cursors.

    Returns (leads, next_cursor). `next_cursor` is None when the page
    is the last one.
    """
    limit = max(1, min(limit, 200))
    qs: QuerySet[Lead] = leads_for_operator(operator, view=view)
    if cursor is not None:
        qs = qs.filter(id__lt=cursor)
    # Force id-desc so cursor semantics hold regardless of the underlying
    # order applied by `leads_for_operator`.
    rows = list(qs.order_by("-id")[: limit + 1])
    next_cursor: int | None = None
    if len(rows) > limit:
        next_cursor = rows[limit - 1].id
        rows = rows[:limit]
    return rows, next_cursor
