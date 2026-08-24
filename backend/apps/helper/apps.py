from django.apps import AppConfig


class HelperConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.helper"
    verbose_name = "In-app operator helper (rule-based suggestions + FAQ)"
