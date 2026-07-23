import pytest
from django.contrib.auth import get_user_model
from rest_framework.exceptions import ValidationError

from apps.operators.models import Operator
from apps.users.models import Profile, Role
from apps.users.services import (
    account_create_for_operator,
    password_view,
    self_change_password,
)

User = get_user_model()


@pytest.fixture
def actor(db):
    manager = User.objects.create_user(username="mgr", password="mgrpass1")
    Profile.objects.create(user=manager, role=Role.MANAGER)
    return manager


@pytest.fixture
def operator_user(db, actor):
    op = Operator.objects.create(full_name="Op", phone="+998901234567", status="active")
    user, plain = account_create_for_operator(operator=op, actor=actor)
    return user, plain


@pytest.mark.django_db
def test_operator_changes_password_manager_sees_new_one(operator_user, actor):
    user, old_plain = operator_user
    self_change_password(user=user, old_password=old_plain, new_password="brandNew1")
    user.refresh_from_db()
    assert user.check_password("brandNew1")
    assert user.check_password(old_plain) is False
    # Manager sees the fresh plaintext now, not the previous one
    assert password_view(actor=actor, target_user=user) == "brandNew1"


@pytest.mark.django_db
def test_self_change_rejects_wrong_old_password(operator_user):
    user, _ = operator_user
    with pytest.raises(ValidationError):
        self_change_password(user=user, old_password="wrongwrong", new_password="brandNew1")


@pytest.mark.django_db
def test_self_change_rejects_short_new_password(operator_user):
    user, plain = operator_user
    with pytest.raises(ValidationError):
        self_change_password(user=user, old_password=plain, new_password="short")
