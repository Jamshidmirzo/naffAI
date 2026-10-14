"""
Design-atlas V2 backend follow-ups (2026-10-14):

1. IMEI duplicate check ignores rejected sales (resubmit after rejection).
2. ImeiLookupApi is open to operators (see apps/catalog/tests too).
3. SaleDetailApi: operator can read sales where they're in a split line.
4. SaleSerializer exposes read-only `lead_id`.
5. /api/sales/mine/ returns returned sales + date_from/date_to filters.
"""

import datetime as dt
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.catalog.models import Channel
from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator
from apps.sales.models import Sale, SaleOperator, SaleStatus
from apps.sales.selectors import sale_imei_duplicate_count
from apps.sales.services import DuplicateError, sale_create
from apps.users.models import Profile

User = get_user_model()

IMEI = "490154203237518"


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Наличные")


@pytest.fixture
def op_a(db):
    return Operator.objects.create(full_name="Оператор А", status="active")


@pytest.fixture
def op_b(db):
    return Operator.objects.create(full_name="Оператор Б", status="active")


def _user(username: str, role: str, operator: Operator | None = None):
    user = User.objects.create_user(username=username, password="testpass")
    profile, _ = Profile.objects.get_or_create(user=user)
    profile.role = role
    profile.operator = operator
    profile.save()
    return user


@pytest.fixture
def user_a(op_a):
    return _user("op_a", "operator", op_a)


@pytest.fixture
def user_b(op_b):
    return _user("op_b", "operator", op_b)


@pytest.fixture
def manager(db):
    return _user("mgr", "team_lead")


def _client(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _sale(
    *,
    channel,
    lines: list[tuple[Operator, str]],
    imei: str = IMEI,
    status: str = SaleStatus.CONFIRMED,
    created_by=None,
    sold_at=None,
    **extra,
) -> Sale:
    total = sum(Decimal(a) for _, a in lines)
    sale = Sale.objects.create(
        imei=imei,
        phone_model="iPhone 13",
        operator=lines[0][0],
        channel=channel,
        amount=total,
        sold_at=sold_at or timezone.now(),
        status=status,
        created_by=created_by,
        **extra,
    )
    for op, amount in lines:
        SaleOperator.objects.create(sale=sale, operator=op, amount=Decimal(amount))
    return sale


# ---------------------------------------------------------------- 1. IMEI dup


@pytest.mark.django_db
def test_duplicate_count_ignores_rejected(channel, op_a):
    _sale(channel=channel, lines=[(op_a, "5000000")], status=SaleStatus.REJECTED)
    assert sale_imei_duplicate_count(imei=IMEI) == 0


@pytest.mark.django_db
def test_duplicate_count_still_counts_pending_and_confirmed(channel, op_a):
    _sale(channel=channel, lines=[(op_a, "5000000")], status=SaleStatus.PENDING)
    _sale(channel=channel, lines=[(op_a, "5000000")], status=SaleStatus.CONFIRMED)
    assert sale_imei_duplicate_count(imei=IMEI) == 2


@pytest.mark.django_db
def test_duplicate_count_ignores_deleted_and_returned(channel, op_a):
    _sale(channel=channel, lines=[(op_a, "5000000")], is_deleted=True)
    _sale(channel=channel, lines=[(op_a, "5000000")], is_returned=True)
    assert sale_imei_duplicate_count(imei=IMEI) == 0


@pytest.mark.django_db
def test_resubmit_after_rejection_passes_duplicate_check(channel, op_a, manager):
    _sale(channel=channel, lines=[(op_a, "5000000")], status=SaleStatus.REJECTED)
    sale = sale_create(
        user=manager,
        imei=IMEI,
        phone_model="iPhone 13",
        operator_id=op_a.id,
        channel_id=channel.id,
        amount=Decimal("5000000"),
    )
    assert sale.pk


@pytest.mark.django_db
def test_confirmed_duplicate_still_blocks_create(channel, op_a, manager):
    _sale(channel=channel, lines=[(op_a, "5000000")])
    with pytest.raises(DuplicateError):
        sale_create(
            user=manager,
            imei=IMEI,
            phone_model="iPhone 13",
            operator_id=op_a.id,
            channel_id=channel.id,
            amount=Decimal("5000000"),
        )


# ------------------------------------------------------- 2. IMEI lookup perms


@override_settings(IMEI_ONLINE_LOOKUP_ENABLED=False)
@pytest.mark.django_db
def test_imei_lookup_open_to_operator(user_a):
    resp = _client(user_a).get(f"/api/imei/{IMEI}/lookup/")
    assert resp.status_code == 200, resp.data
    assert resp.data["valid"] is True


@pytest.mark.django_db
def test_imei_lookup_still_requires_auth():
    resp = APIClient().get(f"/api/imei/{IMEI}/lookup/")
    assert resp.status_code in (401, 403)


# ------------------------------------------------------------ 3. Sale detail


@pytest.mark.django_db
def test_operator_reads_split_sale(channel, op_a, op_b, user_b, manager):
    # Created by the manager, op_a primary, op_b only in a split line.
    sale = _sale(
        channel=channel,
        lines=[(op_a, "3000000"), (op_b, "2000000")],
        created_by=manager,
    )
    resp = _client(user_b).get(f"/api/sales/{sale.id}/")
    assert resp.status_code == 200, resp.data
    assert resp.data["id"] == sale.id


@pytest.mark.django_db
def test_operator_reads_sale_as_primary(channel, op_a, user_a, manager):
    sale = _sale(channel=channel, lines=[(op_a, "5000000")], created_by=manager)
    assert _client(user_a).get(f"/api/sales/{sale.id}/").status_code == 200


@pytest.mark.django_db
def test_operator_cannot_read_foreign_sale(channel, op_a, user_b, manager):
    sale = _sale(channel=channel, lines=[(op_a, "5000000")], created_by=manager)
    assert _client(user_b).get(f"/api/sales/{sale.id}/").status_code == 404


@pytest.mark.django_db
def test_operator_still_cannot_edit_split_sale(channel, op_a, op_b, user_b, manager):
    sale = _sale(
        channel=channel,
        lines=[(op_a, "3000000"), (op_b, "2000000")],
        created_by=manager,
    )
    c = _client(user_b)
    assert c.patch(f"/api/sales/{sale.id}/", {"comment": "x"}, format="json").status_code == 403
    assert c.delete(f"/api/sales/{sale.id}/").status_code == 403
    assert c.post(f"/api/sales/{sale.id}/confirm/").status_code == 403


@pytest.mark.django_db
def test_manager_detail_unchanged(channel, op_a, manager):
    sale = _sale(channel=channel, lines=[(op_a, "5000000")])
    assert _client(manager).get(f"/api/sales/{sale.id}/").status_code == 200


# ------------------------------------------------------------ 4. Serializer


@pytest.mark.django_db
def test_serializer_exposes_lead_id(channel, op_a, manager):
    lead = Lead.objects.create(full_name="Клиент", phone="+998901234567", status=LeadStatus.NEW)
    with_lead = _sale(channel=channel, lines=[(op_a, "5000000")], lead=lead)
    without = _sale(channel=channel, lines=[(op_a, "5000000")], imei="356938035643809")
    c = _client(manager)
    assert c.get(f"/api/sales/{with_lead.id}/").data["lead_id"] == lead.id
    assert c.get(f"/api/sales/{without.id}/").data["lead_id"] is None
    rows = {r["id"]: r for r in c.get("/api/sales/").data["results"]}
    assert rows[with_lead.id]["lead_id"] == lead.id


@pytest.mark.django_db
def test_lead_id_is_read_only(channel, op_a, manager):
    lead = Lead.objects.create(full_name="Клиент", phone="+998901234567", status=LeadStatus.NEW)
    sale = _sale(channel=channel, lines=[(op_a, "5000000")])
    resp = _client(manager).patch(
        f"/api/sales/{sale.id}/", {"lead_id": lead.id}, format="json"
    )
    assert resp.status_code == 200
    sale.refresh_from_db()
    assert sale.lead_id is None


# ------------------------------------------------------------ 5. /sales/mine/


@pytest.mark.django_db
def test_mine_includes_returned_but_excludes_from_total(channel, op_a, user_a):
    kept = _sale(channel=channel, lines=[(op_a, "5000000")])
    returned = _sale(
        channel=channel,
        lines=[(op_a, "3000000")],
        imei="356938035643809",
        is_returned=True,
        returned_at=timezone.now(),
        return_reason="брак",
    )
    deleted = _sale(
        channel=channel, lines=[(op_a, "1000000")], imei="352099001761481", is_deleted=True
    )
    resp = _client(user_a).get("/api/sales/mine/")
    assert resp.status_code == 200
    rows = {r["id"]: r for r in resp.data["results"]}
    assert set(rows) == {kept.id, returned.id}
    assert deleted.id not in rows
    assert rows[returned.id]["is_returned"] is True
    assert rows[returned.id]["return_reason"] == "брак"
    assert rows[returned.id]["returned_at"] is not None
    assert rows[kept.id]["is_returned"] is False
    assert rows[kept.id]["returned_at"] is None
    assert Decimal(resp.data["total_share"]) == Decimal("5000000")


@pytest.mark.django_db
def test_mine_date_filters_use_tashkent_local_dates(channel, op_a, user_a):
    # 2026-10-13 20:30 UTC == 2026-10-14 01:30 Asia/Tashkent (UTC+5).
    late = _sale(
        channel=channel,
        lines=[(op_a, "5000000")],
        sold_at=dt.datetime(2026, 10, 13, 20, 30, tzinfo=dt.UTC),
    )
    # 2026-10-13 10:00 UTC == 2026-10-13 15:00 Tashkent.
    early = _sale(
        channel=channel,
        lines=[(op_a, "4000000")],
        imei="356938035643809",
        sold_at=dt.datetime(2026, 10, 13, 10, 0, tzinfo=dt.UTC),
    )
    c = _client(user_a)

    ids = {r["id"] for r in c.get("/api/sales/mine/?date_from=2026-10-14").data["results"]}
    assert ids == {late.id}

    ids = {r["id"] for r in c.get("/api/sales/mine/?date_to=2026-10-13").data["results"]}
    assert ids == {early.id}

    ids = {
        r["id"]
        for r in c.get(
            "/api/sales/mine/?date_from=2026-10-13&date_to=2026-10-14"
        ).data["results"]
    }
    assert ids == {late.id, early.id}


@pytest.mark.django_db
def test_mine_rejects_bad_date(user_a):
    resp = _client(user_a).get("/api/sales/mine/?date_from=14.10.2026")
    assert resp.status_code == 400
