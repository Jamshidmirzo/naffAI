from __future__ import annotations

import datetime as dt
import logging
from collections.abc import Iterable
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

logger = logging.getLogger(__name__)

from django.db import transaction
from django.utils import timezone

from apps.audit.services import AuditAction, audit_log_create
from apps.catalog.imei_service import imei_lookup
from apps.catalog.models import Channel
from apps.common.exceptions import ApplicationError, DuplicateError
from apps.common.validators import is_valid_imei, normalize_uz_phone
from apps.operators.models import Operator, OperatorStatus

from .models import (
    GiftItem,
    Sale,
    SaleContractPhoto,
    SaleOperator,
    SalePartner,
    SaleStatus,
)
from .selectors import sale_imei_duplicate_count

# Business-rule cap for the multi-photo contract gallery. Kept in the
# service (not the model) so the DB stays flexible while the operator
# UX gets a hard rail.
MAX_CONTRACT_PHOTOS = 5

# Business-rule cap for the multi-channel payment split: one sale can
# be paid through up to N distinct partner channels (Anor+TBC, etc).
# Kept in sync with the operator UI repeater.
MAX_PAYMENT_CHANNELS = 2

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


def _validate_contract_photos(photos: list | None) -> list:
    """Trim None entries + enforce the ≤ MAX_CONTRACT_PHOTOS cap."""
    if not photos:
        return []
    cleaned = [p for p in photos if p is not None]
    if len(cleaned) > MAX_CONTRACT_PHOTOS:
        raise ApplicationError(
            f"Можно приложить не более {MAX_CONTRACT_PHOTOS} фото договора",
            {"field": "contract_photos"},
        )
    return cleaned


def _write_contract_photos(sale: Sale, photos: list, *, legacy_single) -> None:
    """
    Bulk-create SaleContractPhoto rows for `photos` (in the given order).

    If `photos` is empty AND a legacy `contract_photo` (single) was
    attached to the Sale itself, mirror it as the first photo entry so
    the new gallery UI can render a uniform list. This preserves back-
    compat for the old prod-фронт which still sends only the single field.
    """
    if photos:
        SaleContractPhoto.objects.bulk_create(
            [
                SaleContractPhoto(sale=sale, photo=f, position=idx)
                for idx, f in enumerate(photos)
            ]
        )
        return
    if legacy_single:
        SaleContractPhoto.objects.create(sale=sale, photo=legacy_single, position=0)


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

    For `role == "partners"` we additionally enforce:
      - length ≤ MAX_PAYMENT_CHANNELS (business rule: a sale can be split
        across at most 2 payment channels — Anor+TBC, Alif+cash, etc.)
      - each channel is unique per sale (no "Anor 3M + Anor 2M" — merge
        client-side or model as a single 5M line).
    """
    if raw_lines:
        out = []
        seen_partner_ids: set[int] = set()
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
            if role == "partners":
                if obj.id in seen_partner_ids:
                    raise ApplicationError(
                        "Один и тот же канал выбран дважды",
                        {"field": "partners"},
                    )
                seen_partner_ids.add(obj.id)
            out.append((obj, amount))
        if role == "partners" and len(out) > MAX_PAYMENT_CHANNELS:
            raise ApplicationError(
                f"Можно указать не более {MAX_PAYMENT_CHANNELS} каналов оплаты",
                {"field": "partners"},
            )
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
    quantity: int = 1,
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
    bonus_note: str = "",
    sheet_source_id: int | None = None,
    lead_id: int | None = None,
    contract_photo=None,
    contract_photos: list | None = None,
) -> Sale:
    """
    Create a sale.

    Multi-allocation:
      - `operators=[{operator_id|operator_name, amount}, ...]` — payroll split.
      - `partners=[{partner_id|partner_name, amount}, ...]` — payment channels
        (up to MAX_PAYMENT_CHANNELS = 2, unique per sale). Sum of partner
        amounts is the sale total (`amount` field), so one 10M sale split
        6M through Anor + 4M through TBC is expressed as two partner lines.

    Names that don't match an existing record are auto-created (operator →
    status=active, channel/partner → is_active=True).

    Legacy single-FK payload (`operator_id`, `channel_id`, `amount`) is still
    accepted and wrapped into a single allocation line per role — that path
    stays alive for the older prod frontend which sends only one channel.

    Optional add-ons:
      - `contract_photos` — до 5 фото договора (список UploadedFile).
        Legacy single `contract_photo` остаётся принят: если пришёл только
        он — он же кладётся первым в новую таблицу.
    """
    imei = (imei or "").strip()
    if not is_valid_imei(imei):
        raise ApplicationError("IMEI должен быть из 6–15 цифр", {"field": "imei"})

    # Validate optional inputs BEFORE any DB writes so a 6th photo
    # aborts the transaction cleanly with a per-field error.
    photos = _validate_contract_photos(contract_photos)

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

    # Multi-channel split invariant: when the caller supplies BOTH an
    # `amount` (total) AND a `partners` list with more than one entry,
    # the sum of partner shares must equal `amount` to the cent. Guards
    # against typos like "10M total = 6M Anor + 3M TBC" (should be 4M).
    if partners and amount not in (None, "") and len(partner_lines) > 1:
        try:
            expected_total = Decimal(str(amount))
        except (InvalidOperation, TypeError) as exc:
            raise ApplicationError(
                "Некорректная общая сумма", {"field": "amount"}
            ) from exc
        if expected_total.quantize(_MONEY_Q) != total.quantize(_MONEY_Q):
            raise ApplicationError(
                (
                    f"Сумма по каналам ({total}) не равна общей сумме "
                    f"продажи ({expected_total})"
                ),
                {
                    "field": "partners",
                    "expected_total": str(expected_total),
                    "partners_total": str(total),
                },
            )

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

    qty = max(1, int(quantity or 1))
    # Pending sales from operators must have at least one contract photo —
    # accepted either as the new `contract_photos` list or as the legacy
    # single `contract_photo`. Enforced at the service layer so any caller
    # path (API, tests, tg-bot later) gets the same guarantee.
    if status == SaleStatus.PENDING and not (photos or contract_photo):
        raise ApplicationError(
            "Для отправки продажи на подтверждение приложите фото договора.",
            {"field": "contract_photo"},
        )
    sale = Sale.objects.create(
        imei=imei,
        phone_model=phone_model[:128],
        quantity=qty,
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
        bonus_note=(bonus_note or "").strip(),
        sheet_source_id=sheet_source_id,
        contract_photo=contract_photo,
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

    _write_contract_photos(sale, photos, legacy_single=contract_photo)

    audit_log_create(
        user=user,
        action=AuditAction.CREATE,
        entity="sales.Sale",
        entity_id=sale.id,
        changes={
            "imei": sale.imei,
            "phone_model": sale.phone_model,
            "quantity": sale.quantity,
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
            "sheet_source_id": sheet_source_id,
            "bonus_note": sale.bonus_note[:120] if sale.bonus_note else "",
            "contract_photos_count": len(photos) if photos else (1 if contract_photo else 0),
        },
        comment=duplicate_override_comment if duplicates else "",
    )

    resolved_lead_id = lead_id
    auto_matched = False
    if resolved_lead_id is None and client_phone:
        # Auto-link by phone: 98% of manually-created sales on prod arrive
        # without lead_id (the dashboard/admin form doesn't pass it), which
        # broke the "operator conversion" metric because leads never got
        # flipped to WON. Try to find an existing lead by normalised phone
        # and, if found, run the same linkage as an explicit lead_id.
        # Best-effort: any failure here MUST NOT abort the sale — it's
        # already saved and payroll-correct without a lead link.
        try:
            matched = _find_lead_by_client_phone(client_phone)
            if matched is not None:
                resolved_lead_id = matched.id
                auto_matched = True
                logger.info(
                    "sale_create.auto_match sale_id=%s lead_id=%s status=%s",
                    sale.id,
                    matched.id,
                    matched.status,
                )
        except Exception:
            logger.warning(
                "sale_create.auto_match_failed sale_id=%s",
                sale.id,
                exc_info=True,
            )

    if resolved_lead_id is not None:
        _link_sale_to_lead_and_mark_won(
            sale=sale, lead_id=resolved_lead_id, user=user
        )
        if auto_matched:
            logger.info(
                "sale_create.auto_match_applied sale_id=%s lead_id=%s",
                sale.id,
                resolved_lead_id,
            )

    _broadcast_new_sale(sale, primary_op, credited_operator_lines, total)
    return sale


def _find_lead_by_client_phone(client_phone: str):
    """
    Find a Lead matching a client phone, preferring the most useful one:
      1. non-terminal (still workable) leads first — flipping to WON is
         valuable there.
      2. else an already-WON lead (idempotent re-link for repeat customers).
      3. else the newest match (LOST/ARCHIVED) — link but don't overwrite.

    Phone normalization uses `normalize_uz_phone` so `+998 90 123 45 67`,
    `998901234567`, `+998901234567`, `90 123-45-67` all match the same
    canonical `+998901234567`. Returns `None` if no match or the phone
    can't be normalised.
    """
    from apps.leads.models import Lead
    from apps.leads.selectors import terminal_lead_status_codes

    normalized, ok = normalize_uz_phone(client_phone)
    if not ok:
        return None

    base_qs = Lead.objects.filter(phone=normalized)
    if not base_qs.exists():
        return None

    terminal = list(terminal_lead_status_codes())
    # 1. Active (non-terminal) — highest priority; newest first so a fresh
    #    lead outranks a stale duplicate.
    active = base_qs.exclude(status__in=terminal).order_by("-updated_at").first()
    if active is not None:
        return active
    # 2. Already WON — idempotent re-link (safe: _link…and_mark_won won't
    #    flip a lead already in a terminal status).
    won = base_qs.filter(status="won").order_by("-updated_at").first()
    if won is not None:
        return won
    # 3. Fallback: any (LOST/ARCHIVED/…). Sale still gets a lead link for
    #    the analytics pipeline, but status stays terminal.
    return base_qs.order_by("-updated_at").first()


def _link_sale_to_lead_and_mark_won(*, sale: Sale, lead_id: int, user) -> None:
    """
    When an operator creates a sale after finding a matching lead by phone
    (SaleCreate → phone-search → pick), we:
      1. Attach `sale.lead = lead` (and copy `sheet_source` if the sale had
         none — mirrors the invariant in `lead_convert_to_sale`).
      2. If the lead's current status is not terminal (won/lost/archived/
         needs_review + any manager-flagged terminal label), flip it to WON
         through `lead_update_status` so audit + refill fire correctly.

    Any failure is logged but must NOT abort the sale — the sale is already
    saved, the linkage is best-effort. Same connection/transaction as
    sale_create (the outer @transaction.atomic wraps this call).
    """
    from apps.leads.models import Lead, LeadStatus
    from apps.leads.selectors import terminal_lead_status_codes
    from apps.leads.services import lead_update_status

    try:
        lead = Lead.objects.select_for_update().filter(pk=lead_id).first()
        if lead is None:
            return
        sale.lead = lead
        update_fields = ["lead"]
        if lead.sheet_source_id and not sale.sheet_source_id:
            sale.sheet_source_id = lead.sheet_source_id
            update_fields.append("sheet_source")
        sale.save(update_fields=update_fields)
        if lead.status not in terminal_lead_status_codes():
            lead_update_status(
                lead=lead,
                status=LeadStatus.WON,
                user=user,
                comment=f"Продажа №{sale.id}: авто-конвертация по phone-match",
            )
    except Exception:
        logger.exception("link_sale_to_lead failed sale=%s lead_id=%s", sale.id, lead_id)


def _broadcast_new_sale(sale, primary_op, operator_lines, total) -> None:
    """
    Fire in-app notifications + Telegram DMs to every senior user
    (manager / team_lead) about a freshly-created sale. Failures are
    swallowed on purpose — an outage in the notification layer must
    never abort the sale itself.
    """
    try:
        from apps.notifications.services import (
            NotificationKind,
            notification_broadcast,
        )
        from apps.users.models import Profile, Role
    except Exception:
        return

    op_names = ", ".join(o.full_name for o, _ in operator_lines) or (
        primary_op.full_name if primary_op else "—"
    )
    source_name = None
    try:
        source_name = sale.sheet_source.name if sale.sheet_source_id else None
    except Exception:
        source_name = None
    amount_int = int(total)

    title = f"💰 {op_names} · {sale.phone_model}"
    body_parts = [
        f"{amount_int:,}".replace(",", " ") + " сум",
        f"Источник: {source_name or 'Прямая'}",
    ]
    if sale.bonus_note.strip():
        body_parts.append(f"🎁 {sale.bonus_note.strip()[:200]}")
    body = " · ".join(body_parts)

    seniors = Profile.objects.filter(
        role__in=[Role.TEAM_LEAD, Role.MANAGER, Role.SUPERADMIN]
    ).select_related("user")
    recipient_ids = [p.user_id for p in seniors if p.user_id]
    tg_ids = [p.telegram_user_id for p in seniors if p.telegram_user_id]

    try:
        notification_broadcast(
            kind=NotificationKind.SALE_CREATED,
            title=title,
            body=body,
            link=f"/sales/{sale.id}",
            recipient_ids=recipient_ids,
            metadata={
                "sale_id": sale.id,
                "amount": amount_int,
                "operator_names": op_names,
                "sheet_source_name": source_name,
                "bonus_note": sale.bonus_note.strip()[:200],
            },
        )
    except Exception:
        pass

    if tg_ids:
        try:
            import asyncio

            from apps.tg_bot.notify import send_sale_created_dms

            asyncio.run(
                send_sale_created_dms(
                    recipient_ids=tg_ids,
                    operator_name=op_names,
                    phone_model=sale.phone_model,
                    amount_uzs=amount_int,
                    sheet_source_name=source_name,
                    bonus_note=sale.bonus_note,
                    sale_id=sale.id,
                )
            )
        except Exception:
            pass


@transaction.atomic
def sale_full_update(
    *,
    sale: Sale,
    user=None,
    imei: str,
    phone_model: str | None = None,
    quantity: int | None = None,
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
    contract_photos: list | None = None,
    contract_photo=None,
    **_kwargs,
) -> Sale:
    imei = (imei or "").strip()
    if not is_valid_imei(imei):
        raise ApplicationError("IMEI должен быть из 6–15 цифр", {"field": "imei"})

    # Validate optional add-ons BEFORE mutating any rows.
    photos = _validate_contract_photos(contract_photos)

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

    # Multi-channel split invariant (see sale_create for the reasoning):
    # if the caller sends both `amount` (total) and a multi-line partners
    # list, their sums must match to the cent.
    if partners and amount not in (None, "") and len(partner_lines) > 1:
        try:
            expected_total = Decimal(str(amount))
        except (InvalidOperation, TypeError) as exc:
            raise ApplicationError(
                "Некорректная общая сумма", {"field": "amount"}
            ) from exc
        if expected_total.quantize(_MONEY_Q) != total.quantize(_MONEY_Q):
            raise ApplicationError(
                (
                    f"Сумма по каналам ({total}) не равна общей сумме "
                    f"продажи ({expected_total})"
                ),
                {
                    "field": "partners",
                    "expected_total": str(expected_total),
                    "partners_total": str(total),
                },
            )

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
    if quantity is not None:
        sale.quantity = max(1, int(quantity))
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

    # Photos: pass an explicit list (even []) to replace; omit the key
    # to keep the existing gallery.
    photos_updated = False
    if contract_photos is not None:
        sale.contract_photos_all.all().delete()
        _write_contract_photos(sale, photos, legacy_single=contract_photo)
        photos_updated = True

    audit_changes = {
        "imei": sale.imei,
        "phone_model": sale.phone_model,
        "quantity": sale.quantity,
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
    }
    if photos_updated:
        audit_changes["contract_photos_count"] = len(photos) if photos else (
            1 if contract_photo else 0
        )
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="sales.Sale",
        entity_id=sale.id,
        changes=audit_changes,
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
    {"sold_at", "client_name", "client_phone", "comment", "phone_model", "discount", "quantity"}
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
        if key == "quantity":
            try:
                value = int(value)
            except (TypeError, ValueError) as exc:
                raise ApplicationError(
                    "Количество должно быть целым числом", {"field": "quantity"}
                ) from exc
            if value < 1:
                raise ApplicationError(
                    "Количество должно быть не меньше 1", {"field": "quantity"}
                )
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
    old_status = sale.status
    sale.status = SaleStatus.CONFIRMED
    # Clear any prior rejection payload — manager may have rejected once
    # then reconsidered after an edit + approve pass.
    sale.rejection_reason = ""
    sale.rejected_at = None
    sale.save(update_fields=["status", "rejection_reason", "rejected_at", "updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="sales.Sale",
        entity_id=sale.id,
        changes={"status": {"old": old_status, "new": "confirmed"}},
    )
    return sale


@transaction.atomic
def sale_reject(*, sale: Sale, user, reason: str) -> Sale:
    """
    Manager rejects a pending sale. Requires a non-empty reason so the
    operator sees actionable feedback (shown on their /my/sales pending
    tab + in-app notification). Only PENDING sales can be rejected.
    """
    reason = (reason or "").strip()
    if not reason:
        raise ApplicationError(
            "Причина отклонения обязательна.",
            {"field": "reason"},
        )
    if sale.status != SaleStatus.PENDING:
        raise ApplicationError(
            "Отклонить можно только продажу на подтверждении.",
            {"field": "status"},
        )
    sale.status = SaleStatus.REJECTED
    sale.rejection_reason = reason
    sale.rejected_at = timezone.now()
    # One-shot marker consumed by apps.tg_bot.signals — triggers a manager
    # DM in the post_save handler without hard-coupling sales → tg_bot.
    sale._naff_notify_reject = True
    sale.save(
        update_fields=["status", "rejection_reason", "rejected_at", "updated_at"]
    )
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="sales.Sale",
        entity_id=sale.id,
        changes={
            "status": {"old": "pending", "new": "rejected"},
            "rejection_reason": reason,
        },
    )
    _notify_operator_of_reject(sale=sale, reason=reason, user=user)
    return sale


def _notify_operator_of_reject(*, sale: Sale, reason: str, user) -> None:
    """
    In-app notification for the operator whose pending sale was rejected.
    Best-effort — errors are swallowed so the reject itself succeeds even
    if notifications app is down.
    """
    try:
        from apps.notifications.models import NotificationKind
        from apps.notifications.services import notification_broadcast

        if not sale.created_by_id:
            return
        notification_broadcast(
            kind=NotificationKind.SALE_REJECTED,
            title="Продажа отклонена",
            body=f"Продажа №{sale.id} ({sale.phone_model}) отклонена. Причина: {reason}",
            link=f"/sales/{sale.id}",
            recipient_ids=[sale.created_by_id],
            metadata={"sale_id": sale.id, "reason": reason},
        )
    except Exception:
        import logging

        logging.getLogger(__name__).exception(
            "reject notification failed sale=%s", sale.id
        )
