from django.core.management.base import BaseCommand

from apps.catalog.models import Channel

DEFAULTS = ["Telegram", "Instagram", "WhatsApp", "Walk-in", "Phone-call"]


class Command(BaseCommand):
    help = "Seed default sales channels (idempotent)."

    def handle(self, *args, **options):
        created = 0
        for name in DEFAULTS:
            _, was_created = Channel.objects.get_or_create(name=name, defaults={"is_active": True})
            created += int(was_created)
        self.stdout.write(
            self.style.SUCCESS(f"Channels: +{created} new (total {Channel.objects.count()})")
        )
