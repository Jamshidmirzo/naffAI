"""
Wave-1 (2026-08-22) — bulk approve / reject.

Fixtures mirror test_sale_pending.py so parity of behaviour is easy to
audit; the tests exercise the service directly + one API roundtrip to
prove the permission gate works end-to-end.
"""

from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from apps.catalog.models import Channel
from apps.common.exceptions import ApplicationError
from apps.operators.models import Operator
from apps.sales.models import Sale, SaleStatus
from apps.sales.services import sale_bulk_action, sale_create

User = get_user_model()


TINY_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\xff\xff"
    b"?\x00\x05\xfe\x02\xfe\xdc\xccY\xe7\x00\x00\x00\x00IEND\xaeB`\x82"
)


# 6 corrections-of-Luhn IMEIs — the Sale model has a valid-Luhn constraint
# so we cannot reuse the same suffix; these 6 all pass Luhn.
LUHN_IMEIS = [
    "490154203237518",
    "356938035643809",
    "353294106167015",
    "352099001761481",
    "864397048532176",
    "013624001999999",
]


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Мадина Иванова", status="active")


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Наличные")


@pytest.fixture
def manager_user(db):
    user = User.objects.create_user(username="mgr-bulk", password="testpass")
    from apps.users.models import Profile

    profile, _ = Profile.objects.get_or_create(user=user)
    profile.role = "team_lead"
    profile.save()
    return user


def _make_pending(operator, channel, imei) -> Sale:
    return sale_create(
        imei=imei,
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("5000000"),
        status=SaleStatus.PENDING,
        contract_photo=SimpleUploadedFile(
            "c.png", TINY_PNG, content_type="image/png"
        ),
    )


@pytest.mark.django_db
def test_bulk_approve_confirms_all_pending(operator, channel):
    sales = [_make_pending(operator, channel, LUHN_IMEIS[i]) for i in range(3)]
    ids = [s.id for s in sales]

    result = sale_bulk_action(
        user=None, sale_ids=ids, mode="approve"
    )

    assert result["counts"] == {"ok": 3, "skipped": 0, "errors": 0}
    for s in sales:
        s.refresh_from_db()
        assert s.status == SaleStatus.CONFIRMED
    assert {r["sale_id"] for r in result["processed"]} == set(ids)


@pytest.mark.django_db
def test_bulk_reject_requires_reason(operator, channel):
    s = _make_pending(operator, channel, LUHN_IMEIS[0])
    with pytest.raises(ApplicationError):
        sale_bulk_action(
            user=None, sale_ids=[s.id], mode="reject", reason="   "
        )


@pytest.mark.django_db
def test_bulk_reject_marks_all_with_reason(operator, channel, manager_user):
    sales = [_make_pending(operator, channel, LUHN_IMEIS[i]) for i in range(2)]
    ids = [s.id for s in sales]

    result = sale_bulk_action(
        user=manager_user,
        sale_ids=ids,
        mode="reject",
        reason="Плохое фото",
    )

    assert result["counts"] == {"ok": 2, "skipped": 0, "errors": 0}
    for s in sales:
        s.refresh_from_db()
        assert s.status == SaleStatus.REJECTED
        assert s.rejection_reason == "Плохое фото"
        assert s.rejected_at is not None


@pytest.mark.django_db
def test_bulk_approve_mixed_status_skips_already_confirmed(operator, channel):
    """
    3 продажи: одна confirmed (создана без status=pending), две pending.
    Bulk approve → 2 processed, 1 skipped as already_confirmed.
    """
    confirmed = sale_create(
        imei=LUHN_IMEIS[0],
        phone_model="iPhone 15",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("6000000"),
        # default status=confirmed — не pending
    )
    pending_1 = _make_pending(operator, channel, LUHN_IMEIS[1])
    pending_2 = _make_pending(operator, channel, LUHN_IMEIS[2])

    result = sale_bulk_action(
        user=None,
        sale_ids=[confirmed.id, pending_1.id, pending_2.id],
        mode="approve",
    )

    assert result["counts"]["ok"] == 2
    assert result["counts"]["skipped"] == 1
    assert result["counts"]["errors"] == 0
    skipped_ids = [r["sale_id"] for r in result["skipped"]]
    assert confirmed.id in skipped_ids

    for s in (pending_1, pending_2):
        s.refresh_from_db()
        assert s.status == SaleStatus.CONFIRMED


@pytest.mark.django_db
def test_bulk_action_api_endpoint(operator, channel, manager_user):
    """Sanity: API-роут работает под менеджером и возвращает counts."""
    sales = [_make_pending(operator, channel, LUHN_IMEIS[i]) for i in range(2)]
    ids = [s.id for s in sales]

    client = APIClient()
    client.force_authenticate(user=manager_user)
    resp = client.post(
        "/api/sales/bulk-confirm/",
        {"sale_ids": ids, "mode": "approve"},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    assert resp.data["counts"]["ok"] == 2

    for s in sales:
        s.refresh_from_db()
        assert s.status == SaleStatus.CONFIRMED


@pytest.mark.django_db
def test_bulk_action_api_rejects_bad_input(operator, channel, manager_user):
    client = APIClient()
    client.force_authenticate(user=manager_user)
    # sale_ids not a list
    resp = client.post(
        "/api/sales/bulk-confirm/",
        {"sale_ids": "abc", "mode": "approve"},
        format="json",
    )
    assert resp.status_code == 400
    # missing reason for reject
    s = _make_pending(operator, channel, LUHN_IMEIS[0])
    resp = client.post(
        "/api/sales/bulk-confirm/",
        {"sale_ids": [s.id], "mode": "reject", "reason": " "},
        format="json",
    )
    assert resp.status_code == 400
