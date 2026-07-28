from django.urls import include, path

from apps.calls.urls import (
    callback_urlpatterns,
    lead_nested_urlpatterns,
)
from apps.leads.urls import (
    alias_urlpatterns,
    sheet_source_urlpatterns,
    telegram_urlpatterns,
)
from apps.greetings.urls import me_urlpatterns as greetings_me_urlpatterns
from apps.operators.urls import me_urlpatterns as operators_me_urlpatterns
from apps.stickers.urls import (
    me_sticker_urlpatterns,
    operator_sticker_urlpatterns,
    palette_urlpatterns as stickers_palette_urlpatterns,
)
from apps.users.urls import me_urlpatterns as users_me_urlpatterns
from apps.users.urls import (
    operator_account_urlpatterns as users_operator_account_urlpatterns,
    users_urlpatterns,
)
from apps.attendance.urls import me_urlpatterns as attendance_me_urlpatterns

urlpatterns = [
    path("auth/", include("apps.users.urls")),
    path("me/", include((users_me_urlpatterns, "users_me"))),
    path("me/", include((me_sticker_urlpatterns, "users_me_sticker"))),
    path("me/", include((greetings_me_urlpatterns, "greetings_me"))),
    path("me/", include((operators_me_urlpatterns, "operators_me"))),
    path("me/", include((attendance_me_urlpatterns, "attendance_me"))),
    # Manager-only account CRUD for operators. Mounted BEFORE
    # `apps.operators.urls` so `<int:operator_id>/account/...` doesn't
    # collide with the operators CRUD paths (they use `<int:pk>/`).
    path("operators/", include((users_operator_account_urlpatterns, "operator_accounts"))),
    path("operators/", include((operator_sticker_urlpatterns, "operator_stickers"))),
    path("operators/", include("apps.operators.urls")),
    path("stickers/", include((stickers_palette_urlpatterns, "stickers_palette"))),
    path("channels/", include("apps.catalog.urls_channels")),
    path("imei/", include("apps.catalog.urls_imei")),
    path("sales/", include("apps.sales.urls")),
    path("payroll/", include("apps.payroll.urls")),
    path("analytics/", include("apps.analytics.urls")),
    path("audit/", include("apps.audit.urls")),
    # Pre-sale contour (Этап A):
    #  - /leads/*         CRUD + reassign + convert-to-sale + operator's own list
    #  - /leads/<pk>/call-attempts/  + /leads/<pk>/callbacks/  (nested)
    #  - /callbacks/*     mine / due / done / snooze
    #  - /sheet-sources/, /operator-sheet-aliases/  (sheet mapping admin)
    #  - /telegram/lookup, /telegram/lookup (POST upsert)
    path("leads/", include("apps.leads.urls")),
    path("leads/", include((lead_nested_urlpatterns, "calls_nested"))),
    path("callbacks/", include((callback_urlpatterns, "callbacks"))),
    path("sheet-sources/", include((sheet_source_urlpatterns, "sheet_sources"))),
    path("operator-sheet-aliases/", include((alias_urlpatterns, "operator_sheet_aliases"))),
    path("telegram/", include((telegram_urlpatterns, "telegram"))),
    # Telegram user-client (Telethon MTProto — operator session management)
    path("tg-userclient/", include("apps.tg_userclient.urls")),
    # F3.A AI-chat (manager-only, read-only tool calls)
    path("ai-chat/", include("apps.ai_chat.urls")),
    # F3.B Marketing analyst insights
    path("marketing/", include("apps.marketing.urls")),
    path("lessons/", include("apps.lessons.urls")),
    path("attendance/", include("apps.attendance.urls")),
    # Manager-only user management (web accounts, not operators).
    path("users/", include((users_urlpatterns, "users"))),
    # In-app notifications (senior users get pinged on sale/callback events).
    path("notifications/", include("apps.notifications.urls")),
]
