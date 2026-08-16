"""
Per-operator opt-in для morning-gate (2026-08-16).

Глобальный `SystemSetting.morning_gate_enabled` включает механизм гейта,
но применяется он только к операторам с `Operator.blocking_gate_enabled=True`.
Prod-безопасный rollout: у новых операторов флаг по умолчанию OFF, они
получают лидов без блокировки.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.calls.services import callback_reminder_create
from apps.leads.models import Lead, LeadStatusLabel
from apps.leads.selectors import (
    my_status_for_operator,
    operator_has_open_backlog,
    operator_is_blocked_by_overdue_callbacks,
    operator_yesterday_backlog_count,
    operators_eligible_for_new_leads,
)
from apps.operators.models import Operator, OperatorStatus
from apps.system_settings.models import SystemSetting


def _set_global_gate(enabled: bool) -> None:
    obj = SystemSetting.get_solo()
    obj.morning_gate_enabled = enabled
    obj.save(update_fields=["morning_gate_enabled", "updated_at"])


def _make_blocking_status(code: str = "phone_on") -> LeadStatusLabel:
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


# ---------- Blocking-status leads --------------------------------------


@pytest.mark.django_db
def test_operator_without_flag_is_not_blocked_by_spec_lead():
    """
    Глобальный switch ON, но у оператора `blocking_gate_enabled=False` →
    спец-лид на плече не должен ни блокировать RR, ни поднимать счётчики.
    """
    _set_global_gate(True)
    _make_blocking_status()

    op = Operator.objects.create(
        full_name="ProdSafe",
        status=OperatorStatus.ACTIVE,
        blocking_gate_enabled=False,
    )
    Lead.objects.create(
        full_name="L",
        phone="+998900101010",
        operator=op,
        status="phone_on",
    )

    assert operator_yesterday_backlog_count(op) == 0
    assert operator_has_open_backlog(op) is False
    assert op.id in list(
        operators_eligible_for_new_leads().values_list("id", flat=True)
    )


@pytest.mark.django_db
def test_operator_with_flag_is_blocked_by_spec_lead():
    """
    Оператор с включённым флагом получает старое поведение: спец-лид
    исключает его из RR и подсвечивает баннер.
    """
    _set_global_gate(True)
    _make_blocking_status()

    op = Operator.objects.create(
        full_name="Testing",
        status=OperatorStatus.ACTIVE,
        blocking_gate_enabled=True,
    )
    Lead.objects.create(
        full_name="L",
        phone="+998900202020",
        operator=op,
        status="phone_on",
    )

    assert operator_yesterday_backlog_count(op) == 1
    assert operator_has_open_backlog(op) is True
    assert op.id not in list(
        operators_eligible_for_new_leads().values_list("id", flat=True)
    )


# ---------- Overdue callback ------------------------------------------


@pytest.mark.django_db
def test_operator_without_flag_not_blocked_by_overdue_callback():
    _set_global_gate(True)
    op = Operator.objects.create(
        full_name="ProdSafe",
        status=OperatorStatus.ACTIVE,
        blocking_gate_enabled=False,
    )
    lead = Lead.objects.create(full_name="L", phone="+998900303030", operator=op)
    callback_reminder_create(
        lead=lead,
        operator=op,
        remind_at=timezone.now() - dt.timedelta(hours=2),
    )

    assert operator_is_blocked_by_overdue_callbacks(op) is False
    assert op.id in list(
        operators_eligible_for_new_leads().values_list("id", flat=True)
    )


@pytest.mark.django_db
def test_operator_with_flag_blocked_by_overdue_callback():
    _set_global_gate(True)
    op = Operator.objects.create(
        full_name="Testing",
        status=OperatorStatus.ACTIVE,
        blocking_gate_enabled=True,
    )
    lead = Lead.objects.create(full_name="L", phone="+998900404040", operator=op)
    callback_reminder_create(
        lead=lead,
        operator=op,
        remind_at=timezone.now() - dt.timedelta(hours=2),
    )

    assert operator_is_blocked_by_overdue_callbacks(op) is True


# ---------- my_status_for_operator payload -----------------------------


@pytest.mark.django_db
def test_my_status_shape_when_gate_off_for_operator():
    """
    Без флага у оператора my_status возвращает пустые списки блокировок
    и `gate_active=False` — фронт по этому решает НЕ показывать баннер.
    """
    _set_global_gate(True)
    _make_blocking_status()

    op = Operator.objects.create(
        full_name="ProdSafe",
        status=OperatorStatus.ACTIVE,
        blocking_gate_enabled=False,
    )
    Lead.objects.create(
        full_name="L",
        phone="+998900505050",
        operator=op,
        status="phone_on",
    )

    payload = my_status_for_operator(op)
    assert payload["gate_active"] is False
    assert payload["blocking_leads"] == []
    assert payload["overdue_callbacks"] == []
    assert payload["blocking_leads_count"] == 0
    assert payload["operator_gate_flag"] is False
    assert payload["global_gate_on"] is True


@pytest.mark.django_db
def test_my_status_shape_when_gate_on_for_operator_lists_blocking_leads():
    """
    С включённым флагом my_status возвращает CONCRETE лидов — фронт
    рисует список карточек «закрой эти», а не одно абстрактное число.
    """
    _set_global_gate(True)
    _make_blocking_status("phone_on")
    _make_blocking_status("no_answer")

    op = Operator.objects.create(
        full_name="Testing",
        status=OperatorStatus.ACTIVE,
        blocking_gate_enabled=True,
    )
    lead1 = Lead.objects.create(
        full_name="Иван",
        phone="+998900606060",
        operator=op,
        status="phone_on",
    )
    lead2 = Lead.objects.create(
        full_name="Пётр",
        phone="+998900707070",
        operator=op,
        status="no_answer",
    )

    payload = my_status_for_operator(op)
    assert payload["gate_active"] is True
    ids = {row["id"] for row in payload["blocking_leads"]}
    assert lead1.id in ids
    assert lead2.id in ids
    assert payload["blocking_leads_count"] >= 2
    # Каждая карточка содержит достаточно данных для UI.
    for row in payload["blocking_leads"]:
        assert "full_name" in row
        assert "phone" in row
        assert "status" in row
        assert "id" in row


@pytest.mark.django_db
def test_my_status_includes_overdue_callbacks_when_gated():
    _set_global_gate(True)
    op = Operator.objects.create(
        full_name="Testing",
        status=OperatorStatus.ACTIVE,
        blocking_gate_enabled=True,
    )
    lead = Lead.objects.create(
        full_name="Сергей",
        phone="+998900808080",
        operator=op,
    )
    callback_reminder_create(
        lead=lead,
        operator=op,
        remind_at=timezone.now() - dt.timedelta(minutes=30),
    )

    payload = my_status_for_operator(op)
    assert payload["gate_active"] is True
    assert payload["overdue_callbacks_count"] >= 1
    row = payload["overdue_callbacks"][0]
    assert row["lead_id"] == lead.id
    assert row["full_name"] == "Сергей"
    assert "remind_at" in row


@pytest.mark.django_db
def test_global_switch_off_beats_per_op_flag():
    """
    Kill-switch: если глобальный тумблер OFF — даже с включённым
    флагом у оператора гейт не применяется.
    """
    _set_global_gate(False)
    _make_blocking_status()

    op = Operator.objects.create(
        full_name="Testing",
        status=OperatorStatus.ACTIVE,
        blocking_gate_enabled=True,
    )
    Lead.objects.create(
        full_name="L",
        phone="+998900909090",
        operator=op,
        status="phone_on",
    )

    assert operator_yesterday_backlog_count(op) == 0
    assert operator_has_open_backlog(op) is False
    payload = my_status_for_operator(op)
    assert payload["gate_active"] is False
    assert payload["global_gate_on"] is False
    assert payload["operator_gate_flag"] is True
