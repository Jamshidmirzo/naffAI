"""
Тесты для SystemSetting.retry_export_statuses:
- селектор `get_retry_export_statuses` возвращает дефолт при пустом поле
  и кастом при непустом;
- сервис `retry_export_statuses_update` валидирует код через LeadStatusLabel;
- endpoint /api/settings/retry-export/ (GET + PATCH):
  * manager 200, operator 403, unauth 401/403;
  * PATCH с неизвестным code → 400;
  * пустой список разрешён (сброс на дефолт).
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.leads.models import LeadStatusLabel
from apps.leads.selectors import retry_export_candidates
from apps.operators.models import Operator, OperatorStatus
from apps.system_settings.models import SystemSetting
from apps.system_settings.selectors import (
    DEFAULT_RETRY_EXPORT_STATUSES,
    get_retry_export_statuses,
)
from apps.system_settings.services import retry_export_statuses_update
from apps.users.models import Profile, Role

User = get_user_model()


def _mgr(username: str = "mgr") -> User:
    user = User.objects.create_user(username=username, password="mgrpass1")
    Profile.objects.create(user=user, role=Role.MANAGER)
    return user


def _op_user(operator: Operator, username: str = "op") -> User:
    user = User.objects.create_user(username=username, password="oppass123")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=operator)
    return user


def _seed_label(code: str, label_ru: str) -> LeadStatusLabel:
    """LeadStatusLabel seeding — 0007 data migration уже сажает 13 builtin
    статусов; здесь просто get_or_create'им, чтобы тест не крашился если
    seed ещё не прогнали (fresh test DB)."""
    obj, _ = LeadStatusLabel.objects.get_or_create(
        code=code,
        defaults={"label_ru": label_ru, "is_active": True, "is_builtin": True},
    )
    return obj


# ---- Selector ------------------------------------------------------------


@pytest.mark.django_db
def test_selector_empty_field_returns_default():
    obj = SystemSetting.get_solo()
    obj.retry_export_statuses = []
    obj.save(update_fields=["retry_export_statuses", "updated_at"])
    assert get_retry_export_statuses() == list(DEFAULT_RETRY_EXPORT_STATUSES)


@pytest.mark.django_db
def test_selector_custom_field_returns_custom():
    obj = SystemSetting.get_solo()
    obj.retry_export_statuses = ["a", "b"]
    obj.save(update_fields=["retry_export_statuses", "updated_at"])
    assert get_retry_export_statuses() == ["a", "b"]


@pytest.mark.django_db
def test_selector_filters_out_non_string_garbage():
    obj = SystemSetting.get_solo()
    obj.retry_export_statuses = ["a", "", None, 123, "b"]
    obj.save(update_fields=["retry_export_statuses", "updated_at"])
    assert get_retry_export_statuses() == ["a", "b"]


# ---- Service -------------------------------------------------------------


@pytest.mark.django_db
def test_service_persists_and_writes_audit():
    _seed_label("no_answer", "Не ответил")
    _seed_label("contacted_telegram", "TG")
    user = _mgr()
    obj = retry_export_statuses_update(
        user=user, statuses=["no_answer", "contacted_telegram"]
    )
    assert obj.retry_export_statuses == ["no_answer", "contacted_telegram"]


@pytest.mark.django_db
def test_service_rejects_unknown_code():
    _seed_label("no_answer", "Не ответил")
    from django.core.exceptions import ValidationError

    with pytest.raises(ValidationError):
        retry_export_statuses_update(
            user=None, statuses=["no_answer", "definitely_not_a_status"]
        )


@pytest.mark.django_db
def test_service_empty_list_is_ok_and_falls_back_to_default():
    obj = retry_export_statuses_update(user=None, statuses=[])
    assert obj.retry_export_statuses == []
    # А селектор всё равно вернёт дефолт.
    assert get_retry_export_statuses() == list(DEFAULT_RETRY_EXPORT_STATUSES)


# ---- API GET -------------------------------------------------------------


@pytest.mark.django_db
def test_api_get_returns_current_and_available():
    _seed_label("no_answer", "Не ответил")
    _seed_label("contacted_telegram", "TG")
    user = _mgr()
    c = APIClient()
    c.force_authenticate(user=user)

    r = c.get("/api/settings/retry-export/")
    assert r.status_code == 200, r.content
    body = r.data
    # По дефолту (пустой список в БД) — вернуть 4 дефолтных кода.
    assert body["statuses"] == list(DEFAULT_RETRY_EXPORT_STATUSES)
    codes_in_available = {row["code"] for row in body["available"]}
    assert "no_answer" in codes_in_available
    assert "contacted_telegram" in codes_in_available


# ---- API PATCH -----------------------------------------------------------


@pytest.mark.django_db
def test_api_patch_saves_new_selection():
    _seed_label("no_answer", "Не ответил")
    _seed_label("contacted_telegram", "TG")
    user = _mgr()
    c = APIClient()
    c.force_authenticate(user=user)

    r = c.patch(
        "/api/settings/retry-export/",
        {"statuses": ["no_answer", "contacted_telegram"]},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.data["statuses"] == ["no_answer", "contacted_telegram"]

    obj = SystemSetting.get_solo()
    assert obj.retry_export_statuses == ["no_answer", "contacted_telegram"]


@pytest.mark.django_db
def test_api_patch_rejects_unknown_code():
    _seed_label("no_answer", "Не ответил")
    user = _mgr("mgr2")
    c = APIClient()
    c.force_authenticate(user=user)

    r = c.patch(
        "/api/settings/retry-export/",
        {"statuses": ["no_answer", "not_a_real_code"]},
        format="json",
    )
    assert r.status_code == 400


@pytest.mark.django_db
def test_api_patch_operator_forbidden():
    op = Operator.objects.create(full_name="Op", status=OperatorStatus.ACTIVE)
    user = _op_user(op)
    c = APIClient()
    c.force_authenticate(user=user)

    r = c.patch(
        "/api/settings/retry-export/", {"statuses": []}, format="json"
    )
    assert r.status_code == 403


@pytest.mark.django_db
def test_api_get_anon_forbidden():
    c = APIClient()
    r = c.get("/api/settings/retry-export/")
    assert r.status_code in (401, 403)


# ---- Integration: селектор retry_export_candidates использует новое поле -


@pytest.mark.django_db
def test_retry_export_candidates_uses_setting():
    """Селектор `retry_export_candidates` должен фильтровать лидов по
    статусам, сохранённым в SystemSetting."""
    from apps.leads.models import Lead, LeadStatus

    op = Operator.objects.create(full_name="Op", status=OperatorStatus.ACTIVE)
    # Seed builtin labels
    _seed_label("no_answer", "Не ответил")
    _seed_label("contacted_telegram", "TG")

    Lead.objects.create(
        full_name="A", phone="+998900000001", status="no_answer", operator=op
    )
    Lead.objects.create(
        full_name="B",
        phone="+998900000002",
        status=LeadStatus.CONTACTED_TELEGRAM,
        operator=op,
    )
    Lead.objects.create(
        full_name="Won",
        phone="+998900000003",
        status=LeadStatus.WON,
        operator=op,
    )

    # По дефолту — SMS+TG+no_answer+no_answer_2 → селектор возвращает 2 (won не считается).
    assert retry_export_candidates().count() == 2

    # Меняем через сервис — только no_answer.
    retry_export_statuses_update(user=None, statuses=["no_answer"])
    codes = list(retry_export_candidates().values_list("status", flat=True))
    assert codes == ["no_answer"]
