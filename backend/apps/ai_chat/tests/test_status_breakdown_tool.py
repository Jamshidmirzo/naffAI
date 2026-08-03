"""
Tests for `get_lead_status_breakdown` AI-chat tool.

Проверяет, что инструмент возвращает реальный breakdown лидов по всем
статусам из `LeadStatusLabel`, а также корректно фильтрует по периоду
и оператору.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.ai_chat.tools import call_tool
from apps.leads.models import Lead, LeadStatusLabel
from apps.operators.models import Operator, OperatorStatus


@pytest.fixture
def label_new(db):
    return LeadStatusLabel.objects.update_or_create(
        code="new",
        defaults={
            "label_ru": "Новый",
            "tone": "neutral",
            "emoji": "🟢",
            "is_active": True,
            "is_terminal": False,
            "carry_over_next_day": False,
        },
    )[0]


@pytest.fixture
def label_harid_qildi(db):
    return LeadStatusLabel.objects.update_or_create(
        code="harid_qildi",
        defaults={
            "label_ru": "Harid Qildi",
            "tone": "positive",
            "emoji": "✅",
            "is_active": True,
            "is_terminal": True,
            "carry_over_next_day": False,
        },
    )[0]


@pytest.fixture
def label_no_answer(db):
    return LeadStatusLabel.objects.update_or_create(
        code="no_answer",
        defaults={
            "label_ru": "Javob bermadi 1",
            "tone": "warning",
            "emoji": "🟡",
            "is_active": True,
            "is_terminal": False,
            "carry_over_next_day": True,
        },
    )[0]


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Test Op", status=OperatorStatus.ACTIVE)


@pytest.mark.django_db
def test_empty_db_returns_zero_total():
    """Нет лидов → total=0, items=[]."""
    Lead.objects.all().delete()
    result = call_tool("get_lead_status_breakdown")
    assert result["total"] == 0
    assert result["items"] == []
    assert result["period"] == "all"
    assert result["operator_id"] is None


@pytest.mark.django_db
def test_breakdown_returns_all_statuses_with_labels(
    label_new, label_harid_qildi, label_no_answer
):
    """Все использованные статусы попадают в items с label_ru и флагами."""
    Lead.objects.create(status="new")
    Lead.objects.create(status="new")
    Lead.objects.create(status="new")
    Lead.objects.create(status="harid_qildi")
    Lead.objects.create(status="no_answer")
    Lead.objects.create(status="no_answer")

    result = call_tool("get_lead_status_breakdown")
    assert result["total"] == 6

    by_code = {it["code"]: it for it in result["items"]}
    assert by_code["new"]["count"] == 3
    assert by_code["new"]["label_ru"] == "Новый"
    assert by_code["new"]["is_terminal"] is False
    assert by_code["new"]["is_carry_over"] is False

    assert by_code["harid_qildi"]["count"] == 1
    assert by_code["harid_qildi"]["label_ru"] == "Harid Qildi"
    assert by_code["harid_qildi"]["is_terminal"] is True
    assert by_code["harid_qildi"]["is_carry_over"] is False

    assert by_code["no_answer"]["count"] == 2
    assert by_code["no_answer"]["label_ru"] == "Javob bermadi 1"
    assert by_code["no_answer"]["is_terminal"] is False
    assert by_code["no_answer"]["is_carry_over"] is True


@pytest.mark.django_db
def test_breakdown_sorted_by_count_desc(label_new, label_harid_qildi, label_no_answer):
    Lead.objects.create(status="harid_qildi")
    for _ in range(5):
        Lead.objects.create(status="new")
    for _ in range(3):
        Lead.objects.create(status="no_answer")

    result = call_tool("get_lead_status_breakdown")
    counts = [it["count"] for it in result["items"]]
    assert counts == sorted(counts, reverse=True)
    assert result["items"][0]["code"] == "new"


@pytest.mark.django_db
def test_breakdown_filters_by_operator(label_new, operator):
    other_op = Operator.objects.create(full_name="Other", status=OperatorStatus.ACTIVE)
    Lead.objects.create(status="new", operator=operator)
    Lead.objects.create(status="new", operator=operator)
    Lead.objects.create(status="new", operator=other_op)
    Lead.objects.create(status="new")  # unassigned

    result = call_tool("get_lead_status_breakdown", operator_id=operator.id)
    assert result["total"] == 2
    assert result["operator_id"] == operator.id
    assert result["items"][0]["count"] == 2


@pytest.mark.django_db
def test_breakdown_filters_by_period(label_new):
    """Лиды старше 30 дней должны отсекаться при period='month'."""
    now = timezone.now()
    old = Lead.objects.create(status="new")
    Lead.objects.filter(pk=old.pk).update(created_at=now - dt.timedelta(days=90))

    Lead.objects.create(status="new")
    Lead.objects.create(status="new")

    result = call_tool("get_lead_status_breakdown", period="month")
    assert result["total"] == 2
    assert result["period"] == "month"


@pytest.mark.django_db
def test_breakdown_falls_back_to_code_when_label_missing():
    """Если LeadStatusLabel для code нет — используем сам код как label_ru."""
    Lead.objects.create(status="mystery_status")
    result = call_tool("get_lead_status_breakdown")
    assert result["total"] == 1
    item = result["items"][0]
    assert item["code"] == "mystery_status"
    assert item["label_ru"] == "mystery_status"
    assert item["is_terminal"] is False
    assert item["is_carry_over"] is False


@pytest.mark.django_db
def test_tool_registered_in_TOOLS_dict():
    from apps.ai_chat.tools import TOOLS

    assert "get_lead_status_breakdown" in TOOLS
    spec = TOOLS["get_lead_status_breakdown"]
    assert "description" in spec
    assert "handler" in spec
    assert callable(spec["handler"])
