from django.contrib import admin
from .models import OperatorQr, AttendanceLog, AttendanceSettings


@admin.register(OperatorQr)
class OperatorQrAdmin(admin.ModelAdmin):
    list_display = ("operator", "nonce_short", "created_at", "revoked_at")
    search_fields = ("operator__full_name", "nonce")
    list_filter = ("revoked_at",)

    def nonce_short(self, obj):
        return obj.nonce[:6] + "..."

    nonce_short.short_description = "Nonce"


@admin.register(AttendanceLog)
class AttendanceLogAdmin(admin.ModelAdmin):
    list_display = (
        "operator",
        "checked_in_at",
        "checked_out_at",
        "duration_min",
        "was_late",
        "auto_closed",
        "source",
    )
    list_filter = ("checked_in_at", "was_late", "auto_closed", "source")
    search_fields = ("operator__full_name",)

    def duration_min(self, obj):
        if obj.duration_seconds is None:
            return "-"
        return f"{obj.duration_seconds // 60} мин"

    duration_min.short_description = "Длительность"


@admin.register(AttendanceSettings)
class AttendanceSettingsAdmin(admin.ModelAdmin):
    list_display = (
        "shift_start",
        "shift_end",
        "late_threshold_min",
        "auto_close_at",
        "tg_checkin_enabled",
    )
