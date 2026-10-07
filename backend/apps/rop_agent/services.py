"""
Services layer — the OODA loop glue.

HackSoft rule: all business writes live here. Management commands are
one-liners that call one of ``run_*`` entry points. Selectors handle reads,
services orchestrate (compose selector output + LLM + TG push + persistence).

Entry points:
- :func:`run_morning_briefing(*, dry_run=False)`
- :func:`run_midday_pulse(*, dry_run=False)`
- :func:`run_evening_wrap(*, dry_run=False)`
- :func:`run_reminder(stage, *, dry_run=False)`
- :func:`run_alert_check(*, dry_run=False)`
- :func:`run_weekly_scorecard(*, dry_run=False)`
- :func:`execute_pending_approval(approval_id, resolved_by_tg_user_id)`
- :func:`cleanup_expired_approvals()`
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Any

from django.conf import settings
from django.utils import timezone

from apps.rop_agent import alerts as alerts_mod
from apps.rop_agent import llm, selectors, telegram
from apps.rop_agent.models import (
    AlertLog,
    DailyBriefing,
    PendingApproval,
    ROPState,
)
from apps.rop_agent.prompts import (
    SYSTEM_PROMPT_ALERT,
    SYSTEM_PROMPT_BRIEFING,
    SYSTEM_PROMPT_EVENING,
    SYSTEM_PROMPT_PULSE,
    SYSTEM_PROMPT_REMINDER,
    SYSTEM_PROMPT_WEEKLY,
)

logger = logging.getLogger("apps.rop_agent.services")


def _dumps(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, default=str)


def _is_muted() -> bool:
    state = ROPState.get_solo()
    return bool(state.muted_until and state.muted_until > timezone.now())


# ---------------------------------------------------------------------------
# Morning briefing (07:00 Tashkent)
# ---------------------------------------------------------------------------
def run_morning_briefing(*, dry_run: bool = False, force: bool = False) -> dict[str, Any]:
    """
    Daily 07:00 briefing. Idempotent for the scheduler — the ``force=True``
    knob is only for on-demand owner commands (``/rop_brifing``) that need to
    re-generate for the day. When forced, the existing row for today is
    replaced in-place so there's never more than one briefing per date.
    """
    if not getattr(settings, "ROP_ENABLED", False):
        logger.info("ROP_ENABLED=False — skipping morning briefing")
        return {"skipped": "disabled"}
    if _is_muted() and not force:
        logger.info("ROP muted — skipping morning briefing")
        return {"skipped": "muted"}

    today = selectors.today_tz()
    if DailyBriefing.objects.filter(date=today).exists() and not dry_run and not force:
        logger.info("Morning briefing for %s already sent — skipping", today)
        return {"skipped": "already_sent"}

    kpi = selectors.morning_kpi_snapshot()
    recent_alerts = list(
        AlertLog.objects.filter(
            created_at__gte=timezone.now() - timedelta(hours=24)
        ).values("alert_type", "priority", "message_text")[:20]
    )

    payload = {"kpi": kpi, "recent_alerts": recent_alerts}
    result = llm.synthesize(
        SYSTEM_PROMPT_BRIEFING, _dumps(payload), channel="briefing", max_tokens=1200
    )
    text = result["text"]
    full = _render_briefing_header(kpi) + "\n\n" + text

    if dry_run:
        logger.info("DRY-RUN morning briefing (model=%s, in=%s, out=%s)",
                    result["model"], result["tokens_in"], result["tokens_out"])
        return {"dry_run": True, "preview": full[:500], "model": result["model"]}

    if force:
        DailyBriefing.objects.filter(date=today).delete()
    briefing = DailyBriefing.objects.create(
        date=today,
        kpi_snapshot=kpi,
        synthesis_text=text,
        top_priorities=[],
        model_used=result["model"],
        tokens_in=result["tokens_in"],
        tokens_out=result["tokens_out"],
    )
    kb = telegram.briefing_action_keyboard()
    msg_id = telegram.send_to_owner(full, reply_markup=kb)
    if msg_id:
        briefing.sent_at = timezone.now()
        briefing.tg_message_id = msg_id
        briefing.save(update_fields=["sent_at", "tg_message_id"])
    state = ROPState.get_solo()
    state.last_briefing_at = timezone.now()
    state.save(update_fields=["last_briefing_at", "updated_at"])
    return {"sent": True, "briefing_id": briefing.id, "tg_message_id": msg_id}


def _render_briefing_header(kpi: dict[str, Any]) -> str:
    y = kpi.get("yesterday", {})
    partner = (y.get("partner_split") or [])
    top = partner[0]["channel"] if partner else "—"
    header = (
        "🌅 <b>Xayrli tong!</b>\n"
        f"📅 {kpi.get('today_tashkent','—')}\n\n"
        "┌─ <b>KECHAGI NATIJA</b>\n"
        f"│ Leads: <b>{y.get('leads_created',0)}</b> | "
        f"Contact: <b>{y.get('leads_contacted',0)}</b> | "
        f"Sale: <b>{y.get('sales_count',0)}</b>\n"
        f"│ Conv: <b>{y.get('conv',0)*100:.1f}%</b> | "
        f"Revenue: <b>{y.get('sales_amount',0):,.0f} so'm</b>\n"
        f"│ Top partner: <b>{top}</b>\n"
        "└─"
    )
    return header


# ---------------------------------------------------------------------------
# Midday pulse (14:00 Tashkent)
# ---------------------------------------------------------------------------
def run_midday_pulse(*, dry_run: bool = False) -> dict[str, Any]:
    if not getattr(settings, "ROP_ENABLED", False):
        return {"skipped": "disabled"}
    if _is_muted():
        return {"skipped": "muted"}

    kpi = selectors.midday_kpi_snapshot()
    result = llm.synthesize(SYSTEM_PROMPT_PULSE, _dumps(kpi), channel="briefing", max_tokens=600)
    r = kpi.get("range", {})
    header = (
        "☀️ <b>Yarim kun hisoboti</b>\n"
        f"Leads: <b>{r.get('leads_created',0)}</b> | "
        f"Contact: <b>{r.get('leads_contacted',0)}</b> | "
        f"Sale: <b>{r.get('sales_count',0)}</b> | "
        f"Conv: <b>{r.get('conv',0)*100:.1f}%</b>\n"
    )
    full = header + "\n" + result["text"]

    if dry_run:
        return {"dry_run": True, "preview": full[:500]}

    msg_id = telegram.send_to_owner(full)
    state = ROPState.get_solo()
    state.last_pulse_at = timezone.now()
    state.save(update_fields=["last_pulse_at", "updated_at"])
    return {"sent": True, "tg_message_id": msg_id}


# ---------------------------------------------------------------------------
# Evening wrap (21:00 Tashkent)
# ---------------------------------------------------------------------------
def run_evening_wrap(*, dry_run: bool = False) -> dict[str, Any]:
    if not getattr(settings, "ROP_ENABLED", False):
        return {"skipped": "disabled"}
    if _is_muted():
        return {"skipped": "muted"}

    kpi = selectors.evening_kpi_snapshot()
    result = llm.synthesize(SYSTEM_PROMPT_EVENING, _dumps(kpi), channel="briefing", max_tokens=900)
    t = kpi.get("today", {})
    header = (
        "🌙 <b>Kun yakuni</b>\n"
        f"Leads: <b>{t.get('leads_created',0)}</b> | "
        f"Contact: <b>{t.get('leads_contacted',0)}</b> | "
        f"Sale: <b>{t.get('sales_count',0)}</b> | "
        f"Revenue: <b>{t.get('sales_amount',0):,.0f} so'm</b>\n"
    )
    full = header + "\n" + result["text"]

    if dry_run:
        return {"dry_run": True, "preview": full[:500]}

    msg_id = telegram.send_to_owner(full)
    state = ROPState.get_solo()
    state.last_evening_at = timezone.now()
    state.save(update_fields=["last_evening_at", "updated_at"])
    return {"sent": True, "tg_message_id": msg_id}


# ---------------------------------------------------------------------------
# Reminder (11 / 15 / 19 Tashkent)
# ---------------------------------------------------------------------------
def run_reminder(stage: str, *, dry_run: bool = False) -> dict[str, Any]:
    if not getattr(settings, "ROP_ENABLED", False):
        return {"skipped": "disabled"}
    if _is_muted():
        return {"skipped": "muted"}

    kpi = selectors.midday_kpi_snapshot()
    today = selectors.today_tz()
    briefing = DailyBriefing.objects.filter(date=today).first()
    payload = {
        "stage": stage,
        "kpi": kpi,
        "morning_priorities": briefing.top_priorities if briefing else [],
    }
    result = llm.synthesize(SYSTEM_PROMPT_REMINDER, _dumps(payload),
                            channel="briefing", max_tokens=400)
    header = f"⏰ <b>Soat {stage}:00 pulse</b>\n"
    full = header + "\n" + result["text"]
    if dry_run:
        return {"dry_run": True, "preview": full[:500]}
    msg_id = telegram.send_to_owner(full)
    return {"sent": True, "tg_message_id": msg_id, "stage": stage}


# ---------------------------------------------------------------------------
# Alerts (every 10 min)
# ---------------------------------------------------------------------------
def run_alert_check(*, dry_run: bool = False) -> dict[str, Any]:
    if not getattr(settings, "ROP_ENABLED", False):
        return {"skipped": "disabled"}

    new_alerts = alerts_mod.run_all_alerts(persist=not dry_run)
    pushed = 0
    if _is_muted():
        # Still persist so history is complete, but suppress TG push unless RED.
        allow_push = False
    else:
        allow_push = True

    for a in new_alerts:
        if dry_run:
            continue
        # Only RED and INFO (celebrations) break through mute.
        if not allow_push and a["priority"] not in ("red", "info"):
            continue
        msg_id = telegram.send_to_owner(a["message_text"])
        if msg_id and a.get("alert_log_id"):
            AlertLog.objects.filter(id=a["alert_log_id"]).update(tg_message_id=msg_id)
            pushed += 1

    return {"found": len(new_alerts), "pushed": pushed, "dry_run": dry_run}


# ---------------------------------------------------------------------------
# Weekly scorecard (Sun 09:00)
# ---------------------------------------------------------------------------
def run_weekly_scorecard(*, dry_run: bool = False) -> dict[str, Any]:
    if not getattr(settings, "ROP_ENABLED", False):
        return {"skipped": "disabled"}
    if _is_muted():
        return {"skipped": "muted"}

    kpi = selectors.weekly_kpi_snapshot()
    result = llm.synthesize(SYSTEM_PROMPT_WEEKLY, _dumps(kpi), channel="weekly", max_tokens=2000)
    header = (
        "📊 <b>Haftalik scorecard</b>\n"
        f"📅 Hafta: {kpi.get('today_tashkent','—')}\n"
    )
    full = header + "\n" + result["text"]
    if dry_run:
        return {"dry_run": True, "preview": full[:800]}
    msg_id = telegram.send_to_owner(full)
    state = ROPState.get_solo()
    state.last_weekly_at = timezone.now()
    state.save(update_fields=["last_weekly_at", "updated_at"])
    return {"sent": True, "tg_message_id": msg_id}


# ---------------------------------------------------------------------------
# Approval flow
# ---------------------------------------------------------------------------
def create_pending_approval(
    *,
    action_type: str,
    action_payload: dict[str, Any],
    description: str,
    ttl_hours: int = 24,
) -> PendingApproval | None:
    """
    Create a PendingApproval + send TG with inline keyboard.
    In demo (ROP_APPROVAL_REQUIRED=False) returns None and the caller must
    execute the action immediately itself.
    """
    if not getattr(settings, "ROP_APPROVAL_REQUIRED", True):
        return None
    pa = PendingApproval.objects.create(
        action_type=action_type,
        action_payload=action_payload,
        description=description,
        expires_at=timezone.now() + timedelta(hours=ttl_hours),
    )
    kb = telegram.approval_keyboard(pa.id)
    text = f"❓ <b>Tasdiq so'raladi</b>\n{description}"
    msg_id = telegram.send_to_owner(text, reply_markup=kb)
    if msg_id:
        pa.tg_message_id = msg_id
        pa.save(update_fields=["tg_message_id"])
    return pa


def execute_pending_approval(
    approval_id: int, *, resolved_by_tg_user_id: int | None = None
) -> dict[str, Any]:
    """
    Called by the aiogram callback_query handler after owner clicks ✅.
    MVP: only logs the resolution — concrete action handlers are added in V2
    (write-actions aren't shipped in MVP yet).
    """
    try:
        pa = PendingApproval.objects.get(id=approval_id)
    except PendingApproval.DoesNotExist:
        return {"ok": False, "error": "not_found"}
    if pa.status != PendingApproval.Status.PENDING:
        return {"ok": False, "error": f"already {pa.status}"}
    if pa.expires_at < timezone.now():
        pa.status = PendingApproval.Status.EXPIRED
        pa.resolved_at = timezone.now()
        pa.save(update_fields=["status", "resolved_at"])
        return {"ok": False, "error": "expired"}

    pa.status = PendingApproval.Status.APPROVED
    pa.resolved_at = timezone.now()
    pa.resolved_by_tg_user_id = resolved_by_tg_user_id
    pa.result_text = (
        f"[MVP stub] {pa.action_type} would run with payload: {pa.action_payload}"
    )
    pa.save(update_fields=[
        "status", "resolved_at", "resolved_by_tg_user_id", "result_text"
    ])
    logger.info("Approved: %s (payload=%s)", pa.action_type, pa.action_payload)
    # TODO(V2): dispatch per action_type to the real handler
    return {"ok": True, "action_type": pa.action_type}


def reject_pending_approval(
    approval_id: int, *, resolved_by_tg_user_id: int | None = None
) -> dict[str, Any]:
    try:
        pa = PendingApproval.objects.get(id=approval_id)
    except PendingApproval.DoesNotExist:
        return {"ok": False, "error": "not_found"}
    if pa.status != PendingApproval.Status.PENDING:
        return {"ok": False, "error": f"already {pa.status}"}
    pa.status = PendingApproval.Status.REJECTED
    pa.resolved_at = timezone.now()
    pa.resolved_by_tg_user_id = resolved_by_tg_user_id
    pa.save(update_fields=["status", "resolved_at", "resolved_by_tg_user_id"])
    return {"ok": True}


def cleanup_expired_approvals() -> int:
    now = timezone.now()
    rows = PendingApproval.objects.filter(
        status=PendingApproval.Status.PENDING, expires_at__lt=now
    )
    cnt = rows.update(status=PendingApproval.Status.EXPIRED, resolved_at=now)
    return cnt


# ---------------------------------------------------------------------------
# Mute (/stop_agent handler can wire into this)
# ---------------------------------------------------------------------------
def mute(duration: timedelta | None = None) -> datetime:
    state = ROPState.get_solo()
    state.muted_until = timezone.now() + (duration or timedelta(hours=2))
    state.save(update_fields=["muted_until", "updated_at"])
    return state.muted_until


def unmute() -> None:
    state = ROPState.get_solo()
    state.muted_until = None
    state.save(update_fields=["muted_until", "updated_at"])
