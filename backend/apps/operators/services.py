from __future__ import annotations

from django.db import transaction
from rest_framework.exceptions import ValidationError

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
    """Soft delete: we never remove operators (sale history points to them)."""
    return operator_update(operator=operator, user=user, status=OperatorStatus.INACTIVE)


@transaction.atomic
def operator_reactivate(*, operator: Operator, user=None) -> Operator:
    return operator_update(operator=operator, user=user, status=OperatorStatus.ACTIVE)


@transaction.atomic
def operator_delete(*, operator: Operator, user=None) -> None:
    """
    Hard-delete an operator.

    Business rule (per user decision, restored in Wave 1.8): delete is
    refused if the operator has any *active* (not soft-deleted) Sale
    attached. Callers must either deactivate the operator instead or
    soft-delete the sales first. Soft-deleted history rows do NOT block
    the deletion — otherwise operators would become undeletable after
    even a single cleanup.

    All other side-effect rows (SaleOperator allocation lines, Profile
    links, PayrollRule) are detached in-place and counted into a single
    audit entry so we can reconstruct what the delete touched.
    """
    # Local imports to avoid app-loading cycles.
    from apps.payroll.models import PayrollRule
    from apps.sales.models import Sale, SaleOperator
    from apps.users.models import Profile

    if Sale.objects.filter(operator=operator, is_deleted=False).exists():
        raise ValidationError(
            "Удаление невозможно: у оператора есть активные продажи. "
            "Используйте деактивацию или сначала удалите продажи."
        )

    snapshot = {
        "id": operator.id,
        "full_name": operator.full_name,
        "phone": operator.phone,
        "status": operator.status,
    }

    # Detach in a fixed order so the counts we record match the DELETE
    # sequence. SaleOperator lines are wiped (they're per-sale allocation
    # rows, not history). Sale FK is nulled to preserve historical rows.
    sale_operator_rows_deleted = SaleOperator.objects.filter(
        operator=operator
    ).delete()[0]
    sales_unlinked = Sale.objects.filter(operator=operator).update(operator=None)
    profiles_unlinked = Profile.objects.filter(operator=operator).update(operator=None)
    payroll_rules_deleted = PayrollRule.objects.filter(operator=operator).delete()[0]

    operator_id = operator.id
    operator.delete()

    audit_log_create(
        user=user,
        action=AuditAction.DELETE,
        entity="operators.Operator",
        entity_id=operator_id,
        changes={
            "snapshot": snapshot,
            "deleted_related": {
                "sale_operator_rows_deleted": sale_operator_rows_deleted,
                "sales_unlinked": sales_unlinked,
                "profiles_unlinked": profiles_unlinked,
                "payroll_rules_deleted": payroll_rules_deleted,
            },
        },
    )


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
