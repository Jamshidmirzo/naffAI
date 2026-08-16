"""
Восстановление логики «спец-лиды блокируют раздачу»: `_morning_gate_enabled()`
теперь читает `SystemSetting.morning_gate_enabled` (default=True),
`settings.MORNING_GATE_ENABLED` — override для тестов/emergency.

Проверяем что тумблер реально влияет на:
  - `operators_eligible_for_new_leads()`  → RR исключает залоченных
  - `operator_yesterday_backlog_count()`  → счётчик для баннера
  - `operator_has_open_backlog()`         → union-флаг для /my
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.test import override_settings
from django.utils import timezone

from apps.calls.services import callback_reminder_create
from apps.leads.models import Lead, LeadStatusLabel
from apps.leads.selectors import (
    operator_has_open_backlog,
    operator_yesterday_backlog_count,
    operators_eligible_for_new_leads,
)
from apps.operators.models import Operator, OperatorStatus
from apps.system_settings.models import SystemSetting


def _set_gate(enabled: bool) -> None:
    obj = SystemSetting.get_solo()
    obj.morning_gate_enabled = enabled
    obj.save(update_fields=["morning_gate_enabled", "updated_at"])


def _make_blocking_status(code: str = "phone_on") -> LeadStatusLabel:
    """
    По умолчанию `phone_on` уже отмечен `blocks_new_leads=True` в
    миграции 0014_leadstatuslabel_blocks_new_leads. get_or_create
    покрывает случай отдельного тест-запуска.
    """
    obj, _ = LeadStatusLabel.objects.get_or_create(
        code=code,
        defaults={
            "label": code,
            "is_active": True,
            "blocks_new_leads": True,
            "is_terminal": False,
        },
    )
    if not obj.blocks_new_leads:
        obj.blocks_new_leads = True
        obj.save(update_fields=["blocks_new_leads"])
    return obj


@pytest.mark.django_db
def test_gate_enabled_excludes_operator_with_blocking_status_lead():
    _set_gate(True)
    _make_blocking_status()

    op = Operator.objects.create(
        full_name="Blocked",
        status=OperatorStatus.ACTIVE,
        blocking_gate_enabled=True,
    )
    Lead.objects.create(
        full_name="L",
        phone="+998900000001",
        operator=op,
        status="phone_on",
    )

    eligible_ids = list(operators_eligible_for_new_leads().values_list("id", flat=True))
    assert op.id not in eligible_ids
    assert operator_yesterday_backlog_count(op) == 1
    assert operator_has_open_backlog(op) is True


@pytest.mark.django_db
def test_gate_disabled_allows_operator_with_blocking_status_lead():
    _set_gate(False)
    _make_blocking_status()

    # Даже при `blocking_gate_enabled=True` глобальный switch OFF
    # должен отпустить оператора.
    op = Operator.objects.create(
        full_name="OK",
        status=OperatorStatus.ACTIVE,
        blocking_gate_enabled=True,
    )
    Lead.objects.create(
        full_name="L",
        phone="+998900000002",
        operator=op,
        status="phone_on",
    )

    eligible_ids = list(operators_eligible_for_new_leads().values_list("id", flat=True))
    assert op.id in eligible_ids
    # При выключенном гейте счётчик молчит (0), чтобы фронт не
    # рисовал баннер / lock.
    assert operator_yesterday_backlog_count(op) == 0
    assert operator_has_open_backlog(op) is False


@pytest.mark.django_db
def test_gate_enabled_excludes_operator_with_due_callback():
    """
    Callback due-or-imminent (в пределах CALLBACK_GATE_LOOKAHEAD_MINUTES)
    тоже должен блокировать RR при включённом гейте.
    """
    _set_gate(True)

    op = Operator.objects.create(
        full_name="Callback",
        status=OperatorStatus.ACTIVE,
        blocking_gate_enabled=True,
    )
    lead = Lead.objects.create(
        full_name="L",
        phone="+998900000003",
        operator=op,
    )
    callback_reminder_create(
        lead=lead,
        operator=op,
        # 1 минута в прошлом — точно попадает в lookahead-окно.
        remind_at=timezone.now() - dt.timedelta(minutes=1),
    )

    eligible_ids = list(operators_eligible_for_new_leads().values_list("id", flat=True))
    assert op.id not in eligible_ids


@pytest.mark.django_db
def test_env_override_beats_db_setting():
    """
    `settings.MORNING_GATE_ENABLED=False` побеждает DB=True (kill-switch
    остаётся доступен через env для emergency и для тестов).
    """
    _set_gate(True)
    _make_blocking_status()

    op = Operator.objects.create(
        full_name="Env",
        status=OperatorStatus.ACTIVE,
        blocking_gate_enabled=True,
    )
    Lead.objects.create(
        full_name="L",
        phone="+998900000004",
        operator=op,
        status="phone_on",
    )

    with override_settings(MORNING_GATE_ENABLED=False):
        eligible_ids = list(operators_eligible_for_new_leads().values_list("id", flat=True))
        assert op.id in eligible_ids


@pytest.mark.django_db
def test_future_callback_does_not_block_when_gate_enabled():
    """
    Callback на «после обеда» (за пределами lookahead) не должен
    блокировать утреннюю RR-раздачу — эта тонкость сохранилась
    из commit 8b01be2 (callback blocks RR only when due).
    """
    _set_gate(True)

    op = Operator.objects.create(
        full_name="Later",
        status=OperatorStatus.ACTIVE,
        blocking_gate_enabled=True,
    )
    lead = Lead.objects.create(
        full_name="L",
        phone="+998900000005",
        operator=op,
    )
    callback_reminder_create(
        lead=lead,
        operator=op,
        remind_at=timezone.now() + dt.timedelta(hours=4),
    )

    eligible_ids = list(operators_eligible_for_new_leads().values_list("id", flat=True))
    assert op.id in eligible_ids
