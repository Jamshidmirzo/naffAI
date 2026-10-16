"""
Auto pool order and switched-off sources (2026-10-16).

The refill took the pool oldest-first and ignored `SheetSource.active`, so
month-old leads of a switched-off sheet (put back nightly by
release_stale_leads) went out ahead of today's leads.

  * fresh leads (created in the last LEADS_POOL_FRESH_DAYS days) go first,
    older ones only after them;
  * leads of a switched-off source are not handed out automatically, but
    stay visible when the manager picks that source explicitly.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.leads.models import DistributionMode, Lead, LeadStatus, SheetSource
from apps.leads.selectors import _orphan_pool_size, orphan_leads
from apps.leads.services import morning_distribute_leads, refill_operator_leads
from apps.operators.models import Operator, OperatorStatus


def _sheet(name: str, gid: int, *, active: bool = True) -> SheetSource:
    return SheetSource.objects.create(
        name=name,
        spreadsheet_id=f"SS_{gid}",
        gid=gid,
        column_map={"phone": "phone", "full_name": "name"},
        distribution_mode=DistributionMode.ALIAS_OR_ROUND_ROBIN,
        active=active,
    )


_seq = iter(range(1, 10_000))


def _orphan(name: str, *, days_ago: float, sheet: SheetSource | None = None) -> Lead:
    n = next(_seq)
    lead = Lead.objects.create(
        full_name=name,
        phone=f"+99891{n:07d}",
        status=LeadStatus.NEW,
        sheet_source=sheet,
        sheet_row_index=n if sheet else None,
    )
    Lead.objects.filter(pk=lead.pk).update(created_at=timezone.now() - dt.timedelta(days=days_ago))
    return lead


@pytest.mark.django_db
def test_refill_hands_out_fresh_leads_before_old_ones():
    op = Operator.objects.create(full_name="Op", status=OperatorStatus.ACTIVE)
    sheet = _sheet("Main", 1)
    old = [_orphan(f"old-{i}", days_ago=20 + i, sheet=sheet) for i in range(3)]
    fresh = [_orphan(f"fresh-{i}", days_ago=0.1 * (i + 1), sheet=sheet) for i in range(2)]

    got = refill_operator_leads(operator=op, size=3)

    # Both fresh leads (older of them first), then the oldest of the old ones.
    assert [le.id for le in got] == [fresh[1].id, fresh[0].id, old[2].id]


@pytest.mark.django_db
def test_refill_skips_switched_off_source():
    op = Operator.objects.create(full_name="Op", status=OperatorStatus.ACTIVE)
    off = _sheet("srm", 2, active=False)
    on = _sheet("Main", 3)
    _orphan("srm-1", days_ago=1, sheet=off)
    _orphan("srm-2", days_ago=1, sheet=off)
    kept = _orphan("main", days_ago=30, sheet=on)
    manual = _orphan("manual", days_ago=40)

    got = refill_operator_leads(operator=op, size=5)

    assert {le.id for le in got} == {kept.id, manual.id}
    assert Lead.objects.filter(sheet_source=off, operator__isnull=True).count() == 2


@pytest.mark.django_db
def test_morning_split_fresh_first_and_skips_switched_off_source():
    ops = [Operator.objects.create(full_name=f"Op-{i}", status=OperatorStatus.ACTIVE) for i in range(2)]
    off = _sheet("srm", 4, active=False)
    on = _sheet("Main", 5)
    _orphan("srm", days_ago=0.5, sheet=off)
    old = _orphan("old", days_ago=15, sheet=on)
    fresh = [_orphan(f"fresh-{i}", days_ago=1, sheet=on) for i in range(2)]

    counts = morning_distribute_leads(seed=1, limit=2)

    assert sum(counts.values()) == 2
    assigned = set(Lead.objects.filter(operator__in=ops).values_list("id", flat=True))
    assert assigned == {fresh[0].id, fresh[1].id}
    assert Lead.objects.get(pk=old.pk).operator_id is None


@pytest.mark.django_db
def test_pool_counts_ignore_switched_off_source_unless_picked():
    off = _sheet("srm", 6, active=False)
    on = _sheet("Main", 7)
    _orphan("srm", days_ago=10, sheet=off)
    _orphan("main", days_ago=10, sheet=on)

    assert orphan_leads().count() == 1
    assert _orphan_pool_size() == 1
    assert orphan_leads(sheet_source_id=off.id).count() == 1
