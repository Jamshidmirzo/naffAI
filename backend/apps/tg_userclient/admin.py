from django.contrib import admin

from .models import TgAiInsight, TgBackfillJob, TgChat, TgMessage, TgSession


@admin.register(TgSession)
class TgSessionAdmin(admin.ModelAdmin):
    list_display = ("id", "operator", "phone", "status", "tg_username", "last_connected_at")
    list_filter = ("status",)
    search_fields = ("phone", "tg_username", "operator__full_name")
    readonly_fields = ("encrypted_session", "phone_code_hash")
    raw_id_fields = ("operator",)


@admin.register(TgChat)
class TgChatAdmin(admin.ModelAdmin):
    list_display = ("id", "session", "kind", "title", "partner_name", "partner_phone", "last_message_at")
    list_filter = ("kind",)
    search_fields = ("title", "partner_name", "partner_phone")
    raw_id_fields = ("session", "lead")


@admin.register(TgMessage)
class TgMessageAdmin(admin.ModelAdmin):
    list_display = ("id", "chat", "direction", "kind", "sent_at")
    list_filter = ("direction", "kind")
    raw_id_fields = ("chat",)
    date_hierarchy = "sent_at"


@admin.register(TgAiInsight)
class TgAiInsightAdmin(admin.ModelAdmin):
    list_display = ("id", "session", "chat", "quality_score", "since", "until", "created_at")
    list_filter = ("prompt_version",)
    raw_id_fields = ("session", "chat")


@admin.register(TgBackfillJob)
class TgBackfillJobAdmin(admin.ModelAdmin):
    list_display = ("id", "session", "status", "since", "chats_scanned", "messages_saved", "started_at", "finished_at")
    list_filter = ("status",)
    raw_id_fields = ("session",)

