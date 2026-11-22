"""Read-only admin view for the webhook lead intake journal."""

from django.contrib import admin

from .models import InboundLeadEvent


class _ReadOnlyAdmin(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


@admin.register(InboundLeadEvent)
class InboundLeadEventAdmin(_ReadOnlyAdmin):
    list_display = ("id", "received_at", "source", "outcome", "external_id", "lead", "remote_ip")
    list_filter = ("outcome", "source")
    search_fields = ("external_id", "error")
    ordering = ("-received_at",)
    raw_id_fields = ("lead",)
