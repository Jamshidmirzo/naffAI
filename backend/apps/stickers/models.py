"""
Operator sticker — a small personal emoji next to their name.

Business rules:
- Every operator can pick ONE regular emoji from a small predefined palette.
- Regular emojis are unique across the whole system — nobody else can pick
  the same one (partial unique index; enforced with UniqueConstraint +
  condition=Q(is_rare=False)).
- Exactly one sticker can be "rare" across the whole system at any time
  (partial unique index; enforced with UniqueConstraint on `is_rare` where
  is_rare=True). The rare sticker is assigned by an admin (team_lead/manager)
  and can be re-assigned — the previous holder loses it.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models

from apps.common.models import TimestampedModel


class OperatorSticker(TimestampedModel):
    operator = models.OneToOneField(
        "operators.Operator",
        on_delete=models.CASCADE,
        related_name="sticker",
    )
    emoji = models.CharField(max_length=8)
    is_rare = models.BooleanField(default=False)
    assigned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
        help_text="Who assigned the sticker (only meaningful for rare).",
    )

    class Meta:
        constraints = [
            # Regular emoji is unique in the whole system.
            models.UniqueConstraint(
                fields=["emoji"],
                condition=models.Q(is_rare=False),
                name="unique_common_sticker_emoji",
            ),
            # Only a single rare sticker across all operators.
            models.UniqueConstraint(
                fields=["is_rare"],
                condition=models.Q(is_rare=True),
                name="single_rare_sticker_holder",
            ),
        ]

    def __str__(self) -> str:
        marker = " (rare)" if self.is_rare else ""
        return f"{self.emoji}{marker} → {self.operator_id}"
