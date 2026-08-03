"""
Сортировка `/api/leads/my/?view=active`:
  1. carry_over (спец-лиды, no_answer/phone_on/callback_scheduled/...) — первыми
  2. вчерашние (созданные до today_start) — после свежих
  3. затем по -updated_at

view=postponed / view=all — сортировку не ломаем.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.leads.models import Lead, LeadStatus
from apps.leads.selectors import leads_for_operator
from apps.leads.services import lead_postpone
from apps.operators.models import Operator, OperatorStatus


@pytest.fixture
def op(db):
    return Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)


def _mk_lead(
    op: Operator,
    idx: int,
    *,
    status: str,
    created_days_ago: int,
    updated_offset_seconds: int = 0,
) -> Lead:
    """
    Создать лид с backdated created_at и updated_at. Порядок вызовов
    для _mk_lead определяет relative updated_at внутри одного дня,
    но чтобы явно контролировать сортировку — используем updated_offset_seconds.
    """
    now = timezone.now()
    created = now - dt.timedelta(days=created_days_ago)
    lead = Lead.objects.create(
        full_name=f"L-{idx}",
        phone=f"+99890{idx:07d}",
        status=status,
        operator=op,
    )
    # auto_now_add / auto_now — обходим ручным UPDATE.
    Lead.objects.filter(pk=lead.pk).update(
        created_at=created,
        updated_at=created + dt.timedelta(seconds=updated_offset_seconds),
    )
    lead.refresh_from_db()
    return lead


@pytest.mark.django_db
def test_carry_over_leads_come_first(op):
    """
    5 лидов у оператора:
      - 2 в no_answer (carry), созданы вчера
      - 2 сегодня в assigned (свежие)
      - 1 вчерашний в assigned
    Ожидаемый порядок: [carry1, carry2, today1, today2, yesterday_assigned].
    Внутри группы — по -updated_at.
    """
    carry_a = _mk_lead(
        op, 1, status=LeadStatus.NO_ANSWER, created_days_ago=1, updated_offset_seconds=10
    )
    carry_b = _mk_lead(
        op, 2, status=LeadStatus.NO_ANSWER, created_days_ago=1, updated_offset_seconds=20
    )
    today_a = _mk_lead(
        op, 3, status=LeadStatus.ASSIGNED, created_days_ago=0, updated_offset_seconds=100
    )
    today_b = _mk_lead(
        op, 4, status=LeadStatus.ASSIGNED, created_days_ago=0, updated_offset_seconds=200
    )
    yesterday_plain = _mk_lead(
        op, 5, status=LeadStatus.ASSIGNED, created_days_ago=1, updated_offset_seconds=50
    )

    ordered = list(leads_for_operator(op, view="active").values_list("id", flat=True))

    # Проверяем группы, а не абсолютный порядок внутри — carry первыми,
    # свежие вторыми, старые последними.
    carry_ids = {carry_a.id, carry_b.id}
    fresh_ids = {today_a.id, today_b.id}

    assert set(ordered[:2]) == carry_ids
    assert set(ordered[2:4]) == fresh_ids
    assert ordered[4] == yesterday_plain.id


@pytest.mark.django_db
def test_within_carry_group_sorted_by_updated_at_desc(op):
    older = _mk_lead(
        op, 1, status=LeadStatus.NO_ANSWER, created_days_ago=1, updated_offset_seconds=10
    )
    newer = _mk_lead(
        op, 2, status=LeadStatus.NO_ANSWER, created_days_ago=1, updated_offset_seconds=100
    )

    ordered = list(leads_for_operator(op, view="active").values_list("id", flat=True))

    # newer.updated_at > older.updated_at → newer идёт первым.
    assert ordered.index(newer.id) < ordered.index(older.id)


@pytest.mark.django_db
def test_view_postponed_ordering_untouched(op):
    a = _mk_lead(
        op, 1, status=LeadStatus.ASSIGNED, created_days_ago=1, updated_offset_seconds=10
    )
    b = _mk_lead(
        op, 2, status=LeadStatus.ASSIGNED, created_days_ago=0, updated_offset_seconds=10
    )
    lead_postpone(lead=a, operator=op)
    lead_postpone(lead=b, operator=op)

    ordered = list(leads_for_operator(op, view="postponed").values_list("id", flat=True))

    # postponed — по -postponed_at (b позже, значит первым).
    assert ordered[0] == b.id
    assert ordered[1] == a.id


@pytest.mark.django_db
def test_view_all_ordering_untouched(op):
    a = _mk_lead(
        op, 1, status=LeadStatus.NO_ANSWER, created_days_ago=1, updated_offset_seconds=10
    )
    b = _mk_lead(
        op, 2, status=LeadStatus.ASSIGNED, created_days_ago=0, updated_offset_seconds=1000
    )

    ordered = list(leads_for_operator(op, view="all").values_list("id", flat=True))
    # view=all — просто -updated_at, без carry/morning-аннотаций.
    assert ordered[0] == b.id
    assert ordered[1] == a.id
