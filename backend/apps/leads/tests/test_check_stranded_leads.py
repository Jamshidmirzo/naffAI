"""
`check_stranded_leads` management-команда — ежедневная гигиена.

Правила:
  * оба счётчика ниже порога → тихо, никаких TG.
  * либо один выше → строит алерт и (если не --dry-run) шлёт superadmin'ам.
  * `--dry-run` печатает body в stdout, но НЕ шлёт TG.

Для проверки «TG не отправлен» мокаем `_broadcast_to_superadmins` —
он единственная точка выхода в сеть.
"""

from __future__ import annotations

import datetime as dt
from io import StringIO
from unittest.mock import patch

import pytest
from django.core.management import call_command
from django.utils import timezone

from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator, OperatorStatus


def _mk_op(name: str, status: str = OperatorStatus.INACTIVE) -> Operator:
    return Operator.objects.create(full_name=name, status=status)


def _mk_lead(
    operator: Operator | None,
    *,
    idx: int,
    status: str = LeadStatus.NEW,
    needs_review: bool = False,
    created_days_ago: int = 0,
) -> Lead:
    lead = Lead.objects.create(
        full_name=f"L-{idx}",
        phone=f"+99890{idx:07d}",
        status=status,
        operator=operator,
        needs_review=needs_review,
    )
    if created_days_ago:
        past = timezone.now() - dt.timedelta(days=created_days_ago)
        Lead.objects.filter(pk=lead.pk).update(created_at=past)
    return lead


@pytest.mark.django_db
def test_dry_run_never_calls_telegram():
    inactive = _mk_op("Inactive")
    for i in range(25):  # выше default threshold=20
        _mk_lead(inactive, idx=i, status=LeadStatus.NEW)

    with patch(
        "apps.leads.management.commands.check_stranded_leads._broadcast_to_superadmins"
    ) as mock_send:
        call_command("check_stranded_leads", "--dry-run", stdout=StringIO())
        assert mock_send.call_count == 0


@pytest.mark.django_db
def test_silent_when_below_threshold():
    inactive = _mk_op("Inactive")
    for i in range(5):  # ниже threshold=20
        _mk_lead(inactive, idx=i, status=LeadStatus.NEW)

    out = StringIO()
    with patch(
        "apps.leads.management.commands.check_stranded_leads._broadcast_to_superadmins"
    ) as mock_send:
        call_command("check_stranded_leads", "--threshold=20", stdout=out)
        assert mock_send.call_count == 0
    assert "всё в порядке" in out.getvalue()


@pytest.mark.django_db
def test_alerts_above_threshold_via_stranded():
    inactive = _mk_op("Inactive")
    for i in range(6):
        _mk_lead(inactive, idx=i, status=LeadStatus.NEW)

    out = StringIO()
    # Threshold=5 → 6 > 5, должен сработать
    async def _fake(body: str) -> int:
        return 1

    with patch(
        "apps.leads.management.commands.check_stranded_leads._broadcast_to_superadmins",
        wraps=_fake,
    ) as mock_send:
        call_command(
            "check_stranded_leads", "--threshold=5", stdout=out
        )
        assert mock_send.call_count == 1


@pytest.mark.django_db
def test_alerts_via_needs_review_over_7_days():
    # 6 сирот в needs_review, все созданы 10 дней назад — > threshold=5.
    for i in range(6):
        _mk_lead(
            None,
            idx=i,
            status=LeadStatus.NEEDS_REVIEW,
            needs_review=True,
            created_days_ago=10,
        )

    async def _fake(body: str) -> int:
        return 1

    with patch(
        "apps.leads.management.commands.check_stranded_leads._broadcast_to_superadmins",
        wraps=_fake,
    ) as mock_send:
        call_command(
            "check_stranded_leads", "--threshold=5", stdout=StringIO()
        )
        assert mock_send.call_count == 1
