"""
`leads_for_operator(op, view="closed")` — история терминальных лидов
оператора (кнопка «Закрытые» на /my). В отличие от `active`/`postponed`/
`all`, `closed` смотрит только на `is_terminal=True` статусы и сортирует
по `-updated_at` (последнее закрытое сверху).

Правило:
  - Включаем: won, lost, archived, needs_review + все custom-коды с
    `LeadStatusLabel.is_terminal=True` (harid_qildi, kartsi_yoq,
    sms_jonatildi, has_debt (в 0015 отмечен terminal), contacted_telegram,
    qimmatlik_qildi, waiting_salary, notogri_raqam, qarzi_bor).
  - Исключаем: активные (new, assigned, in_progress, no_answer, phone_on,
    callback_scheduled, dokonga_keladi) и postponed.
  - Скоп — только лиды текущего оператора: чужие терминальные не показываем.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.core.cache import cache
from django.utils import timezone

from apps.leads.models import Lead, LeadStatus
from apps.leads.selectors import leads_for_operator, terminal_lead_status_codes
from apps.operators.models import Operator, OperatorStatus


@pytest.fixture(autouse=True)
def _clear_carry_cache():
    """
    `carry_over_status_codes()` / `recall_after_lunch_status_codes()`
    кэшируют 60с в locmem — между тестами сбрасываем, иначе первый тест
    «протекает» кэшом в следующие (та же практика, что в
    test_auto_close_stale_leads.py).
    """
    cache.delete("carry_over_status_codes")
    cache.delete("recall_after_lunch_status_codes")
    yield
    cache.delete("carry_over_status_codes")
    cache.delete("recall_after_lunch_status_codes")


def _mk_op(name: str = "OP") -> Operator:
    return Operator.objects.create(full_name=name, status=OperatorStatus.ACTIVE)


def _mk_lead(
    op: Operator,
    idx: int,
    *,
    status: str = LeadStatus.WON,
    updated_minutes_ago: int = 0,
    postponed: bool = False,
) -> Lead:
    """
    Создать лид у оператора и вручную сдвинуть `updated_at`.
    Используем минуты (а не дни) — тесту нужен строгий порядок «-updated_at»,
    а полагаться на автосохранение auto_now рискованно (тайминги внутри
    одного save-а неразличимы).
    """
    lead = Lead.objects.create(
        full_name=f"L-{idx}",
        phone=f"+99890{idx:07d}",
        status=status,
        operator=op,
        postponed_at=timezone.now() if postponed else None,
    )
    now = timezone.now()
    Lead.objects.filter(pk=lead.pk).update(
        updated_at=now - dt.timedelta(minutes=updated_minutes_ago)
    )
    lead.refresh_from_db()
    return lead


# ---- Основной сценарий из ТЗ --------------------------------------------


@pytest.mark.django_db
def test_closed_view_returns_only_terminal_leads_of_operator():
    """
    Сценарий из ТЗ:
      - у оператора 2 won + 3 lost (terminal → в closed)
      - у оператора 1 assigned (active → НЕ в closed)
      - у оператора 1 postponed (active + отложен → НЕ в closed)
    Ожидание: closed.count() == 5.
    """
    op = _mk_op()

    for i in range(2):
        _mk_lead(op, 10 + i, status=LeadStatus.WON)
    for i in range(3):
        _mk_lead(op, 20 + i, status=LeadStatus.LOST)

    _mk_lead(op, 30, status=LeadStatus.ASSIGNED)
    _mk_lead(op, 31, status=LeadStatus.IN_PROGRESS, postponed=True)

    qs = leads_for_operator(op, view="closed")
    assert qs.count() == 5

    codes = set(qs.values_list("status", flat=True))
    assert codes == {LeadStatus.WON, LeadStatus.LOST}


# ---- Порядок -------------------------------------------------------------


@pytest.mark.django_db
def test_closed_view_orders_by_updated_at_desc():
    """
    Самый свежий closed — сверху. Проверяем сортировку `-updated_at`.
    """
    op = _mk_op()
    oldest = _mk_lead(op, 1, status=LeadStatus.WON, updated_minutes_ago=120)
    middle = _mk_lead(op, 2, status=LeadStatus.LOST, updated_minutes_ago=60)
    newest = _mk_lead(op, 3, status=LeadStatus.ARCHIVED, updated_minutes_ago=5)

    ids = list(leads_for_operator(op, view="closed").values_list("id", flat=True))
    assert ids == [newest.id, middle.id, oldest.id]


# ---- Изоляция по оператору ----------------------------------------------


@pytest.mark.django_db
def test_closed_view_isolated_per_operator():
    """
    Терминальные лиды другого оператора — не в выдаче. Каждый смотрит
    только свою историю.
    """
    me = _mk_op("Me")
    other = _mk_op("Other")

    mine = _mk_lead(me, 1, status=LeadStatus.WON)
    _mk_lead(other, 2, status=LeadStatus.WON)
    _mk_lead(other, 3, status=LeadStatus.LOST)

    qs = leads_for_operator(me, view="closed")
    assert list(qs.values_list("id", flat=True)) == [mine.id]


# ---- Не пересекается с active/postponed ---------------------------------


@pytest.mark.django_db
def test_closed_view_excludes_active_and_postponed_statuses():
    """
    Активные статусы (new / assigned / in_progress / no_answer / phone_on /
    callback_scheduled) и postponed — не должны попадать в `closed`,
    даже если updated_at очень свежий.
    """
    op = _mk_op()

    for code in (
        LeadStatus.NEW,
        LeadStatus.ASSIGNED,
        LeadStatus.IN_PROGRESS,
        LeadStatus.NO_ANSWER,
        LeadStatus.PHONE_ON,
        LeadStatus.CALLBACK_SCHEDULED,
    ):
        _mk_lead(op, hash(code) % 10_000, status=code, updated_minutes_ago=1)

    _mk_lead(op, 99, status=LeadStatus.IN_PROGRESS, postponed=True)

    assert leads_for_operator(op, view="closed").count() == 0


# ---- Все terminal-коды видны, включая custom (harid_qildi, kartsi_yoq…) --


@pytest.mark.django_db
def test_closed_view_includes_custom_terminal_codes():
    """
    Terminal-набор — динамический (из LeadStatusLabel.is_terminal=True).
    Проверяем, что custom-код (создан менеджером через админку — здесь
    имитируем прямым insert'ом), помеченный `is_terminal=True`, тоже
    попадает в `closed`. Иначе истории оператора будет неполной, когда
    менеджер добавит собственный «закрытый» статус (напр. `harid_qildi`).
    """
    from apps.leads.models import LeadStatusLabel

    LeadStatusLabel.objects.create(
        code="harid_qildi",
        label_ru="Купил",
        label_uz="Xarid qildi",
        tone="success",
        emoji="🛍",
        sort_order=200,
        is_active=True,
        is_terminal=True,
    )

    op = _mk_op()

    terminal_codes = terminal_lead_status_codes()
    assert "harid_qildi" in terminal_codes
    assert "sms_jonatildi" in terminal_codes, (
        "seed migration 0015 должна пометить sms_jonatildi as terminal"
    )

    _mk_lead(op, 1, status="harid_qildi")
    _mk_lead(op, 2, status="sms_jonatildi")
    _mk_lead(op, 3, status=LeadStatus.WON)
    _mk_lead(op, 4, status=LeadStatus.LOST)

    assert leads_for_operator(op, view="closed").count() == 4


# ---- Не ломаем active/postponed/all -------------------------------------


@pytest.mark.django_db
def test_active_view_still_excludes_terminal():
    """
    Регрессия: терминальные лиды не должны утекать в `view=active`.
    """
    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.WON)
    _mk_lead(op, 2, status=LeadStatus.LOST)
    active_lead = _mk_lead(op, 3, status=LeadStatus.ASSIGNED)

    ids = list(leads_for_operator(op, view="active").values_list("id", flat=True))
    assert ids == [active_lead.id]
