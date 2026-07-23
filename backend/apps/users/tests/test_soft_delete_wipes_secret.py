"""
account_soft_delete must remove the reversibly-encrypted OperatorSecret
row in the same transaction — otherwise a soft-deleted account still
holds a decryptable plaintext password on disk.

The behaviour is already covered indirectly by
test_soft_delete_wipes_secret_and_marks_profile in
test_account_lifecycle.py; this file is the Wave 1.5 acceptance test
named per spec.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model

from apps.operators.models import Operator
from apps.users.models import OperatorSecret, Profile, Role
from apps.users.services import account_create_for_operator, account_soft_delete

User = get_user_model()


@pytest.fixture
def actor(db):
    manager = User.objects.create_user(username="mgr", password="mgrpass1")
    Profile.objects.create(user=manager, role=Role.MANAGER)
    return manager


@pytest.fixture
def operator(db):
    return Operator.objects.create(
        full_name="Ivan Ivanov", phone="+998901234567", status="active"
    )


@pytest.mark.django_db
def test_account_soft_delete_clears_operator_secret(actor, operator):
    user, _plain = account_create_for_operator(operator=operator, actor=actor)
    assert OperatorSecret.objects.filter(user=user).exists()

    account_soft_delete(user=user, actor=actor)

    # Secret must be gone; the user row itself stays (audit trail).
    assert not OperatorSecret.objects.filter(user=user).exists()
    user.refresh_from_db()
    assert user.is_active is False
