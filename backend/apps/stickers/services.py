"""
Sticker services — all mutating operations go through here.

- ``sticker_set``     — operator (or admin acting on their behalf) picks a
                       regular (non-rare) emoji. Must not collide with any
                       other operator's regular emoji.
- ``sticker_grant_rare`` — admin awards the single system-wide "rare"
                       sticker. If someone already holds it, they are
                       demoted (their sticker is removed entirely — audit
                       records both the grant and the revoke).
- ``sticker_revoke``  — admin removes an operator's sticker.

Regular emojis are drawn from ``ALLOWED_COMMON_EMOJIS``. The rare emoji
can be anything the admin picks — no palette restriction.
"""

from __future__ import annotations

from django.db import transaction
from rest_framework.exceptions import ValidationError

from apps.audit.services import AuditAction, audit_log_create
from apps.operators.models import Operator

from .models import OperatorSticker

# Curated set of ~100 common emojis operators can pick from. UI shows the
# whole set; taken ones are greyed out with a tooltip. Keeping this in
# code (not DB) so that the palette stays consistent across environments.
ALLOWED_COMMON_EMOJIS: tuple[str, ...] = (
    "🔥", "⚡", "🎯", "💎", "🌟", "💫", "🚀", "⭐", "🎨", "🎪",
    "🎭", "🎬", "🎤", "🎧", "🎼", "🎹", "🥁", "🎸", "🎺", "🎻",
    "🏆", "🥇", "🥈", "🥉", "🏅", "🎖️", "🏵️", "🎗️", "🏹", "⚔️",
    "🌈", "☀️", "🌙", "⛅", "🌤️", "❄️", "🌊", "🌵", "🌸", "🌺",
    "🌻", "🌼", "🌷", "🍀", "🍁", "🍂", "🌿", "🍃", "🪴", "🌱",
    "🍎", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🍒", "🍑", "🥭",
    "🍍", "🥝", "🥥", "🥑", "🍔", "🍕", "🍟", "🌮", "🌯", "🍣",
    "☕", "🍵", "🧃", "🥤", "🍰", "🎂", "🍩", "🍪", "🍫", "🍬",
    "⚽", "🏀", "🏈", "⚾", "🎾", "🏐", "🏓", "🎱", "🎳", "🎮",
    "🕹️", "🎲", "🧩", "♟️", "🐱", "🐶", "🦊", "🦁", "🐯", "🐼",
)


def _validate_common_emoji(emoji: str) -> None:
    if emoji not in ALLOWED_COMMON_EMOJIS:
        raise ValidationError({"emoji": "Недопустимый эмодзи. Выберите из палитры."})


@transaction.atomic
def sticker_set(*, operator: Operator, emoji: str, actor=None) -> OperatorSticker:
    """
    Operator claims (or updates) their regular sticker.

    Raises ValidationError if the emoji is already taken by another
    (regular) sticker, or if it's outside the allowed palette.
    """
    _validate_common_emoji(emoji)

    clash = (
        OperatorSticker.objects
        .filter(emoji=emoji, is_rare=False)
        .exclude(operator=operator)
        .exists()
    )
    if clash:
        raise ValidationError({"emoji": "Этот стикер уже занят другим оператором."})

    sticker, created = OperatorSticker.objects.update_or_create(
        operator=operator,
        defaults={"emoji": emoji, "is_rare": False, "assigned_by": None},
    )
    audit_log_create(
        user=actor,
        action=AuditAction.CREATE if created else AuditAction.UPDATE,
        entity="stickers.OperatorSticker",
        entity_id=sticker.id,
        changes={"operator_id": operator.id, "emoji": emoji, "is_rare": False},
    )
    return sticker


@transaction.atomic
def sticker_grant_rare(*, operator: Operator, emoji: str, actor=None) -> OperatorSticker:
    """
    Admin awards the single system-wide rare sticker. If another operator
    currently holds the rare sticker, it is revoked from them (their row
    is deleted entirely — the design decision: only one rare in the
    system, and losing it means losing the row).
    """
    if not emoji:
        raise ValidationError({"emoji": "Нужен эмодзи для rare-стикера."})

    # Revoke any existing rare from someone else.
    current = OperatorSticker.objects.filter(is_rare=True).exclude(operator=operator).first()
    if current is not None:
        prev_operator_id = current.operator_id
        prev_emoji = current.emoji
        current.delete()
        audit_log_create(
            user=actor,
            action=AuditAction.DELETE,
            entity="stickers.OperatorSticker",
            entity_id=prev_operator_id,
            changes={
                "reason": "rare_reassigned",
                "operator_id": prev_operator_id,
                "emoji": prev_emoji,
            },
        )

    sticker, created = OperatorSticker.objects.update_or_create(
        operator=operator,
        defaults={"emoji": emoji, "is_rare": True, "assigned_by": actor},
    )
    audit_log_create(
        user=actor,
        action=AuditAction.CREATE if created else AuditAction.UPDATE,
        entity="stickers.OperatorSticker",
        entity_id=sticker.id,
        changes={
            "operator_id": operator.id,
            "emoji": emoji,
            "is_rare": True,
            "granted_by": getattr(actor, "id", None),
        },
    )
    return sticker


@transaction.atomic
def sticker_revoke(*, operator: Operator, actor=None) -> None:
    sticker = OperatorSticker.objects.filter(operator=operator).first()
    if sticker is None:
        return
    sticker_id = sticker.id
    snapshot = {
        "operator_id": operator.id,
        "emoji": sticker.emoji,
        "is_rare": sticker.is_rare,
    }
    sticker.delete()
    audit_log_create(
        user=actor,
        action=AuditAction.DELETE,
        entity="stickers.OperatorSticker",
        entity_id=sticker_id,
        changes=snapshot,
    )
