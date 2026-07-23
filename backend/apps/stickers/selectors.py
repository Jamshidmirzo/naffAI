from __future__ import annotations

from apps.operators.models import Operator

from .models import OperatorSticker


def taken_emojis() -> dict[str, str]:
    """Map of regular (non-rare) emoji -> operator full_name that owns it."""
    qs = OperatorSticker.objects.filter(is_rare=False).select_related("operator")
    return {row.emoji: row.operator.full_name for row in qs}


def rare_holder() -> OperatorSticker | None:
    return OperatorSticker.objects.filter(is_rare=True).select_related("operator").first()


def sticker_for(operator: Operator) -> OperatorSticker | None:
    return OperatorSticker.objects.filter(operator=operator).first()
