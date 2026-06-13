from __future__ import annotations

from .models import PayrollRule, PayrollScope


def payroll_rule_for(operator_id: int) -> PayrollRule | None:
    """Operator-scoped override wins, otherwise the active global rule."""
    op_rule = (
        PayrollRule.objects.filter(
            scope=PayrollScope.OPERATOR, operator_id=operator_id, is_active=True
        )
        .order_by("-id")
        .first()
    )
    if op_rule:
        return op_rule
    return (
        PayrollRule.objects.filter(scope=PayrollScope.GLOBAL, is_active=True)
        .order_by("-id")
        .first()
    )
