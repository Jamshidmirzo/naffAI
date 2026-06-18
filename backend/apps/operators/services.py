from __future__ import annotations

from django.db import transaction
from rest_framework.exceptions import ValidationError

from apps.audit.services import AuditAction, audit_diff, audit_log_create

from .models import Operator, OperatorStatus


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
    Hard-delete an operator. Allowed ONLY when there are no Sale and no
    SaleOperator rows pointing at this operator. We refuse otherwise — soft
    delete (deactivate) is the right tool for operators with history.
    """
    # Local imports to avoid app-loading cycles.
    from apps.payroll.models import PayrollRule
    from apps.sales.models import Sale, SaleOperator
    from apps.users.models import Profile

    sale_count = Sale.objects.filter(operator=operator).count()
    line_count = SaleOperator.objects.filter(operator=operator).count()
    total = sale_count + line_count
    if total > 0:
        raise ValidationError(
            {
                "detail": (
                    f"У оператора {total} продаж. Удаление невозможно. "
                    f"Используйте деактивацию."
                )
            }
        )

    snapshot = {
        "id": operator.id,
        "full_name": operator.full_name,
        "phone": operator.phone,
        "status": operator.status,
    }
    Profile.objects.filter(operator=operator).update(operator=None)
    PayrollRule.objects.filter(operator=operator).delete()
    operator_id = operator.id
    operator.delete()
    audit_log_create(
        user=user,
        action=AuditAction.DELETE,
        entity="operators.Operator",
        entity_id=operator_id,
        changes={"snapshot": snapshot},
    )
