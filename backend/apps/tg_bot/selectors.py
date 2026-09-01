"""
Selectors for tg_bot models (HackSoft pattern).
"""

from __future__ import annotations

import html
from datetime import UTC

from django.db.models import QuerySet

from .models import BotSubscription


def subscriptions_ready_for_dm() -> QuerySet[BotSubscription]:
    """Return subscriptions active and not blocked by user."""
    return BotSubscription.objects.filter(is_active=True, blocked_at__isnull=True)


def bot_broadcast_recipients() -> QuerySet[BotSubscription]:
    """
    Return subscriptions cleared to receive manager broadcasts
    (3-hour leaderboard, daily digest, etc.).

    Filter is 3-legged so a manager can pause a chat WITHOUT losing the
    linked_operator/phone metadata:
      1) `is_active=True`   — /subscribe not undone by /unsubscribe;
      2) `blocked_at__isnull=True` — user didn't block the bot itself;
      3) `receives_broadcasts=True` — manager toggle in the UI.

    Both blanket-subscribers (a manager subscribes via /subscribe → we
    then flip broadcasts on for them in the UI) and phone-linked
    subscribers (operator sent contact via /start → manager may opt them
    IN or leave off) pass through the same gate.
    """
    return BotSubscription.objects.filter(
        is_active=True,
        blocked_at__isnull=True,
        receives_broadcasts=True,
    )


def bot_subscribers_all() -> QuerySet[BotSubscription]:
    """
    All bot subscribers regardless of is_active / broadcast state — used
    by the manager UI which needs to show inactive/blocked rows so the
    manager can re-invite them or verify why messages aren't going out.
    """
    return BotSubscription.objects.select_related(
        "linked_operator", "linked_profile__user"
    ).all()


# ---- /whyauto command diagnostics ----------------------------------------


def _fmt_status_ru(code: str) -> str:
    """Best-effort human label for status code — избегаем extra SQL, если lookup невозможен."""
    from apps.leads.models import LeadStatusLabel

    label = LeadStatusLabel.objects.filter(code=code).values_list("label_ru", flat=True).first()
    return label or code


def render_diagnose_report(diag: dict) -> str:
    """
    Приводим машинный вердикт `diagnose_operator_assignment()` к
    HTML-строке для Telegram (parse_mode="HTML"). Аккуратно экранируем
    имена — операторские полные имена могут содержать неожиданные
    символы (кавычки, скобки, эмодзи).

    Форма:
        <b>Оператор Muxlisa · id=33</b>
        <b>Итог:</b> Квота 42/5 — не разгребает старые лиды
        <blockquote>объяснение почему</blockquote>
        <b>Что делать:</b> …

        <i>Счётчики</i>
        working=42/5   пул=0   backlog=0
        callbacks=0   gate=OFF

        <i>За 24ч пришло</i>
        morning_split=21, admin_reassign=11

        <i>Топ старых лидов на плечах</i>
        1. Ali Valiyev  +99890…  SMS отправлен  · 2ч назад
        2. …
    """
    op = diag.get("operator") or {}
    name = html.escape(op.get("full_name") or "?")
    op_id = op.get("id") or "?"
    op_status = op.get("status") or "?"

    title = html.escape(diag.get("verdict_title_ru") or "")
    body = html.escape(diag.get("verdict_body_ru") or "")
    action = html.escape(diag.get("next_action_ru") or "")
    verdict = diag.get("verdict") or "?"

    counters = diag.get("counters") or {}
    working = counters.get("working", 0)
    quota = counters.get("quota", 0)
    pool = counters.get("pool_size", 0)
    backlog = counters.get("backlog_blocking_leads", 0)
    callbacks = counters.get("open_callbacks", 0)
    gate_active = counters.get("gate_active", False)
    op_gate_flag = counters.get("operator_gate_flag", False)
    global_gate = counters.get("global_gate_on", False)

    recent = diag.get("recent_assignments") or {}
    recent_line = (
        ", ".join(f"{html.escape(k)}={v}" for k, v in sorted(recent.items()))
        if recent
        else "—"
    )

    lines: list[str] = []
    lines.append(f"<b>Оператор {name} · id={op_id} · {html.escape(op_status)}</b>")
    lines.append("")
    lines.append(f"<b>Итог:</b> {title}")
    if body:
        lines.append(f"<blockquote>{body}</blockquote>")
    if action:
        lines.append(f"<b>Что делать:</b> {action}")
    lines.append("")
    lines.append("<i>Счётчики</i>")
    lines.append(
        f"working={working}/{quota}   пул={pool}   backlog={backlog}   callbacks={callbacks}"
    )
    gate_txt = (
        f"gate: global={'ON' if global_gate else 'OFF'} "
        f"op_flag={'ON' if op_gate_flag else 'OFF'} "
        f"effective={'ON' if gate_active else 'OFF'}"
    )
    lines.append(gate_txt)
    lines.append("")
    lines.append("<i>За 24ч пришло автора</i>")
    lines.append(recent_line)

    # Топ старых лидов — показываем только если вердикт про квоту / гейт.
    blocking = diag.get("blocking_leads") or []
    if blocking and verdict in {"quota_full", "morning_gate_backlog"}:
        lines.append("")
        lines.append("<i>Топ старых лидов на плечах</i>")
        from datetime import datetime

        now = datetime.now(UTC)
        for idx, lead in enumerate(blocking[:5], start=1):
            fn = html.escape(lead.get("full_name") or "?")
            phone = html.escape(lead.get("phone") or "—")
            status = html.escape(_fmt_status_ru(lead.get("status") or ""))
            updated = lead.get("updated_at")
            ago = ""
            if updated:
                try:
                    dt_iso = datetime.fromisoformat(updated)
                    minutes = int((now - dt_iso).total_seconds() // 60)
                    if minutes < 60:
                        ago = f" · {minutes}м назад"
                    elif minutes < 24 * 60:
                        ago = f" · {minutes // 60}ч назад"
                    else:
                        ago = f" · {minutes // (60 * 24)}д назад"
                except Exception:
                    ago = ""
            lines.append(f"{idx}. {fn} · {phone} · {status}{ago}")

    return "\n".join(lines)
