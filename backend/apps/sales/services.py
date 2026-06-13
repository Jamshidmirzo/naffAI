from __future__ import annotations

import datetime as dt
from collections.abc import Iterable
from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.utils import timezone

from apps.audit.services import AuditAction, audit_log_create
from apps.catalog.imei_service import imei_lookup
from apps.common.exceptions import ApplicationError, DuplicateError
from apps.common.validators import is_valid_imei

from apps.catalog.models import Channel
from apps.operators.models import Operator, OperatorStatus

from .models import GiftItem, Sale, SaleOperator, SalePartner, SaleStatus
from .selectors import sale_imei_duplicate_count


def _resolve_operator(line: dict) -> Operator:
    """Resolve an operator-line entry by id, else by trimmed name (create if missing)."""
    if line.get("operator_id"):
        return Operator.objects.get(pk=int(line["operator_id"]))
    name = (line.get("operator_name") or line.get("name") or "").strip()
    if not name:
        raise ApplicationError("Укажите оператора", {"field": "operators"})
    op = Operator.objects.filter(full_name__iexact=name).first()
    if op:
        return op
    return Operator.objects.create(full_name=name[:128], status=OperatorStatus.ACTIVE)


def _resolve_partner(line: dict) -> Channel:
    if line.get("partner_id"):
        return Channel.objects.get(pk=int(line["partner_id"]))
    if line.get("channel_id"):  # legacy key
        return Channel.objects.get(pk=int(line["channel_id"]))
    name = (line.get("partner_name") or line.get("name") or "").strip()
    if not name:
        raise ApplicationError("Укажите партнёра", {"field": "partners"})
    ch, _ = Channel.objects.get_or_create(name=name[:64], defaults={"is_active": True})
    if not ch.is_active:
        ch.is_active = True
        ch.save(update_fields=["is_active", "updated_at"])
    return ch


def _coerce_lines(
    raw_lines: list[dict] | None,
    *,
    fallback_id: int | None,
    fallback_amount: Decimal,
    role: str,
) -> list[tuple]:
    """
    Normalise create-form payload:
      - if `raw_lines` is given, return [(model, amount), ...] using the resolver.
      - else fall back to a single line built from the legacy single-FK + amount.
    """
    if raw_lines:
        out = []
        for line in raw_lines:
            try:
                amount_raw = line.get("amount", 0)
                amount = Decimal(str(amount_raw)) if amount_raw not in ("", None) else Decimal(0)
            except (InvalidOperation, TypeError) as exc:
                raise ApplicationError(
                    f"Некорректная сумма у {role}", {"field": role}
                ) from exc
            if amount <= 0:
                raise ApplicationError(
                    f"Сумма у каждого {role} должна быть > 0", {"field": role}
                )
            obj = _resolve_operator(line) if role == "operators" else _resolve_partner(line)
            out.append((obj, amount))
        return out
    if not fallback_id:
        raise ApplicationError(f"Укажите минимум одного: {role}", {"field": role})
    obj = (
        Operator.objects.get(pk=fallback_id)
        if role == "operators"
        else Channel.objects.get(pk=fallback_id)
    )
    return [(obj, fallback_amount)]


@transaction.atomic
def sale_create(
    *,
    user=None,
    imei: str,
    phone_model: str | None = None,
    operator_id: int | None = None,
    channel_id: int | None = None,
    amount: Decimal | None = None,
    operators: list[dict] | None = None,
    partners: list[dict] | None = None,
    sold_at: dt.datetime | None = None,
    comment: str = "",
    status: str = SaleStatus.CONFIRMED,
    gifts: Iterable[dict] | None = None,
    allow_duplicate_imei: bool = False,
    duplicate_override_comment: str = "",
) -> Sale:
    """
    Create a sale.

    Multi-allocation: pass `operators=[{operator_id|operator_name, amount}, ...]`
    and `partners=[{partner_id|partner_name, amount}, ...]`. Names that don't
    match an existing record are auto-created (operator → status=active,
    partner → is_active=True).

    Legacy single-FK payload (`operator_id`, `channel_id`, `amount`) is still
    accepted and wrapped into a single allocation line per role.
    """
    imei = (imei or "").strip()
    if not is_valid_imei(imei):
        raise ApplicationError("IMEI должен быть из 6–15 цифр", {"field": "imei"})

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

    legacy_amount = Decimal(str(amount)) if amount not in (None, "") else Decimal(0)
    operator_lines = _coerce_lines(
        operators, fallback_id=operator_id, fallback_amount=legacy_amount, role="operators"
    )
    partner_lines = _coerce_lines(
        partners, fallback_id=channel_id, fallback_amount=legacy_amount, role="partners"
    )

    total = sum(amt for _, amt in partner_lines)
    if total <= 0:
        raise ApplicationError("Сумма должна быть положительной", {"field": "amount"})

    if not phone_model:
        lookup = imei_lookup(imei)
        if lookup.valid and (lookup.brand or lookup.model):
            phone_model = f"{lookup.brand} {lookup.model}".strip()
    if not phone_model:
        phone_model = "Не определена"

    primary_op = operator_lines[0][0]
    primary_partner = partner_lines[0][0]

    sale = Sale.objects.create(
        imei=imei,
        phone_model=phone_model[:128],
        operator=primary_op,
        channel=primary_partner,
        amount=total,
        comment=comment,
        sold_at=sold_at or timezone.now(),
        created_by=user if user and getattr(user, "is_authenticated", False) else None,
        status=status,
    )

    SaleOperator.objects.bulk_create(
        [SaleOperator(sale=sale, operator=o, amount=a) for o, a in operator_lines]
    )
    SalePartner.objects.bulk_create(
        [SalePartner(sale=sale, partner=p, amount=a) for p, a in partner_lines]
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
            "operators": [
                {"id": o.id, "name": o.full_name, "amount": str(a)} for o, a in operator_lines
            ],
            "partners": [
                {"id": p.id, "name": p.name, "amount": str(a)} for p, a in partner_lines
            ],
            "total": str(total),
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
            raise ApplicationError("IMEI должен быть из 6–15 цифр", {"field": "imei"})
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
