from __future__ import annotations

from django.db import transaction

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
