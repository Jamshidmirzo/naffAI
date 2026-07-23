from .base import *  # noqa: F403

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": ":memory:",
    }
}
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
IMEI_ONLINE_LOOKUP_ENABLED = False

# Deterministic Fernet key for tests. Not a secret — do not reuse in prod.
OPERATOR_PASSWORD_ENCRYPTION_KEY = "zmWkE-QjZ8SFYQtT-U0iiKUeM-1O6h2QG3l-EwLp6TQ="
TG_SESSION_ENCRYPTION_KEY = "zmWkE-QjZ8SFYQtT-U0iiKUeM-1O6h2QG3l-EwLp6TQ="
OPERATOR_PASSWORD_ENCRYPTION_KEYS = {"1": OPERATOR_PASSWORD_ENCRYPTION_KEY}
OPERATOR_PASSWORD_ENCRYPTION_CURRENT_VERSION = 1
TG_SESSION_ENCRYPTION_KEYS = {"1": TG_SESSION_ENCRYPTION_KEY}
TG_SESSION_ENCRYPTION_CURRENT_VERSION = 1
