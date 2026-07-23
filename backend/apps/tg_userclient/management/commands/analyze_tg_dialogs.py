"""
Management command: batch AI analysis of TG dialogs.

Usage:
    python manage.py analyze_tg_dialogs

Cron: every hour (idempotent — skips chats already analyzed up to
their latest message, with retry backoff on LLM errors).
"""

from datetime import timedelta
from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.tg_userclient.ai.provider import MessageDTO, get_provider
from apps.tg_userclient.models import (
    TgAiInsight,
    TgAiInsightAttempt,
    TgAiInsightAttemptStatus,
    TgChat,
    TgMessage,
    TgSession,
    TgSessionStatus,
)


def _should_process(chat: TgChat) -> bool:
    latest_insight = TgAiInsight.objects.filter(chat=chat).order_by("-until").first()
    if latest_insight and chat.last_message_at and latest_insight.until >= chat.last_message_at:
        return False
    last_attempt = TgAiInsightAttempt.objects.filter(chat=chat).order_by("-attempted_at").first()
    if last_attempt:
        if last_attempt.status == TgAiInsightAttemptStatus.ERROR_PERMANENT:
            return False
        if (
            last_attempt.status == TgAiInsightAttemptStatus.ERROR_RETRIABLE
            and last_attempt.next_retry_at
            and last_attempt.next_retry_at > timezone.now()
        ):
            return False
    return True


class Command(BaseCommand):
    help = "Analyze TG operator dialogs with LLM and create TgAiInsight records"

    def add_arguments(self, parser):
        parser.add_argument(
            "--operator",
            type=int,
            default=None,
            help="Analyze only this operator (by ID)",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Show what would be analyzed without calling LLM",
        )

    def handle(self, *args, **options):
        provider = get_provider()
        self.stdout.write(f"Using LLM provider: {type(provider).__name__}")

        # Find active sessions
        sessions_qs = TgSession.objects.filter(status=TgSessionStatus.ACTIVE)
        if options["operator"]:
            sessions_qs = sessions_qs.filter(operator_id=options["operator"])

        analyzed = 0
        skipped = 0

        for session in sessions_qs.select_related("operator"):
            chats = TgChat.objects.filter(session=session).exclude(last_message_at=None)

            for chat in chats:
                if not _should_process(chat):
                    skipped += 1
                    continue

                # Gather last 50 messages
                messages = list(
                    TgMessage.objects.filter(chat=chat)
                    .order_by("sent_at")
                    .values("direction", "text", "sent_at")[:50]
                )

                if not messages:
                    continue

                if options["dry_run"]:
                    self.stdout.write(
                        f"  [DRY RUN] Would analyze chat {chat.id} "
                        f"({chat.partner_name or chat.title}): {len(messages)} messages"
                    )
                    continue

                # Build DTOs
                dtos = [
                    MessageDTO(
                        direction=m["direction"],
                        text=m["text"],
                        sent_at=m["sent_at"].isoformat(),
                    )
                    for m in messages
                ]

                try:
                    result = provider.analyze_dialogs(
                        messages=dtos,
                        op_name=session.operator.full_name,
                        prompt_version="v1",
                    )
                except Exception as exc:
                    error_attempts = TgAiInsightAttempt.objects.filter(
                        chat=chat, status=TgAiInsightAttemptStatus.ERROR_RETRIABLE
                    ).count()
                    delays = [60, 300, 1800]
                    if error_attempts >= len(delays):
                        status = TgAiInsightAttemptStatus.ERROR_PERMANENT
                        next_retry_at = None
                    else:
                        status = TgAiInsightAttemptStatus.ERROR_RETRIABLE
                        next_retry_at = timezone.now() + timedelta(
                            seconds=delays[error_attempts]
                        )

                    TgAiInsightAttempt.objects.create(
                        chat=chat,
                        session=session,
                        status=status,
                        error_message=str(exc),
                        next_retry_at=next_retry_at,
                    )
                    self.stderr.write(
                        self.style.ERROR(
                            f"  LLM error for chat {chat.id}: {exc}"
                        )
                    )
                    continue

                since = messages[0]["sent_at"]
                until = messages[-1]["sent_at"]

                TgAiInsightAttempt.objects.create(
                    chat=chat,
                    session=session,
                    status=TgAiInsightAttemptStatus.SUCCESS,
                    error_message="",
                    next_retry_at=None,
                )

                provider_used_raw = getattr(result, "provider", "") or ""
                provider_used = provider_used_raw if isinstance(provider_used_raw, str) else ""
                TgAiInsight.objects.create(
                    session=session,
                    chat=chat,
                    since=since,
                    until=until,
                    model_version=result.model_version,
                    prompt_version="v1",
                    summary=result.summary,
                    quality_score=result.quality_score,
                    red_flags=result.red_flags,
                    highlights=result.highlights,
                    provider_used=provider_used,
                )
                analyzed += 1
                self.stdout.write(
                    f"  Analyzed chat {chat.id} ({chat.partner_name or chat.title}): "
                    f"score={result.quality_score}"
                )

        self.stdout.write(
            self.style.SUCCESS(
                f"Done: {analyzed} chats analyzed, {skipped} skipped (up-to-date or backoff)"
            )
        )
