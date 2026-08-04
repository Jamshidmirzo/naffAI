"""
`GET /api/leads/my/?status=<code>` — chip-режим на странице «Мои лиды».

Оператор кликает status-chip (например «TG'га боғланди» =
contacted_telegram) — фронт хочет видеть ВСЕ его лиды с этим статусом
за всё время, включая terminal (contacted_telegram, harid_qildi, lost и т.д.,
которые не входят в active_lead_status_codes() и потому исключены из
view=active).

Bug motivator: до фикса chip-фильтрация делалась локально массивом
`results` (== view=active), поэтому terminal-лиды вообще не показывались —
оператор поставил статус и видел пустую страницу.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator, OperatorStatus
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Sevara", status=OperatorStatus.ACTIVE)


@pytest.fixture
def other_operator(db):
    return Operator.objects.create(full_name="Nurik", status=OperatorStatus.ACTIVE)


@pytest.fixture
def operator_user(db, operator):
    u = User.objects.create_user(username="sevara", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=operator)
    return u


@pytest.fixture
def api_client(operator_user):
    c = APIClient()
    c.force_authenticate(user=operator_user)
    return c


def _make_lead(*, operator: Operator, status: str, phone: str) -> Lead:
    return Lead.objects.create(
        full_name=f"L-{status}-{phone[-3:]}",
        phone=phone,
        operator=operator,
        status=status,
    )


@pytest.mark.django_db
def test_chip_returns_terminal_status_leads(api_client, operator):
    """
    Terminal-статус contacted_telegram НЕ входит в active_lead_status_codes,
    поэтому view=active его не покажет. Chip-режим должен возвращать всё
    равно, потому что это исторический поиск, не «что мне работать».
    """
    tg1 = _make_lead(
        operator=operator, status=LeadStatus.CONTACTED_TELEGRAM, phone="+998900000101"
    )
    tg2 = _make_lead(
        operator=operator, status=LeadStatus.CONTACTED_TELEGRAM, phone="+998900000102"
    )
    _make_lead(operator=operator, status=LeadStatus.NEW, phone="+998900000103")

    resp = api_client.get("/api/leads/my/?status=contacted_telegram")
    assert resp.status_code == 200
    body = resp.json()

    ids = {row["id"] for row in body["results"]}
    assert ids == {tg1.id, tg2.id}
    assert body["count"] == 2


@pytest.mark.django_db
def test_chip_scoped_to_current_operator(api_client, operator, other_operator):
    """Лиды чужого оператора не должны утечь в мой ответ."""
    mine = _make_lead(
        operator=operator, status=LeadStatus.WON, phone="+998900000201"
    )
    _make_lead(
        operator=other_operator,
        status=LeadStatus.WON,
        phone="+998900000202",
    )

    resp = api_client.get("/api/leads/my/?status=won")
    assert resp.status_code == 200
    ids = [row["id"] for row in resp.json()["results"]]
    assert ids == [mine.id]


@pytest.mark.django_db
def test_chip_sorted_by_updated_at_desc(api_client, operator):
    """Свежее обновление → сверху."""
    old = _make_lead(operator=operator, status=LeadStatus.LOST, phone="+998900000301")
    new = _make_lead(operator=operator, status=LeadStatus.LOST, phone="+998900000302")
    # Форсим updated_at (в create они очень близко, лучше явно сдвинуть).
    Lead.objects.filter(pk=old.pk).update(
        updated_at=timezone.now() - timezone.timedelta(days=2)
    )
    Lead.objects.filter(pk=new.pk).update(updated_at=timezone.now())

    resp = api_client.get("/api/leads/my/?status=lost")
    ids = [row["id"] for row in resp.json()["results"]]
    assert ids == [new.id, old.id]


@pytest.mark.django_db
def test_chip_empty_when_no_matches(api_client, operator):
    _make_lead(operator=operator, status=LeadStatus.NEW, phone="+998900000401")
    resp = api_client.get("/api/leads/my/?status=contacted_telegram")
    assert resp.status_code == 200
    body = resp.json()
    assert body["results"] == []
    assert body["count"] == 0


@pytest.mark.django_db
def test_chip_preserves_counts_envelope(api_client, operator):
    """
    Envelope в chip-режиме должен остаться совместимым с обычным ответом:
    operator + counts + results (+ count). Фронт полагается на counts для
    tab-бейджей.
    """
    _make_lead(operator=operator, status=LeadStatus.NEW, phone="+998900000501")
    _make_lead(
        operator=operator, status=LeadStatus.CONTACTED_TELEGRAM, phone="+998900000502"
    )

    resp = api_client.get("/api/leads/my/?status=contacted_telegram")
    body = resp.json()

    assert "operator" in body
    assert "counts" in body
    assert "active" in body["counts"]
    assert "postponed" in body["counts"]
    assert "results" in body


@pytest.mark.django_db
def test_no_status_param_keeps_old_behavior(api_client, operator):
    """
    Без ?status — старый путь (view=active). Terminal-лиды НЕ показываются.
    Гарантия что мы не сломали существующий контракт.
    """
    _make_lead(
        operator=operator, status=LeadStatus.CONTACTED_TELEGRAM, phone="+998900000601"
    )
    active_lead = _make_lead(
        operator=operator, status=LeadStatus.NEW, phone="+998900000602"
    )

    resp = api_client.get("/api/leads/my/?view=active")
    body = resp.json()
    ids = [row["id"] for row in body["results"]]
    assert active_lead.id in ids
    # terminal contacted_telegram НЕ должен появиться в view=active
    for row in body["results"]:
        assert row["status"] != LeadStatus.CONTACTED_TELEGRAM
