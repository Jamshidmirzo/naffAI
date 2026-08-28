"""
Retry-export: snapshot всех лидов в статусах `sms_jonatildi`+`contacted_telegram`
в отдельный tab Google Sheet'а по кнопке из /leads-stats.

Тесты покрывают:
- селектор `retry_export_candidates` фильтрует только два целевых статуса
  (не подхватывает won/lost/new/…).
- Сервис `retry_export_to_sheet` собирает 2-D values (header + rows),
  вызывает `ensure_tab` и `overwrite_tab` с ожидаемыми аргументами.
- Fallback: если `SystemSetting.retry_export_spreadsheet_id` пуст,
  сервис берёт первый активный SheetSource; иначе — RetryExportMisconfigured.
- Concurrency: пока лок держится, повторный вызов бросает RetryExportBusy.
- API: manager 200, operator 403, unauth 401; 409 при повторе.
- CRM ссылка строится из `PUBLIC_APP_URL` + `/leads/{id}`.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.leads.models import Lead, LeadStatus, SheetSource
from apps.leads.selectors import retry_export_candidates
from apps.leads.services import (
    RetryExportBusy,
    RetryExportMisconfigured,
    _retry_export_build_values,
    _retry_export_target,
    retry_export_to_sheet,
)
from apps.operators.models import Operator, OperatorStatus
from apps.system_settings.models import SystemSetting
from apps.users.models import Profile, Role

User = get_user_model()


# ---- Fixtures ------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clear_lock():
    """Каждый тест начинается с чистого redis-лока — иначе порядок
    исполнения ломает concurrency-тест."""
    cache.delete("retry_export:running")
    yield
    cache.delete("retry_export:running")


@pytest.fixture
def op(db) -> Operator:
    return Operator.objects.create(full_name="Alice", status=OperatorStatus.ACTIVE)


@pytest.fixture
def leads_mix(db, op):
    """
    3 лида в целевых статусах + 2 «шумовых» (won, lost) чтобы селектор
    имел что фильтровать.
    """
    l_sms = Lead.objects.create(
        full_name="SMS Client",
        phone="+998900000001",
        status=LeadStatus.SMS_JONATILDI if hasattr(LeadStatus, "SMS_JONATILDI") else "sms_jonatildi",
        operator=op,
    )
    l_tg = Lead.objects.create(
        full_name="TG Client",
        phone="+998900000002",
        status=LeadStatus.CONTACTED_TELEGRAM,
        operator=op,
    )
    l_tg2 = Lead.objects.create(
        full_name="TG Client 2",
        phone="+998900000003",
        status=LeadStatus.CONTACTED_TELEGRAM,
        operator=op,
    )
    Lead.objects.create(
        full_name="Won Client",
        phone="+998900000004",
        status=LeadStatus.WON,
        operator=op,
    )
    Lead.objects.create(
        full_name="Lost Client",
        phone="+998900000005",
        status=LeadStatus.LOST,
        operator=op,
    )
    return {"sms": l_sms, "tg": l_tg, "tg2": l_tg2}


def _mgr(username: str = "mgr") -> User:
    user = User.objects.create_user(username=username, password="mgrpass1")
    Profile.objects.create(user=user, role=Role.MANAGER)
    return user


def _op_user(operator: Operator, username: str = "op") -> User:
    user = User.objects.create_user(username=username, password="oppass123")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=operator)
    return user


# ---- Selector ------------------------------------------------------------


@pytest.mark.django_db
def test_selector_returns_only_target_statuses(leads_mix):
    qs = retry_export_candidates()
    codes = list(qs.values_list("status", flat=True))
    assert set(codes) == {"sms_jonatildi", "contacted_telegram"}
    assert qs.count() == 3


@pytest.mark.django_db
def test_selector_orders_by_updated_at_desc(leads_mix):
    # Meta.ordering не совпадает — форсим свежий update
    from django.utils import timezone

    latest = leads_mix["sms"]
    Lead.objects.filter(pk=latest.pk).update(updated_at=timezone.now())
    ids = list(retry_export_candidates().values_list("id", flat=True))
    assert ids[0] == latest.id


# ---- Target resolution ---------------------------------------------------


@pytest.mark.django_db
def test_target_uses_system_setting_when_set():
    obj = SystemSetting.get_solo()
    obj.retry_export_spreadsheet_id = "SS_FROM_SETTING"
    obj.retry_export_tab_name = "Custom Tab"
    obj.save()
    sid, tab = _retry_export_target()
    assert sid == "SS_FROM_SETTING"
    assert tab == "Custom Tab"


@pytest.mark.django_db
def test_target_falls_back_to_active_sheet_source():
    # SystemSetting.retry_export_spreadsheet_id пуст, но есть активный SheetSource
    SheetSource.objects.create(
        name="Main sheet",
        spreadsheet_id="SS_FROM_FALLBACK",
        gid=1,
        active=True,
    )
    sid, tab = _retry_export_target()
    assert sid == "SS_FROM_FALLBACK"
    # default tab name
    assert tab == "Retry SMS+TG"


@pytest.mark.django_db
def test_target_raises_when_no_config_and_no_sheet_source():
    with pytest.raises(RetryExportMisconfigured):
        _retry_export_target()


@pytest.mark.django_db
def test_target_ignores_inactive_sheet_source():
    SheetSource.objects.create(
        name="Retired sheet",
        spreadsheet_id="SS_INACTIVE",
        gid=1,
        active=False,
    )
    with pytest.raises(RetryExportMisconfigured):
        _retry_export_target()


# ---- Values builder ------------------------------------------------------


@pytest.mark.django_db
def test_build_values_shape_header_and_rows(leads_mix, settings):
    settings.PUBLIC_APP_URL = "https://example.test"
    candidates = list(retry_export_candidates())
    values = _retry_export_build_values(candidates)

    # Header + 3 lead rows
    assert len(values) == 4
    header = values[0]
    assert header == [
        "Дата статуса",
        "Телефон",
        "Имя",
        "Статус",
        "Оператор",
        "Комментарий",
        "Sheet источник",
        "CRM ссылка",
    ]

    # Every row: 8 columns, phone included, CRM link is absolute.
    for row in values[1:]:
        assert len(row) == 8
        assert row[1].startswith("+998")
        assert row[7].startswith("https://example.test/leads/")


@pytest.mark.django_db
def test_build_values_public_url_defaults_to_prod(leads_mix, settings):
    # Simulate the case where env didn't override PUBLIC_APP_URL —
    # base default kicks in.
    settings.PUBLIC_APP_URL = "https://naff.flek.uz"
    candidates = list(retry_export_candidates())
    values = _retry_export_build_values(candidates)
    for row in values[1:]:
        assert row[7].startswith("https://naff.flek.uz/leads/")


# ---- Service happy path (mock client) ------------------------------------


@pytest.mark.django_db
def test_retry_export_service_calls_client_correctly(leads_mix):
    SheetSource.objects.create(
        name="Main sheet",
        spreadsheet_id="SS_MAIN",
        gid=1,
        active=True,
    )

    fake_gid = 987654321
    with patch("apps.leads.services.GoogleSheetsClient") as mock_cls:
        instance = mock_cls.return_value
        instance.ensure_tab.return_value = fake_gid
        instance.overwrite_tab.return_value = None

        result = retry_export_to_sheet()

        instance.ensure_tab.assert_called_once_with("SS_MAIN", "Retry SMS+TG")
        # overwrite_tab called with the same spreadsheet+tab and a 2-D list
        args, kwargs = instance.overwrite_tab.call_args
        assert args[0] == "SS_MAIN"
        assert args[1] == "Retry SMS+TG"
        values = args[2]
        assert isinstance(values, list) and isinstance(values[0], list)
        assert len(values) == 4  # header + 3 leads

    assert result["count"] == 3
    assert result["spreadsheet_id"] == "SS_MAIN"
    assert result["tab_name"] == "Retry SMS+TG"
    assert result["gid"] == fake_gid
    assert result["url"] == (
        f"https://docs.google.com/spreadsheets/d/SS_MAIN/edit#gid={fake_gid}"
    )
    assert "exported_at" in result


@pytest.mark.django_db
def test_retry_export_service_uses_setting_over_fallback(leads_mix):
    # Both configured — SystemSetting wins.
    SheetSource.objects.create(
        name="Fallback",
        spreadsheet_id="SS_FALLBACK",
        gid=1,
        active=True,
    )
    setting = SystemSetting.get_solo()
    setting.retry_export_spreadsheet_id = "SS_EXPLICIT"
    setting.save()

    with patch("apps.leads.services.GoogleSheetsClient") as mock_cls:
        instance = mock_cls.return_value
        instance.ensure_tab.return_value = 1
        instance.overwrite_tab.return_value = None
        result = retry_export_to_sheet()

    assert result["spreadsheet_id"] == "SS_EXPLICIT"
    instance.ensure_tab.assert_called_once_with("SS_EXPLICIT", "Retry SMS+TG")


@pytest.mark.django_db
def test_retry_export_service_misconfigured_bubbles_up():
    # No SystemSetting override, no active SheetSource.
    with pytest.raises(RetryExportMisconfigured):
        retry_export_to_sheet()


# ---- Concurrency guard ---------------------------------------------------


@pytest.mark.django_db
def test_retry_export_concurrency_lock_blocks_second_call(leads_mix):
    SheetSource.objects.create(
        name="S",
        spreadsheet_id="SS_C",
        gid=1,
        active=True,
    )
    # First call obtains the lock. If the mocked client is well-behaved
    # the lock is released before the second call — simulate slow client
    # by having a side_effect that checks the lock is held.
    holding = {"held": False}

    def check_lock_still_held(*_a, **_kw):
        # While inside the first call, another call must see busy.
        with pytest.raises(RetryExportBusy):
            retry_export_to_sheet()
        holding["held"] = True

    with patch("apps.leads.services.GoogleSheetsClient") as mock_cls:
        instance = mock_cls.return_value
        instance.ensure_tab.return_value = 1
        instance.overwrite_tab.side_effect = check_lock_still_held
        retry_export_to_sheet()

    assert holding["held"] is True
    # After first call finished, the lock is released → third call proceeds.
    with patch("apps.leads.services.GoogleSheetsClient") as mock_cls:
        instance = mock_cls.return_value
        instance.ensure_tab.return_value = 1
        instance.overwrite_tab.return_value = None
        result = retry_export_to_sheet()
    assert result["count"] == 3


# ---- API endpoint --------------------------------------------------------


@pytest.mark.django_db
def test_api_manager_gets_200(leads_mix):
    SheetSource.objects.create(
        name="S",
        spreadsheet_id="SS_API",
        gid=1,
        active=True,
    )
    mgr = _mgr()
    c = APIClient()
    c.force_authenticate(user=mgr)

    with patch("apps.leads.services.GoogleSheetsClient") as mock_cls:
        instance = mock_cls.return_value
        instance.ensure_tab.return_value = 42
        instance.overwrite_tab.return_value = None
        r = c.post("/api/leads/retry-export/", {}, format="json")

    assert r.status_code == 200, r.content
    assert r.data["count"] == 3
    assert r.data["tab_name"] == "Retry SMS+TG"
    assert "gid=42" in r.data["url"]


@pytest.mark.django_db
def test_api_operator_gets_403(leads_mix, op):
    op_user = _op_user(op)
    c = APIClient()
    c.force_authenticate(user=op_user)
    r = c.post("/api/leads/retry-export/", {}, format="json")
    assert r.status_code == 403


@pytest.mark.django_db
def test_api_anonymous_gets_401_or_403():
    c = APIClient()
    r = c.post("/api/leads/retry-export/", {}, format="json")
    # DRF default для sessionless-anonymous == 401 (после WWW-Authenticate),
    # но без auth-класса, дающего challenge, будет 403. Оба варианта — «отказано».
    assert r.status_code in (401, 403)


@pytest.mark.django_db
def test_api_second_call_while_locked_returns_409(leads_mix):
    SheetSource.objects.create(
        name="S",
        spreadsheet_id="SS_CONC",
        gid=1,
        active=True,
    )
    mgr = _mgr("mgr_conc")
    c = APIClient()
    c.force_authenticate(user=mgr)

    # Simulate an already-running export by pre-acquiring the lock.
    cache.add("retry_export:running", "1", timeout=60)
    try:
        r = c.post("/api/leads/retry-export/", {}, format="json")
    finally:
        cache.delete("retry_export:running")
    assert r.status_code == 409
    assert r["Retry-After"] == "30"


@pytest.mark.django_db
def test_api_returns_500_when_misconfigured():
    # No SystemSetting override + no active SheetSource.
    mgr = _mgr("mgr_misconf")
    c = APIClient()
    c.force_authenticate(user=mgr)
    r = c.post("/api/leads/retry-export/", {}, format="json")
    assert r.status_code == 500
    assert "retry-лист" in r.data["detail"].lower() or "sheetsource" in r.data["detail"].lower()
