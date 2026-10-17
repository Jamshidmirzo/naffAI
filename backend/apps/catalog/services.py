from __future__ import annotations

import io
import logging
import os
import re
from decimal import Decimal

from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import transaction
from PIL import Image, ImageOps, UnidentifiedImageError

from apps.audit.services import AuditAction, audit_log_create
from apps.common.exceptions import ApplicationError

from .models import (
    Channel,
    InstallmentTier,
    MarketingSettings,
    PhoneColor,
    PhoneModel,
    PhoneSpinFrame,
)

logger = logging.getLogger(__name__)


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


# ---------------------------------------------------------------------------
# Phone colors — upsert by name. Spin frames hang off PhoneColor, so the old
# "delete all colors, recreate" PATCH would wipe every 360° set on any edit.
# ---------------------------------------------------------------------------

_COLOR_FIELDS = ("hex_code", "price_override", "is_available", "sort_order")


@transaction.atomic
def phone_colors_sync(*, phone: PhoneModel, colors_data: list[dict]) -> None:
    """
    Make `phone.colors` match `colors_data` (the editor always sends the
    full list, without ids). Matched by exact `name`: existing colors are
    updated in place (keeping their id and spin frames), new names are
    created, names that are gone are deleted — together with their spin
    frames and the frame files.
    """
    existing = {c.name: c for c in phone.colors.all()}
    seen: set[str] = set()
    for data in colors_data:
        name = data["name"]
        seen.add(name)
        color = existing.get(name)
        if color is None:
            existing[name] = PhoneColor.objects.create(phone=phone, **data)
            continue
        changed = [f for f in _COLOR_FIELDS if f in data and getattr(color, f) != data[f]]
        for f in changed:
            setattr(color, f, data[f])
        if changed:
            color.save(update_fields=changed)
    stale = [c.id for name, c in existing.items() if name not in seen]
    if stale:
        _spin_files_delete_on_commit(
            PhoneSpinFrame.objects.filter(color_id__in=stale).values_list("image", flat=True)
        )
        PhoneColor.objects.filter(id__in=stale).delete()


# ---------------------------------------------------------------------------
# 360° spin frames. A manager uploads a whole set at once (8..120 photos,
# a turntable shoot); the set replaces the previous one for that color.
# Frames are normalised to WebP ≤1200 px wide so the site preloads a spin
# in a few MB.
# ---------------------------------------------------------------------------

SPIN_MIN_FRAMES = 8
SPIN_MAX_FRAMES = 120
SPIN_MAX_FILE_BYTES = 20 * 1024 * 1024
SPIN_MAX_WIDTH = 1200
SPIN_WEBP_QUALITY = 80

_DIGITS_RE = re.compile(r"(\d+)")


def _natural_key(name: str) -> list:
    """`frame10.jpg` after `frame2.jpg` (plain sort puts it first)."""
    base = os.path.basename(name or "").lower()
    return [(0, int(part), "") if part.isdigit() else (1, 0, part) for part in _DIGITS_RE.split(base)]


def _spin_files_delete_on_commit(names) -> None:
    names = [n for n in names if n]
    if not names:
        return

    def _delete():
        for name in names:
            try:
                default_storage.delete(name)
            except Exception:  # a missing file must not break the request
                logger.warning("spin: could not delete %s", name, exc_info=True)

    transaction.on_commit(_delete)


def _spin_validate(files: list) -> None:
    if len(files) < SPIN_MIN_FRAMES or len(files) > SPIN_MAX_FRAMES:
        raise ApplicationError(
            f"Для 360° нужно от {SPIN_MIN_FRAMES} до {SPIN_MAX_FRAMES} кадров, "
            f"получено {len(files)}",
            {"field": "frames"},
        )
    for f in files:
        if f.size > SPIN_MAX_FILE_BYTES:
            raise ApplicationError(
                f"Файл {f.name} больше 20 МБ", {"field": "frames", "file": f.name}
            )
        try:
            f.seek(0)
            with Image.open(f) as img:
                img.verify()
        except (UnidentifiedImageError, OSError, SyntaxError, ValueError, Image.DecompressionBombError):
            raise ApplicationError(
                f"Файл {f.name} — не изображение", {"field": "frames", "file": f.name}
            ) from None
        finally:
            f.seek(0)


def _spin_to_webp(f) -> bytes:
    """EXIF-rotate, flatten alpha onto white, fit to SPIN_MAX_WIDTH, WebP q80."""
    f.seek(0)
    with Image.open(f) as src:
        # JPEG decoder can downscale by 1/2..1/8 while decoding — big win on
        # 50 MP camera files. Keeps both sides ≥ SPIN_MAX_WIDTH, so the
        # EXIF rotation below can't leave the result under-sized.
        src.draft("RGB", (SPIN_MAX_WIDTH, SPIN_MAX_WIDTH))
        img = ImageOps.exif_transpose(src)
        has_alpha = img.mode in ("RGBA", "LA", "PA") or (
            img.mode == "P" and "transparency" in img.info
        )
        if has_alpha:
            rgba = img.convert("RGBA")
            img = Image.new("RGB", rgba.size, (255, 255, 255))
            img.paste(rgba, mask=rgba.getchannel("A"))
        elif img.mode != "RGB":
            img = img.convert("RGB")
        if img.width > SPIN_MAX_WIDTH:
            height = max(1, round(img.height * SPIN_MAX_WIDTH / img.width))
            img = img.resize((SPIN_MAX_WIDTH, height), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="WEBP", quality=SPIN_WEBP_QUALITY)
    return buf.getvalue()


def phone_spin_replace(
    *, phone: PhoneModel, color: PhoneColor | None, files: list, user=None
) -> list[PhoneSpinFrame]:
    """
    Replace the 360° set of (phone, color) with `files` — order = natural
    sort of the original file names (`1.jpg, 2.jpg, 10.jpg`). `color=None`
    is the colorless set. Old frames and their files go away only after
    the new set is committed.
    """
    if color is not None and color.phone_id != phone.id:
        raise ApplicationError("Цвет не принадлежит этому телефону", {"field": "color_id"})
    files = list(files)
    _spin_validate(files)
    files.sort(key=lambda f: _natural_key(f.name))
    # Heavy Pillow work happens before the transaction opens.
    blobs = [_spin_to_webp(f) for f in files]

    prefix = f"{phone.id}-{color.id if color else 'x'}"
    saved: list[str] = []
    try:
        with transaction.atomic():
            old = PhoneSpinFrame.objects.select_for_update().filter(phone=phone, color=color)
            old_names = list(old.values_list("image", flat=True))
            old.delete()
            frames: list[PhoneSpinFrame] = []
            for i, data in enumerate(blobs):
                frame = PhoneSpinFrame(phone=phone, color=color, index=i)
                frame.image.save(f"{prefix}-{i:03d}.webp", ContentFile(data), save=False)
                saved.append(frame.image.name)
                frame.save()
                frames.append(frame)
            audit_log_create(
                user=user,
                action=AuditAction.UPDATE,
                entity="catalog.PhoneModel",
                entity_id=phone.id,
                changes={"spin": {"color_id": color.id if color else None, "frames": len(frames)}},
            )
            _spin_files_delete_on_commit(old_names)
    except Exception:
        # Rolled back — the files written for the new set are orphans now.
        for name in saved:
            try:
                default_storage.delete(name)
            except Exception:
                logger.warning("spin: could not clean up %s", name, exc_info=True)
        raise
    return frames


@transaction.atomic
def phone_spin_clear(*, phone: PhoneModel, color: PhoneColor | None, user=None) -> int:
    if color is not None and color.phone_id != phone.id:
        raise ApplicationError("Цвет не принадлежит этому телефону", {"field": "color_id"})
    qs = PhoneSpinFrame.objects.filter(phone=phone, color=color)
    names = list(qs.values_list("image", flat=True))
    deleted = len(names)
    if deleted:
        qs.delete()
        audit_log_create(
            user=user,
            action=AuditAction.DELETE,
            entity="catalog.PhoneModel",
            entity_id=phone.id,
            changes={"spin": {"color_id": color.id if color else None, "frames": 0}},
        )
        _spin_files_delete_on_commit(names)
    return deleted


def phone_spin_files_cleanup(*, phone: PhoneModel) -> None:
    """Call inside the transaction that deletes `phone` (cascade drops the
    frame rows, not the files)."""
    _spin_files_delete_on_commit(
        PhoneSpinFrame.objects.filter(phone=phone).values_list("image", flat=True)
    )
