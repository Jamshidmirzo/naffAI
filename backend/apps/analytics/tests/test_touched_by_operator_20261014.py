"""
2026-10-14: «obzvon» in the 3h report / lead stats counts leads the operator
worked (a call or a status change they made), not leads the system merely
assigned to them (refill / morning split also bump Lead.updated_at).
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.analytics.selectors import lead_stats_snapshot
from apps.leads.models import Lead, LeadStatus
from apps.leads.services import lead_update_status
from apps.operators.models import Operator, OperatorStatus
from apps.users.models import Profile, Role

pytestmark = pytest.mark.django_db


def _window():
    today = timezone.localdate()
    tz = timezone.get_current_timezone()
    return (
        dt.datetime.combine(today, dt.time.min, tzinfo=tz),
        dt.datetime.combine(today, dt.time.max, tzinfo=tz),
    )


def _row(snapshot: dict, op: Operator) -> dict | None:
    return next((r for r in snapshot["by_operator"] if r.get("operator_id") == op.id), None)


def test_assigned_but_untouched_leads_are_not_counted():
    op = Operator.objects.create(full_name="Given only", status=OperatorStatus.ACTIVE)
    for i in range(5):
        Lead.objects.create(full_name=f"L{i}", phone=f"+99890{i:07d}", status=LeadStatus.NEW, operator=op)

    date_from, date_to = _window()
    row = _row(lead_stats_snapshot(date_from=date_from, date_to=date_to), op)
    assert row is None or int(row.get("total", 0)) == 0


def test_status_change_by_the_operator_is_counted():
    op = Operator.objects.create(full_name="Worker", status=OperatorStatus.ACTIVE)
    user = get_user_model().objects.create_user(username="worker", password="x")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=op)
    lead = Lead.objects.create(full_name="L", phone="+998901112233", status=LeadStatus.ASSIGNED, operator=op)
    Lead.objects.create(full_name="Untouched", phone="+998901112244", status=LeadStatus.NEW, operator=op)

    lead_update_status(lead=lead, status=LeadStatus.LOST, user=user)

    date_from, date_to = _window()
    row = _row(lead_stats_snapshot(date_from=date_from, date_to=date_to), op)
    assert row is not None and int(row["total"]) == 1
