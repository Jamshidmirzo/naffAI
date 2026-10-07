from __future__ import annotations

from django.contrib import admin

from apps.rop_agent.models import (
    AlertLog,
    DailyBriefing,
    OperatorCoachingLog,
    PendingApproval,
    ROPState,
)


@admin.register(ROPState)
class ROPStateAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "muted_until",
        "last_briefing_at",
        "last_pulse_at",
        "last_evening_at",
        "last_weekly_at",
        "updated_at",
    )
    readonly_fields = ("updated_at",)


@admin.register(DailyBriefing)
class DailyBriefingAdmin(admin.ModelAdmin):
    list_display = (
        "date",
        "sent_at",
        "model_used",
        "tokens_in",
        "tokens_out",
        "tg_message_id",
    )
    list_filter = ("model_used",)
    search_fields = ("synthesis_text",)
    date_hierarchy = "date"
    readonly_fields = ("created_at",)


@admin.register(AlertLog)
class AlertLogAdmin(admin.ModelAdmin):
    list_display = (
        "created_at",
        "priority",
        "alert_type",
        "dedup_key",
        "tg_message_id",
        "resolved_at",
    )
    list_filter = ("priority", "alert_type")
    search_fields = ("message_text", "dedup_key")
    date_hierarchy = "created_at"
    readonly_fields = ("created_at",)


@admin.register(OperatorCoachingLog)
class OperatorCoachingLogAdmin(admin.ModelAdmin):
    list_display = ("date", "operator", "status", "created_at")
    list_filter = ("status",)
    search_fields = ("operator__full_name",)
    date_hierarchy = "date"


@admin.register(PendingApproval)
class PendingApprovalAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "action_type",
        "status",
        "created_at",
        "expires_at",
        "resolved_at",
        "tg_message_id",
    )
    list_filter = ("status", "action_type")
    search_fields = ("description",)
    date_hierarchy = "created_at"
