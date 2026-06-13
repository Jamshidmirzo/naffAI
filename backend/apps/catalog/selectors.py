from __future__ import annotations

from django.db.models import QuerySet

from .models import Channel, TacLookup


def channel_list(*, active_only: bool = False) -> QuerySet[Channel]:
    qs = Channel.objects.all()
    if active_only:
        qs = qs.filter(is_active=True)
    return qs


def tac_get(tac: str) -> TacLookup | None:
    return TacLookup.objects.filter(tac=tac).first()
