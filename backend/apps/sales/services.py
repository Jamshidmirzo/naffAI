from __future__ import annotations

import datetime as dt
from collections.abc import Iterable
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from apps.audit.services import AuditAction, audit_log_create
from apps.catalog.imei_service import imei_lookup
from apps.common.exceptions import ApplicationError, DuplicateError
from apps.common.validators import is_valid_imei

from .models import GiftItem, Sale, SaleStatus
from .selectors import sale_imei_duplicate_count


@transaction.atomic
def sale_create(
    *,
    user=None,
    imei: str,
    phone_model: str | None = None,
    operator_id: int,
    channel_id: int,
    amount: Decimal,
    sold_at: dt.datetime | None = None,
    comment: str = "",
    status: str = SaleStatus.CONFIRMED,
    gifts: Iterable[dict] | None = None,
    allow_duplicate_imei: bool = False,
    duplicate_override_comment: str = "",
) -> Sale:
    """
    Create a sale with full validation pipeline:
      1. IMEI Luhn check
      2. Duplicate IMEI gate (override requires explicit flag + comment)
      3. Auto-fill phone_model from TAC if missing
      4. Audit log with the actor
    """
    imei = (imei or "").strip()
    if not is_valid_imei(imei):
        raise ApplicationError("IMEI не прошёл проверку Luhn", {"field": "imei"})

    if amount is None or Decimal(amount) <= 0:
        raise ApplicationError("Сумма должна быть положительной", {"field": "amount"})

    duplicates = sale_imei_duplicate_count(imei=imei)
    if duplicates and not allow_duplicate_imei:
        raise DuplicateError(
            "Продажа с таким IMEI уже существует",
            {"field": "imei", "duplicate_count": duplicates},
        )
    if duplicates and allow_duplicate_imei and not duplicate_override_comment.strip():
        raise ApplicationError(
            "Для подтверждения дубликата требуется комментарий",
            {"field": "duplicate_override_comment"},
        )

    if not phone_model:
        lookup = imei_lookup(imei)
        if lookup.valid and (lookup.brand or lookup.model):
            phone_model = f"{lookup.brand} {lookup.model}".strip()
    if not phone_model:
        phone_model = "Не определена"

    sale = Sale.objects.create(
        imei=imei,
        phone_model=phone_model[:128],
        operator_id=operator_id,
        channel_id=channel_id,
        amount=Decimal(amount),
        comment=comment,
        sold_at=sold_at or timezone.now(),
        created_by=user if user and getattr(user, "is_authenticated", False) else None,
        status=status,
    )

    if gifts:
        GiftItem.objects.bulk_create(
            [
                GiftItem(sale=sale, name=g["name"][:128], cost=g.get("cost"))
                for g in gifts
                if g.get("name")
            ]
        )

    audit_log_create(
        user=user,
        action=AuditAction.CREATE,
        entity="sales.Sale",
        entity_id=sale.id,
        changes={
            "imei": sale.imei,
            "phone_model": sale.phone_model,
            "operator_id": sale.operator_id,
            "amount": str(sale.amount),
        },
        comment=duplicate_override_comment if duplicates else "",
    )
    return sale


@transaction.atomic
def sale_update(
    *,
    sale: Sale,
    user=None,
    **fields,
) -> Sale:
    if "imei" in fields:
        new_imei = (fields["imei"] or "").strip()
        if not is_valid_imei(new_imei):
            raise ApplicationError("IMEI не прошёл проверку Luhn", {"field": "imei"})
        fields["imei"] = new_imei

    old = {k: getattr(sale, k) for k in fields}
    for k, v in fields.items():
        setattr(sale, k, v)
    sale.save()

    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="sales.Sale",
        entity_id=sale.id,
        changes={k: {"old": str(old[k]), "new": str(getattr(sale, k))} for k in fields},
    )
    return sale


@transaction.atomic
def sale_mark_returned(*, sale: Sale, reason: str, user=None) -> Sale:
    if sale.is_returned:
        return sale
    sale.is_returned = True
    sale.returned_at = timezone.now()
    sale.return_reason = reason or ""
    sale.save(update_fields=["is_returned", "returned_at", "return_reason", "updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="sales.Sale",
        entity_id=sale.id,
        changes={"is_returned": True, "return_reason": reason},
        comment="Возврат",
    )
    return sale


@transaction.atomic
def sale_soft_delete(*, sale: Sale, user=None) -> Sale:
    if sale.is_deleted:
        return sale
    sale.is_deleted = True
    sale.deleted_at = timezone.now()
    sale.save(update_fields=["is_deleted", "deleted_at", "updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.DELETE,
        entity="sales.Sale",
        entity_id=sale.id,
        changes={"is_deleted": True},
    )
    return sale


@transaction.atomic
def sale_confirm(*, sale: Sale, user=None) -> Sale:
    if sale.status == SaleStatus.CONFIRMED:
        return sale
    sale.status = SaleStatus.CONFIRMED
    sale.save(update_fields=["status", "updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="sales.Sale",
        entity_id=sale.id,
        changes={"status": "confirmed"},
    )
    return sale
