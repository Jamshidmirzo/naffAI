"""
Тесты assignment_summary() и operator_assignments_for_day() — селекторы
для ops-агента бота («кто сколько получил лидов за день»).

Матрица:
  * Двое операторов + разные source → правильные total и by_source.
  * Активный оператор без назначений → total=0, но в списке.
  * Сортировка по total DESC.
  * operator_assignments_for_day — хронология для одного оператора.
  * Дата «вчера» — фильтр работает по границам локального часового пояса.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.leads.models import Lead, LeadAssignment, LeadAssignmentSource, LeadStatus
from apps.leads.selectors import (
    assignment_summary,
    operator_assignments_for_day,
)
from apps.operators.models import Operator, OperatorStatus


def _mk_op(name: str, *, active: bool = True) -> Operator:
    return Operator.objects.create(
        full_name=name,
        status=OperatorStatus.ACTIVE if active else OperatorStatus.INACTIVE,
    )


def _mk_lead(op: Operator | None, phone: str) -> Lead:
    return Lead.objects.create(
        full_name=f"Client-{phone}",
        phone=phone,
        status=LeadStatus.NEW,
        operator=op,
    )


def _mk_assignment(
    lead: Lead, op: Operator, source: str, when: dt.datetime | None = None
) -> LeadAssignment:
    row = LeadAssignment.objects.create(lead=lead, operator=op, source=source)
    if when is not None:
        # created_at auto_now_add — обходим через update()
        LeadAssignment.objects.filter(pk=row.pk).update(created_at=when)
        row.refresh_from_db()
    return row


@pytest.mark.django_db
class TestAssignmentSummary:
    def test_two_operators_mixed_sources(self):
        op_a = _mk_op("Muxlisa")
        op_b = _mk_op("Sevinch")
        lead1 = _mk_lead(op_a, "998900000001")
        lead2 = _mk_lead(op_a, "998900000002")
        lead3 = _mk_lead(op_b, "998900000003")
        _mk_assignment(lead1, op_a, LeadAssignmentSource.MORNING_SPLIT)
        _mk_assignment(lead2, op_a, LeadAssignmentSource.AUTO_REFILL)
        _mk_assignment(lead3, op_b, LeadAssignmentSource.MORNING_SPLIT)

        rows = assignment_summary()
        by_name = {r["full_name"]: r for r in rows}
        assert by_name["Muxlisa"]["total"] == 2
        assert by_name["Sevinch"]["total"] == 1
        assert by_name["Muxlisa"]["by_source"] == {
            "morning_split": 1,
            "auto_refill": 1,
        }

    def test_sorted_by_total_desc(self):
        op_a = _mk_op("SmallGuy")
        op_b = _mk_op("BigGuy")
        for i in range(5):
            _mk_assignment(
                _mk_lead(op_b, f"9989000000{10 + i}"),
                op_b,
                LeadAssignmentSource.MORNING_SPLIT,
            )
        _mk_assignment(
            _mk_lead(op_a, "998900000099"),
            op_a,
            LeadAssignmentSource.AUTO_REFILL,
        )
        rows = assignment_summary()
        # BigGuy должен идти первым.
        names_with_hits = [r["full_name"] for r in rows if r["total"] > 0]
        assert names_with_hits[0] == "BigGuy"
        assert "SmallGuy" in names_with_hits

    def test_active_op_with_no_assignments_still_present(self):
        _mk_op("Idle")  # активный, но никаких назначений
        rows = assignment_summary()
        names = {r["full_name"] for r in rows}
        assert "Idle" in names
        idle = next(r for r in rows if r["full_name"] == "Idle")
        assert idle["total"] == 0
        # eligible приходит из operators_distribution_status → должен быть bool
        assert idle["eligible"] in (True, False)

    def test_yesterday_filter(self):
        op = _mk_op("Yesterman")
        lead = _mk_lead(op, "998900000200")
        # ставим назначение на «сегодня 3ч назад» и на «вчера 12:00»
        now = timezone.now()
        _mk_assignment(lead, op, LeadAssignmentSource.MORNING_SPLIT, when=now)
        lead2 = _mk_lead(op, "998900000201")
        yesterday_noon = timezone.localtime().replace(hour=12, minute=0, second=0, microsecond=0) - dt.timedelta(days=1)
        _mk_assignment(lead2, op, LeadAssignmentSource.AUTO_REFILL, when=yesterday_noon)

        today_rows = assignment_summary(timezone.localdate())
        yest_rows = assignment_summary(timezone.localdate() - dt.timedelta(days=1))
        today_row = next(r for r in today_rows if r["full_name"] == "Yesterman")
        yest_row = next(r for r in yest_rows if r["full_name"] == "Yesterman")
        assert today_row["total"] == 1
        assert yest_row["total"] == 1
        assert today_row["by_source"] == {"morning_split": 1}
        assert yest_row["by_source"] == {"auto_refill": 1}


@pytest.mark.django_db
class TestOperatorAssignmentsForDay:
    def test_chronological_order(self):
        op = _mk_op("Chrono")
        now = timezone.now()
        # три назначения в разное время
        for i, minutes in enumerate([120, 60, 30]):
            lead = _mk_lead(op, f"9989000003{i:02d}")
            _mk_assignment(
                lead,
                op,
                LeadAssignmentSource.MORNING_SPLIT,
                when=now - dt.timedelta(minutes=minutes),
            )
        rows = operator_assignments_for_day(op)
        assert len(rows) == 3
        # created_at должен быть возрастающим
        times = [r["created_at"] for r in rows]
        assert times == sorted(times)

    def test_empty_for_operator_without_assignments(self):
        op = _mk_op("Empty")
        rows = operator_assignments_for_day(op)
        assert rows == []

    def test_returns_source_and_lead_meta(self):
        op = _mk_op("Meta")
        lead = _mk_lead(op, "998900000500")
        _mk_assignment(lead, op, LeadAssignmentSource.QIMMATLIK_RETRY)
        rows = operator_assignments_for_day(op)
        assert len(rows) == 1
        r = rows[0]
        assert r["source"] == "qimmatlik_retry"
        assert r["lead_id"] == lead.id
        assert r["lead_phone"] == "998900000500"
        assert r["assignment_id"]
