"""
«Вставить и раздать»: строки, вставленные менеджером, сразу у выбранных
операторов.
- новый номер → лид создан и назначен (ADMIN_REASSIGN)
- открытый лид у другого → забран, статус и напоминания переехали
- take_existing=False → открытый лид не трогается
- уже у выбранного / плохой номер / повтор в вставке → пропуск
- номер только с закрытыми лидами → новый лид
- раздача поровну, неактивный оператор → 400, только менеджер
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AuditLog
from apps.calls.models import CallAttempt, CallbackReminder, CallbackReminderStatus
from apps.leads.models import (
    Lead,
    LeadAssignment,
    LeadAssignmentSource,
    LeadSource,
    LeadStatus,
    SheetSource,
)
from apps.leads.services import _RELEASABLE_SOURCES, leads_paste_distribute
from apps.operators.models import Operator, OperatorStatus
from apps.users.models import Profile, Role

User = get_user_model()


def _user(username: str, role: str, operator: Operator | None = None):
    user = User.objects.create_user(username=username, password="pass12345")
    Profile.objects.create(user=user, role=role, operator=operator)
    return user


def _op(name: str, status: str = OperatorStatus.ACTIVE) -> Operator:
    return Operator.objects.create(full_name=name, status=status)


def _row(phone: str, name: str = "Ali", product: str = "iPhone 15", **extra) -> dict:
    return {"full_name": name, "phone": phone, "product_hint": product, **extra}


@pytest.fixture
def mgr(db):
    return _user("mgr", Role.MANAGER)


@pytest.mark.django_db
def test_new_rows_are_created_and_split_evenly(mgr):
    a, b = _op("A"), _op("B")
    src = SheetSource.objects.create(name="Insta", spreadsheet_id="x", gid=1)
    rows = [_row(f"+99890111000{i}", name=f"N{i}") for i in range(5)]
    rows[0]["comment"] = "kartasi bor"
    rows[1]["phone_alt"] = "93 222 33 44"

    res = leads_paste_distribute(
        rows=rows, operator_ids=[a.id, b.id], sheet_source_id=src.id, user=mgr
    )

    assert res["created"] == 5 and res["taken"] == 0
    assert res["assigned"] == {str(a.id): 3, str(b.id): 2}
    leads = Lead.objects.order_by("id")
    assert [ld.operator_id for ld in leads] == [a.id, b.id, a.id, b.id, a.id]
    first = leads[0]
    assert first.status == LeadStatus.ASSIGNED
    assert first.source == LeadSource.MANUAL and first.sheet_source_id == src.id
    assert first.metadata["comment_text"] == "kartasi bor"
    assert first.metadata["paste_batch"] == res["batch"]
    assert leads[1].phone_alt == "+998932223344"
    assert LeadAssignment.objects.filter(
        active=True, source=LeadAssignmentSource.ADMIN_REASSIGN
    ).count() == 5
    assert AuditLog.objects.filter(entity="leads.PasteDistribute").count() == 1


@pytest.mark.django_db
def test_open_lead_of_another_operator_is_taken(mgr):
    old, new = _op("Old"), _op("New")
    lead = Lead.objects.create(
        full_name="",
        phone="+998901234567",
        status="sms_jonatildi",
        operator=old,
        metadata={"qimmatlik_retry_at": "2026-11-05T16:00:00+05:00"},
        postponed_at=timezone.now(),
    )
    reminder = CallbackReminder.objects.create(
        lead=lead,
        operator=old,
        remind_at=timezone.now() + dt.timedelta(hours=1),
        status=CallbackReminderStatus.PENDING,
    )

    res = leads_paste_distribute(
        rows=[_row("90 123 45 67", name="Vali", comment="qayta")],
        operator_ids=[new.id],
        user=mgr,
    )

    assert res["created"] == 0 and res["taken"] == 1
    assert res["taken_from"] == [{"lead_id": lead.id, "from": "Old", "to": "New"}]
    lead.refresh_from_db()
    assert lead.operator_id == new.id
    assert lead.status == "sms_jonatildi"  # history stays
    assert lead.postponed_at is None
    assert lead.full_name == "Vali"  # empty field filled
    assert "qimmatlik_retry_at" not in lead.metadata
    assert lead.metadata["comment_text"] == "qayta"
    reminder.refresh_from_db()
    assert reminder.operator_id == new.id
    assert Lead.objects.count() == 1


@pytest.mark.django_db
def test_open_lead_without_operator_is_taken(mgr):
    # Lead from the free pool (operator NULL) — the take path locks it with a
    # LEFT JOIN on operator; Postgres used to answer 500 here.
    new = _op("New")
    lead = Lead.objects.create(phone="+998901234567", status="new", operator=None)

    res = leads_paste_distribute(
        rows=[_row("90 123 45 67")], operator_ids=[new.id], user=mgr
    )

    assert res["taken"] == 1
    assert res["taken_from"] == [{"lead_id": lead.id, "from": "", "to": "New"}]
    lead.refresh_from_db()
    assert lead.operator_id == new.id
    assert Lead.objects.count() == 1


@pytest.mark.django_db
def test_take_existing_off_leaves_open_lead_alone(mgr):
    old, new = _op("Old"), _op("New")
    lead = Lead.objects.create(phone="+998901234567", status="no_answer", operator=old)

    res = leads_paste_distribute(
        rows=[_row("+998901234567"), _row("+998907654321")],
        operator_ids=[new.id],
        take_existing=False,
        user=mgr,
    )

    assert res["created"] == 1 and res["taken"] == 0 and res["skipped"]["not_taken"] == 1
    lead.refresh_from_db()
    assert lead.operator_id == old.id


@pytest.mark.django_db
def test_skips_keep_invalid_and_duplicates(mgr):
    a = _op("A")
    Lead.objects.create(phone="+998901111111", status=LeadStatus.ASSIGNED, operator=a)

    res = leads_paste_distribute(
        rows=[
            _row("+998901111111"),  # already with A
            _row("12-34"),  # bad phone
            _row("+998902222222"),
            _row("90 222 22 22"),  # same phone again
        ],
        operator_ids=[a.id],
        user=mgr,
    )

    assert res["created"] == 1
    assert res["skipped"] == {"keep": 1, "invalid": 1, "duplicate": 1, "not_taken": 0}
    assert Lead.objects.count() == 2


@pytest.mark.django_db
def test_phone_with_only_closed_leads_gets_a_new_lead(mgr):
    a, b = _op("A"), _op("B")
    closed = Lead.objects.create(phone="+998903333333", status=LeadStatus.WON, operator=a)

    res = leads_paste_distribute(rows=[_row("+998903333333")], operator_ids=[b.id], user=mgr)

    assert res["created"] == 1
    closed.refresh_from_db()
    assert closed.operator_id == a.id and closed.status == LeadStatus.WON
    assert Lead.objects.filter(phone="+998903333333", operator=b).count() == 1


@pytest.mark.django_db
def test_manual_assignment_is_not_released_from_absent_operator():
    assert LeadAssignmentSource.ADMIN_REASSIGN not in _RELEASABLE_SOURCES


@pytest.mark.django_db
def test_preview_api_classifies_rows_and_writes_nothing(mgr):
    a, b = _op("A"), _op("B")
    taken = Lead.objects.create(phone="+998904444444", status="phone_on", operator=a)
    CallAttempt.objects.create(lead=taken, operator=a)
    api = APIClient()
    api.force_authenticate(mgr)

    r = api.post(
        "/api/leads/paste/preview/",
        {
            "rows": [
                _row("+998904444444"),
                _row("+998905555555"),
                _row("abc"),
                _row("+998905555555"),
            ],
            "operator_ids": [b.id],
        },
        format="json",
    )

    assert r.status_code == 200, r.content
    body = r.json()
    assert body["summary"] == {"new": 1, "take": 1, "keep": 0, "invalid": 1, "duplicate": 1}
    first = body["rows"][0]
    assert first["kind"] == "take" and first["lead_operator"] == "A"
    assert first["lead_status"] == "phone_on" and first["called_today"] is True
    assert Lead.objects.count() == 1


@pytest.mark.django_db
def test_distribute_api_rejects_inactive_operator_and_non_managers(mgr):
    gone = _op("Gone", status=OperatorStatus.INACTIVE)
    api = APIClient()
    api.force_authenticate(mgr)
    payload = {"rows": [_row("+998906666666")], "operator_ids": [gone.id]}

    r = api.post("/api/leads/paste/distribute/", payload, format="json")
    assert r.status_code == 400 and r.json()["operator_ids"] == [gone.id]
    assert not Lead.objects.exists()

    op = _op("Me")
    for user in (_user("op", Role.OPERATOR, operator=op), _user("smm", Role.SMM)):
        api.force_authenticate(user)
        assert api.post("/api/leads/paste/distribute/", payload, format="json").status_code == 403
        assert api.post("/api/leads/paste/preview/", payload, format="json").status_code == 403


@pytest.mark.django_db
def test_distribute_api_happy_path(mgr):
    a = _op("A")
    api = APIClient()
    api.force_authenticate(mgr)

    r = api.post(
        "/api/leads/paste/distribute/",
        {"rows": [_row("+998907777777"), _row("+998908888888")], "operator_ids": [a.id]},
        format="json",
    )

    assert r.status_code == 200, r.content
    assert r.json()["created"] == 2 and r.json()["assigned"] == {str(a.id): 2}
    assert Lead.objects.filter(operator=a).count() == 2


@pytest.mark.django_db
def test_distribution_status_reports_availability(mgr):
    a = _op("A")
    Operator.objects.filter(pk=a.pk).update(is_paused=True)
    api = APIClient()
    api.force_authenticate(mgr)

    rows = api.get("/api/leads/distribution-status/").json()["operators"]

    row = next(r for r in rows if r["id"] == a.id)
    assert row["is_paused"] is True and row["unavailable_reason"] == "paused"
