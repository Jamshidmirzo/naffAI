"""
Management command: retry TG chat history backfill.

Usage:
    python manage.py retry_tg_backfill --operator 1
    python manage.py retry_tg_backfill --session 42
    python manage.py retry_tg_backfill --all-errors
"""

from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Retry TG chat history backfill for specified operator/session or all errored jobs"

    def add_arguments(self, parser):
        parser.add_argument("--operator", type=int, default=None, help="Operator ID")
        parser.add_argument("--session", type=int, default=None, help="TgSession ID")
        parser.add_argument(
            "--all-errors",
            action="store_true",
            help="Retry backfill for all active sessions whose latest job failed with error",
        )

    def handle(self, *args, **options):
        from apps.tg_userclient.models import TgBackfillJobStatus, TgSession, TgSessionStatus
        from apps.tg_userclient.services import _ensure_backfill_job

        sessions = []

        if options["session"]:
            sess = TgSession.objects.filter(id=options["session"]).first()
            if sess:
                sessions.append(sess)
        elif options["operator"]:
            sess = TgSession.objects.filter(operator_id=options["operator"]).first()
            if sess:
                sessions.append(sess)
        elif options["all_errors"]:
            # Find active sessions whose latest job is in ERROR status
            active_sessions = TgSession.objects.filter(status=TgSessionStatus.ACTIVE)
            for sess in active_sessions:
                latest = sess.backfill_jobs.order_by("-id").first()
                if latest and latest.status == TgBackfillJobStatus.ERROR:
                    sessions.append(sess)
        else:
            self.stderr.write("Please specify --operator, --session, or --all-errors")
            return

        queued = 0
        for sess in sessions:
            if sess.status != TgSessionStatus.ACTIVE:
                self.stdout.write(f"Skipping session {sess.id} (status: {sess.status})")
                continue
            job = _ensure_backfill_job(sess)
            if job:
                queued += 1
                self.stdout.write(f"Queued backfill job #{job.id} for session {sess.id} (operator {sess.operator_id})")

        self.stdout.write(self.style.SUCCESS(f"Queued {queued} backfill jobs"))
