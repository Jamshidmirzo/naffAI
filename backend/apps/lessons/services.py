"""
Write-side business logic for the ``lessons`` app.

Views/serializers stay thin — anything that mutates DailyLesson or its
feedback goes through here so we can add audit / A/B tracking / etc. in
one place later.
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import transaction

from .models import DailyLesson, DailyLessonFeedback

User = get_user_model()


@transaction.atomic
def lesson_feedback_upsert(
    *,
    lesson: DailyLesson,
    actor,
    rating: str,
    comment: str = "",
) -> DailyLessonFeedback:
    """
    Idempotent: creating a second feedback for the same lesson overwrites
    the previous one (we only keep the latest signal per operator per
    lesson — matches the UI where the operator taps 👍 or 👎 once).
    """
    fb, _ = DailyLessonFeedback.objects.update_or_create(
        lesson=lesson,
        defaults={
            "rating": rating,
            "comment": comment or "",
            "created_by": actor if getattr(actor, "is_authenticated", False) else None,
        },
    )
    return fb
