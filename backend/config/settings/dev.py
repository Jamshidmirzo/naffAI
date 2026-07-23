import logging

from .base import *  # noqa: F403
from .base import (
    OPERATOR_PASSWORD_ENCRYPTION_KEY,
    OPERATOR_PASSWORD_ENCRYPTION_KEYS,
)

DEBUG = True
ALLOWED_HOSTS = ["localhost", "127.0.0.1"]
CORS_ALLOW_ALL_ORIGINS = True

# Dev fallback: if no key is configured, mint an ephemeral one so the app
# still boots. WARNING: any password stored under an ephemeral key becomes
# unrecoverable after restart — that's fine locally, not in prod.
if not OPERATOR_PASSWORD_ENCRYPTION_KEY:
    from apps.users.utils import generate_fernet_key

    OPERATOR_PASSWORD_ENCRYPTION_KEY = generate_fernet_key()
    OPERATOR_PASSWORD_ENCRYPTION_KEYS["1"] = OPERATOR_PASSWORD_ENCRYPTION_KEY
    logging.getLogger(__name__).warning(
        "OPERATOR_PASSWORD_ENCRYPTION_KEY was empty; generated an ephemeral key. "
        "Set the env var to keep saved passwords readable across restarts."
    )
