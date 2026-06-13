"""
Generate a small demo dataset so the dashboard isn't empty on first boot.

Usage:
  python manage.py seed_demo
  python manage.py seed_demo --only-if-empty
"""

from __future__ import annotations

import random
from datetime import timedelta
from decimal import Decimal

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.catalog.models import Channel, TacLookup
from apps.operators.models import Operator, OperatorStatus
from apps.payroll.models import PayoutType, PayrollRule, PayrollScope
from apps.sales.models import Sale, SaleStatus

OPERATORS = [
    ("Алишер Каримов", OperatorStatus.ACTIVE),
    ("Дилфуза Рахимова", OperatorStatus.ACTIVE),
    ("Бекзод Юлдашев", OperatorStatus.ACTIVE),
    ("Нодира Усманова", OperatorStatus.TRAINEE),
    ("Шерзод Ахмедов", OperatorStatus.ACTIVE),
]


def luhn_check_digit(without_checksum: str) -> str:
    total = 0
    for i, ch in enumerate(reversed(without_checksum)):
        n = int(ch)
        if i % 2 == 0:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return str((10 - total % 10) % 10)


def gen_imei(tac: str) -> str:
    serial = "".join(str(random.randint(0, 9)) for _ in range(6))
    body = (tac + serial)[:14]
    return body + luhn_check_digit(body)


class Command(BaseCommand):
    help = "Seed demo operators, channels and recent sales."

    def add_arguments(self, parser):
        parser.add_argument("--only-if-empty", action="store_true")

    def handle(self, *args, **opts):
        if opts["only_if_empty"] and Sale.objects.exists():
            self.stdout.write("Sales already exist — skipping demo seed.")
            return

        # Channels
        from apps.catalog.management.commands.seed_channels import DEFAULTS as CH_DEFAULTS

        for name in CH_DEFAULTS:
            Channel.objects.get_or_create(name=name)

        # TAC seed (builtin)
        if not TacLookup.objects.exists():
            from apps.catalog.management.commands.seed_tac import BUILTIN_TAC

            for row in BUILTIN_TAC:
                TacLookup.objects.update_or_create(
                    tac=row["tac"],
                    defaults={
                        "brand": row["brand"],
                        "model": row["model"],
                        "device_type": row.get("device_type", ""),
                    },
                )

        # Operators
        ops = []
        for name, status in OPERATORS:
            op, _ = Operator.objects.get_or_create(full_name=name, defaults={"status": status})
            ops.append(op)

        # Default global payroll rule
        PayrollRule.objects.get_or_create(
            scope=PayrollScope.GLOBAL,
            defaults={
                "threshold": Decimal("50000000"),
                "payout_type": PayoutType.PERCENT,
                "payout_value": Decimal("3"),
                "is_active": True,
            },
        )

        channels = list(Channel.objects.filter(is_active=True))
        tacs = list(TacLookup.objects.all())
        if not channels or not tacs:
            self.stdout.write(self.style.ERROR("Missing channels or TAC table — abort"))
            return

        now = timezone.now()
        created = 0
        for _ in range(120):
            op = random.choice(ops)
            ch = random.choice(channels)
            tac = random.choice(tacs)
            imei = gen_imei(tac.tac)
            sold_at = now - timedelta(
                days=random.randint(0, 40),
                hours=random.randint(0, 23),
                minutes=random.randint(0, 59),
            )
            amount = Decimal(random.randint(1_200_000, 18_000_000))
            Sale.objects.create(
                imei=imei,
                phone_model=f"{tac.brand} {tac.model}",
                operator=op,
                channel=ch,
                amount=amount,
                sold_at=sold_at,
                status=SaleStatus.CONFIRMED,
            )
            created += 1

        self.stdout.write(self.style.SUCCESS(f"Demo seed: +{created} sales"))
