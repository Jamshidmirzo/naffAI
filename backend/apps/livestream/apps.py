from django.apps import AppConfig


class LivestreamConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.livestream"
    verbose_name = "Operator livestream (WebRTC + egress recording)"
