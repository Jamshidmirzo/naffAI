from django.contrib import admin

from .models import SalesTarget


@admin.register(SalesTarget)
class SalesTargetAdmin(admin.ModelAdmin):
    list_display = ("period_type", "period_start", "target_count", "target_amount", "note")
    list_filter = ("period_type",)
    ordering = ("-period_start", "period_type")
    search_fields = ("note",)
