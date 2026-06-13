"""
Convert a `ParsedSale` into a `pending` Sale draft.

We map the seller hint to an Operator by `full_name` (case-insensitive
substring). If unresolved we still create the draft and let the team lead
pick the operator in the UI.
"""

from __future__ import annotations

from decimal import Decimal

from django.utils import timezone

from apps.audit.services import AuditAction, audit_log_create
from apps.catalog.models import Channel
from apps.common.validators import is_valid_imei
from apps.operators.models import Operator
from apps.sales.models import Sale, SaleStatus

from .parser import ParsedSale, parse_message


def _resolve_operator(hint: str | None) -> Operator | None:
    if not hint:
        return None
    hint = hint.strip()
    # exact match first
    op = Operator.objects.filter(full_name__iexact=hint).first()
    if op:
        return op
    # then loose substring (first/last name)
    for token in hint.split():
        op = Operator.objects.filter(full_name__icontains=token).first()
        if op:
            return op
    return None


def _resolve_channel() -> Channel:
    ch = Channel.objects.filter(name__iexact="Telegram").first()
    if ch:
        return ch
    return Channel.objects.create(name="Telegram", is_active=True)


def create_pending_from_message(text: str) -> Sale | None:
    parsed: ParsedSale = parse_message(text)
    if not parsed.imei or not is_valid_imei(parsed.imei):
        return None

    operator = _resolve_operator(parsed.seller_hint)
    channel = _resolve_channel()

    if not operator:
        # Use a "fallback" operator named «Не определён» if it exists,
        # otherwise just skip — the lead needs an operator to assign.
        operator = Operator.objects.filter(full_name__iexact="Не определён").first()
        if not operator:
            operator = Operator.objects.create(full_name="Не определён", status="inactive")

    try:
        amount = Decimal(parsed.amount) if parsed.amount else Decimal("0")
    except Exception:
        amount = Decimal("0")

    sale = Sale.objects.create(
        imei=parsed.imei,
        phone_model=parsed.model or "Не определена",
        operator=operator,
        channel=channel,
        amount=amount,
        comment=parsed.raw[:1000],
        sold_at=timezone.now(),
        status=SaleStatus.PENDING,
    )
    audit_log_create(
        user=None,
        action=AuditAction.CREATE,
        entity="sales.Sale",
        entity_id=sale.id,
        changes={"source": "telegram_bot", "raw": parsed.raw[:500]},
        comment="Авто-черновик из Telegram",
    )
    return sale
