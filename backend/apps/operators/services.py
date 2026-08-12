from __future__ import annotations

from django.db import transaction
from django.db.models import Count
from django.utils import timezone

from apps.audit.services import AuditAction, audit_diff, audit_log_create

from .models import Operator, OperatorMonthlyPlan, OperatorStatus


@transaction.atomic
def operator_create(*, user=None, **fields) -> Operator:
    op = Operator.objects.create(**fields)
    audit_log_create(
        user=user,
        action=AuditAction.CREATE,
        entity="operators.Operator",
        entity_id=op.id,
        changes={k: str(v) for k, v in fields.items()},
    )
    return op


@transaction.atomic
def operator_update(*, operator: Operator, user=None, **fields) -> Operator:
    old = {f: getattr(operator, f) for f in fields}
    for k, v in fields.items():
        setattr(operator, k, v)
    operator.save()
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="operators.Operator",
        entity_id=operator.id,
        changes=audit_diff(
            {k: str(v) for k, v in old.items()}, {k: str(v) for k, v in fields.items()}
        ),
    )
    return operator


@transaction.atomic
def operator_deactivate(*, operator: Operator, user=None) -> Operator:
    """
    Soft delete + auto-rebalance:
    1. Set the operator's status to INACTIVE (round-robin will skip them
       for any new leads).
    2. Take back their **untouched** leads (status in {new, assigned},
       not postponed) and hand them out round-robin across the remaining
       eligible operators. Leads where the operator already made contact
       (in_progress / callback / no_answer / phone_on / has_debt) stay
       put so the context isn't lost.
    3. For every re-assigned lead, live callback reminders (pending /
       snoozed / overdue) that belong to the leaving operator are moved
       to the new owner with `dm_sent_at` cleared, so the next cron tick
       DMs the new operator instead of the ex-owner.

    Returns the operator with the extra `.rebalanced_count` /
    `.callbacks_moved` attributes attached (not persisted) — the view
    surfaces them in the API response.
    """
    from collections import defaultdict

    from django.db.models import Count, Q
    from django.utils import timezone

    from apps.leads.models import (
        Lead,
        LeadAssignment,
        LeadAssignmentSource,
        LeadStatus,
    )
    from apps.leads.selectors import (
        active_lead_status_codes,
        operators_eligible_for_new_leads,
    )

    operator_update(operator=operator, user=user, status=OperatorStatus.INACTIVE)

    candidate_ids = list(
        Lead.objects.filter(
            operator_id=operator.id,
            status__in=[LeadStatus.NEW, LeadStatus.ASSIGNED],
            postponed_at__isnull=True,
        ).values_list("id", flat=True)
    )
    operator.rebalanced_count = 0
    operator.callbacks_moved = 0

    if not candidate_ids:
        return operator

    ops = list(operators_eligible_for_new_leads().exclude(pk=operator.id))
    if not ops:
        # Nobody to receive — leave them on the deactivated operator.
        return operator

    # Snapshot current load per candidate operator, then run round-robin
    # in-memory: always give the next lead to the least-loaded operator
    # (tie broken by id for determinism).
    load_qs = (
        Lead.objects.filter(operator_id__in=[o.id for o in ops])
        .values("operator_id")
        .annotate(n=Count("id", filter=Q(status__in=active_lead_status_codes())))
    )
    load = defaultdict(int)
    for row in load_qs:
        load[row["operator_id"]] = row["n"]

    now = timezone.now()
    per_op: dict[int, int] = defaultdict(int)

    def pick_next() -> int:
        return min(ops, key=lambda o: (load[o.id], o.id)).id

    CHUNK = 500
    total_reassigned = 0
    for start in range(0, len(candidate_ids), CHUNK):
        chunk = candidate_ids[start : start + CHUNK]
        leads = list(Lead.objects.filter(id__in=chunk))
        assignments = []
        for lead in leads:
            op_id = pick_next()
            LeadAssignment.objects.filter(lead=lead, active=True).update(active=False)
            lead.operator_id = op_id
            lead.status = LeadStatus.ASSIGNED
            lead.updated_at = now
            load[op_id] += 1
            per_op[op_id] += 1
            assignments.append(
                LeadAssignment(
                    lead=lead,
                    operator_id=op_id,
                    source=LeadAssignmentSource.AUTO_ROUND_ROBIN,
                    reason=f"auto-rebalance on operator#{operator.id} deactivation",
                    active=True,
                )
            )
        Lead.objects.bulk_update(
            leads, ["operator_id", "status", "updated_at"], batch_size=200
        )
        LeadAssignment.objects.bulk_create(assignments, batch_size=200)
        total_reassigned += len(leads)

    # Move any live callback reminders on these leads to the new owner
    # so DM cron pings the right person.
    from apps.calls.models import CallbackReminder, CallbackReminderStatus

    live_statuses = (
        CallbackReminderStatus.PENDING,
        CallbackReminderStatus.SNOOZED,
        CallbackReminderStatus.OVERDUE,
    )
    cb_qs = CallbackReminder.objects.filter(
        lead_id__in=candidate_ids,
        operator_id=operator.id,
        status__in=live_statuses,
    )
    # Per-lead new_operator lookup: rebuild it via a single query
    # (bulk_update rewired the operator FK above).
    lead_owner = dict(
        Lead.objects.filter(id__in=candidate_ids).values_list("id", "operator_id")
    )
    for cb in cb_qs:
        cb.operator_id = lead_owner.get(cb.lead_id, cb.operator_id)
        cb.dm_sent_at = None
    if cb_qs.exists():
        CallbackReminder.objects.bulk_update(list(cb_qs), ["operator_id", "dm_sent_at"], batch_size=200)

    operator.rebalanced_count = total_reassigned
    operator.callbacks_moved = cb_qs.count()

    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="operators.Operator",
        entity_id=operator.id,
        changes={
            "auto_rebalance_on_deactivate": True,
            "leads_reassigned": total_reassigned,
            "callbacks_moved": operator.callbacks_moved,
            "per_operator": {op.full_name: per_op[op.id] for op in ops if per_op.get(op.id)},
        },
        comment=f"Auto-rebalanced {total_reassigned} untouched leads on deactivate",
    )
    return operator


@transaction.atomic
def operator_reactivate(*, operator: Operator, user=None) -> Operator:
    """
    Flip to ACTIVE, then auto-rebalance untouched leads TO the new
    operator so they don't sit on 0 while everyone else has 60. Mirrors
    `operator_deactivate` — same untouched-only rule (status ∈ {new,
    assigned}, not postponed), same LeadAssignment history, same audit
    shape. Callbacks are not pulled: they belong to the donor's
    previous contact with that client.
    """
    from collections import defaultdict

    from django.db.models import Count, Q

    from apps.leads.models import (
        Lead,
        LeadAssignment,
        LeadAssignmentSource,
        LeadStatus,
    )
    from apps.leads.selectors import (
        active_lead_status_codes,
        operators_eligible_for_new_leads,
    )

    operator_update(operator=operator, user=user, status=OperatorStatus.ACTIVE)
    operator.rebalanced_count = 0

    donors = list(operators_eligible_for_new_leads().exclude(pk=operator.id))
    if not donors:
        return operator

    all_ops = donors + [operator]
    active_codes = active_lead_status_codes()

    load: dict[int, int] = defaultdict(int)
    for row in (
        Lead.objects.filter(operator_id__in=[o.id for o in all_ops])
        .values("operator_id")
        .annotate(n=Count("id", filter=Q(status__in=active_codes)))
    ):
        load[row["operator_id"]] = row["n"]

    target = sum(load.values()) // len(all_ops)
    per_donor: dict[int, int] = defaultdict(int)
    total_moved = 0

    active_donors = list(donors)
    while load[operator.id] < target and active_donors:
        donor = max(active_donors, key=lambda o: load[o.id])
        if load[donor.id] <= target:
            break
        lead = (
            Lead.objects.filter(
                operator_id=donor.id,
                status__in=(LeadStatus.NEW, LeadStatus.ASSIGNED),
                postponed_at__isnull=True,
            )
            .order_by("-created_at")
            .first()
        )
        if lead is None:
            active_donors = [o for o in active_donors if o.id != donor.id]
            continue

        LeadAssignment.objects.filter(lead=lead, active=True).update(active=False)
        LeadAssignment.objects.create(
            lead=lead,
            operator=operator,
            source=LeadAssignmentSource.AUTO_ROUND_ROBIN,
            active=True,
            reason=f"rebalance on activate: from op#{donor.id}",
        )
        lead.operator = operator
        lead.save(update_fields=["operator", "updated_at"])
        load[donor.id] -= 1
        load[operator.id] += 1
        per_donor[donor.id] += 1
        total_moved += 1

    operator.rebalanced_count = total_moved
    if total_moved:
        donor_names = {
            o.full_name: per_donor[o.id]
            for o in donors
            if per_donor.get(o.id)
        }
        audit_log_create(
            user=user,
            action=AuditAction.UPDATE,
            entity="operators.Operator",
            entity_id=operator.id,
            changes={
                "auto_rebalance_on_activate": True,
                "leads_reassigned": total_moved,
                "per_donor": donor_names,
            },
            comment=f"Auto-rebalanced {total_moved} untouched leads on activate",
        )
    return operator


@transaction.atomic
def operator_delete(*, operator: Operator, user=None) -> dict:
    """
    Hard-delete an operator, cleaning up their attached sales:
      - Sales where this operator was the ONLY seller (`operator_lines.count()==1`
        AND not already soft-deleted) → soft-delete (`is_deleted=True`,
        `deleted_at=now()`). Their total drops out of dashboard KPI, per-op
        analytics, and payroll.
      - Sales where this operator was ONE OF SEVERAL → drop only their
        `SaleOperator` line and append a note into `sale.comment` recording
        the deleted operator + their share, so the manager can later trace
        why the remaining sellers' amounts don't sum to `sale.amount`.
        `sale.amount` stays untouched (the customer still paid this money).

    Legacy single-FK `Sale.operator` is nulled to `SET_NULL`-equivalent via
    UPDATE (the FK is defined as PROTECT to guard against accidental
    `.delete()`, so we sidestep it explicitly).

    All other side-effect rows (SaleOperator lines already handled above,
    Profile links, PayrollRule) are detached in-place. Every count is
    recorded in a single audit entry so we can reconstruct what the
    delete touched. Returns the counts as a dict for the API layer.
    """
    # Local imports to avoid app-loading cycles.
    from apps.payroll.models import PayrollRule
    from apps.sales.models import Sale, SaleOperator
    from apps.users.models import Profile

    snapshot = {
        "id": operator.id,
        "full_name": operator.full_name,
        "phone": operator.phone,
        "status": operator.status,
    }

    now = timezone.now()

    # Split affected sales into "will become orphan after we drop this line"
    # vs "still has other operators". Only consider not-yet-soft-deleted
    # sales — historical soft-deleted ones we can leave untouched.
    affected_sales = (
        SaleOperator.objects.filter(operator=operator, sale__is_deleted=False)
        .values("sale_id", "amount")
        .annotate(total_lines=Count("sale__operator_lines"))
    )
    single_op_sale_ids: list[int] = []
    multi_op_notes: list[dict] = []
    for row in affected_sales:
        if row["total_lines"] == 1:
            single_op_sale_ids.append(row["sale_id"])
        else:
            multi_op_notes.append({"sale_id": row["sale_id"], "amount": row["amount"]})

    # Multi-op: append a `[Удалён YYYY-MM-DD] Оператор X: доля N сум` note
    # so the sale detail retains context for the shopkeeper reviewing later.
    note_stem = f"[Удалён {now:%Y-%m-%d}] Оператор {operator.full_name}: доля"
    for entry in multi_op_notes:
        sale = Sale.objects.filter(pk=entry["sale_id"]).only("id", "comment").first()
        if sale is None:
            continue
        share_fmt = f"{int(entry['amount']):,}".replace(",", " ")
        line = f"{note_stem} {share_fmt} сум"
        sale.comment = (sale.comment + "\n" + line).strip() if sale.comment else line
        sale.save(update_fields=["comment"])

    # Soft-delete single-operator sales.
    sales_soft_deleted = 0
    if single_op_sale_ids:
        sales_soft_deleted = Sale.objects.filter(pk__in=single_op_sale_ids).update(
            is_deleted=True, deleted_at=now
        )

    # Now drop the SaleOperator lines (both single-op orphaned and multi-op share)
    # and detach the legacy single-FK on any remaining Sale rows.
    sale_operator_rows_deleted = SaleOperator.objects.filter(
        operator=operator
    ).delete()[0]
    sales_unlinked = Sale.objects.filter(operator=operator).update(operator=None)
    profiles_unlinked = Profile.objects.filter(operator=operator).update(operator=None)
    payroll_rules_deleted = PayrollRule.objects.filter(operator=operator).delete()[0]

    operator_id = operator.id
    operator.delete()

    deleted_related = {
        "sale_operator_rows_deleted": sale_operator_rows_deleted,
        "sales_soft_deleted_count": sales_soft_deleted,
        "sales_soft_deleted_ids": single_op_sale_ids,
        "sales_annotated_count": len(multi_op_notes),
        "sales_annotated_ids": [e["sale_id"] for e in multi_op_notes],
        "sales_unlinked": sales_unlinked,
        "profiles_unlinked": profiles_unlinked,
        "payroll_rules_deleted": payroll_rules_deleted,
    }

    audit_log_create(
        user=user,
        action=AuditAction.DELETE,
        entity="operators.Operator",
        entity_id=operator_id,
        changes={
            "snapshot": snapshot,
            "deleted_related": deleted_related,
        },
    )
    return deleted_related


@transaction.atomic
def operator_self_update_preferences(
    *,
    operator: Operator,
    user=None,
    daily_lesson_opt_out: bool | None = None,
) -> Operator:
    """
    Operator-facing preferences update — narrower than `operator_update`
    on purpose. The operator can toggle their own notification flags
    without needing the team-lead permission.

    Only the fields explicitly passed here are mutated; everything else
    (name, phone, hired_at, ...) is off-limits from this surface.
    """
    changes: dict[str, str] = {}
    if daily_lesson_opt_out is not None and daily_lesson_opt_out != operator.daily_lesson_opt_out:
        old = operator.daily_lesson_opt_out
        operator.daily_lesson_opt_out = daily_lesson_opt_out
        operator.save(update_fields=["daily_lesson_opt_out", "updated_at"])
        changes["daily_lesson_opt_out"] = f"{old} → {daily_lesson_opt_out}"

    if changes:
        audit_log_create(
            user=user,
            action=AuditAction.UPDATE,
            entity="operators.Operator",
            entity_id=operator.id,
            changes={"self_preferences": changes},
        )
    return operator


@transaction.atomic
def operator_plan_upsert(*, operator: Operator, year: int, month: int, target_amount, user=None) -> OperatorMonthlyPlan:
    plan, created = OperatorMonthlyPlan.objects.update_or_create(
        operator=operator, year=year, month=month,
        defaults={"target_amount": target_amount},
    )
    audit_log_create(
        user=user,
        action=AuditAction.CREATE if created else AuditAction.UPDATE,
        entity="operators.OperatorMonthlyPlan",
        entity_id=plan.id,
        changes={"year": str(year), "month": str(month), "target_amount": str(target_amount)},
    )
    return plan
