"""
`exclude_system_lost` не должен подкидывать наши автозакрытые лиды в
lost-статистику (иначе 556 разовых миграций 2026-09-02 съезжают воронку
и дневной график lost'ов).

Проверяем на реальных селекторах, а не мокаем — иначе рефакторинг
`lead_stats_snapshot` может тихо потерять фильтр.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.analytics.selectors import funnel_by_source, lead_stats_snapshot
from apps.leads.models import Lead, LeadStatus
from apps.leads.services import (
    LOST_REASON_INVALID_PHONE_FROM_SHEET,
    LOST_REASON_STRANDED_ON_INACTIVE,
    lead_mark_system_lost,
)
from apps.operators.models import Operator, OperatorStatus


def _mk_lead(*, idx: int, status: str = LeadStatus.LOST) -> Lead:
    return Lead.objects.create(
        full_name=f"L-{idx}",
        phone=f"+99890{idx:07d}",
        status=status,
    )


@pytest.mark.django_db
def test_lead_stats_snapshot_by_status_excludes_system_lost():
    real_lost = _mk_lead(idx=1, status=LeadStatus.LOST)
    stranded_lead = _mk_lead(idx=2, status=LeadStatus.IN_PROGRESS)
    lead_mark_system_lost(
        lead=stranded_lead,
        reason=LOST_REASON_STRANDED_ON_INACTIVE,
    )

    # Оба созданы «сегодня» — попадают в окно.
    now = timezone.now()
    snapshot = lead_stats_snapshot(
        date_from=now - dt.timedelta(days=1),
        date_to=now + dt.timedelta(days=1),
    )
    by_status = {r["code"]: r["count"] for r in snapshot["by_status"]}
    # Реальный lost есть, system-lost — нет.
    assert by_status.get("lost", 0) == 1
    assert snapshot["total"] == 2  # общий счётчик created не задет


@pytest.mark.django_db
def test_lead_stats_snapshot_daily_lost_excludes_system_lost():
    _mk_lead(idx=10, status=LeadStatus.LOST)  # реальный

    stranded = _mk_lead(idx=11, status=LeadStatus.IN_PROGRESS)
    lead_mark_system_lost(
        lead=stranded, reason=LOST_REASON_STRANDED_ON_INACTIVE
    )

    now = timezone.now()
    snapshot = lead_stats_snapshot(
        date_from=now - dt.timedelta(days=1),
        date_to=now + dt.timedelta(days=1),
    )
    total_lost = sum(day["lost"] for day in snapshot["daily"])
    assert total_lost == 1  # только реальный, не system-lost


@pytest.mark.django_db
def test_funnel_by_source_excludes_system_lost():
    _mk_lead(idx=20, status=LeadStatus.LOST)
    stranded = _mk_lead(idx=21, status=LeadStatus.IN_PROGRESS)
    lead_mark_system_lost(
        lead=stranded, reason=LOST_REASON_INVALID_PHONE_FROM_SHEET
    )

    now = timezone.now()
    funnel = funnel_by_source(
        date_from=now - dt.timedelta(days=1),
        date_to=now + dt.timedelta(days=1),
    )
    # Оба лида — источник Manual (source='sheet' по default, но без
    # sheet_source_id это «Другое»). Найдём общий бакет и убедимся, что
    # `lost` считает только реальный.
    total_lost = sum(row.get("lost", 0) for row in funnel)
    assert total_lost == 1
