import pytest
from django.contrib.auth import authenticate, get_user_model
from rest_framework.exceptions import ValidationError

from apps.audit.models import AuditLog
from apps.operators.models import Operator
from apps.users.models import OperatorSecret, Profile, Role
from apps.users.services import (
    account_activate,
    account_create_for_operator,
    account_deactivate,
    account_reset_password,
    account_soft_delete,
    password_view,
)

User = get_user_model()


@pytest.fixture
def actor(db):
    manager = User.objects.create_user(username="mgr", password="mgrpass1")
    Profile.objects.create(user=manager, role=Role.MANAGER)
    return manager


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Ivan Ivanov", phone="+998901234567", status="active")


@pytest.mark.django_db
def test_create_generates_username_from_phone_and_returns_plain(actor, operator):
    user, plain = account_create_for_operator(operator=operator, actor=actor)
    assert user.username == "+998901234567"
    assert user.is_active is True
    assert user.check_password(plain) is True
    assert user.profile.role == Role.OPERATOR
    assert user.profile.operator_id == operator.id
    # audit trail written
    assert AuditLog.objects.filter(entity="users.OperatorAccount", entity_id=str(user.id)).exists()


@pytest.mark.django_db
def test_create_with_explicit_password_uses_it(actor, operator):
    user, plain = account_create_for_operator(operator=operator, actor=actor, plain="mysecret9")
    assert plain == "mysecret9"
    assert user.check_password("mysecret9") is True


@pytest.mark.django_db
def test_create_rejects_short_password(actor, operator):
    with pytest.raises(ValidationError):
        account_create_for_operator(operator=operator, actor=actor, plain="short")


@pytest.mark.django_db
def test_create_refuses_operator_with_bad_phone(actor):
    op = Operator.objects.create(full_name="No Phone", phone="", status="active")
    with pytest.raises(ValidationError):
        account_create_for_operator(operator=op, actor=actor)


@pytest.mark.django_db
def test_create_refuses_second_account_for_same_operator(actor, operator):
    account_create_for_operator(operator=operator, actor=actor)
    with pytest.raises(ValidationError):
        account_create_for_operator(operator=operator, actor=actor)


@pytest.mark.django_db
def test_view_password_returns_the_same_plain(actor, operator):
    user, plain = account_create_for_operator(operator=operator, actor=actor)
    retrieved = password_view(actor=actor, target_user=user)
    assert retrieved == plain
    # a viewer entry lands in audit
    assert AuditLog.objects.filter(
        entity="users.OperatorAccount",
        changes__kind="password_viewed",
    ).exists()


@pytest.mark.django_db
def test_reset_invalidates_old_password(actor, operator):
    user, old_plain = account_create_for_operator(operator=operator, actor=actor)
    new_plain = account_reset_password(user=user, actor=actor)
    user.refresh_from_db()
    assert new_plain != old_plain
    assert user.check_password(new_plain) is True
    assert user.check_password(old_plain) is False
    # view now returns the new one
    assert password_view(actor=actor, target_user=user) == new_plain


@pytest.mark.django_db
def test_reset_with_explicit_plain(actor, operator):
    user, _ = account_create_for_operator(operator=operator, actor=actor)
    new_plain = account_reset_password(user=user, actor=actor, plain="freshOne1")
    user.refresh_from_db()
    assert new_plain == "freshOne1"
    assert user.check_password("freshOne1") is True


@pytest.mark.django_db
def test_deactivate_blocks_login(actor, operator):
    user, plain = account_create_for_operator(operator=operator, actor=actor)
    account_deactivate(user=user, actor=actor)
    user.refresh_from_db()
    assert user.is_active is False
    # authenticate returns None for is_active=False accounts
    assert authenticate(username=user.username, password=plain) is None


@pytest.mark.django_db
def test_activate_restores_login(actor, operator):
    user, plain = account_create_for_operator(operator=operator, actor=actor)
    account_deactivate(user=user, actor=actor)
    account_activate(user=user, actor=actor)
    user.refresh_from_db()
    assert user.is_active is True
    assert authenticate(username=user.username, password=plain) is not None


@pytest.mark.django_db
def test_soft_delete_wipes_secret_and_marks_profile(actor, operator):
    user, _ = account_create_for_operator(operator=operator, actor=actor)
    account_soft_delete(user=user, actor=actor)
    user.refresh_from_db()
    assert user.is_active is False
    profile = Profile.objects.get(user=user)
    assert profile.deleted_at is not None
    assert not OperatorSecret.objects.filter(user=user).exists()
    # audit trail preserved
    assert AuditLog.objects.filter(
        entity="users.OperatorAccount",
        changes__kind="account_deleted",
    ).exists()


@pytest.mark.django_db
def test_soft_delete_lets_manager_create_a_new_account(actor, operator):
    user1, _ = account_create_for_operator(operator=operator, actor=actor)
    account_soft_delete(user=user1, actor=actor)
    # The old User.username is still occupied — we allow re-issuing a
    # new login only if the phone changes. Confirm the guard.
    operator.phone = "+998901112233"
    operator.save(update_fields=["phone"])
    user2, plain = account_create_for_operator(operator=operator, actor=actor)
    assert user2.pk != user1.pk
    assert user2.username == "+998901112233"
    assert user2.check_password(plain) is True
