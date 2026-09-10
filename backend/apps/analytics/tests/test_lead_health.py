"""
Тесты `lead_health_snapshot()` — виджет «Здоровье воронки» на Dashboard.

Проверяем что селектор возвращает адекватные счётчики
(мы не пытаемся ловить бизнес-логику — она вся в отдельных селекторах;
этот только агрегирует).
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.analytics.selectors import lead_health_snapshot
from apps.leads.models import Lead, LeadStatus, SheetSource
from apps.operators.models import Operator, OperatorStatus


@pytest.mark.django_db
def test_lead_health_snapshot_empty_db_returns_zero_counters():
    snap = lead_health_snapshot()
    assert set(snap.keys()) == {"generated_at", "sheet_sources", "leaks", "bottlenecks"}
    assert snap["leaks"]["system_lost_24h"] == 0
    assert snap["leaks"]["stale_no_answer_48h"] == 0
    assert snap["leaks"]["high_lost_operators"] == []
    assert snap["leaks"]["sync_errors"] == []
    assert snap["bottlenecks"] == []


@pytest.mark.django_db
def test_lead_health_snapshot_counts_system_lost_24h():
    now = timezone.now()
    # system-lost за последние 24ч.
    l1 = Lead.objects.create(
        full_name="A", phone="+1", status=LeadStatus.LOST,
        metadata={"lost_by": "system:operator_deactivate"},
    )
    Lead.objects.filter(pk=l1.pk).update(updated_at=now - dt.timedelta(hours=3))
    # older than 24h — не считается в 24h но попадёт в 7d avg.
    l2 = Lead.objects.create(
        full_name="B", phone="+2", status=LeadStatus.LOST,
        metadata={"lost_by": "system:operator_deactivate"},
    )
    Lead.objects.filter(pk=l2.pk).update(updated_at=now - dt.timedelta(days=3))
    # manual lost — не считается ни там ни там.
    Lead.objects.create(
        full_name="C", phone="+3", status=LeadStatus.LOST,
        metadata={"lost_by": "manual"},
    )

    snap = lead_health_snapshot()
    assert snap["leaks"]["system_lost_24h"] == 1
    # 7d avg — 2 события / 7 дней = 0.3.
    assert snap["leaks"]["system_lost_7d_avg"] == pytest.approx(0.3, abs=0.05)


@pytest.mark.django_db
def test_lead_health_snapshot_flags_stale_no_answer():
    now = timezone.now()
    stale = Lead.objects.create(full_name="S", phone="+11", status=LeadStatus.NO_ANSWER)
    Lead.objects.filter(pk=stale.pk).update(updated_at=now - dt.timedelta(hours=72))
    fresh = Lead.objects.create(full_name="F", phone="+12", status=LeadStatus.NO_ANSWER)
    Lead.objects.filter(pk=fresh.pk).update(updated_at=now - dt.timedelta(hours=12))

    snap = lead_health_snapshot()
    assert snap["leaks"]["stale_no_answer_48h"] == 1


@pytest.mark.django_db
def test_lead_health_snapshot_high_lost_operator_appears():
    op = Operator.objects.create(full_name="Umida", status=OperatorStatus.ACTIVE)
    now = timezone.now()
    # 4 lost + 1 won за 24h → 80% lost.
    for i in range(4):
        lead = Lead.objects.create(
            full_name=f"L{i}", phone=f"+2{i}", status=LeadStatus.LOST, operator=op,
        )
        Lead.objects.filter(pk=lead.pk).update(updated_at=now - dt.timedelta(hours=2))
    won = Lead.objects.create(
        full_name="W", phone="+29", status=LeadStatus.WON, operator=op,
    )
    Lead.objects.filter(pk=won.pk).update(updated_at=now - dt.timedelta(hours=2))

    snap = lead_health_snapshot()
    names = [x["name"] for x in snap["leaks"]["high_lost_operators"]]
    assert "Umida" in names
    row = next(x for x in snap["leaks"]["high_lost_operators"] if x["name"] == "Umida")
    assert row["closed"] == 5
    assert row["lost"] == 4
    assert row["lost_pct"] == pytest.approx(80.0, abs=0.5)


@pytest.mark.django_db
def test_lead_health_snapshot_sync_errors_from_sheet_sources():
    ok = SheetSource.objects.create(
        name="ok", spreadsheet_id="a", gid=0, worksheet_name="A", active=True,
    )
    bad = SheetSource.objects.create(
        name="broken",
        spreadsheet_id="b",
        gid=1,
        worksheet_name="B",
        active=True,
        last_sync_error="Auth failed",
    )

    snap = lead_health_snapshot()
    err_names = [e["source_name"] for e in snap["leaks"]["sync_errors"]]
    assert "broken" in err_names
    assert "ok" not in err_names
    # sheet_sources содержит оба.
    assert {s["name"] for s in snap["sheet_sources"]} == {"ok", "broken"}


@pytest.mark.django_db
def test_lead_health_snapshot_bottlenecks_return_top_slow_statuses():
    now = timezone.now()
    # 5 лидов в phone_on с возрастом 3 дня.
    for i in range(5):
        lead = Lead.objects.create(
            full_name=f"P{i}", phone=f"+80{i:03d}", status=LeadStatus.PHONE_ON,
        )
        Lead.objects.filter(pk=lead.pk).update(updated_at=now - dt.timedelta(days=3))
    # 2 лида в in_progress с возрастом 1 день.
    for i in range(2):
        lead = Lead.objects.create(
            full_name=f"I{i}", phone=f"+90{i:03d}", status=LeadStatus.IN_PROGRESS,
        )
        Lead.objects.filter(pk=lead.pk).update(updated_at=now - dt.timedelta(days=1))

    snap = lead_health_snapshot()
    statuses = [b["status"] for b in snap["bottlenecks"]]
    assert LeadStatus.PHONE_ON in statuses
    # phone_on идёт первым по возрасту.
    assert snap["bottlenecks"][0]["status"] == LeadStatus.PHONE_ON
    assert snap["bottlenecks"][0]["count"] == 5
