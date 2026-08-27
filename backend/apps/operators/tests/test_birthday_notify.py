"""
Management command `birthday_notify` — идентификация именинников,
идемпотентность, --dry-run, --date override, edge-case 29.02.

TG DM мокаем (aiogram не должен реально уходить в сеть).
Notification создаём — проверяем реальный Django ORM.
"""

from __future__ import annotations

import datetime as dt
from io import StringIO
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command

from apps.notifications.models import Notification, NotificationKind
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()


def _run(**kwargs) -> str:
    """Run birthday_notify collecting stdout."""
    out = StringIO()
    call_command("birthday_notify", stdout=out, **kwargs)
    return out.getvalue()


@pytest.fixture
def manager_user(db):
    u = User.objects.create_user(username="mgr1", password="x", is_active=True)
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def team_lead_user(db):
    u = User.objects.create_user(username="tl1", password="x", is_active=True)
    Profile.objects.create(user=u, role=Role.TEAM_LEAD)
    return u


@pytest.fixture
def op_birthday_today(db):
    return Operator.objects.create(
        full_name="Именинница Иванова",
        status="active",
        phone="+998900000042",
        birth_date=dt.date(1990, 6, 15),
    )


@pytest.fixture
def op_no_bd(db):
    return Operator.objects.create(full_name="Без даты", status="active", birth_date=None)


@pytest.fixture
def op_inactive_birthday(db):
    return Operator.objects.create(
        full_name="Уволен Иванов",
        status="inactive",
        birth_date=dt.date(1990, 6, 15),
    )


@pytest.fixture(autouse=True)
def _no_real_tg_send():
    """Patch aiogram Bot to no-op — тесты не должны ходить в сеть."""
    with patch("apps.operators.management.commands.birthday_notify._send_dm", return_value=True):
        yield


@pytest.mark.django_db
def test_notifies_managers_for_birthday_operator(
    op_birthday_today, manager_user, team_lead_user
):
    out = _run(date="2030-06-15")
    assert "op#" in out

    op_birthday_today.refresh_from_db()
    assert op_birthday_today.birthday_notified_on == dt.date(2030, 6, 15)

    notifs = Notification.objects.filter(kind=NotificationKind.BIRTHDAY)
    recipients = set(notifs.values_list("recipient_id", flat=True))
    assert manager_user.id in recipients
    assert team_lead_user.id in recipients

    row = notifs.filter(recipient=manager_user).first()
    assert row is not None
    assert op_birthday_today.full_name in row.title
    assert row.metadata["operator_id"] == op_birthday_today.id
    assert row.metadata["age"] == 40  # 2030 - 1990
    assert row.metadata["birth_date"] == "1990-06-15"
    assert row.link == f"/operators/{op_birthday_today.id}"


@pytest.mark.django_db
def test_idempotent_second_run_same_day(op_birthday_today, manager_user):
    _run(date="2030-06-15")
    first_count = Notification.objects.filter(kind=NotificationKind.BIRTHDAY).count()

    _run(date="2030-06-15")
    second_count = Notification.objects.filter(kind=NotificationKind.BIRTHDAY).count()
    assert first_count == second_count, (
        "второй запуск за тот же день не должен дублировать уведомления"
    )


@pytest.mark.django_db
def test_dry_run_does_not_mutate(op_birthday_today, manager_user):
    out = _run(dry_run=True, date="2030-06-15")
    assert "dry_run=True" in out
    assert Notification.objects.filter(kind=NotificationKind.BIRTHDAY).count() == 0

    op_birthday_today.refresh_from_db()
    assert op_birthday_today.birthday_notified_on is None


@pytest.mark.django_db
def test_null_birth_date_skipped(op_no_bd, manager_user):
    _run(date="2030-06-15")
    assert Notification.objects.filter(kind=NotificationKind.BIRTHDAY).count() == 0


@pytest.mark.django_db
def test_inactive_operator_skipped(op_inactive_birthday, manager_user):
    _run(date="2030-06-15")
    assert Notification.objects.filter(kind=NotificationKind.BIRTHDAY).count() == 0


@pytest.mark.django_db
def test_year_of_birth_is_ignored(op_birthday_today, manager_user):
    """
    Оператор родился в 1990 → каждый год ДР срабатывает.
    Проверяем 3 разных года.
    """
    for year, expected_age in [(2020, 30), (2030, 40), (2035, 45)]:
        Notification.objects.all().delete()
        # Reset guard so cron re-fires.
        op_birthday_today.birthday_notified_on = None
        op_birthday_today.save(update_fields=["birthday_notified_on"])

        _run(date=f"{year}-06-15")
        row = Notification.objects.filter(kind=NotificationKind.BIRTHDAY).first()
        assert row is not None, f"нет уведомления в {year} году"
        assert row.metadata["age"] == expected_age


@pytest.mark.django_db
def test_feb29_non_leap_year_notified_on_feb28(db, manager_user):
    op = Operator.objects.create(
        full_name="Феврал Марта", status="active", birth_date=dt.date(2000, 2, 29)
    )
    _run(date="2027-02-28")  # 2027 — не високосный
    row = Notification.objects.filter(
        kind=NotificationKind.BIRTHDAY, metadata__operator_id=op.id
    ).first()
    assert row is not None, "29-февральский оператор должен получить поздравление 28 фев в невисокосный год"
    assert row.metadata["age"] == 27  # 2027 - 2000


@pytest.mark.django_db
def test_feb29_leap_year_notified_on_feb29(db, manager_user):
    op = Operator.objects.create(
        full_name="Феврал Марта", status="active", birth_date=dt.date(2000, 2, 29)
    )
    # 28 фев 2028 — високосный год: 28-го не должно быть матча
    _run(date="2028-02-28")
    assert not Notification.objects.filter(metadata__operator_id=op.id).exists()

    # Reset guard just in case
    op.refresh_from_db()
    assert op.birthday_notified_on is None

    # 29 фев 2028 — теперь матч
    _run(date="2028-02-29")
    row = Notification.objects.filter(
        kind=NotificationKind.BIRTHDAY, metadata__operator_id=op.id
    ).first()
    assert row is not None


@pytest.mark.django_db
def test_no_managers_no_notifications_but_guard_still_set(op_birthday_today, db):
    """
    Если менеджеров нет вообще — guard всё равно ставим, чтобы cron не
    крутил впустую каждую ночь.
    """
    _run(date="2030-06-15")
    assert Notification.objects.count() == 0
    op_birthday_today.refresh_from_db()
    assert op_birthday_today.birthday_notified_on == dt.date(2030, 6, 15)


@pytest.mark.django_db
def test_tg_dm_dispatched_when_manager_linked_tg(op_birthday_today, manager_user, settings):
    """
    Если менеджер /link'нул Telegram (Profile.telegram_user_id заполнен)
    → _send_dm вызывается с его chat_id. Мы просто проверяем, что вызов
    состоялся с правильным chat_id.
    """
    manager_user.profile.telegram_user_id = 123456789
    manager_user.profile.save(update_fields=["telegram_user_id"])
    settings.TELEGRAM_BOT_TOKEN = "test-token"

    with patch(
        "apps.operators.management.commands.birthday_notify._send_dm",
        return_value=True,
    ) as mock_send:
        _run(date="2030-06-15")
        assert mock_send.called, "TG DM должен был отправиться менеджеру с linked TG"
        call_args = mock_send.call_args_list[0]
        # Chat id — первый позиционный аргумент _send_dm(chat_id, text, token).
        assert call_args.args[0] == 123456789


@pytest.mark.django_db
def test_no_tg_dm_when_manager_has_no_linked_tg(op_birthday_today, manager_user, settings):
    """
    Менеджер без telegram_user_id → TG DM не шлём (только in-app).
    """
    assert manager_user.profile.telegram_user_id is None
    settings.TELEGRAM_BOT_TOKEN = "test-token"

    with patch(
        "apps.operators.management.commands.birthday_notify._send_dm",
        return_value=True,
    ) as mock_send:
        _run(date="2030-06-15")
        assert not mock_send.called

    # In-app всё равно создано.
    assert Notification.objects.filter(
        kind=NotificationKind.BIRTHDAY, recipient=manager_user
    ).exists()
