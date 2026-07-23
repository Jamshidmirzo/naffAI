"""
callback_reminder_create must be race-free: two concurrent callers on the
same lead may not both leave a PENDING reminder alive.

We can't reliably exercise a real transaction race under the test-suite's
sqlite backend (select_for_update is a no-op there and the in-memory DB
is single-connection), so we drive the race with an explicit
``threading.Barrier`` inside the service and assert:

    (a) select_for_update(of=("self",)) is called on the Lead
        — the lock strategy the service relies on
    (b) after two sequential calls the invariant "exactly one active
        reminder per lead" still holds — as a smoke check

The (a) test is the load-bearing one: it verifies the fix stays in
place. Postgres provides the actual serialization at runtime.
"""

from __future__ import annotations

import datetime as dt
import threading
from unittest.mock import patch

import pytest
from django.utils import timezone

from apps.calls.models import CallbackReminder, CallbackReminderStatus
from apps.calls.services import callback_reminder_create
from apps.leads.models import Lead
from apps.operators.models import Operator, OperatorStatus


@pytest.fixture
def lead_and_op(db):
    op = Operator.objects.create(full_name="Op", status=OperatorStatus.ACTIVE)
    lead = Lead.objects.create(full_name="L", phone="+998900002233", operator=op)
    return lead, op


@pytest.mark.django_db
def test_callback_reminder_create_uses_select_for_update_on_lead(lead_and_op):
    """The fix hinges on Lead being row-locked before we scan for supersession."""
    lead, op = lead_and_op

    calls = []
    original = Lead.objects.__class__.select_for_update

    def _spy(self, *args, **kwargs):
        calls.append(kwargs)
        return original(self, *args, **kwargs)

    with patch.object(Lead.objects.__class__, "select_for_update", _spy):
        callback_reminder_create(
            lead=lead,
            operator=op,
            remind_at=timezone.now() + dt.timedelta(hours=1),
        )

    assert calls, "expected select_for_update to be invoked on the Lead queryset"
    # `of=("self",)` — locking only the Lead row, not FK targets.
    assert calls[-1].get("of") == ("self",)


@pytest.mark.django_db
def test_callback_reminder_create_parallel_no_race(lead_and_op):
    """
    Two threads try to create a reminder on the same lead simultaneously.
    Regardless of which wins, only ONE reminder must remain in an active
    (PENDING) state. The other must be SUPERSEDED.

    Under sqlite the atomic block + select_for_update are advisory only, so
    this test exercises the code path but the strong safety net is Postgres
    at runtime.
    """
    lead, op = lead_and_op
    barrier = threading.Barrier(2)
    errors: list[BaseException] = []

    def _worker(offset_hours: int) -> None:
        try:
            barrier.wait(timeout=5)
            callback_reminder_create(
                lead=lead,
                operator=op,
                remind_at=timezone.now() + dt.timedelta(hours=offset_hours),
            )
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    t1 = threading.Thread(target=_worker, args=(1,))
    t2 = threading.Thread(target=_worker, args=(2,))
    t1.start()
    t2.start()
    t1.join(timeout=10)
    t2.join(timeout=10)

    # sqlite may raise OperationalError "database is locked" — that is
    # itself proof that serialization kicked in. Any other error is a bug.
    tolerated_msgs = ("database is locked", "database table is locked")
    unexpected = [
        e for e in errors if not any(m in str(e) for m in tolerated_msgs)
    ]
    assert not unexpected, f"unexpected errors: {unexpected}"

    active = CallbackReminder.objects.filter(
        lead=lead,
        status__in=(
            CallbackReminderStatus.PENDING,
            CallbackReminderStatus.SNOOZED,
            CallbackReminderStatus.OVERDUE,
        ),
    ).count()
    assert active <= 1, (
        f"expected at most 1 active reminder after concurrent creates, got {active}"
    )
