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
def operator_deactivate(
    *, operator: Operator, user=None, rescue_touched: bool = True
) -> Operator:
    """
    Soft delete + auto-rebalance:
    1. Set the operator's status to INACTIVE (round-robin will skip them
       for any new leads).
    2. Take back their **untouched** leads (status in {new, assigned},
       not postponed) and hand them out round-robin across the remaining
       eligible operators.
    3. If `rescue_touched=True` (default) — non-terminal touched лиды
       (in_progress / no_answer / phone_on / has_debt / callback_scheduled
       / …) отвязываются от оператора и уходят в `needs_review=True`,
       чтобы менеджер вручную разобрал контекст через новый чип
       /leads/orphans?kind=needs_review. Раньше они оставались висеть на
       уволенном и никогда никому не выдавались (см. rescue-command
       `rescue_stranded_leads`).
       При `rescue_touched=False` — legacy-поведение: touched-лиды
       остаются на уволенном (для обратной совместимости, если
       вызывающий явно попросил).
    4. For every re-assigned lead, live callback reminders (pending /
       snoozed / overdue) that belong to the leaving operator are moved
       to the new owner with `dm_sent_at` cleared, so the next cron tick
       DMs the new operator instead of the ex-owner.

    Returns the operator with the extra `.rebalanced_count`,
    `.callbacks_moved`, `.touched_needs_review_count` attributes attached
    (not persisted) — the view surfaces them in the API response.
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
    operator.touched_needs_review_count = 0

    # Если оператор был последний activate — некому раздавать
    # untouched. Но rescue_touched может всё равно сработать: touched
    # уходят в needs_review, не требуя другого оператора.
    if not candidate_ids:
        _apply_rescue_touched_if_needed(
            operator=operator, user=user, rescue_touched=rescue_touched
        )
        return operator

    ops = list(operators_eligible_for_new_leads().exclude(pk=operator.id))
    if not ops:
        # Nobody to receive untouched leads — оставляем их на
        # деактивированном. Но rescue_touched всё равно может отработать
        # (touched → needs_review не требует свободных операторов).
        _apply_rescue_touched_if_needed(
            operator=operator, user=user, rescue_touched=rescue_touched
        )
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

    _apply_rescue_touched_if_needed(
        operator=operator, user=user, rescue_touched=rescue_touched
    )
    return operator


def _apply_rescue_touched_if_needed(
    *, operator: Operator, user, rescue_touched: bool
) -> None:
    """
    После основного untouched-rebalance: touched non-terminal лиды
    (`in_progress` / `no_answer*` / `phone_on` / `has_debt` /
    `callback_scheduled` / …) отвязываем от оператора в `needs_review`.
    Менеджер сам решит через новый чип /leads/orphans?kind=needs_review,
    что с ними делать: продолжить разговор, отдать другому, закрыть как
    LOST и т.п. Автоматически распихивать их по операторам нельзя —
    новый оператор позвонит клиенту «с начала», потеряется контекст.

    Реализация делегирована в `apps.leads.services.rescue_stranded_leads_for_operator`,
    чтобы rescue-логика жила рядом с самими селекторами лидов и была
    доступна для отдельной management-команды.

    Кладём `operator.touched_needs_review_count = N` — API-слой
    сурфейсит цифру в toast «N лидов ушло в needs_review».
    """
    if not rescue_touched:
        return
    from apps.leads.services import rescue_stranded_leads_for_operator

    result = rescue_stranded_leads_for_operator(operator=operator, user=user)
    operator.touched_needs_review_count = int(
        result.get("touched_moved_to_needs_review", 0)
    )
    # untouched_moved_to_pool в этот момент = 0 (мы их уже развезли выше),
    # но если по какой-то причине остались — они тоже уйдут в пул через rescue.
    if result.get("untouched_moved_to_pool"):
        operator.rebalanced_count = (
            int(getattr(operator, "rebalanced_count", 0) or 0)
            + int(result["untouched_moved_to_pool"])
        )


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

      - Sales where this operator was the ONLY seller
        (`operator_lines.count()==1` AND not already soft-deleted) →
        soft-delete (`is_deleted=True`, `deleted_at=now()`). Their total
        drops out of dashboard KPI, per-op analytics, and payroll.

      - Sales where this operator was ONE OF SEVERAL → **subtract only
        this operator's share** from the sale's gross amount and drop
        their `SaleOperator` line. The sale stays visible; remaining
        operators keep their credit; the store's reported revenue
        (`amount − discount`) drops by exactly this operator's net
        share. `SalePartner` lines are reduced proportionally to keep
        `Σ partner.amount == sale.amount`. A note is appended to
        `sale.comment` recording the operator + subtracted share so the
        manager can trace the change later.

    Math for the multi-op branch (money is `Decimal(14, 2)`):
        gross         = sale.amount
        discount      = sale.discount
        net           = gross − discount
        share_net     = SaleOperator.amount for the leaving operator
        share_gross   = share_net × gross / net       (when net > 0)
        share_disc    = share_gross − share_net
        new_amount    = gross − share_gross
        new_discount  = discount − share_disc
    Rounding uses ROUND_HALF_UP to 0.01 with the remainder pushed onto
    the last partner line so the invariants stay exact:
        Σ SaleOperator.amount = new_amount − new_discount
        Σ SalePartner.amount  = new_amount

    Legacy single-FK `Sale.operator` is nulled via UPDATE (the FK is
    defined as PROTECT to guard against accidental `.delete()`, so we
    sidestep it explicitly).

    All other side-effect rows (Profile links, PayrollRule) are
    detached in-place. Every count is recorded in a single audit entry
    so we can reconstruct what the delete touched. Returns the counts
    as a dict for the API layer.
    """
    # Local imports to avoid app-loading cycles.
    from decimal import ROUND_HALF_UP, Decimal

    from apps.payroll.models import PayrollRule
    from apps.sales.models import Sale, SaleOperator, SalePartner
    from apps.users.models import Profile

    _MONEY_Q = Decimal("0.01")
    _ZERO = Decimal("0")

    snapshot = {
        "id": operator.id,
        "full_name": operator.full_name,
        "phone": operator.phone,
        "status": operator.status,
    }

    now = timezone.now()

    # Split affected sales into "will become orphan after we drop this
    # line" vs "still has other operators". Only consider not-yet-soft-
    # deleted sales — historical soft-deleted ones we can leave alone.
    affected_sales = (
        SaleOperator.objects.filter(operator=operator, sale__is_deleted=False)
        .values("sale_id", "amount")
        .annotate(total_lines=Count("sale__operator_lines"))
    )
    single_op_sale_ids: list[int] = []
    multi_op_entries: list[dict] = []
    for row in affected_sales:
        if row["total_lines"] == 1:
            single_op_sale_ids.append(row["sale_id"])
        else:
            multi_op_entries.append({"sale_id": row["sale_id"], "share_net": row["amount"]})

    # Multi-op: shrink the sale — subtract this operator's share from
    # gross amount / discount / partner lines proportionally, then drop
    # the operator's SaleOperator line and annotate the sale comment.
    multi_op_adjustments: list[dict] = []
    note_stem = f"[Удалён {now:%Y-%m-%d}] Оператор {operator.full_name}: списана доля"
    for entry in multi_op_entries:
        sale = Sale.objects.filter(pk=entry["sale_id"]).first()
        if sale is None:
            continue
        share_net: Decimal = Decimal(entry["share_net"])
        gross: Decimal = Decimal(sale.amount)
        discount: Decimal = Decimal(sale.discount)
        net: Decimal = gross - discount

        if net > 0:
            share_gross = (share_net * gross / net).quantize(_MONEY_Q, rounding=ROUND_HALF_UP)
        else:
            # Degenerate: net=0 → share_net must also be 0. Nothing to shrink.
            share_gross = _ZERO
        share_disc = (share_gross - share_net).quantize(_MONEY_Q, rounding=ROUND_HALF_UP)

        new_amount = (gross - share_gross).quantize(_MONEY_Q, rounding=ROUND_HALF_UP)
        new_discount = (discount - share_disc).quantize(_MONEY_Q, rounding=ROUND_HALF_UP)
        # Clamp against float dust; discount can never exceed amount.
        if new_discount < 0:
            new_discount = _ZERO
        if new_discount > new_amount:
            new_discount = new_amount

        # Shrink partner lines proportionally so
        # `Σ SalePartner.amount == new_amount` still holds. Last line
        # absorbs the rounding remainder.
        partner_lines = list(sale.partner_lines.all().order_by("id"))
        if partner_lines and gross > 0 and new_amount != gross:
            shrink_factor = new_amount / gross
            running = _ZERO
            for i, pl in enumerate(partner_lines):
                if i == len(partner_lines) - 1:
                    pl.amount = (new_amount - running).quantize(_MONEY_Q, rounding=ROUND_HALF_UP)
                else:
                    pl.amount = (Decimal(pl.amount) * shrink_factor).quantize(
                        _MONEY_Q, rounding=ROUND_HALF_UP
                    )
                    running += pl.amount
                pl.save(update_fields=["amount"])

        # Append a human-readable note before updating amount.
        share_fmt = f"{int(share_net):,}".replace(",", " ")
        new_amount_fmt = f"{int(new_amount):,}".replace(",", " ")
        line = f"{note_stem} {share_fmt} сум, новая сумма продажи {new_amount_fmt} сум"
        sale.comment = (sale.comment + "\n" + line).strip() if sale.comment else line
        sale.amount = new_amount
        sale.discount = new_discount
        sale.save(update_fields=["amount", "discount", "comment"])

        multi_op_adjustments.append(
            {
                "sale_id": sale.id,
                "share_net": str(share_net),
                "share_gross": str(share_gross),
                "old_amount": str(gross),
                "new_amount": str(new_amount),
                "old_discount": str(discount),
                "new_discount": str(new_discount),
            }
        )

    # Soft-delete single-operator sales.
    sales_soft_deleted = 0
    if single_op_sale_ids:
        sales_soft_deleted = Sale.objects.filter(pk__in=single_op_sale_ids).update(
            is_deleted=True, deleted_at=now
        )

    # Now drop the SaleOperator lines (both single-op orphaned and
    # multi-op share) and detach the legacy single-FK on any remaining
    # Sale rows.
    sale_operator_rows_deleted = SaleOperator.objects.filter(
        operator=operator
    ).delete()[0]
    sales_unlinked = Sale.objects.filter(operator=operator).update(operator=None)
    profiles_unlinked = Profile.objects.filter(operator=operator).update(operator=None)
    payroll_rules_deleted = PayrollRule.objects.filter(operator=operator).delete()[0]

    # Historic FKs (LeadAssignment / CallAttempt / CallbackReminder) are
    # SET_NULL — Django's collector nullifies them inside operator.delete()
    # so lead history and reminder trails survive the operator being gone.
    # We snapshot the counts here for the audit entry.
    from apps.calls.models import CallAttempt, CallbackReminder
    from apps.leads.models import LeadAssignment

    lead_assignments_detached = LeadAssignment.objects.filter(operator=operator).count()
    call_attempts_detached = CallAttempt.objects.filter(operator=operator).count()
    callback_reminders_detached = CallbackReminder.objects.filter(operator=operator).count()

    operator_id = operator.id
    operator.delete()

    deleted_related = {
        "sale_operator_rows_deleted": sale_operator_rows_deleted,
        "sales_soft_deleted_count": sales_soft_deleted,
        "sales_soft_deleted_ids": single_op_sale_ids,
        "sales_shrunk_count": len(multi_op_adjustments),
        "sales_shrunk_ids": [e["sale_id"] for e in multi_op_adjustments],
        "sales_shrunk_details": multi_op_adjustments,
        # Back-compat aliases kept so older audit-log readers keep working.
        "sales_annotated_count": len(multi_op_adjustments),
        "sales_annotated_ids": [e["sale_id"] for e in multi_op_adjustments],
        "sales_unlinked": sales_unlinked,
        "profiles_unlinked": profiles_unlinked,
        "payroll_rules_deleted": payroll_rules_deleted,
        "lead_assignments_detached": lead_assignments_detached,
        "call_attempts_detached": call_attempts_detached,
        "callback_reminders_detached": callback_reminders_detached,
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
def operator_self_update_birth_date(
    *,
    operator: Operator,
    user=None,
    birth_date=None,
) -> Operator:
    """
    Operator-facing update своей даты рождения.

    Отдельный сервис (а не общий `operator_update`), потому что:
      1. Оператор не имеет права трогать другие поля модели —
         сериалайзер даёт наружу только `birth_date` через `PATCH /me/`;
      2. Меняя ДР, сбрасываем `birthday_notified_on` в None только если
         дата сдвинулась на другой день/месяц — иначе теряется
         idempotency-guard cron'a (перестанет считать «уже поздравил»).
      3. Audit-log-ем изменение с полем `self_birth_date` — легко
         фильтровать в аудите (кто менял ДР, было/стало).

    `birth_date=None` очищает дату (оператор передумал делиться).
    """
    old = operator.birth_date
    if old == birth_date:
        return operator

    operator.birth_date = birth_date
    # Если день/месяц поменялись — сбрасываем idempotency guard.
    # Если это тот же day/month, но другой год — не сбрасываем, cron уже
    # поздравил на этот день, повторно не надо.
    same_day = (
        old is not None
        and birth_date is not None
        and old.month == birth_date.month
        and old.day == birth_date.day
    )
    if not same_day:
        operator.birthday_notified_on = None
        operator.save(update_fields=["birth_date", "birthday_notified_on", "updated_at"])
    else:
        operator.save(update_fields=["birth_date", "updated_at"])

    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="operators.Operator",
        entity_id=operator.id,
        changes={
            "self_birth_date": {
                "old": old.isoformat() if old else None,
                "new": birth_date.isoformat() if birth_date else None,
            }
        },
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
