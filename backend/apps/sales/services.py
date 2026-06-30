from __future__ import annotations

import datetime as dt
from collections.abc import Iterable
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from django.db import transaction
from django.utils import timezone

from apps.audit.services import AuditAction, audit_log_create
from apps.catalog.imei_service import imei_lookup
from apps.catalog.models import Channel
from apps.common.exceptions import ApplicationError, DuplicateError
from apps.common.validators import is_valid_imei
from apps.operators.models import Operator, OperatorStatus

from .models import GiftItem, Sale, SaleOperator, SalePartner, SaleStatus
from .selectors import sale_imei_duplicate_count

# Money is stored as Decimal(14, 2). All proportional splits round
# half-up to two decimal places and dump any rounding remainder onto
# the last allocation line so the line-amount sum is exactly equal to
# `amount − discount`.
_MONEY_Q = Decimal("0.01")


def _coerce_decimal(value, *, field: str, default: Decimal = Decimal("0")) -> Decimal:
    if value in (None, ""):
        return default
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ApplicationError(f"Некорректное число в поле {field}", {"field": field}) from exc


def _apply_discount_to_operator_lines(
    operator_lines: list[tuple], *, gross: Decimal, discount: Decimal
) -> list[tuple]:
    """
    Reduce each operator line's amount proportionally to the discount.

    The discount lives on the Sale (single source of truth), but operator
    payroll credit is `(amount − discount)`. We push the reduction down
    onto the SaleOperator rows so existing selectors / payroll queries
    (which sum SaleOperator.amount) keep working without changes.

      net_op_i = op_i × (gross − discount) / gross

    Rounding to 2dp is half-up; any sub-cent rounding remainder is added
    to the last line so the sum stays exact:

      Σ net_op_i == gross − discount
    """
    if discount <= 0 or not operator_lines:
        return operator_lines

    net = gross - discount
    if net <= 0:
        raise ApplicationError(
            "Скидка не может быть равна или превышать сумму продажи",
            {"field": "discount"},
        )

    scaled: list[tuple] = []
    running = Decimal("0")
    for i, (obj, amt) in enumerate(operator_lines):
        if i == len(operator_lines) - 1:
            # Last line absorbs the rounding remainder so the sum is exact.
            new_amt = (net - running).quantize(_MONEY_Q, rounding=ROUND_HALF_UP)
        else:
            new_amt = (amt * net / gross).quantize(_MONEY_Q, rounding=ROUND_HALF_UP)
            running += new_amt
        scaled.append((obj, new_amt))
    return scaled


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
    discount: Decimal | None = None,
    operators: list[dict] | None = None,
    partners: list[dict] | None = None,
    sold_at: dt.datetime | None = None,
    client_name: str = "",
    client_phone: str = "",
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

    discount_dec = _coerce_decimal(discount, field="discount")
    if discount_dec < 0:
        raise ApplicationError("Скидка не может быть отрицательной", {"field": "discount"})
    if discount_dec >= total:
        raise ApplicationError(
            "Скидка не может быть равна или превышать сумму продажи",
            {"field": "discount"},
        )

    # Reduce operator credit proportionally to absorb the discount.
    # Partner lines stay untouched: the customer still pays the gross
    # `total`; the shop just keeps less commission for the operators.
    credited_operator_lines = _apply_discount_to_operator_lines(
        operator_lines, gross=total, discount=discount_dec
    )

    if not phone_model:
        lookup = imei_lookup(imei)
        if lookup.valid and (lookup.brand or lookup.model):
            phone_model = f"{lookup.brand} {lookup.model}".strip()
    if not phone_model:
        phone_model = "Не определена"

    primary_op = credited_operator_lines[0][0]
    primary_partner = partner_lines[0][0]

    sale = Sale.objects.create(
        imei=imei,
        phone_model=phone_model[:128],
        operator=primary_op,
        channel=primary_partner,
        amount=total,
        discount=discount_dec,
        client_name=(client_name or "").strip()[:128],
        client_phone=(client_phone or "").strip()[:32],
        comment=comment,
        sold_at=sold_at or timezone.now(),
        created_by=user if user and getattr(user, "is_authenticated", False) else None,
        status=status,
    )

    SaleOperator.objects.bulk_create(
        [SaleOperator(sale=sale, operator=o, amount=a) for o, a in credited_operator_lines]
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
                {"id": o.id, "name": o.full_name, "amount": str(a)}
                for o, a in credited_operator_lines
            ],
            "partners": [
                {"id": p.id, "name": p.name, "amount": str(a)} for p, a in partner_lines
            ],
            "total": str(total),
            "discount": str(discount_dec),
            "net": str(total - discount_dec),
        },
        comment=duplicate_override_comment if duplicates else "",
    )
    return sale


@transaction.atomic
def sale_full_update(
    *,
    sale: Sale,
    user=None,
    imei: str,
    phone_model: str | None = None,
    operator_id: int | None = None,
    channel_id: int | None = None,
    amount: Decimal | None = None,
    discount: Decimal | None = None,
    operators: list[dict] | None = None,
    partners: list[dict] | None = None,
    sold_at: dt.datetime | None = None,
    client_name: str = "",
    client_phone: str = "",
    comment: str = "",
    gifts: Iterable[dict] | None = None,
    allow_duplicate_imei: bool = False,
    duplicate_override_comment: str = "",
    **_kwargs,
) -> Sale:
    imei = (imei or "").strip()
    if not is_valid_imei(imei):
        raise ApplicationError("IMEI должен быть из 6–15 цифр", {"field": "imei"})

    if imei != sale.imei:
        duplicates = sale_imei_duplicate_count(imei=imei, exclude_id=sale.id)
        if duplicates and not allow_duplicate_imei:
            raise DuplicateError(
                "Продажа с таким IMEI уже существует",
                {"field": "imei", "duplicate_count": duplicates},
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

    # If the caller omits `discount` from the payload (legacy clients),
    # preserve the current value rather than silently zeroing it out.
    discount_dec = (
        _coerce_decimal(discount, field="discount")
        if discount is not None
        else sale.discount
    )
    if discount_dec < 0:
        raise ApplicationError("Скидка не может быть отрицательной", {"field": "discount"})
    if discount_dec >= total:
        raise ApplicationError(
            "Скидка не может быть равна или превышать сумму продажи",
            {"field": "discount"},
        )

    credited_operator_lines = _apply_discount_to_operator_lines(
        operator_lines, gross=total, discount=discount_dec
    )

    if not phone_model:
        phone_model = sale.phone_model

    primary_op = credited_operator_lines[0][0]
    primary_partner = partner_lines[0][0]

    sale.imei = imei
    sale.phone_model = (phone_model or "")[:128]
    sale.operator = primary_op
    sale.channel = primary_partner
    sale.amount = total
    sale.discount = discount_dec
    sale.client_name = (client_name or "").strip()[:128]
    sale.client_phone = (client_phone or "").strip()[:32]
    sale.comment = comment
    if sold_at:
        sale.sold_at = sold_at
    sale.save()

    sale.operator_lines.all().delete()
    sale.partner_lines.all().delete()

    SaleOperator.objects.bulk_create(
        [SaleOperator(sale=sale, operator=o, amount=a) for o, a in credited_operator_lines]
    )
    SalePartner.objects.bulk_create(
        [SalePartner(sale=sale, partner=p, amount=a) for p, a in partner_lines]
    )

    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="sales.Sale",
        entity_id=sale.id,
        changes={
            "imei": sale.imei,
            "phone_model": sale.phone_model,
            "operators": [
                {"id": o.id, "name": o.full_name, "amount": str(a)}
                for o, a in credited_operator_lines
            ],
            "partners": [
                {"id": p.id, "name": p.name, "amount": str(a)} for p, a in partner_lines
            ],
            "total": str(total),
            "discount": str(discount_dec),
            "net": str(total - discount_dec),
        },
    )
    return sale


# --- partial update -----------------------------------------------------
#
# A small, surgical update path used for inline UI edits (e.g. fixing the
# sold_at date on a row) and for any legacy PATCH consumer. Only touches
# the fields explicitly passed in `fields`; anything not in that dict is
# preserved verbatim. Does NOT rebuild SaleOperator / SalePartner lines —
# for that, use `sale_full_update`.
_PARTIAL_UPDATE_ALLOWED = frozenset(
    {"sold_at", "client_name", "client_phone", "comment", "phone_model", "discount"}
)


def _reallocate_operator_lines_for_discount(sale: Sale, new_discount: Decimal) -> None:
    """
    Recompute SaleOperator.amount for the existing lines using the new
    discount. Preserves each operator's relative share of the GROSS sale.

    Original gross share is reconstructed from the current line amount
    plus the current discount, so this stays correct across repeated
    edits (e.g. discount 0 → 500k → 200k).
    """
    lines = list(sale.operator_lines.all().order_by("id"))
    if not lines:
        return

    current_credited_sum = sum(ln.amount for ln in lines)
    gross_share_sum = current_credited_sum + sale.discount
    if gross_share_sum <= 0:
        return
    net = sale.amount - new_discount

    running = Decimal("0")
    for i, line in enumerate(lines):
        original_share = line.amount + (
            # proportional reverse of the previously-applied discount
            sale.discount * (line.amount / current_credited_sum)
            if current_credited_sum > 0
            else Decimal("0")
        )
        if i == len(lines) - 1:
            new_amt = (net - running).quantize(_MONEY_Q, rounding=ROUND_HALF_UP)
        else:
            new_amt = (original_share * net / gross_share_sum).quantize(
                _MONEY_Q, rounding=ROUND_HALF_UP
            )
            running += new_amt
        line.amount = new_amt
        line.save(update_fields=["amount"])


@transaction.atomic
def sale_partial_update(*, sale: Sale, user=None, fields: dict) -> Sale:
    """
    Apply a partial update to safe scalar fields on a Sale.

    Only fields in `_PARTIAL_UPDATE_ALLOWED` are accepted; unknown / unsafe
    fields (imei, amount, operator, channel, status, returned, deleted) are
    silently ignored — those need to go through their dedicated services
    (`sale_full_update`, `sale_mark_returned`, `sale_soft_delete`, ...).

    Two audit entries can be written from a single call:
      1. A general UPDATE entry for non-discount scalar diffs (date,
         client info, comment, phone_model).
      2. A dedicated UPDATE entry tagged with the «Скидка» comment
         when the discount changes, alongside the resulting operator-
         line reallocation snapshot — so payroll-affecting edits are
         easy to find in the audit log.
    """
    scalar_diff: dict = {}
    update_fields: list[str] = []
    new_discount: Decimal | None = None

    for key, value in (fields or {}).items():
        if key not in _PARTIAL_UPDATE_ALLOWED:
            continue
        if key == "sold_at" and not value:
            continue
        if key == "discount":
            new_discount = _coerce_decimal(value, field="discount")
            if new_discount < 0:
                raise ApplicationError(
                    "Скидка не может быть отрицательной", {"field": "discount"}
                )
            if new_discount >= sale.amount:
                raise ApplicationError(
                    "Скидка не может быть равна или превышать сумму продажи",
                    {"field": "discount"},
                )
            continue
        if key in ("client_name", "client_phone", "comment", "phone_model"):
            value = (str(value) if value is not None else "").strip()
            if key == "client_name":
                value = value[:128]
            elif key == "client_phone":
                value = value[:32]
            elif key == "phone_model":
                value = value[:128] or sale.phone_model
        old = getattr(sale, key)
        if old != value:
            scalar_diff[key] = {
                "old": str(old) if old is not None else None,
                "new": str(value),
            }
            setattr(sale, key, value)
            update_fields.append(key)

    discount_changed = new_discount is not None and new_discount != sale.discount

    if not update_fields and not discount_changed:
        return sale

    if scalar_diff:
        update_fields.append("updated_at")
        sale.save(update_fields=update_fields)
        audit_log_create(
            user=user,
            action=AuditAction.UPDATE,
            entity="sales.Sale",
            entity_id=sale.id,
            changes=scalar_diff,
        )

    if discount_changed:
        old_discount = sale.discount
        _reallocate_operator_lines_for_discount(sale, new_discount)
        sale.discount = new_discount
        sale.save(update_fields=["discount", "updated_at"])

        # Snapshot the post-change operator lines so payroll diffs are
        # reconstructable from the audit trail alone.
        operator_snapshot = [
            {
                "operator_id": ln.operator_id,
                "operator_name": ln.operator.full_name,
                "amount": str(ln.amount),
            }
            for ln in sale.operator_lines.select_related("operator").all()
        ]
        audit_log_create(
            user=user,
            action=AuditAction.UPDATE,
            entity="sales.Sale",
            entity_id=sale.id,
            changes={
                "discount": {"old": str(old_discount), "new": str(new_discount)},
                "amount": str(sale.amount),
                "net": str(sale.amount - new_discount),
                "operator_lines": operator_snapshot,
            },
            comment="Скидка",
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
