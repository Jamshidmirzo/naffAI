"""
Тесты management-команды `create_superadmin`.
Идемпотентная: повторный запуск обновляет пароль + роль.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command

from apps.users.models import Profile, Role


User = get_user_model()


@pytest.mark.django_db
def test_creates_superadmin_first_run():
    call_command(
        "create_superadmin",
        login="opercoder_new",
        password="opercoder_pw",
        phone="+998955554727",
    )
    u = User.objects.get(username="opercoder_new")
    assert u.is_active is True
    assert u.check_password("opercoder_pw") is True
    assert u.profile.role == Role.SUPERADMIN


@pytest.mark.django_db
def test_second_run_is_idempotent_and_resets_password():
    call_command(
        "create_superadmin",
        login="opercoder_dup",
        password="firstpass1",
        phone="+998955554727",
    )
    # Reactivation path: manually block user, then re-run.
    u = User.objects.get(username="opercoder_dup")
    u.is_active = False
    u.save(update_fields=["is_active"])
    Profile.objects.filter(user=u).update(role=Role.MANAGER)

    call_command(
        "create_superadmin",
        login="opercoder_dup",
        password="secondpass2",
        phone="+998955554727",
    )
    u.refresh_from_db()
    assert u.is_active is True
    assert u.check_password("secondpass2") is True
    assert u.profile.role == Role.SUPERADMIN


@pytest.mark.django_db
def test_rejects_short_password():
    from django.core.management.base import CommandError

    with pytest.raises(CommandError):
        call_command(
            "create_superadmin",
            login="short",
            password="abc",  # <8 chars
        )
