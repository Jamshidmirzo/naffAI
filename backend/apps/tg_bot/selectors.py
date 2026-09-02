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


# ---- Ops-agent renderers (assignment summary / per-op / health / logs) ----
#
# Все четыре — thin HTML-рендер поверх готовых dict'ов. Никакого ORM
# внутри. Bот вызывает соответствующий селектор в asyncio.to_thread(),
# полученный dict сериализуется этой функцией. Полное HTML-эскейпирование
# всего пользовательского контента (имена операторов, docker container
# statuses могут содержать что угодно).


_SOURCE_LABELS_RU = {
    "morning_split": "утро",
    "auto_refill": "долив",
    "auto_round_robin": "RR",
    "admin_reassign": "админ",
    "qimmatlik_retry": "retry",
    "sheet_manual": "лист",
}


def render_assignment_summary(rows: list[dict], target_date) -> str:
    """
    «/whogot» — таблица кто сколько получил за день + разбивка по source.

    Пустой список → «за сегодня никому ничего не пришло». Активные
    операторы с total=0 остаются в списке — менеджеру важно видеть
    «Мухлиса: 0 (квота 5/5 забита)».
    """
    if not rows:
        return (
            f"📊 <b>Раздача за {target_date}</b>\n\n"
            "За этот день никому не пришло ни одного лида — либо пул был "
            "пуст, либо автораздача выключена."
        )

    lines: list[str] = [f"📊 <b>Раздача лидов · {target_date}</b>", ""]
    total_all = sum(r.get("total", 0) for r in rows)
    lines.append(f"<i>Всего роздано за день: {total_all}</i>")
    lines.append("")

    for r in rows:
        name = html.escape(r.get("full_name") or "?")
        op_id = r.get("operator_id")
        total = r.get("total", 0)
        working = r.get("working_count")
        quota = r.get("quota", 0)
        status = r.get("status") or "?"
        by_src = r.get("by_source") or {}

        # Первая строка — имя + total + квота-марка
        badge = ""
        if status != "active":
            badge = " <i>(inactive)</i>"
        elif working is not None and quota and working >= quota:
            badge = " ⛔ <i>квота</i>"
        elif working is not None and quota and total == 0:
            badge = " 💤 <i>idle</i>"

        line = f"<b>{name}</b> · id={op_id} → <b>{total}</b>"
        if working is not None:
            line += f" · сейчас {working}/{quota}"
        line += badge
        lines.append(line)

        if by_src:
            parts = []
            for src, n in sorted(by_src.items(), key=lambda kv: -kv[1]):
                label = _SOURCE_LABELS_RU.get(src, src)
                parts.append(f"{html.escape(label)}={n}")
            lines.append("  " + ", ".join(parts))

    return "\n".join(lines)


def render_operator_assignments(
    operator_name: str, rows: list[dict], target_date
) -> str:
    """
    «/whogot <оператор>» — хронология выдач оператору за день.
    Компактно: время, source, лид (имя+телефон), статус.
    """
    name = html.escape(operator_name or "?")
    header = f"👤 <b>{name} · раздача {target_date}</b>"
    if not rows:
        return (
            f"{header}\n\n"
            "За этот день оператору не пришло ни одного лида "
            "автоматически. Проверь через /whyauto — возможно, квота "
            "или гейт."
        )

    lines: list[str] = [header, "", f"<i>Всего: {len(rows)} лид(ов)</i>", ""]
    from datetime import datetime

    for idx, r in enumerate(rows, start=1):
        src_label = _SOURCE_LABELS_RU.get(r.get("source") or "", r.get("source") or "?")
        lead_name = html.escape((r.get("lead_name") or "?")[:32])
        lead_phone = html.escape(r.get("lead_phone") or "—")
        lead_status = html.escape(r.get("lead_status") or "?")
        created = r.get("created_at") or ""
        time_str = ""
        if created:
            try:
                dt_iso = datetime.fromisoformat(created)
                time_str = dt_iso.strftime("%H:%M")
            except Exception:
                time_str = ""
        lines.append(
            f"{idx}. <code>{time_str or '?'}</code> · <i>{html.escape(src_label)}</i> · "
            f"<b>{lead_name}</b> · {lead_phone} · {lead_status}"
        )
    return "\n".join(lines)


def render_health(
    containers: list[dict],
    *,
    last_assignment_at=None,
    pool_size: int | None = None,
) -> str:
    """
    «/health» — таблица контейнеров + heartbeat раздачи + размер пула.

    containers: list of dicts from `crash_snapshot()` (name/state/status/
    restart_count/oom_killed).
    """
    if not containers:
        return (
            "❌ <b>Docker недоступен</b>\n\n"
            "Бот не смог достучаться до docker-proxy. Проверь, что "
            "сервис <code>docker-proxy</code> поднят и в одной сети "
            "с ботом (переменная <code>DOCKER_PROXY_URL</code>)."
        )

    up = [c for c in containers if c.get("state") == "running"]
    down = [c for c in containers if c.get("state") != "running"]
    restarted = [c for c in containers if c.get("restart_count", 0) > 0]
    oomed = [c for c in containers if c.get("oom_killed")]

    lines: list[str] = ["🩺 <b>Здоровье системы</b>", ""]
    lines.append(
        f"Контейнеров: <b>{len(containers)}</b> · Up: <b>{len(up)}</b>"
        f" · Down: <b>{len(down)}</b>"
    )
    if restarted:
        names = ", ".join(html.escape(c["name"]) for c in restarted)
        lines.append(f"Перезапуски: {names}")
    if oomed:
        names = ", ".join(html.escape(c["name"]) for c in oomed)
        lines.append(f"⚠️ OOM: {names}")

    # Heartbeat раздачи
    if last_assignment_at is not None:
        from datetime import datetime

        try:
            if hasattr(last_assignment_at, "isoformat"):
                ago_dt = last_assignment_at
            else:
                ago_dt = datetime.fromisoformat(str(last_assignment_at))
            now = datetime.now(ago_dt.tzinfo) if ago_dt.tzinfo else datetime.now()
            minutes = int((now - ago_dt).total_seconds() // 60)
            if minutes < 60:
                heartbeat = f"{minutes}м назад"
            elif minutes < 24 * 60:
                heartbeat = f"{minutes // 60}ч назад"
            else:
                heartbeat = f"{minutes // (60 * 24)}д назад"
            lines.append(f"Последняя авто-раздача: <b>{heartbeat}</b>")
        except Exception:
            pass
    if pool_size is not None:
        lines.append(f"Свободных лидов в пуле: <b>{pool_size}</b>")

    lines.append("")
    lines.append("<i>Контейнеры:</i>")
    # Сортируем: сначала не-running, потом с restarts, потом остальные.
    containers_sorted = sorted(
        containers,
        key=lambda c: (
            0 if c.get("state") != "running" else 1,
            -c.get("restart_count", 0),
            c.get("name", ""),
        ),
    )
    for c in containers_sorted:
        name = html.escape(c.get("name") or "?")
        state = c.get("state") or "?"
        status = html.escape((c.get("status") or "?")[:40])
        rc = c.get("restart_count", 0)
        oom = c.get("oom_killed")
        mark = "✅" if state == "running" else "❌"
        rc_str = f" · restarts={rc}" if rc else ""
        oom_str = " · <b>OOM</b>" if oom else ""
        lines.append(f"{mark} <code>{name}</code> · {status}{rc_str}{oom_str}")
    return "\n".join(lines)


def render_logs_tail(service: str, lines_out: list[str], error: str = "") -> str:
    """
    «/logs <service>» — хвост логов. Разбиваем на чанки по 3800 символов,
    чтобы уложиться в Telegram лимит 4096 (+запас на HTML-обвязку).
    В runner.py уже дальше делится, если нужно.
    """
    header = f"📜 <b>Логи · {html.escape(service or '?')}</b>"
    if error:
        return f"{header}\n\n{html.escape(error)}"
    if not lines_out:
        return f"{header}\n\n<i>(пусто)</i>"

    body = "\n".join(html.escape(ln) for ln in lines_out)
    return f"{header}\n\n<pre>{body}</pre>"


def chunk_html_for_telegram(text: str, chunk_size: int = 3800) -> list[str]:
    """
    Aiogram fails if we send >4096 chars per message. Мы предпочитаем
    резать по \n, чтобы не рвать HTML-теги посреди строки.

    Простая эвристика: если у нас `<pre>...</pre>` — режем внутри pre и
    закрываем/открываем тег в каждом чанке. Иначе — обычная нарезка.
    """
    if len(text) <= chunk_size:
        return [text]

    # Быстрый путь без <pre>: разбиваем по \n.
    if "<pre>" not in text:
        chunks: list[str] = []
        buf = ""
        for line in text.split("\n"):
            if len(buf) + len(line) + 1 > chunk_size and buf:
                chunks.append(buf)
                buf = line
            else:
                buf = (buf + "\n" + line) if buf else line
        if buf:
            chunks.append(buf)
        return chunks

    # <pre>...</pre> случай: держим прелюдию + переоткрываем pre в каждом чанке.
    pre_start = text.find("<pre>")
    pre_end = text.rfind("</pre>")
    prelude = text[:pre_start]
    body = text[pre_start + len("<pre>") : pre_end]
    postlude = text[pre_end + len("</pre>") :]

    chunks: list[str] = []
    buf_lines: list[str] = []
    for line in body.split("\n"):
        candidate = "\n".join([*buf_lines, line])
        overhead = len(prelude) + len("<pre></pre>") + len(postlude)
        if len(candidate) + overhead > chunk_size and buf_lines:
            body_out = "\n".join(buf_lines)
            chunks.append(f"{prelude}<pre>{body_out}</pre>{postlude}")
            buf_lines = [line]
            # На следующих чанках префикс/суффикс не дублируем.
            prelude = ""
            postlude = ""
        else:
            buf_lines.append(line)
    if buf_lines:
        body_out = "\n".join(buf_lines)
        chunks.append(f"{prelude}<pre>{body_out}</pre>{postlude}")
    return chunks
