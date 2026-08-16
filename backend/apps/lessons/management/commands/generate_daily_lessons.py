import datetime as dt
import time
from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.operators.models import Operator, OperatorStatus
from apps.lessons.models import DailyLesson, DailyLessonAttempt
from apps.lessons.selectors import collect_yesterday_facts
from apps.lessons.ai.generator import (
    DEFAULT_LANGUAGE as LESSON_DEFAULT_LANGUAGE,
    PROMPT_VERSION as LESSON_PROMPT_VERSION,
    SUPPORTED_LANGUAGES as LESSON_SUPPORTED_LANGUAGES,
    generate_daily_lesson,
)
from apps.lessons.selectors import resolve_operator_language


class Command(BaseCommand):
    help = "Generate daily lessons for operators based on yesterday's activity"

    def add_arguments(self, parser):
        parser.add_argument(
            "--date",
            type=str,
            default=None,
            help="Date to generate lesson for (YYYY-MM-DD), default is yesterday",
        )
        parser.add_argument(
            "--operator",
            type=int,
            default=None,
            help="Filter by specific operator ID",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Run without saving lessons or calling LLM",
        )

    def handle(self, *args, **options):
        date_str = options["date"]
        if date_str:
            target_date = dt.datetime.strptime(date_str, "%Y-%m-%d").date()
        else:
            target_date = timezone.localdate() - dt.timedelta(days=1)

        self.stdout.write(f"Generating lessons for date: {target_date}")

        operators = Operator.objects.exclude(status=OperatorStatus.INACTIVE)
        if options["operator"]:
            operators = operators.filter(id=options["operator"])

        operators = operators.exclude(daily_lesson_opt_out=True)

        for op in operators:
            self.stdout.write(f"Processing operator {op.full_name} (ID: {op.id})")

            if DailyLesson.objects.filter(operator=op, lesson_date=target_date).exists():
                self.stdout.write(f"Lesson already exists for operator {op.id} on {target_date}. Skipping.")
                continue

            facts = collect_yesterday_facts(op, target_date)
            sales_count = facts["sales"]["count"]
            dialogs_count = facts["dialogs"]["count"]

            if sales_count == 0 and dialogs_count == 0:
                self.stdout.write(f"Operator {op.id} had 0 sales and 0 dialogs on {target_date}. Logging skip.")
                if not options["dry_run"]:
                    DailyLessonAttempt.objects.create(
                        operator=op,
                        lesson_date=target_date,
                        status="skip",
                        reason="0 sales and 0 dialogs yesterday",
                    )
                continue

            if options["dry_run"]:
                self.stdout.write(f"[Dry Run] Would call LLM generator for operator {op.id}")
                continue

            # Language preference lives on the operator's linked User→Profile.
            # Fallback: 'uz' (phone-shop default) if no linked profile.
            language = resolve_operator_language(op)

            start_time = time.time()
            try:
                tenure_days = 0
                if op.hired_at:
                    tenure_days = max(0, (target_date - op.hired_at).days)

                res = generate_daily_lesson(op.full_name, tenure_days, facts, language=language)
                duration_ms = int((time.time() - start_time) * 1000)

                stats_snapshot = {
                    "sales_count": sales_count,
                    "revenue_uzs": facts["sales"]["revenue"],
                    "avg_check": facts["sales"]["avg_check"],
                    "dialogs_count": dialogs_count,
                    "avg_quality": facts["dialogs"]["avg_quality_score"],
                    "callbacks_missed": facts["callbacks"]["missed"],
                    "leads_won": facts["leads"]["won"],
                    "leads_lost": facts["leads"]["lost"],
                    "month_progress_pct": facts["context"]["month_progress_pct"],
                    "delta_revenue": facts["sales"]["delta_revenue"],
                    "delta_count": facts["sales"]["delta_count"],
                }

                DailyLesson.objects.create(
                    operator=op,
                    lesson_date=target_date,
                    summary=res["summary"],
                    highlights=res["highlights"],
                    tips=res["tips"],
                    micro_lesson=res["micro_lesson"],
                    content=res.get("content") or {},
                    language=language,
                    stats_snapshot=stats_snapshot,
                    model_version=res["model_used"],
                    prompt_version=LESSON_PROMPT_VERSION,
                )

                DailyLessonAttempt.objects.create(
                    operator=op,
                    lesson_date=target_date,
                    status="ok",
                    model_version=res["model_used"],
                    duration_ms=duration_ms,
                )
                self.stdout.write(self.style.SUCCESS(f"Successfully generated lesson for operator {op.id}"))

            except Exception as exc:
                duration_ms = int((time.time() - start_time) * 1000)
                reason = str(exc)[:280]
                DailyLessonAttempt.objects.create(
                    operator=op,
                    lesson_date=target_date,
                    status="error",
                    reason=reason,
                    duration_ms=duration_ms,
                )
                self.stdout.write(self.style.ERROR(f"Failed to generate lesson for operator {op.id}: {reason}"))
