import sentry_sdk
from sentry_sdk.integrations.django import DjangoIntegration
from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F403
from .base import OPERATOR_PASSWORD_ENCRYPTION_KEY

SENTRY_DSN = config("SENTRY_DSN", default="")
if SENTRY_DSN:
    sentry_sdk.init(
        dsn=SENTRY_DSN,
        integrations=[DjangoIntegration()],
        traces_sample_rate=0.05,
        send_default_pii=False,
        environment="production",
    )

DEBUG = False
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True

if not ALLOWED_HOSTS or ALLOWED_HOSTS == [""]:
    raise ImproperlyConfigured("DJANGO_ALLOWED_HOSTS required in prod")

# Prod refuses to start without a real Fernet key — losing it would make
# every stored plaintext unrecoverable, and we must never fall back to a
# random one silently.
if not OPERATOR_PASSWORD_ENCRYPTION_KEY:
    raise ImproperlyConfigured(
        "OPERATOR_PASSWORD_ENCRYPTION_KEY must be set in production. "
        "Generate one with: "
        'python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"'
    )
