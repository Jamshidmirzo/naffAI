"""
Правило `recall_after_lunch`: после 13:00 Asia/Tashkent лид с recall-
статусом (`no_answer` / `phone_on`), выставленным до обеда, снова
всплывает в /my active как intraday-carry. Если оператор повторно
тронул статус ПОСЛЕ обеда — уходит до завтра по общему правилу.

**Важно (2026-08-04)**: `operator_working_lead_count` НЕ считает
carry-статусы (включая recall-коды — они ⊂ carry). Поэтому «висит в
/my active» и «попадает в квоту working» — теперь разные вещи. Тесты
здесь проверяют ВИДИМОСТЬ в /my active (via `leads_for_operator`),
не считают carry в working.

Поверяем через freeze_time + backdate `updated_at`, чтобы не зависеть
от текущего времени CI-раннера.
"""

from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

import pytest
from django.core.cache import cache
from django.utils import timezone
from freezegun import freeze_time

from apps.leads.models import Lead, LeadStatus
from apps.leads.selectors import (
    leads_for_operator,
    operator_working_lead_count,
    recall_after_lunch_status_codes,
)
from apps.operators.models import Operator, OperatorStatus


TASHKENT = ZoneInfo("Asia/Tashkent")


@pytest.fixture(autouse=True)
def _clear_status_caches():
    """
    `recall_after_lunch_status_codes()` и `carry_over_status_codes()`
    кэшируются в locmem на 60с — между тестами сбрасываем.
    """
    cache.delete("recall_after_lunch_status_codes")
    cache.delete("carry_over_status_codes")
    yield
    cache.delete("recall_after_lunch_status_codes")
    cache.delete("carry_over_status_codes")


@pytest.fixture
def op(db):
    return Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)


def _mk_lead(op: Operator, idx: int, *, status: str, updated_at: dt.datetime) -> Lead:
    """
    Создать лид с backdated `updated_at` (обходим auto_now через .update()).
    """
    lead = Lead.objects.create(
        full_name=f"L-{idx}",
        phone=f"+99890{idx:07d}",
        status=status,
        operator=op,
    )
    Lead.objects.filter(pk=lead.pk).update(updated_at=updated_at)
    lead.refresh_from_db()
    return lead


# ---- Sanity: seed сработал --------------------------------------------------


@pytest.mark.django_db
def test_recall_after_lunch_seed_contains_no_answer_and_phone_on():
    codes = set(recall_after_lunch_status_codes())
    assert "no_answer" in codes
    assert "phone_on" in codes


# ---- До обеда: recall-лиды скрыты (правило «тронут сегодня») ---------------


@pytest.mark.django_db
def test_before_lunch_touched_today_visible(op):
    """10:00 — no_answer поставлен в 09:00 → лид тронут сегодня, но остаётся виден в /my active."""
    with freeze_time("2026-08-04 05:00:00"):  # 10:00 Asia/Tashkent
        updated = timezone.now() - dt.timedelta(hours=1)  # 09:00 локально
        lead = _mk_lead(op, 1, status=LeadStatus.NO_ANSWER, updated_at=updated)
        assert operator_working_lead_count(op) == 0
        visible = list(
            leads_for_operator(op, view="active").values_list("id", flat=True)
        )
        assert visible == [lead.id]


# ---- После обеда: recall-лиды с утренним updated снова активны -------------


@pytest.mark.django_db
def test_after_lunch_touched_before_lunch_visible_but_not_counted(op):
    """
    14:00 — no_answer поставлен в 09:00 (до обеда) → снова активен и
    ВИДЕН в /my active первым (топ-группа), но НЕ в квоте working
    (carry-статус исключён из квоты).
    """
    with freeze_time("2026-08-04 09:00:00"):  # 14:00 Asia/Tashkent
        lunch = timezone.localtime().replace(
            hour=13, minute=0, second=0, microsecond=0
        )
        morning_update = lunch - dt.timedelta(hours=4)  # 09:00 local
        lead = _mk_lead(
            op, 1, status=LeadStatus.NO_ANSWER, updated_at=morning_update
        )
        # carry исключён из working квоты
        assert operator_working_lead_count(op) == 0
        # но виден оператору
        visible = list(
            leads_for_operator(op, view="active").values_list("id", flat=True)
        )
        assert visible == [lead.id]


@pytest.mark.django_db
def test_after_lunch_touched_before_lunch_phone_on_also_recalls(op):
    """phone_on ведёт себя так же — виден в /my active, не в working квоте."""
    with freeze_time("2026-08-04 09:00:00"):
        lunch = timezone.localtime().replace(
            hour=13, minute=0, second=0, microsecond=0
        )
        morning = lunch - dt.timedelta(hours=3)  # 10:00 local
        lead = _mk_lead(op, 1, status=LeadStatus.PHONE_ON, updated_at=morning)
        assert operator_working_lead_count(op) == 0
        assert lead.id in list(
            leads_for_operator(op, view="active").values_list("id", flat=True)
        )


# ---- После обеда: recall-лид, тронутый после 13:00 ------------------


@pytest.mark.django_db
def test_after_lunch_touched_after_lunch_stays_visible(op):
    """
    14:00 — no_answer поставлен в 13:30 (уже после обеда) → лид тронут сегодня,
    но остаётся виден в /my active.
    """
    with freeze_time("2026-08-04 09:00:00"):  # 14:00 local
        lunch = timezone.localtime().replace(
            hour=13, minute=0, second=0, microsecond=0
        )
        after_lunch = lunch + dt.timedelta(minutes=30)  # 13:30 local
        lead = _mk_lead(op, 1, status=LeadStatus.NO_ANSWER, updated_at=after_lunch)
        assert operator_working_lead_count(op) == 0
        visible = list(
            leads_for_operator(op, view="active").values_list("id", flat=True)
        )
        assert visible == [lead.id]


# ---- Non-recall статусы ведут себя как раньше (has_debt) -------------------


@pytest.mark.django_db
def test_after_lunch_non_recall_status_follows_standard_rule(op):
    """
    14:00 — has_debt updated в 09:00 → по общему правилу updated < today_start?
    Нет: 09:00 сегодня, значит updated >= today_start. Значит скрыт.
    Recall тут не применяется — has_debt нет в recall-списке.
    """
    with freeze_time("2026-08-04 09:00:00"):  # 14:00 local
        morning = timezone.localtime().replace(
            hour=9, minute=0, second=0, microsecond=0
        )
        _mk_lead(op, 1, status=LeadStatus.HAS_DEBT, updated_at=morning)
        assert operator_working_lead_count(op) == 0


@pytest.mark.django_db
def test_after_lunch_yesterday_has_debt_still_counts(op):
    """
    14:00 — has_debt updated вчера → активен по общему правилу
    (updated_at < today_start), но НЕ recall — сортируется как обычный
    вчерашний active, не в топе.
    """
    with freeze_time("2026-08-04 09:00:00"):
        yesterday = timezone.localtime() - dt.timedelta(days=1)
        _mk_lead(op, 1, status=LeadStatus.HAS_DEBT, updated_at=yesterday)
        assert operator_working_lead_count(op) == 1


# ---- Сортировка: recall-лиды в топе (наравне с carry) ----------------------


@pytest.mark.django_db
def test_after_lunch_recall_at_top_alongside_carry(op):
    """
    14:00, три лида:
      - no_answer, updated в 09:00 (recall)          → топ
      - callback_scheduled, updated вчера (carry)    → топ
      - has_debt, updated вчера (обычный active)     → не в топе
    """
    with freeze_time("2026-08-04 09:00:00"):
        lunch = timezone.localtime().replace(
            hour=13, minute=0, second=0, microsecond=0
        )
        recall_lead = _mk_lead(
            op,
            1,
            status=LeadStatus.NO_ANSWER,
            updated_at=lunch - dt.timedelta(hours=4),  # 09:00
        )
        carry_lead = _mk_lead(
            op,
            2,
            status=LeadStatus.CALLBACK_SCHEDULED,
            updated_at=timezone.localtime() - dt.timedelta(days=1),
        )
        plain_lead = _mk_lead(
            op,
            3,
            status=LeadStatus.HAS_DEBT,
            updated_at=timezone.localtime() - dt.timedelta(days=1),
        )

        ordered = list(
            leads_for_operator(op, view="active").values_list("id", flat=True)
        )
        # Топ — {recall_lead, carry_lead} в любом порядке (сортировка по
        # -updated_at внутри группы); plain_lead — последним.
        assert set(ordered[:2]) == {recall_lead.id, carry_lead.id}
        assert ordered[-1] == plain_lead.id


# ---- Завтра утром: recall-лид продолжает вести себя как carry --------------


@pytest.mark.django_db
def test_next_day_recall_lead_visible_but_not_in_quota(op):
    """
    Вчерашний no_answer сегодня утром (10:00) — виден оператору первым
    (carry-сортировка), но НЕ в квоте working (carry исключён).
    """
    # Создаём лид «вчера в 15:00 Ташкент» относительно замороженного времени.
    with freeze_time("2026-08-04 05:00:00"):  # 10:00 Asia/Tashkent
        yesterday_15 = timezone.localtime().replace(
            hour=15, minute=0, second=0, microsecond=0
        ) - dt.timedelta(days=1)
        lead = _mk_lead(
            op, 1, status=LeadStatus.NO_ANSWER, updated_at=yesterday_15
        )
        assert operator_working_lead_count(op) == 0
        visible = list(
            leads_for_operator(op, view="active").values_list("id", flat=True)
        )
        assert visible == [lead.id]
