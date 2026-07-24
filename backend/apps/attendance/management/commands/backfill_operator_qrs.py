from django.core.management.base import BaseCommand
from django.db import transaction

from apps.operators.models import Operator, OperatorStatus
from apps.attendance.models import OperatorQr
from apps.attendance.services import operator_qr_rotate


class Command(BaseCommand):
    help = "Backfill or rotate QR codes for all active operators"

    def add_arguments(self, parser):
        parser.add_argument(
            "--force",
            action="store_true",
            help="Force rotation of existing QR codes for all active operators",
        )

    def handle(self, *args, **options):
        force = options["force"]
        active_operators = Operator.objects.exclude(status=OperatorStatus.INACTIVE)

        count = 0
        with transaction.atomic():
            for op in active_operators:
                has_qr = OperatorQr.objects.filter(operator=op, revoked_at__isnull=True).exists()
                if not has_qr or force:
                    operator_qr_rotate(operator=op, actor=None)
                    count += 1

        self.stdout.write(
            self.style.SUCCESS(f"Backfilled/Rotated QR codes for {count} operators.")
        )
