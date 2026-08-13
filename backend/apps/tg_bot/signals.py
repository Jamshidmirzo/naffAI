"""
Django signal handlers that fan out Telegram DMs on domain events.

Kept as real signals (not scheduled batching) because these are «real-time»
by nature — a manager expects to know within seconds that a pending sale
was rejected, or that a callback slipped past its due time.

Note on architecture (per HackSoft styleguide): domain services are the
canonical write path — services call these signals via `post_save`.
This module *only* observes and notifies; it does NOT mutate state.

Signals wired:
  * `Sale.post_save` → on transition to REJECTED, DM every linked
    manager (BotChat.linked_profile.role in (manager, team_lead)).
"""

from __future__ import annotations

import asyncio
import logging
from threading import Thread

from django.db.models.signals import post_save
from django.dispatch import receiver

from apps.sales.models import Sale

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public re-usable helper: broadcast a bot message to every manager DM.
# ---------------------------------------------------------------------------


def notify_managers_async(html: str) -> None:
    """
    Fire-and-forget: DM `html` (Telegram HTML parse mode) to every
    private BotChat whose linked_profile is a manager/team_lead.

    Runs in a background thread so signal-handling doesn't block the
    caller's transaction commit. Errors are swallowed and logged — a
    failed DM must never propagate up and break the sale reject flow.
    """
    Thread(target=_run_broadcast, args=(html,), daemon=True).start()


def _run_broadcast(html: str) -> None:
    try:
        asyncio.run(_broadcast_to_managers(html))
    except Exception:
        log.exception("manager broadcast failed")


async def _broadcast_to_managers(html: str) -> None:
    from asgiref.sync import sync_to_async
    from django.conf import settings

    from .models import BotChat

    token = getattr(settings, "TELEGRAM_BOT_TOKEN", "") or ""
    if not token:
        return

    def _load_chat_ids() -> list[int]:
        return list(
            BotChat.objects.filter(
                is_active=True,
                kind="private",
                linked_profile__role__in=("manager", "team_lead"),
            ).values_list("chat_id", flat=True)
        )

    chat_ids = await sync_to_async(_load_chat_ids)()
    if not chat_ids:
        return

    try:
        from aiogram import Bot
        from aiogram.client.default import DefaultBotProperties
        from aiogram.exceptions import TelegramForbiddenError
    except ImportError:
        return

    bot = Bot(token=token, default=DefaultBotProperties(parse_mode="HTML"))
    try:
        for cid in chat_ids:
            try:
                await bot.send_message(cid, html, disable_web_page_preview=True)
            except TelegramForbiddenError:
                continue
            except Exception:
                log.exception("manager DM failed chat=%s", cid)
    finally:
        try:
            await bot.session.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Sale rejection → manager alert
# ---------------------------------------------------------------------------


# Tracks the pre-save status so we can compare in post_save. Django doesn't
# hand you the previous value out of the box; the alternative is a
# pre_save handler which is more code for the same effect. We piggy-back
# on the pending→rejected transition detection by checking `_prev_status`
# set in a pre_save receiver just below.
_STATUS_CACHE_ATTR = "_naff_prev_status"


@receiver(post_save, sender=Sale)
def _on_sale_saved(sender, instance: Sale, created: bool, **kwargs) -> None:
    """
    Detect PENDING → REJECTED transitions and DM every manager.

    Because reject flow goes through `sales.services.sale_reject`, which
    calls `sale.save()`, we can't distinguish the transition just from
    `instance.status == "rejected"` (any subsequent save also matches).
    We look at `instance._naff_notify_reject` set by the service as a
    one-shot marker — cheaper than diffing DB rows and doesn't require
    a pre_save handler.
    """
    if getattr(instance, "_naff_notify_reject", False):
        # Consume the flag so re-saves don't re-notify.
        instance._naff_notify_reject = False
        _notify_sale_rejected(instance)


def _notify_sale_rejected(sale: Sale) -> None:
    """Compose + fire the manager DM."""
    op_name = ""
    try:
        if sale.operator_id:
            from apps.operators.models import Operator

            op = Operator.objects.filter(pk=sale.operator_id).first()
            if op:
                op_name = op.full_name
    except Exception:
        pass

    def _fmt_uzs(n) -> str:
        try:
            return f"{int(n):,}".replace(",", " ")
        except Exception:
            return str(n)

    reason = (sale.rejection_reason or "").strip() or "—"
    lines = [
        "⛔ <b>Продажа отклонена</b>",
        f"#{sale.id} · {sale.phone_model}",
        f"IMEI: <code>{sale.imei}</code>",
        f"Сумма: <b>{_fmt_uzs(sale.amount)} сум</b>",
    ]
    if op_name:
        lines.append(f"Оператор: <b>{op_name}</b>")
    lines.append(f"Причина: {reason}")

    from django.conf import settings

    base = getattr(settings, "BOT_WEB_BASE_URL", "https://naff.flek.uz").rstrip("/")
    lines.append(f"\n{base}/sales/{sale.id}")

    notify_managers_async("\n".join(lines))
