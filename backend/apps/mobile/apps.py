from django.apps import AppConfig


class MobileConfig(AppConfig):
    """
    Mobile-specific endpoints for the Flutter operator app (naff-call).

    Kept as a thin adapter over existing services/selectors:
      - `apps.mobile.apis` exposes compact JSON tailored to the phone UI.
      - Auth is JWT (`rest_framework_simplejwt`); web CRM keeps using
        Session/Token — both live side-by-side in `DEFAULT_AUTHENTICATION_CLASSES`.
      - No business logic here — everything routes to services (writes) or
        selectors (reads) in the domain apps (`leads`, `calls`, `operators`).
    """

    name = "apps.mobile"
    default_auto_field = "django.db.models.BigAutoField"
