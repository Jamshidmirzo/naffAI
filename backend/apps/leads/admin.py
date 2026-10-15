"""Read-only admin views for the webhook lead intake journal / outbound queue."""

from django.contrib import admin

from .models import InboundLeadEvent, LeadOutboundEvent


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


@admin.register(LeadOutboundEvent)
class LeadOutboundEventAdmin(_ReadOnlyAdmin):
    list_display = ("id", "created_at", "source", "kind", "lead", "attempts", "delivered_at")
    list_filter = ("kind", "source")
    search_fields = ("dedupe_key", "last_error")
    ordering = ("-id",)
    raw_id_fields = ("lead",)
