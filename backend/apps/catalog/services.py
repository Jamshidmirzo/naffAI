from __future__ import annotations

from decimal import Decimal

from django.db import transaction

from apps.audit.services import AuditAction, audit_log_create
from apps.common.exceptions import ApplicationError

from .models import Channel, InstallmentTier, MarketingSettings, PhoneModel


@transaction.atomic
def channel_create(*, name: str, is_active: bool = True, user=None) -> Channel:
    name = (name or "").strip()
    if not name:
        raise ApplicationError("Название не может быть пустым", {"field": "name"})
    existing = Channel.objects.filter(name__iexact=name).first()
    if existing:
        # Reactivate a previously-deactivated partner instead of erroring out.
        if not existing.is_active and is_active:
            existing.is_active = True
            existing.save(update_fields=["is_active", "updated_at"])
            audit_log_create(
                user=user,
                action=AuditAction.UPDATE,
                entity="catalog.Channel",
                entity_id=existing.id,
                changes={"is_active": True},
                comment="reactivated via create",
            )
            return existing
        raise ApplicationError(
            f"Партнёр «{existing.name}» уже существует",
            {"field": "name", "existing_id": existing.id},
        )
    channel = Channel.objects.create(name=name, is_active=is_active)
    audit_log_create(
        user=user,
        action=AuditAction.CREATE,
        entity="catalog.Channel",
        entity_id=channel.id,
        changes={"name": channel.name, "is_active": channel.is_active},
    )
    return channel


@transaction.atomic
def channel_update(*, channel: Channel, user=None, **fields) -> Channel:
    old = {"name": channel.name, "is_active": channel.is_active}
    for k, v in fields.items():
        setattr(channel, k, v)
    channel.save()
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="catalog.Channel",
        entity_id=channel.id,
        changes={"before": old, "after": fields},
    )
    return channel


# ---------------------------------------------------------------------------
# Installment calculator — plugs into /calculator page and the marketing
# builder. Global tiers (InstallmentTier), no per-partner logic.
# ---------------------------------------------------------------------------

_MONEY_Q = Decimal("0.01")


def _to_decimal(value) -> Decimal:
    if value in (None, ""):
        return Decimal("0")
    if isinstance(value, Decimal):
        return value
    # Accept strings like "12 500 000" (thousands-separated) as well as raw ints.
    if isinstance(value, str):
        clean = value.replace(" ", "").replace(" ", "").replace(",", ".")
        return Decimal(clean or "0")
    return Decimal(str(value))


def calculate_installments(
    *, amount, down_payment=Decimal("0"), phone: PhoneModel | None = None
) -> dict:
    """
    Returns the calculator payload — the `ariza` (financed principal) plus
    one row per active InstallmentTier. Frontend renders them as a 6-card
    grid; also used by the marketing text builder (where only rows with
    show_in_marketing=True are rendered).

    Ordering matches InstallmentTier.Meta.ordering (sort_order, months).
    """
    amount_d = _to_decimal(amount)
    down_d = _to_decimal(down_payment)
    if phone is not None and amount_d <= 0:
        amount_d = phone.price or Decimal("0")

    ariza = amount_d - down_d
    if ariza < 0:
        ariza = Decimal("0")

    tiers = InstallmentTier.objects.filter(is_active=True).order_by(
        "sort_order", "months"
    )
    rows: list[dict] = []
    for t in tiers:
        commission_sum = (ariza * t.commission_pct / Decimal("100")).quantize(_MONEY_Q)
        total = (ariza + commission_sum).quantize(_MONEY_Q)
        monthly = (total / Decimal(t.months)).quantize(_MONEY_Q) if t.months else Decimal("0")
        rows.append(
            {
                "tier_id": t.id,
                "months": t.months,
                "commission_pct": str(t.commission_pct),
                "ariza_narxi": str(ariza.quantize(_MONEY_Q)),
                "komissiya_sum": str(commission_sum),
                "total": str(total),
                "sum_per_month": str(monthly),
                "show_in_marketing": t.show_in_marketing,
            }
        )

    return {
        "amount": str(amount_d.quantize(_MONEY_Q)),
        "down_payment": str(down_d.quantize(_MONEY_Q)),
        "ariza": str(ariza.quantize(_MONEY_Q)),
        "tiers": rows,
    }


# ---------------------------------------------------------------------------
# MarketingSettings singleton service — used by the /marketing-settings
# admin form. Keeps write-side logic out of the view.
# ---------------------------------------------------------------------------


@transaction.atomic
def marketing_settings_update(*, user=None, **fields) -> MarketingSettings:
    settings = MarketingSettings.load()
    before = {
        "default_tagline": settings.default_tagline,
        "phone_primary": settings.phone_primary,
        "phone_secondary": settings.phone_secondary,
        "telegram_handle": settings.telegram_handle,
        "address": settings.address,
        "benefits": settings.benefits,
    }
    changed_fields: list[str] = []
    for k, v in fields.items():
        if v is None:
            continue
        if getattr(settings, k) != v:
            setattr(settings, k, v)
            changed_fields.append(k)
    if changed_fields:
        settings.save()
        audit_log_create(
            user=user,
            action=AuditAction.UPDATE,
            entity="catalog.MarketingSettings",
            entity_id=settings.id,
            changes={
                "before": {k: before[k] for k in changed_fields},
                "after": {k: getattr(settings, k) for k in changed_fields},
            },
        )
    return settings


@transaction.atomic
def installment_tier_upsert(
    *, months: int, commission_pct, is_active: bool = True,
    show_in_marketing: bool = False, sort_order: int = 0, user=None,
) -> InstallmentTier:
    if months is None or int(months) <= 0:
        raise ApplicationError("Срок в месяцах должен быть > 0", {"field": "months"})
    if commission_pct is None or Decimal(str(commission_pct)) < 0:
        raise ApplicationError(
            "Комиссия должна быть неотрицательной", {"field": "commission_pct"}
        )
    tier, created = InstallmentTier.objects.update_or_create(
        months=int(months),
        defaults={
            "commission_pct": Decimal(str(commission_pct)),
            "is_active": bool(is_active),
            "show_in_marketing": bool(show_in_marketing),
            "sort_order": int(sort_order),
        },
    )
    audit_log_create(
        user=user,
        action=AuditAction.CREATE if created else AuditAction.UPDATE,
        entity="catalog.InstallmentTier",
        entity_id=tier.id,
        changes={
            "months": tier.months,
            "commission_pct": str(tier.commission_pct),
            "is_active": tier.is_active,
            "show_in_marketing": tier.show_in_marketing,
            "sort_order": tier.sort_order,
        },
    )
    return tier
