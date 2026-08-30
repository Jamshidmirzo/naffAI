"""
`manage.py dedup_leads` — merges duplicate Lead rows sharing the same
normalized phone.

Coverage:
  - `--dry-run` never mutates.
  - Winner-selection rule (status priority DESC, then updated_at DESC).
  - FK-move contract: Sale / CallAttempt / CallbackReminder /
    LeadAssignment / TgChat all follow the winner.
  - `winner.metadata["merged_from"]` audit trail is populated.
  - `--phone` narrows to one group.
  - `--min-dupes` skips small groups.
  - Atomicity: a merge failure inside one group doesn't cascade to the
    rest of the batch.
"""

from __future__ import annotations

import datetime as dt
from io import StringIO

import pytest
from django.core.management import call_command
from django.utils import timezone

from apps.audit.models import AuditLog
from apps.calls.models import CallAttempt, CallOutcome, CallbackReminder
from apps.leads.models import (
    Lead,
    LeadAssignment,
    LeadAssignmentSource,
    LeadStatus,
)
from apps.operators.models import Operator, OperatorStatus


# ---- fixtures / factories -----------------------------------------------


@pytest.fixture
def op(db) -> Operator:
    return Operator.objects.create(full_name="Op1", status=OperatorStatus.ACTIVE)


@pytest.fixture
def op2(db) -> Operator:
    return Operator.objects.create(full_name="Op2", status=OperatorStatus.ACTIVE)


def _mk_lead(
    *,
    phone: str,
    status: str = LeadStatus.NEW,
    operator: Operator | None = None,
    updated_days_ago: int = 0,
    full_name: str = "",
) -> Lead:
    """
    Create a Lead and force `updated_at` to a specific past offset
    (auto_now overwrites on plain save, so we round-trip through
    filter().update()).
    """
    lead = Lead.objects.create(
        full_name=full_name or f"L-{phone[-4:]}",
        phone=phone,
        status=status,
        operator=operator,
    )
    if updated_days_ago:
        target = timezone.now() - dt.timedelta(days=updated_days_ago)
        Lead.objects.filter(pk=lead.pk).update(updated_at=target)
        lead.refresh_from_db()
    return lead


def _run(**kwargs) -> str:
    out = StringIO()
    call_command("dedup_leads", stdout=out, stderr=out, **kwargs)
    return out.getvalue()


# ---- dry-run must not mutate --------------------------------------------


@pytest.mark.django_db
def test_dry_run_does_not_mutate(op):
    a = _mk_lead(phone="+998900000001", status=LeadStatus.LOST, updated_days_ago=3)
    b = _mk_lead(phone="+998900000001", status=LeadStatus.NEW, operator=op)
    c = _mk_lead(phone="+998900000001", status=LeadStatus.WON, updated_days_ago=1)

    # Attach some FK-linked children so we'd notice if a real merge ran.
    CallAttempt.objects.create(lead=a, operator=op, outcome=CallOutcome.NO_ANSWER)
    LeadAssignment.objects.create(
        lead=b, operator=op, source=LeadAssignmentSource.AUTO_ROUND_ROBIN
    )

    lead_ids_before = set(Lead.objects.values_list("id", flat=True))
    call_count_before = CallAttempt.objects.count()
    assign_count_before = LeadAssignment.objects.count()
    audit_count_before = AuditLog.objects.count()

    out = _run(dry_run=True)

    assert "dry-run" in out
    assert set(Lead.objects.values_list("id", flat=True)) == lead_ids_before
    assert CallAttempt.objects.count() == call_count_before
    assert LeadAssignment.objects.count() == assign_count_before
    assert AuditLog.objects.count() == audit_count_before

    # All three still present, none mutated.
    for lead in (a, b, c):
        lead.refresh_from_db()
        assert "merged_from" not in (lead.metadata or {})


# ---- winner selection ---------------------------------------------------


@pytest.mark.django_db
def test_won_beats_active_beats_sms_beats_lost():
    """
    All 4 leads share a phone. Priority ranking (100 > 80 > 60 > 10)
    picks `won` as the winner regardless of updated_at.
    """
    lost = _mk_lead(phone="+998900000002", status=LeadStatus.LOST, updated_days_ago=0)
    sms = _mk_lead(phone="+998900000002", status="sms_jonatildi", updated_days_ago=1)
    active = _mk_lead(
        phone="+998900000002", status=LeadStatus.IN_PROGRESS, updated_days_ago=2
    )
    won = _mk_lead(phone="+998900000002", status=LeadStatus.WON, updated_days_ago=5)

    _run()

    survivors = list(Lead.objects.filter(phone="+998900000002").values_list("id", flat=True))
    assert survivors == [won.id]
    # losers gone
    for lead in (lost, sms, active):
        assert not Lead.objects.filter(pk=lead.pk).exists()


@pytest.mark.django_db
def test_updated_at_breaks_ties_within_same_priority():
    """
    Three active-tier leads (priority 80 each). The one with the freshest
    updated_at should win.
    """
    stale = _mk_lead(
        phone="+998900000003", status=LeadStatus.IN_PROGRESS, updated_days_ago=5
    )
    medium = _mk_lead(
        phone="+998900000003", status=LeadStatus.NEW, updated_days_ago=2
    )
    fresh = _mk_lead(
        phone="+998900000003", status=LeadStatus.HAS_DEBT, updated_days_ago=0
    )

    _run()

    survivors = list(Lead.objects.filter(phone="+998900000003").values_list("id", flat=True))
    assert survivors == [fresh.id]
    assert not Lead.objects.filter(pk__in=[stale.pk, medium.pk]).exists()


# ---- FK repointing ------------------------------------------------------


@pytest.mark.django_db
def test_fk_movements_land_on_winner(op, op2):
    """
    Loser has 2 sales / 3 call_attempts / 1 callback / 4 assignments;
    all must land on winner after merge.
    """
    from apps.sales.models import Sale
    from apps.catalog.models import Channel
    from decimal import Decimal

    channel = Channel.objects.create(name="Walk-in", is_active=True)

    winner = _mk_lead(
        phone="+998900000004", status=LeadStatus.WON, updated_days_ago=0
    )
    loser = _mk_lead(
        phone="+998900000004", status=LeadStatus.LOST, updated_days_ago=2
    )

    now = timezone.now()
    Sale.objects.create(
        imei="111111111111117",
        phone_model="X",
        operator=op,
        channel=channel,
        amount=Decimal("1000000"),
        sold_at=now,
        lead=loser,
    )
    Sale.objects.create(
        imei="222222222222226",
        phone_model="Y",
        operator=op,
        channel=channel,
        amount=Decimal("2000000"),
        sold_at=now,
        lead=loser,
    )
    for _ in range(3):
        CallAttempt.objects.create(
            lead=loser, operator=op, outcome=CallOutcome.NO_ANSWER
        )
    CallbackReminder.objects.create(
        lead=loser, operator=op, remind_at=timezone.now() + dt.timedelta(hours=1)
    )
    for _ in range(4):
        LeadAssignment.objects.create(
            lead=loser, operator=op2, source=LeadAssignmentSource.AUTO_ROUND_ROBIN
        )

    _run()

    assert not Lead.objects.filter(pk=loser.pk).exists()
    winner.refresh_from_db()

    assert Sale.objects.filter(lead=winner).count() == 2
    assert CallAttempt.objects.filter(lead=winner).count() == 3
    assert CallbackReminder.objects.filter(lead=winner).count() == 1
    # winner started with 0 assignments, gains 4 from loser.
    assert LeadAssignment.objects.filter(lead=winner).count() == 4


@pytest.mark.django_db
def test_winner_metadata_records_every_loser():
    """
    `winner.metadata["merged_from"]` should have one entry per loser with
    the loser's snapshot (status, operator, sheet row, updated_at).
    """
    winner = _mk_lead(
        phone="+998900000005", status=LeadStatus.WON, updated_days_ago=0
    )
    l1 = _mk_lead(phone="+998900000005", status=LeadStatus.LOST, updated_days_ago=1)
    l2 = _mk_lead(phone="+998900000005", status="sms_jonatildi", updated_days_ago=2)

    _run()

    winner.refresh_from_db()
    trail = (winner.metadata or {}).get("merged_from") or []
    assert len(trail) == 2
    ids = {t["lead_id"] for t in trail}
    assert ids == {l1.id, l2.id}
    statuses = {t["status"] for t in trail}
    assert statuses == {LeadStatus.LOST, "sms_jonatildi"}

    # Audit log entries: one UPDATE per loser + a metadata-only bump on
    # each merge write. We only assert on the presence of at least one
    # per-loser entry with the right shape.
    entries = AuditLog.objects.filter(
        entity="leads.Lead", entity_id=str(winner.id)
    ).values_list("changes", flat=True)
    merged_ids = {c.get("merged_loser_id") for c in entries if "merged_loser_id" in c}
    assert merged_ids == {l1.id, l2.id}


# ---- CLI filters --------------------------------------------------------


@pytest.mark.django_db
def test_phone_flag_narrows_to_one_group():
    """
    Two independent dupe-groups. `--phone` picks only one; the other
    survives untouched.
    """
    a1 = _mk_lead(phone="+998900000006", status=LeadStatus.WON, updated_days_ago=0)
    a2 = _mk_lead(phone="+998900000006", status=LeadStatus.LOST, updated_days_ago=1)
    b1 = _mk_lead(phone="+998900000007", status=LeadStatus.NEW, updated_days_ago=0)
    b2 = _mk_lead(phone="+998900000007", status=LeadStatus.LOST, updated_days_ago=1)

    _run(phone="+998900000006")

    # Group A collapsed to winner=a1.
    assert list(
        Lead.objects.filter(phone="+998900000006").values_list("id", flat=True)
    ) == [a1.id]
    assert not Lead.objects.filter(pk=a2.pk).exists()

    # Group B untouched.
    assert set(
        Lead.objects.filter(phone="+998900000007").values_list("id", flat=True)
    ) == {b1.id, b2.id}


@pytest.mark.django_db
def test_min_dupes_three_skips_pairs():
    """
    `--min-dupes 3` should ignore phones with exactly 2 leads.
    """
    a1 = _mk_lead(phone="+998900000008", status=LeadStatus.WON, updated_days_ago=0)
    a2 = _mk_lead(phone="+998900000008", status=LeadStatus.LOST, updated_days_ago=1)
    b1 = _mk_lead(phone="+998900000009", status=LeadStatus.WON, updated_days_ago=0)
    b2 = _mk_lead(phone="+998900000009", status=LeadStatus.LOST, updated_days_ago=1)
    b3 = _mk_lead(phone="+998900000009", status=LeadStatus.NEW, updated_days_ago=2)

    _run(min_dupes=3)

    # Pair (group A) untouched.
    assert set(
        Lead.objects.filter(phone="+998900000008").values_list("id", flat=True)
    ) == {a1.id, a2.id}
    # Triple (group B) collapsed.
    assert list(
        Lead.objects.filter(phone="+998900000009").values_list("id", flat=True)
    ) == [b1.id]
    assert not Lead.objects.filter(pk__in=[b2.pk, b3.pk]).exists()


# ---- atomicity ----------------------------------------------------------


@pytest.mark.django_db
def test_group_failure_rolls_back_only_its_group(monkeypatch):
    """
    If merging one loser raises mid-transaction, the whole GROUP must
    roll back (winner's metadata and FK moves both restored) — while
    other, unrelated phone groups still get merged.
    """
    from apps.leads.management.commands import dedup_leads as cmd

    # Group A: two leads on phone X. We'll poison this merge.
    a_winner = _mk_lead(
        phone="+998900000010", status=LeadStatus.WON, updated_days_ago=0
    )
    a_loser = _mk_lead(
        phone="+998900000010", status=LeadStatus.LOST, updated_days_ago=1
    )

    # Group B: two leads on phone Y. This one should merge normally.
    b_winner = _mk_lead(
        phone="+998900000011", status=LeadStatus.WON, updated_days_ago=0
    )
    b_loser = _mk_lead(
        phone="+998900000011", status=LeadStatus.LOST, updated_days_ago=1
    )

    original = cmd._merge_loser_into_winner

    def maybe_boom(*, winner, loser):
        if loser.pk == a_loser.pk:
            raise RuntimeError("simulated FK move failure")
        return original(winner=winner, loser=loser)

    monkeypatch.setattr(cmd, "_merge_loser_into_winner", maybe_boom)

    _run()

    # Group A: both leads still present, winner metadata untouched.
    assert Lead.objects.filter(pk=a_winner.pk).exists()
    assert Lead.objects.filter(pk=a_loser.pk).exists()
    a_winner.refresh_from_db()
    assert "merged_from" not in (a_winner.metadata or {})

    # Group B: merged as normal.
    assert Lead.objects.filter(pk=b_winner.pk).exists()
    assert not Lead.objects.filter(pk=b_loser.pk).exists()
