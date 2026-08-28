"""
Services for the Telegram bot domain (HackSoft):

  1) `create_pending_from_message` — parse a raw group-chat report line
     and stage a `pending` Sale draft for manager confirmation.
  2) `subscription_link_by_phone` — attach a phone (+998XXXXXXXXX) to a
     `BotSubscription` row and auto-resolve the matching Operator +
     Profile so the manager knows who's on the other side of the DM.
  3) `subscription_update` — manager-driven partial update
     (`receives_broadcasts`, `phone`) with audit trail. Phone changes
     re-run the auto-link resolver.

Everything mutating goes through here; APIs / bot handlers stay thin.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from django.utils import timezone

from apps.audit.services import AuditAction, audit_log_create
from apps.catalog.models import Channel
from apps.common.validators import is_valid_imei, normalize_uz_phone
from apps.operators.models import Operator
from apps.sales.models import Sale, SaleStatus
from apps.users.models import Profile

from .models import BotSubscription
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


# -----------------------------------------------------------------------
# Phone-linking / broadcast toggle for BotSubscription
# -----------------------------------------------------------------------


def _resolve_operator_by_phone(phone: str) -> Operator | None:
    if not phone:
        return None
    return Operator.objects.filter(phone=phone).first()


def _resolve_profile_by_phone(phone: str) -> Profile | None:
    """
    App-side profiles are keyed by `User.username == normalised +998... phone`
    (see users/services.py). Fall back to profile.operator.phone match so we
    still catch profiles whose username is a legacy alias but whose linked
    operator has the right phone.
    """
    if not phone:
        return None
    prof = Profile.objects.filter(user__username=phone).select_related("user").first()
    if prof:
        return prof
    return (
        Profile.objects.filter(operator__phone=phone)
        .select_related("user", "operator")
        .first()
    )


def subscription_link_by_phone(
    *, subscription: BotSubscription, raw_phone: str
) -> BotSubscription:
    """
    Normalise `raw_phone`, attach it to `subscription`, and try to resolve
    it against Operator/Profile. Persists the changed fields and returns
    the (refreshed) subscription. Audit entry is written *only* when the
    stored phone actually changes — no-op re-runs stay quiet.

    Called from the bot's `Message.contact` handler after /start; also
    reachable from `subscription_update()` when the manager edits phone
    from the UI.
    """
    normalized, _ = normalize_uz_phone(raw_phone)
    if not normalized:
        return subscription

    changed_fields: list[str] = []
    if subscription.phone != normalized:
        subscription.phone = normalized
        changed_fields.append("phone")

    # Always re-run resolvers on link — the operator may have been created
    # after the first /start, or the manager may have edited the phone.
    op = _resolve_operator_by_phone(normalized)
    prof = _resolve_profile_by_phone(normalized)
    if subscription.linked_operator_id != (op.id if op else None):
        subscription.linked_operator = op
        changed_fields.append("linked_operator")
    if subscription.linked_profile_id != (prof.id if prof else None):
        subscription.linked_profile = prof
        changed_fields.append("linked_profile")

    if changed_fields:
        subscription.save(update_fields=[*changed_fields, "updated_at"])
        audit_log_create(
            user=None,
            action=AuditAction.UPDATE,
            entity="tg_bot.BotSubscription",
            entity_id=subscription.id,
            changes={
                "phone": normalized,
                "linked_operator_id": op.id if op else None,
                "linked_profile_id": prof.id if prof else None,
                "source": "telegram_contact",
            },
            comment="Авто-привязка по контакту из Telegram",
        )
    return subscription


def subscription_update(
    *,
    subscription: BotSubscription,
    actor: Any | None = None,
    receives_broadcasts: bool | None = None,
    phone: str | None = None,
) -> BotSubscription:
    """
    Manager-driven partial update. Any subset of fields may be supplied.

    Rules:
      - `receives_broadcasts` — pure toggle, audited when it changes.
      - `phone` — normalised via `normalize_uz_phone`; if it changed we
        also re-resolve `linked_operator` + `linked_profile`.

    The audit changes dict carries `before`/`after` per field so the
    Audit UI shows a proper diff.
    """
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    changed_fields: list[str] = []

    if receives_broadcasts is not None and bool(receives_broadcasts) != bool(
        subscription.receives_broadcasts
    ):
        before["receives_broadcasts"] = subscription.receives_broadcasts
        subscription.receives_broadcasts = bool(receives_broadcasts)
        after["receives_broadcasts"] = subscription.receives_broadcasts
        changed_fields.append("receives_broadcasts")

    if phone is not None:
        normalized, _ = normalize_uz_phone(phone) if phone else ("", False)
        if normalized != subscription.phone:
            before["phone"] = subscription.phone
            subscription.phone = normalized
            after["phone"] = normalized
            changed_fields.append("phone")
            # Re-link operator/profile whenever phone shifts. `""` phone
            # clears the FKs — a manager deliberately unsetting a wrong
            # match shouldn't leave stale links behind.
            op = _resolve_operator_by_phone(normalized) if normalized else None
            prof = _resolve_profile_by_phone(normalized) if normalized else None
            if subscription.linked_operator_id != (op.id if op else None):
                before["linked_operator_id"] = subscription.linked_operator_id
                subscription.linked_operator = op
                after["linked_operator_id"] = op.id if op else None
                changed_fields.append("linked_operator")
            if subscription.linked_profile_id != (prof.id if prof else None):
                before["linked_profile_id"] = subscription.linked_profile_id
                subscription.linked_profile = prof
                after["linked_profile_id"] = prof.id if prof else None
                changed_fields.append("linked_profile")

    if changed_fields:
        subscription.save(update_fields=[*changed_fields, "updated_at"])
        audit_log_create(
            user=actor,
            action=AuditAction.UPDATE,
            entity="tg_bot.BotSubscription",
            entity_id=subscription.id,
            changes={"before": before, "after": after},
            comment="Обновление подписки бота",
        )
    return subscription
