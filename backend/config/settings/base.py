"""
Base settings for naffAI.

Layered per HackSoft styleguide:
- Models hold data shapes
- Business writes -> services.py
- Reads -> selectors.py
- Thin views/serializers in apis.py
"""

from __future__ import annotations

from pathlib import Path

from decouple import Csv, config

BASE_DIR = Path(__file__).resolve().parent.parent.parent

# --- Security / debug ---
SECRET_KEY = config("DJANGO_SECRET_KEY", default="dev-insecure-change-me-please")
DEBUG = config("DJANGO_DEBUG", default=False, cast=bool)
ALLOWED_HOSTS = [h.strip() for h in config("DJANGO_ALLOWED_HOSTS", default="").split(",") if h.strip()]
CSRF_TRUSTED_ORIGINS = config(
    "DJANGO_CSRF_TRUSTED_ORIGINS",
    default="http://localhost:5173,http://localhost:8000",
    cast=Csv(),
)

# --- Apps ---
DJANGO_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
]

THIRD_PARTY_APPS = [
    "rest_framework",
    "rest_framework.authtoken",
    "corsheaders",
    "django_filters",
    "drf_spectacular",
]

LOCAL_APPS = [
    "apps.common",
    "apps.audit",
    "apps.catalog",
    "apps.operators",
    "apps.sales",
    "apps.payroll",
    "apps.analytics",
    "apps.users",
    "apps.tg_bot",
    "apps.leads",
    "apps.calls",
    "apps.tg_userclient",
    "apps.stickers",
    "apps.greetings",
    "apps.ai_chat",
    "apps.marketing",
    "apps.lessons",
    "apps.attendance",
    "apps.notifications",
    "apps.system_settings",
]

INSTALLED_APPS = DJANGO_APPS + THIRD_PARTY_APPS + LOCAL_APPS

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

# --- Database ---
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": config("POSTGRES_DB", default="naffai"),
        "USER": config("POSTGRES_USER", default="naffai"),
        "PASSWORD": config("POSTGRES_PASSWORD", default="naffai"),
        "HOST": config("POSTGRES_HOST", default="localhost"),
        "PORT": config("POSTGRES_PORT", default="5432"),
    }
}

# --- Auth ---
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
]

# --- I18n / timezone ---
LANGUAGE_CODE = config("DJANGO_LANGUAGE_CODE", default="ru")
TIME_ZONE = config("DJANGO_TIME_ZONE", default="Asia/Tashkent")
USE_I18N = True
USE_TZ = True

# --- Static / media ---
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# --- DRF ---
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.SessionAuthentication",
        "rest_framework.authentication.TokenAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_FILTER_BACKENDS": [
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.SearchFilter",
        "rest_framework.filters.OrderingFilter",
    ],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.LimitOffsetPagination",
    "PAGE_SIZE": 25,
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.UserRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "anon": "20/min",
        "user": "1000/hour",
        "login": "10/min",
    },
}

SPECTACULAR_SETTINGS = {
    "TITLE": "naffAI API",
    "DESCRIPTION": "Sales tracking & operator management for a phone retail call-center",
    "VERSION": "0.1.0",
    "SERVE_INCLUDE_SCHEMA": False,
}

# --- CORS ---
CORS_ALLOWED_ORIGINS = config(
    "CORS_ALLOWED_ORIGINS",
    default="http://localhost:5173,http://localhost:3000",
    cast=Csv(),
)
CORS_ALLOW_CREDENTIALS = True

# --- Payroll defaults ---
PAYROLL_DEFAULT_THRESHOLD_UZS = config("PAYROLL_DEFAULT_THRESHOLD_UZS", default="50000000")
PAYROLL_DEFAULT_PAYOUT_TYPE = config("PAYROLL_DEFAULT_PAYOUT_TYPE", default="percent")
PAYROLL_DEFAULT_PAYOUT_VALUE = config("PAYROLL_DEFAULT_PAYOUT_VALUE", default="3.0")

# --- IMEI online lookup ---
IMEI_ONLINE_LOOKUP_ENABLED = config("IMEI_ONLINE_LOOKUP_ENABLED", default=False, cast=bool)
IMEI_ONLINE_API_URL = config(
    "IMEI_ONLINE_API_URL",
    default="https://alpha.imeicheck.com/api/modelBrandName",
)
IMEI_ONLINE_API_KEY = config("IMEI_ONLINE_API_KEY", default="")

# --- Telegram bot ---
TELEGRAM_BOT_ENABLED = config("TELEGRAM_BOT_ENABLED", default=False, cast=bool)
TELEGRAM_BOT_TOKEN = config("TELEGRAM_BOT_TOKEN", default="")
TELEGRAM_GROUP_ID = config("TELEGRAM_GROUP_ID", default="")

# --- Google Sheets sync ---
# Path to a service-account JSON key with read access to the spreadsheets
# listed in `SheetSource`. Leave empty to disable sheet sync silently
# (`sync_sheets_leads` will refuse to run instead of crashing).
GOOGLE_SHEETS_CREDENTIALS_JSON = config("GOOGLE_SHEETS_CREDENTIALS_JSON", default="")

# --- Callback reminder policy ---
# A callback is "overdue" (and blocks the operator from receiving new leads
# via round-robin) once `remind_at + CALLBACK_OVERDUE_GRACE_MINUTES` has passed.
CALLBACK_OVERDUE_GRACE_MINUTES = config(
    "CALLBACK_OVERDUE_GRACE_MINUTES", default=30, cast=int
)

# --- QR check-in ---
# Public URL of the /scan page a phone camera will open when it decodes
# an operator's QR. `operator_qr_png_bytes` wraps the raw HMAC token as
# `{QR_CHECKIN_URL}?qr=<token>`. Leave empty to fall back to raw token
# (dev only — cameras won't open plain text).
QR_CHECKIN_URL = config("QR_CHECKIN_URL", default="")

# --- Operator password reversible-encryption keys ---
# Fernet keys used to (en|de)crypt the plaintext stored in `OperatorSecret`.
# Generate a key with:
#   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
#
# In prod this MUST be set — see `config.settings.prod`. In `dev`/`test`
# we fall back to an auto-generated ephemeral key (with a warning) so
# local runs don't crash.
#
# Rotation: OPERATOR_PASSWORD_ENCRYPTION_KEYS is a JSON-ish dict
# `{"1": "<key1>", "2": "<key2>"}`. OPERATOR_PASSWORD_ENCRYPTION_CURRENT_VERSION
# selects which one is used for *encrypt*; all listed keys remain trusted
# for *decrypt*. The single-key OPERATOR_PASSWORD_ENCRYPTION_KEY is kept
# as a backwards-compatible fallback: if only it is set, it becomes v1.
OPERATOR_PASSWORD_ENCRYPTION_KEY = config(
    "OPERATOR_PASSWORD_ENCRYPTION_KEY", default=""
)
OPERATOR_PASSWORD_ENCRYPTION_KEYS: dict[str, str] = {}
if OPERATOR_PASSWORD_ENCRYPTION_KEY:
    OPERATOR_PASSWORD_ENCRYPTION_KEYS["1"] = OPERATOR_PASSWORD_ENCRYPTION_KEY
_extra_password_keys = config("OPERATOR_PASSWORD_ENCRYPTION_KEYS_JSON", default="")
if _extra_password_keys:
    import json as _json

    OPERATOR_PASSWORD_ENCRYPTION_KEYS.update(_json.loads(_extra_password_keys))
OPERATOR_PASSWORD_ENCRYPTION_CURRENT_VERSION = config(
    "OPERATOR_PASSWORD_ENCRYPTION_CURRENT_VERSION",
    default=str(max((int(v) for v in OPERATOR_PASSWORD_ENCRYPTION_KEYS), default=1)),
    cast=int,
)

# --- Telegram user-client (Telethon MTProto) ---
# API credentials from https://my.telegram.org/apps — one pair for the whole app.
TG_API_ID = config("TG_API_ID", default=0, cast=int)
TG_API_HASH = config("TG_API_HASH", default="")
# Fernet key for encrypting Telethon StringSession values in DB.
# SEPARATE from OPERATOR_PASSWORD_ENCRYPTION_KEY — leak of one does not
# compromise the other. Generate with:
#   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
TG_SESSION_ENCRYPTION_KEY = config("TG_SESSION_ENCRYPTION_KEY", default="")
TG_SESSION_ENCRYPTION_KEYS: dict[str, str] = {}
if TG_SESSION_ENCRYPTION_KEY:
    TG_SESSION_ENCRYPTION_KEYS["1"] = TG_SESSION_ENCRYPTION_KEY
_extra_tg_keys = config("TG_SESSION_ENCRYPTION_KEYS_JSON", default="")
if _extra_tg_keys:
    import json as _json

    TG_SESSION_ENCRYPTION_KEYS.update(_json.loads(_extra_tg_keys))
TG_SESSION_ENCRYPTION_CURRENT_VERSION = config(
    "TG_SESSION_ENCRYPTION_CURRENT_VERSION",
    default=str(max((int(v) for v in TG_SESSION_ENCRYPTION_KEYS), default=1)),
    cast=int,
)
# Feature flag: transcribe voice messages via Whisper (0 = skipped, 1 = enabled)
TG_TRANSCRIBE_VOICE = config("TG_TRANSCRIBE_VOICE", default=False, cast=bool)
TG_TRANSCRIBE_PROVIDER = config("TG_TRANSCRIBE_PROVIDER", default="openai")
# Message retention in days (older messages are purged by cron)
TG_MESSAGE_RETENTION_DAYS = config("TG_MESSAGE_RETENTION_DAYS", default=90, cast=int)
# Backfill settings
TG_BACKFILL_SINCE = config("TG_BACKFILL_SINCE", default="2026-07-01")
TG_BACKFILL_CHAT_DELAY_MS = config("TG_BACKFILL_CHAT_DELAY_MS", default=800, cast=int)
TG_BACKFILL_BATCH_SIZE = config("TG_BACKFILL_BATCH_SIZE", default=200, cast=int)
TG_BACKFILL_MAX_MESSAGES_PER_CHAT = config("TG_BACKFILL_MAX_MESSAGES_PER_CHAT", default=10000, cast=int)
TG_STALE_RUNNING_TIMEOUT_MIN = config("TG_STALE_RUNNING_TIMEOUT_MIN", default=5, cast=int)
# LLM provider — one of:
#   chain          — walk `LLM_CHAIN` slots in order with 429 fallback
#   gemini         — Google Gemini (AI Studio)
#   github_models  — GitHub Models (OpenAI-compatible, uses gh auth token)
#   openai / anthropic — legacy stubs
#   none           — no-op stub for tests / offline dev
LLM_PROVIDER = config("LLM_PROVIDER", default="none")
OPENAI_API_KEY = config("OPENAI_API_KEY", default="")
ANTHROPIC_API_KEY = config("ANTHROPIC_API_KEY", default="")
GEMINI_API_KEY = config("GEMINI_API_KEY", default="")
GEMINI_MODEL = config("GEMINI_MODEL", default="gemini-flash-latest")
GEMINI_FALLBACK_MODEL = config("GEMINI_FALLBACK_MODEL", default="gemini-2.5-flash-lite")

# GitHub Models — OpenAI-compatible endpoint.
# Token: output of `gh auth token` (regular GitHub OAuth, no Copilot Pro).
# Quota: 150 requests/day per model (across models on the same account).
GITHUB_MODELS_TOKEN = config("GITHUB_MODELS_TOKEN", default="")

# Ordered chain of provider slots. Each token references a key in
# `LLM_CHAIN_MODELS`. When `LLM_PROVIDER=chain`, the first slot is tried
# first and on `LLMRateLimitError` we advance to the next.
LLM_CHAIN = config(
    "LLM_CHAIN",
    default="gemini,github_models_gpt4omini,github_models_deepseek,github_models_llama",
)
LLM_CHAIN_MODELS = {
    "gemini": config("LLM_CHAIN_GEMINI_MODEL", default=GEMINI_MODEL),
    "github_models_gpt4omini": config("LLM_CHAIN_GH_GPT4OMINI", default="openai/gpt-4o-mini"),
    "github_models_deepseek": config("LLM_CHAIN_GH_DEEPSEEK", default="deepseek/deepseek-v3-0324"),
    "github_models_llama": config("LLM_CHAIN_GH_LLAMA", default="meta/llama-3.3-70b-instruct"),
    "github_models_gpt41mini": config("LLM_CHAIN_GH_GPT41MINI", default="openai/gpt-4.1-mini"),
}

# --- Logging ---
LOG_DIR = config("LOG_DIR", default="")
_handlers = {
    "console": {
        "class": "logging.StreamHandler",
        "formatter": "default",
        "level": "INFO",
    }
}
if LOG_DIR:
    _handlers["file"] = {
        "class": "logging.handlers.RotatingFileHandler",
        "filename": f"{LOG_DIR}/naffai.log",
        "maxBytes": 10 * 1024 * 1024,
        "backupCount": 5,
        "formatter": "default",
        "level": "INFO",
    }

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "default": {"format": "[{asctime}] {levelname} {name}: {message}", "style": "{"},
    },
    "handlers": _handlers,
    "root": {"handlers": list(_handlers.keys()), "level": "INFO"},
    "loggers": {
        "django": {"handlers": list(_handlers.keys()), "level": "INFO", "propagate": False},
        "apps": {"handlers": list(_handlers.keys()), "level": "DEBUG", "propagate": False},
    },
}

# --- QR Attendance Settings ---
QR_ATTENDANCE_HMAC_KEY = config("QR_ATTENDANCE_HMAC_KEY", default="")
ATTENDANCE_ALLOWED_NETWORKS = config(
    "ATTENDANCE_ALLOWED_NETWORKS",
    default="",
    cast=lambda v: [s.strip() for s in v.split(",") if s.strip()],
)
ATTENDANCE_SCAN_COOLDOWN_SECONDS = config("ATTENDANCE_SCAN_COOLDOWN_SECONDS", default=30, cast=int)

REST_FRAMEWORK.setdefault("DEFAULT_THROTTLE_RATES", {})
REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["attendance_scan_ip"] = "20/min"
