"""
Автозакрытие вчерашних необработанных non-carry лидов:
`leads_auto_close_stale` + management-команда `auto_close_stale_leads`.

Правило (см. `stale_leads_for_auto_close`):
  - non-carry активные (has_debt, needs_review-подобные, …)
  - updated_at < сегодня 00:00 Asia/Tashkent
  - оператор задан, лид не отложен
  → закрываются как LOST с audit-логом «Автозакрытие: не обработан вручную»

carry (`no_answer`, `phone_on`, `callback_scheduled`, `contacted_telegram`,
`dokonga_keladi`) и untouched (`new`, `assigned`) — не трогаем.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.core.cache import cache
from django.core.management import call_command
from django.utils import timezone
from io import StringIO

from apps.audit.models import AuditAction, AuditLog
from apps.leads.models import Lead, LeadAssignmentSource, LeadStatus
from apps.leads.selectors import stale_leads_for_auto_close
from apps.leads.services import leads_auto_close_stale
from apps.operators.models import Operator, OperatorStatus
from apps.system_settings.models import SystemSetting


@pytest.fixture(autouse=True)
def _clear_carry_cache():
    """
    `carry_over_status_codes()` кэширует 60с в locmem — между тестами
    сбрасываем, иначе первый тест «протекает» кэшом в следующие.
    """
    cache.delete("carry_over_status_codes")
    yield
    cache.delete("carry_over_status_codes")


def _mk_op(name: str = "OP") -> Operator:
    return Operator.objects.create(full_name=name, status=OperatorStatus.ACTIVE)


def _mk_lead(
    op: Operator | None,
    idx: int,
    *,
    status: str = LeadStatus.HAS_DEBT,
    updated_days_ago: int = 1,
    postponed: bool = False,
) -> Lead:
    """
    Создать лид и вручную сдвинуть `updated_at` (auto_now перезапишет
    его при save, поэтому идём через `objects.filter(pk=...).update`).
    """
    lead = Lead.objects.create(
        full_name=f"L-{idx}",
        phone=f"+99890{idx:07d}",
        status=status,
        operator=op,
        postponed_at=timezone.now() if postponed else None,
    )
    now = timezone.now()
    Lead.objects.filter(pk=lead.pk).update(
        updated_at=now - dt.timedelta(days=updated_days_ago)
    )
    lead.refresh_from_db()
    return lead


# ---- selectors -----------------------------------------------------------


@pytest.mark.django_db
def test_selector_picks_only_non_carry_stale():
    """
    3 лида одного оператора:
      - has_debt updated вчера      → в выборке (не carry, non-terminal, stale)
      - no_answer (carry) вчера     → пропускаем (carry)
      - assigned (untouched) вчера  → пропускаем (untouched — ждёт первого контакта)
    """
    op = _mk_op()
    stale = _mk_lead(op, 1, status=LeadStatus.HAS_DEBT, updated_days_ago=1)
    _mk_lead(op, 2, status=LeadStatus.NO_ANSWER, updated_days_ago=1)
    _mk_lead(op, 3, status=LeadStatus.ASSIGNED, updated_days_ago=1)

    ids = set(stale_leads_for_auto_close().values_list("id", flat=True))
    assert ids == {stale.id}


@pytest.mark.django_db
def test_selector_ignores_leads_touched_today():
    """Лид updated сегодня — не трогаем даже если non-carry (оператор ещё работает)."""
    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.HAS_DEBT, updated_days_ago=0)
    assert stale_leads_for_auto_close().count() == 0


@pytest.mark.django_db
def test_selector_ignores_postponed_leads():
    """Postponed — оператор явно попросил отложить, мимо."""
    op = _mk_op()
    _mk_lead(
        op, 1, status=LeadStatus.HAS_DEBT, updated_days_ago=1, postponed=True
    )
    assert stale_leads_for_auto_close().count() == 0


@pytest.mark.django_db
def test_selector_ignores_orphan_leads():
    """`operator IS NULL` — сирота в общем пуле, не задача auto-closer'а."""
    _mk_lead(None, 1, status=LeadStatus.HAS_DEBT, updated_days_ago=1)
    assert stale_leads_for_auto_close().count() == 0


# ---- service -------------------------------------------------------------


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_service_closes_only_stale_non_carry():
    """
    Оператор, 3 лида (все updated вчера):
      - has_debt   → закроется как LOST
      - no_answer  → carry, останется
      - assigned   → untouched, останется
    """
    op = _mk_op()
    stale = _mk_lead(op, 1, status=LeadStatus.HAS_DEBT, updated_days_ago=1)
    carry = _mk_lead(op, 2, status=LeadStatus.NO_ANSWER, updated_days_ago=1)
    untouched = _mk_lead(op, 3, status=LeadStatus.ASSIGNED, updated_days_ago=1)

    counts = leads_auto_close_stale(dry_run=False)

    assert counts == {op.id: 1}

    stale.refresh_from_db()
    carry.refresh_from_db()
    untouched.refresh_from_db()
    assert stale.status == LeadStatus.LOST
    assert carry.status == LeadStatus.NO_ANSWER
    assert untouched.status == LeadStatus.ASSIGNED


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_service_writes_audit_log_with_expected_comment():
    op = _mk_op()
    stale = _mk_lead(op, 1, status=LeadStatus.HAS_DEBT, updated_days_ago=1)

    leads_auto_close_stale(dry_run=False)

    entries = AuditLog.objects.filter(
        entity="leads.Lead",
        entity_id=str(stale.id),
        action=AuditAction.UPDATE,
    )
    assert entries.exists()
    assert entries.filter(comment__icontains="Автозакрытие").exists()


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_service_disabled_by_killswitch():
    """
    Если `SystemSetting.auto_distribution_enabled=False` — не закрываем
    ничего, чтобы менеджерский kill-switch реально гасил всю автомату.
    """
    obj = SystemSetting.get_solo()
    obj.auto_distribution_enabled = False
    obj.save(update_fields=["auto_distribution_enabled", "updated_at"])

    op = _mk_op()
    stale = _mk_lead(op, 1, status=LeadStatus.HAS_DEBT, updated_days_ago=1)

    counts = leads_auto_close_stale(dry_run=False)

    assert counts == {}
    stale.refresh_from_db()
    assert stale.status == LeadStatus.HAS_DEBT


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_service_dry_run_does_not_mutate():
    op = _mk_op()
    stale = _mk_lead(op, 1, status=LeadStatus.HAS_DEBT, updated_days_ago=1)

    counts = leads_auto_close_stale(dry_run=True)

    assert counts == {op.id: 1}
    stale.refresh_from_db()
    assert stale.status == LeadStatus.HAS_DEBT
    assert not AuditLog.objects.filter(
        entity="leads.Lead", entity_id=str(stale.id), action=AuditAction.UPDATE
    ).exists()


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_service_triggers_refill_when_operator_becomes_empty():
    """
    Оператор с 1 stale-лидом; в пуле 20 сирот → после auto-close operator
    working_count падает до 0 → refill-по-N через on_commit доливает 5.
    """
    from apps.leads.models import LeadAssignment

    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.HAS_DEBT, updated_days_ago=1)
    for i in range(20):
        Lead.objects.create(
            full_name=f"O-{i}",
            phone=f"+99899{i:07d}",
            status=LeadStatus.NEW,
            operator=None,
        )

    leads_auto_close_stale(dry_run=False)

    # 1 LOST + 5 свежих refill.
    assert Lead.objects.filter(operator=op).count() == 6
    assert Lead.objects.filter(operator=op, status=LeadStatus.LOST).count() == 1
    assert (
        LeadAssignment.objects.filter(
            operator=op, source=LeadAssignmentSource.AUTO_REFILL
        ).count()
        == 5
    )


# ---- management command --------------------------------------------------


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_command_runs_and_reports_per_operator():
    op_a = _mk_op("A")
    op_b = _mk_op("B")
    _mk_lead(op_a, 1, status=LeadStatus.HAS_DEBT, updated_days_ago=1)
    _mk_lead(op_a, 2, status=LeadStatus.HAS_DEBT, updated_days_ago=1)
    _mk_lead(op_b, 3, status=LeadStatus.HAS_DEBT, updated_days_ago=1)

    out = StringIO()
    call_command("auto_close_stale_leads", stdout=out)
    output = out.getvalue()

    assert f"operator={op_a.id}" in output
    assert "closed=2" in output
    assert f"operator={op_b.id}" in output
    assert "closed=1" in output
    assert "total closed: 3" in output


@pytest.mark.django_db
def test_command_dry_run_reports_but_doesnt_mutate():
    op = _mk_op()
    stale = _mk_lead(op, 1, status=LeadStatus.HAS_DEBT, updated_days_ago=1)

    out = StringIO()
    call_command("auto_close_stale_leads", "--dry-run", stdout=out)
    output = out.getvalue()

    assert "dry-run" in output
    assert "would close 1" in output or "would_close: 1" in output
    stale.refresh_from_db()
    assert stale.status == LeadStatus.HAS_DEBT


@pytest.mark.django_db
def test_command_respects_killswitch():
    obj = SystemSetting.get_solo()
    obj.auto_distribution_enabled = False
    obj.save(update_fields=["auto_distribution_enabled", "updated_at"])

    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.HAS_DEBT, updated_days_ago=1)

    out = StringIO()
    call_command("auto_close_stale_leads", stdout=out)
    output = out.getvalue()

    assert "disabled" in output.lower()
