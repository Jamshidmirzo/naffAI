"""
API `/api/leads/my/status/` — диагностика для баннера на странице
«Мои лиды» и sidebar-бейджа. Селектор `my_status_for_operator` считает
разбивку working_count по классам carry / recall-after-lunch / today и
готовит человекочитаемый `reason_ru`.

Freeze_time на 10:00 (до обеда) и 14:00 (после) Asia/Tashkent, чтобы
проверить, что recall_active_now и recall_afternoon_count зависят от
времени, но остальные поля стабильны.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from freezegun import freeze_time
from rest_framework.test import APIClient

from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator, OperatorStatus
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture(autouse=True)
def _clear_status_caches():
    cache.delete("carry_over_status_codes")
    cache.delete("recall_after_lunch_status_codes")
    yield
    cache.delete("carry_over_status_codes")
    cache.delete("recall_after_lunch_status_codes")


def _operator_user(op: Operator) -> User:
    user = User.objects.create_user(username=f"op{op.id}", password="oppass1234")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=op)
    return user


def _manager_user() -> User:
    user = User.objects.create_user(username="mgr", password="mgrpass1234")
    Profile.objects.create(user=user, role=Role.MANAGER)
    return user


def _mk_op() -> Operator:
    return Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)


def _mk_lead(op: Operator, idx: int, *, status: str, updated_at: dt.datetime) -> Lead:
    lead = Lead.objects.create(
        full_name=f"L-{idx}",
        phone=f"+99890{idx:07d}",
        status=status,
        operator=op,
    )
    Lead.objects.filter(pk=lead.pk).update(updated_at=updated_at)
    lead.refresh_from_db()
    return lead


# ---- Base cases ------------------------------------------------------------


@pytest.mark.django_db
def test_empty_operator_returns_all_zeros_and_eligible():
    op = _mk_op()
    c = APIClient()
    c.force_authenticate(user=_operator_user(op))

    r = c.get("/api/leads/my/status/")
    assert r.status_code == 200, r.content
    body = r.data
    assert body["working_count"] == 0
    assert body["carry_count"] == 0
    assert body["recall_afternoon_count"] == 0
    assert body["today_fresh_count"] == 0
    assert body["postponed_count"] == 0
    assert body["eligible_for_new"] is True
    assert body["quota_limit"] >= 1
    # При пустых плечах — всегда «Всё закрыто».
    assert "закрыто" in body["reason_ru"].lower()


# ---- Only carry (вчерашние спец-лиды) -------------------------------------


@pytest.mark.django_db
def test_only_carry_leads_reported_in_carry_bucket():
    op = _mk_op()
    # Утро (до обеда), чтобы recall не подмешался.
    with freeze_time("2026-08-05 05:00:00"):  # 10:00 Ташкент
        yesterday_15 = timezone.localtime().replace(
            hour=15, minute=0, second=0, microsecond=0
        ) - dt.timedelta(days=1)
        _mk_lead(op, 1, status=LeadStatus.NO_ANSWER, updated_at=yesterday_15)
        _mk_lead(op, 2, status=LeadStatus.PHONE_ON, updated_at=yesterday_15)
        _mk_lead(op, 3, status=LeadStatus.CALLBACK_SCHEDULED, updated_at=yesterday_15)

        c = APIClient()
        c.force_authenticate(user=_operator_user(op))
        r = c.get("/api/leads/my/status/")
        assert r.status_code == 200
        body = r.data
        assert body["working_count"] == 3
        assert body["carry_count"] == 3
        assert body["recall_afternoon_count"] == 0
        assert body["today_fresh_count"] == 0
        assert body["recall_active_now"] is False
        assert "вчерашние" in body["reason_ru"]


# ---- Only recall (после обеда) --------------------------------------------


@pytest.mark.django_db
def test_after_lunch_recall_bucket_populated():
    """
    14:00 Ташкент — no_answer, тронутый утром в 09:00, должен всплыть как
    recall_afternoon.
    """
    op = _mk_op()
    with freeze_time("2026-08-05 09:00:00"):  # 14:00 Ташкент
        morning = timezone.localtime().replace(
            hour=9, minute=0, second=0, microsecond=0
        )
        _mk_lead(op, 1, status=LeadStatus.NO_ANSWER, updated_at=morning)

        c = APIClient()
        c.force_authenticate(user=_operator_user(op))
        r = c.get("/api/leads/my/status/")
        assert r.status_code == 200
        body = r.data
        assert body["working_count"] == 1
        assert body["carry_count"] == 0
        assert body["recall_afternoon_count"] == 1
        assert body["today_fresh_count"] == 0
        assert body["recall_active_now"] is True
        assert "после обеда" in body["reason_ru"].lower()


# ---- Quota full ------------------------------------------------------------


@pytest.mark.django_db
def test_quota_full_marks_ineligible_and_says_close_one(settings):
    settings.RR_BATCH_SIZE = 5
    op = _mk_op()
    with freeze_time("2026-08-05 05:00:00"):  # 10:00 Ташкент
        # 5 свежих assigned, не carry, не recall.
        now = timezone.now()
        for i in range(5):
            _mk_lead(op, i, status=LeadStatus.ASSIGNED, updated_at=now)

        c = APIClient()
        c.force_authenticate(user=_operator_user(op))
        r = c.get("/api/leads/my/status/")
        assert r.status_code == 200
        body = r.data
        assert body["working_count"] == 5
        assert body["quota_limit"] == 5
        assert body["carry_count"] == 0
        assert body["recall_afternoon_count"] == 0
        assert body["today_fresh_count"] == 5
        assert body["eligible_for_new"] is False
        assert "закрой" in body["reason_ru"].lower()


# ---- Mixed case (наиболее реалистичный: 34 working с carry-хвостом) -------


@pytest.mark.django_db
def test_mixed_case_carry_recall_and_today(settings):
    """
    Симулируем боль: 8 лидов — 4 вчерашних carry, 2 утренних recall, 2
    сегодняшних свежих. После 13:00. quota=5 → eligible=False, но
    reason подсвечивает и carry, и recall.
    """
    settings.RR_BATCH_SIZE = 5
    op = _mk_op()
    with freeze_time("2026-08-05 09:00:00"):  # 14:00 Ташкент
        now = timezone.now()
        yesterday = now - dt.timedelta(days=1)
        morning = timezone.localtime().replace(
            hour=9, minute=0, second=0, microsecond=0
        )

        # 4 вчерашних carry
        for i in range(4):
            _mk_lead(op, i, status=LeadStatus.NO_ANSWER, updated_at=yesterday)
        # 2 утренних recall (сегодня, до 13:00)
        _mk_lead(op, 100, status=LeadStatus.PHONE_ON, updated_at=morning)
        _mk_lead(op, 101, status=LeadStatus.NO_ANSWER, updated_at=morning)
        # Нужен второй recall с другим статусом, но у нас no_answer уже
        # использован — использованный лид имеет уникальный phone, статус
        # может повторяться, ок.

        # 2 свежих assigned (только что раздали, updated=сейчас)
        _mk_lead(op, 200, status=LeadStatus.ASSIGNED, updated_at=now)
        _mk_lead(op, 201, status=LeadStatus.ASSIGNED, updated_at=now)

        c = APIClient()
        c.force_authenticate(user=_operator_user(op))
        r = c.get("/api/leads/my/status/")
        assert r.status_code == 200
        body = r.data
        assert body["working_count"] == 8
        assert body["carry_count"] == 4
        assert body["recall_afternoon_count"] == 2
        assert body["today_fresh_count"] == 2
        assert body["eligible_for_new"] is False
        # Оба класса упомянуты
        assert "вчерашние" in body["reason_ru"]
        assert "после обеда" in body["reason_ru"].lower()


# ---- Permission gate -------------------------------------------------------


@pytest.mark.django_db
def test_operator_permission_ok_200():
    op = _mk_op()
    c = APIClient()
    c.force_authenticate(user=_operator_user(op))
    r = c.get("/api/leads/my/status/")
    assert r.status_code == 200


@pytest.mark.django_db
def test_manager_gets_400_no_linked_operator():
    """
    Manager проходит IsOperator (senior=True), но без linked operator в
    profile получит 400 «У пользователя не привязан оператор».
    """
    _mk_op()
    c = APIClient()
    c.force_authenticate(user=_manager_user())
    r = c.get("/api/leads/my/status/")
    assert r.status_code == 400


@pytest.mark.django_db
def test_unauthenticated_gets_401_or_403():
    c = APIClient()
    r = c.get("/api/leads/my/status/")
    assert r.status_code in (401, 403)


# ---- Postponed доступен отдельным счётчиком (не в working) ----------------


@pytest.mark.django_db
def test_postponed_count_reported_separately():
    op = _mk_op()
    with freeze_time("2026-08-05 05:00:00"):
        now = timezone.now()
        lead = _mk_lead(op, 1, status=LeadStatus.ASSIGNED, updated_at=now)
        Lead.objects.filter(pk=lead.pk).update(postponed_at=now)

        c = APIClient()
        c.force_authenticate(user=_operator_user(op))
        r = c.get("/api/leads/my/status/")
        assert r.status_code == 200
        body = r.data
        assert body["working_count"] == 0
        assert body["postponed_count"] == 1
