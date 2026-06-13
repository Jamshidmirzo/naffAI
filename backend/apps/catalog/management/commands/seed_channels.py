from django.core.management.base import BaseCommand

from apps.catalog.models import Channel

DEFAULTS = ["Alif", "Uzum", "WhatsApp", "Walk-in", "Phone-call"]
DEPRECATED = ["Telegram", "Instagram"]


class Command(BaseCommand):
    help = (
        "Seed default sales channels (idempotent). "
        "Adds Alif / Uzum / WhatsApp / Walk-in / Phone-call, "
        "deactivates legacy Telegram & Instagram if present."
    )

    def handle(self, *args, **options):
        created = 0
        for name in DEFAULTS:
            _, was_created = Channel.objects.get_or_create(name=name, defaults={"is_active": True})
            created += int(was_created)

        deactivated = Channel.objects.filter(name__in=DEPRECATED, is_active=True).update(
            is_active=False
        )

        self.stdout.write(
            self.style.SUCCESS(
                f"Channels: +{created} new, -{deactivated} deactivated "
                f"(active: {Channel.objects.filter(is_active=True).count()}, "
                f"total: {Channel.objects.count()})"
            )
        )
