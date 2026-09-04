"""
Тесты отложенного retry для qimmatlik_qildi (блок #2 из
parallel-inventing-dragon.md).

Проверяем:

  * `lead_update_status(..., status="qimmatlik_qildi")` в 11:00 →
    metadata.qimmatlik_retry_at == сегодня 16:00 (не мгновенный retry).
  * `lead_update_status(..., status="qimmatlik_qildi")` в 15:00 →
    metadata.qimmatlik_retry_at == завтра 09:30.
  * Оператор лида НЕ меняется на месте — переуступка только когда
    команда `qimmatlik_retry_due` замечает наступивший срок.
  * Команда `qimmatlik_retry_due` обрабатывает только due-лиды и
    очищает `qimmatlik_retry_at`; не-due не трогает.
  * Когда все операторы уже пробовали — команда закрывает лид как LOST
    (существующее поведение lead_qimmatlik_retry сохранилось).
  * --dry-run ничего не пишет.

Все тайминги в Asia/Tashkent через freezegun.
"""

from __future__ import annotations

import datetime as dt
from io import StringIO

import pytest
from django.core.management import call_command
from django.utils import timezone
from freezegun import freeze_time

from apps.leads.models import (
    Lead,
    LeadAssignment,
    LeadAssignmentSource,
    LeadStatus,
)
from apps.leads.services import lead_update_status
from apps.operators.models import Operator, OperatorStatus

# ---- fixtures / helpers -------------------------------------------------


def _mk_op(name: str, *, active: bool = True) -> Operator:
    return Operator.objects.create(
        full_name=name,
        status=OperatorStatus.ACTIVE if active else OperatorStatus.INACTIVE,
    )


def _mk_lead(op: Operator | None, phone: str) -> Lead:
    return Lead.objects.create(
        full_name=f"Client-{phone}",
        phone=phone,
        status=LeadStatus.ASSIGNED,
        operator=op,
    )


def _mk_active_assignment(lead: Lead, op: Operator) -> LeadAssignment:
    # Активный assignment — важен, чтобы lead_qimmatlik_retry увидел
    # оператора как «уже пробовавшего» и исключил его из кандидатов.
    return LeadAssignment.objects.create(
        lead=lead,
        operator=op,
        source=LeadAssignmentSource.SHEET_MANUAL,
        active=True,
    )


def _local(y: int, m: int, d: int, hh: int, mm: int = 0) -> dt.datetime:
    """Local-aware datetime в текущем TZ (Asia/Tashkent) — для freezegun
    удобнее собирать naive и потом дать freeze_time зафиксировать
    точку."""
    return dt.datetime(y, m, d, hh, mm, 0)


# ---- 1. lead_update_status выставляет retry_at, не переуступает ---------


@pytest.mark.django_db
def test_status_at_11_schedules_today_16_00():
    op = _mk_op("Op-A")
    lead = _mk_lead(op, "998900000101")
    _mk_active_assignment(lead, op)

    # 2026-09-04 11:00 в текущем TZ (Asia/Tashkent).
    tz = timezone.get_current_timezone()
    freeze_at = dt.datetime(2026, 9, 4, 11, 0, 0, tzinfo=tz)

    with freeze_time(freeze_at):
        lead_update_status(lead=lead, status="qimmatlik_qildi", comment="test")

    lead.refresh_from_db()
    assert lead.status == "qimmatlik_qildi"
    # Оператор не поменялся — retry отложен.
    assert lead.operator_id == op.id

    raw = lead.metadata.get("qimmatlik_retry_at")
    assert raw, "retry_at must be set on qimmatlik_qildi"
    parsed = dt.datetime.fromisoformat(raw)
    parsed_local = timezone.localtime(parsed)
    assert parsed_local.year == 2026
    assert parsed_local.month == 9
    assert parsed_local.day == 4
    assert parsed_local.hour == 16
    assert parsed_local.minute == 0


@pytest.mark.django_db
def test_status_at_15_schedules_tomorrow_09_30():
    op = _mk_op("Op-B")
    lead = _mk_lead(op, "998900000102")
    _mk_active_assignment(lead, op)

    tz = timezone.get_current_timezone()
    freeze_at = dt.datetime(2026, 9, 4, 15, 0, 0, tzinfo=tz)

    with freeze_time(freeze_at):
        lead_update_status(lead=lead, status="qimmatlik_qildi", comment="test")

    lead.refresh_from_db()
    raw = lead.metadata.get("qimmatlik_retry_at")
    assert raw
    parsed_local = timezone.localtime(dt.datetime.fromisoformat(raw))
    assert parsed_local.year == 2026
    assert parsed_local.month == 9
    assert parsed_local.day == 5   # завтра
    assert parsed_local.hour == 9
    assert parsed_local.minute == 30


@pytest.mark.django_db
def test_status_exactly_at_13_00_treated_as_afternoon():
    # Граничный кейс: 13:00 сама по себе — уже после обеда.
    op = _mk_op("Op-Boundary")
    lead = _mk_lead(op, "998900000103")
    _mk_active_assignment(lead, op)

    tz = timezone.get_current_timezone()
    freeze_at = dt.datetime(2026, 9, 4, 13, 0, 0, tzinfo=tz)

    with freeze_time(freeze_at):
        lead_update_status(lead=lead, status="qimmatlik_qildi", comment="test")

    lead.refresh_from_db()
    parsed_local = timezone.localtime(
        dt.datetime.fromisoformat(lead.metadata["qimmatlik_retry_at"])
    )
    assert parsed_local.day == 5
    assert (parsed_local.hour, parsed_local.minute) == (9, 30)


# ---- 2. Команда qimmatlik_retry_due обрабатывает только due -------------


@pytest.mark.django_db
def test_command_processes_only_due_leads():
    # Два лида: один due (retry_at в прошлом), один not-due (retry_at
    # в будущем). Команда трогает только первый.
    op_original = _mk_op("Original")
    op_fresh = _mk_op("Fresh")   # свежий оператор — единственный кандидат
    lead_due = _mk_lead(op_original, "998900000201")
    _mk_active_assignment(lead_due, op_original)
    lead_future = _mk_lead(op_original, "998900000202")
    _mk_active_assignment(lead_future, op_original)

    tz = timezone.get_current_timezone()

    # Ставим оба лида в qimmatlik в 11:00 (retry_at = сегодня 16:00).
    with freeze_time(dt.datetime(2026, 9, 4, 11, 0, 0, tzinfo=tz)):
        lead_update_status(lead=lead_due, status="qimmatlik_qildi")
        lead_update_status(lead=lead_future, status="qimmatlik_qildi")

    # Переводим часы на 16:30 — due наступил для обоих. Но у lead_future
    # заранее переставим retry_at на завтра, чтобы проверить, что команда
    # уважает per-lead время, а не только per-status.
    tomorrow = dt.datetime(2026, 9, 5, 9, 30, 0, tzinfo=tz)
    lead_future.refresh_from_db()
    meta = dict(lead_future.metadata)
    meta["qimmatlik_retry_at"] = tomorrow.isoformat()
    lead_future.metadata = meta
    lead_future.save(update_fields=["metadata", "updated_at"])

    out = StringIO()
    with freeze_time(dt.datetime(2026, 9, 4, 16, 30, 0, tzinfo=tz)):
        call_command("qimmatlik_retry_due", stdout=out)

    lead_due.refresh_from_db()
    lead_future.refresh_from_db()

    # Due-лид переуступлен свежему оператору, ключ metadata очищен.
    assert lead_due.operator_id == op_fresh.id
    assert lead_due.status == LeadStatus.ASSIGNED
    assert "qimmatlik_retry_at" not in (lead_due.metadata or {})

    # Not-due остался у оригинального оператора, статус qimmatlik_qildi,
    # ключ на месте.
    assert lead_future.operator_id == op_original.id
    assert lead_future.status == "qimmatlik_qildi"
    assert "qimmatlik_retry_at" in (lead_future.metadata or {})


@pytest.mark.django_db
def test_command_before_due_time_is_noop():
    # Даже если статус уже qimmatlik_qildi, команда, запущенная ДО retry_at,
    # ничего не делает: оператор остаётся прежним, ключ на месте.
    op = _mk_op("StayPut")
    _mk_op("Other")   # есть альтернатива, но не должна активироваться
    lead = _mk_lead(op, "998900000301")
    _mk_active_assignment(lead, op)

    tz = timezone.get_current_timezone()
    with freeze_time(dt.datetime(2026, 9, 4, 11, 0, 0, tzinfo=tz)):
        lead_update_status(lead=lead, status="qimmatlik_qildi")

    # 14:00 — до срока 16:00.
    with freeze_time(dt.datetime(2026, 9, 4, 14, 0, 0, tzinfo=tz)):
        call_command("qimmatlik_retry_due")

    lead.refresh_from_db()
    assert lead.operator_id == op.id
    assert lead.status == "qimmatlik_qildi"
    assert "qimmatlik_retry_at" in lead.metadata


# ---- 3. Все операторы исчерпаны → LOST ----------------------------------


@pytest.mark.django_db
def test_command_closes_lost_when_no_fresh_operators():
    # Всего один активный оператор, он уже пробовал (единственный
    # assignment на лиде) → команда должна закрыть лид как LOST.
    op = _mk_op("Only")
    lead = _mk_lead(op, "998900000401")
    _mk_active_assignment(lead, op)

    tz = timezone.get_current_timezone()
    with freeze_time(dt.datetime(2026, 9, 4, 11, 0, 0, tzinfo=tz)):
        lead_update_status(lead=lead, status="qimmatlik_qildi")

    with freeze_time(dt.datetime(2026, 9, 4, 16, 5, 0, tzinfo=tz)):
        call_command("qimmatlik_retry_due")

    lead.refresh_from_db()
    assert lead.status == LeadStatus.LOST
    # Ключ очищен, чтобы watcher не пытался повторно.
    assert "qimmatlik_retry_at" not in (lead.metadata or {})


# ---- 4. --dry-run ничего не пишет ---------------------------------------


@pytest.mark.django_db
def test_command_dry_run_does_not_mutate():
    op = _mk_op("Origin")
    _mk_op("Fresh")
    lead = _mk_lead(op, "998900000501")
    _mk_active_assignment(lead, op)

    tz = timezone.get_current_timezone()
    with freeze_time(dt.datetime(2026, 9, 4, 11, 0, 0, tzinfo=tz)):
        lead_update_status(lead=lead, status="qimmatlik_qildi")

    with freeze_time(dt.datetime(2026, 9, 4, 16, 5, 0, tzinfo=tz)):
        out = StringIO()
        call_command("qimmatlik_retry_due", "--dry-run", stdout=out)

    lead.refresh_from_db()
    assert lead.status == "qimmatlik_qildi"
    assert lead.operator_id == op.id
    assert "qimmatlik_retry_at" in lead.metadata
    assert "dry-run" in out.getvalue()
