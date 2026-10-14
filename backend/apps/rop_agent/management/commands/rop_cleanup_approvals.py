from django.core.management.base import BaseCommand

from apps.rop_agent.services import cleanup_expired_approvals


class Command(BaseCommand):
    help = "Mark PendingApprovals past their expires_at as EXPIRED."

    def handle(self, *args, **opts):
        n = cleanup_expired_approvals()
        self.stdout.write(self.style.SUCCESS(f"expired={n}"))
