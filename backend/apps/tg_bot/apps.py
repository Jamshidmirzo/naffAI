from django.apps import AppConfig


class TgBotConfig(AppConfig):
    name = "apps.tg_bot"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self) -> None:
        # Wire post_save signals for manager notifications (Sale rejected, …).
        # Import here to avoid running at import-time before Django is ready.
        from apps.tg_bot import signals  # noqa: F401
