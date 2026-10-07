"""
Alert triggers for the ROP agent.

Each ``check_*`` function returns a list of candidate alert dicts. The
orchestrator ``run_all_alerts`` runs every check, drops duplicates via
``AlertLog.dedup_key`` + the trigger's dedup window, persists survivors to
``AlertLog`` and returns the new rows for TG push.

Thresholds live at the top so they're easy to tune without reading the body.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Callable

from django.utils import timezone

from apps.rop_agent import selectors
from apps.rop_agent.models import AlertLog

logger = logging.getLogger("apps.rop_agent.alerts")


# ---------------------------------------------------------------------------
# Tunable thresholds (kept together on purpose)
# ---------------------------------------------------------------------------
QIMMATLI_LONG_WAIT_MINUTES = 120           # alert 1
LEADS_QUEUE_OVERFLOW_COUNT = 50            # alert 2
LEADS_QUEUE_OVERFLOW_MIN_WAIT = 30
OPERATOR_CONV_DROP_PP = -20.0              # alert 3
OPERATOR_CONV_MIN_CONTACTED = 10
FOLLOWUP_RATE_FLOOR = 0.75                 # alert 4
PARTNER_SHARE_SHIFT_PP = 15.0              # alert 5
BIG_SALE_AMOUNT = 15_000_000               # alert 6
BIG_SALE_WINDOW_MIN = 60
OPERATOR_SILENT_AFTER_HOUR = 11            # alert 7
MISSED_QIMMATLI_WINDOW_MIN = 30            # alert 8
CONV_SLUMP_DELTA_PP = -20.0                # alert 9
REMINDER_OVERDUE_SPIKE = 30                # alert 10


# ---------------------------------------------------------------------------
# Alert dict schema
# ---------------------------------------------------------------------------
@dataclass
class AlertCandidate:
    alert_type: str
    priority: str  # red / yellow / green / info
    dedup_key: str
    dedup_window_minutes: int
    payload: dict[str, Any]
    message_text: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "alert_type": self.alert_type,
            "priority": self.priority,
            "dedup_key": self.dedup_key,
            "dedup_window_minutes": self.dedup_window_minutes,
            "payload": self.payload,
            "message_text": self.message_text,
        }


def _candidate(**kwargs: Any) -> dict[str, Any]:
    return AlertCandidate(**kwargs).as_dict()


# ---------------------------------------------------------------------------
# 1 — qimmatli_long_wait
# ---------------------------------------------------------------------------
def check_qimmatli_long_wait() -> list[dict[str, Any]]:
    waiting = selectors.qimmatli_waiting_now(min_wait_minutes=QIMMATLI_LONG_WAIT_MINUTES)
    out = []
    for l in waiting:
        if l["wait_minutes"] < QIMMATLI_LONG_WAIT_MINUTES:
            continue
        out.append(
            _candidate(
                alert_type="qimmatli_long_wait",
                priority="red",
                dedup_key=f"lead:{l['lead_id']}",
                dedup_window_minutes=240,
                payload=l,
                message_text=(
                    f"🚨 <b>Qimmatli lead {l['wait_minutes']} daqiqadan beri kutmoqda</b>\n"
                    f"#{l['lead_id']} {l['full_name']} — operator: "
                    f"{l['operator_name'] or '—'}\n"
                    f"15 daqiqa ichida qo'ng'iroq qiling yoki boshqa operatorga bering."
                ),
            )
        )
    return out


# ---------------------------------------------------------------------------
# 2 — leads_queue_overflow
# ---------------------------------------------------------------------------
def check_leads_queue_overflow() -> list[dict[str, Any]]:
    cnt = selectors.leads_waiting_over(minutes=LEADS_QUEUE_OVERFLOW_MIN_WAIT)
    if cnt < LEADS_QUEUE_OVERFLOW_COUNT:
        return []
    return [
        _candidate(
            alert_type="leads_queue_overflow",
            priority="red",
            dedup_key="global",
            dedup_window_minutes=60,
            payload={"count": cnt, "min_wait": LEADS_QUEUE_OVERFLOW_MIN_WAIT},
            message_text=(
                f"🚨 <b>Lead navbati portladi: {cnt} ta lead "
                f"{LEADS_QUEUE_OVERFLOW_MIN_WAIT}+ daqiqa kutmoqda</b>\n"
                "Avtoraspredeleniyeni tekshiring, ehtimol operatorlar yetarli emas."
            ),
        )
    ]


# ---------------------------------------------------------------------------
# 3 — operator_conv_drop
# ---------------------------------------------------------------------------
def check_operator_conv_drop() -> list[dict[str, Any]]:
    out = []
    for row in selectors.per_operator_conv_7d():
        if row["this_contacted"] < OPERATOR_CONV_MIN_CONTACTED:
            continue
        if row["delta_pp"] > OPERATOR_CONV_DROP_PP:
            continue
        out.append(
            _candidate(
                alert_type="operator_conv_drop",
                priority="red",
                dedup_key=f"op:{row['operator_id']}",
                dedup_window_minutes=24 * 60,
                payload=row,
                message_text=(
                    f"🚨 <b>{row['operator_name']} — conv tushib ketdi "
                    f"({row['delta_pp']:+.1f}pp)</b>\n"
                    f"Shu hafta {row['this_conv']*100:.1f}% vs oldingi "
                    f"{row['prev_conv']*100:.1f}%. Coaching rejasini tuzing."
                ),
            )
        )
    return out


# ---------------------------------------------------------------------------
# 4 — followup_rate_low
# ---------------------------------------------------------------------------
def check_followup_rate_low() -> list[dict[str, Any]]:
    f = selectors.followup_rate_today()
    if f["total"] == 0 or f["rate"] >= FOLLOWUP_RATE_FLOOR:
        return []
    return [
        _candidate(
            alert_type="followup_rate_low",
            priority="yellow",
            dedup_key="daily",
            dedup_window_minutes=24 * 60,
            payload=f,
            message_text=(
                f"⚠️ <b>Followup rate past: {f['rate']*100:.0f}%</b>\n"
                f"Bugun {f['total']} ta reminder'dan {f['done']} ta bajarilgan, "
                f"{f['overdue']} ta kechikdi."
            ),
        )
    ]


# ---------------------------------------------------------------------------
# 5 — partner_share_shift
# ---------------------------------------------------------------------------
def check_partner_share_shift() -> list[dict[str, Any]]:
    out = []
    for row in selectors.partner_share_7d_vs_prev():
        if abs(row["delta_pp"]) < PARTNER_SHARE_SHIFT_PP:
            continue
        out.append(
            _candidate(
                alert_type="partner_share_shift",
                priority="yellow",
                dedup_key=f"ch:{row['channel']}",
                dedup_window_minutes=24 * 60,
                payload=row,
                message_text=(
                    f"⚠️ <b>Partner ulushi o'zgardi — {row['channel']} "
                    f"{row['delta_pp']:+.1f}pp</b>\n"
                    f"Hozir {row['this_pct']:.1f}%, oldin {row['prev_pct']:.1f}%."
                ),
            )
        )
    return out


# ---------------------------------------------------------------------------
# 6 — big_sale_celebrate
# ---------------------------------------------------------------------------
def check_big_sale_celebrate() -> list[dict[str, Any]]:
    out = []
    for s in selectors.big_sales_recent(
        min_amount=BIG_SALE_AMOUNT, window_minutes=BIG_SALE_WINDOW_MIN
    ):
        out.append(
            _candidate(
                alert_type="big_sale_celebrate",
                priority="info",
                dedup_key=f"sale:{s['sale_id']}",
                dedup_window_minutes=24 * 60,
                payload=s,
                message_text=(
                    f"💰 <b>Katta sotuv! {s['amount']:,.0f} so'm</b>\n"
                    f"{s['operator_name']} — {s['phone_model']}"
                ),
            )
        )
    return out


# ---------------------------------------------------------------------------
# 7 — operator_silent
# ---------------------------------------------------------------------------
def check_operator_silent() -> list[dict[str, Any]]:
    out = []
    for row in selectors.silent_operators_now(after_hour=OPERATOR_SILENT_AFTER_HOUR):
        out.append(
            _candidate(
                alert_type="operator_silent",
                priority="red",
                dedup_key=f"op:{row['operator_id']}",
                dedup_window_minutes=24 * 60,
                payload=row,
                message_text=(
                    f"🚨 <b>{row['operator_name']}</b> — bugun hali 0 ta qo'ng'iroq.\n"
                    f"Soat {OPERATOR_SILENT_AFTER_HOUR}:00 dan keyin ham sukut. Tekshiring."
                ),
            )
        )
    return out


# ---------------------------------------------------------------------------
# 8 — missed_qimmatli_call
# ---------------------------------------------------------------------------
def check_missed_qimmatli_call() -> list[dict[str, Any]]:
    out = []
    for c in selectors.missed_qimmatli_calls_recent(window_minutes=MISSED_QIMMATLI_WINDOW_MIN):
        out.append(
            _candidate(
                alert_type="missed_qimmatli_call",
                priority="red",
                dedup_key=f"lead:{c['lead_id']}",
                dedup_window_minutes=120,
                payload=c,
                message_text=(
                    f"🚨 <b>Qimmatli lead qo'ng'iroqni ko'tarmadi</b>\n"
                    f"#{c['lead_id']} {c['lead_name']} — "
                    f"operator: {c['operator_name'] or '—'}\n"
                    "15-30 daqiqadan keyin yana urinib ko'ring."
                ),
            )
        )
    return out


# ---------------------------------------------------------------------------
# 9 — conv_today_slump
# ---------------------------------------------------------------------------
def check_conv_today_slump() -> list[dict[str, Any]]:
    """
    today-so-far conv vs 7-day average. Compare percentage points.
    Only fires after 14:00 Tashkent so the morning noise doesn't trip it.
    """
    from zoneinfo import ZoneInfo
    now_tz = timezone.now().astimezone(ZoneInfo("Asia/Tashkent"))
    if now_tz.hour < 14:
        return []
    today = selectors.today_tz()
    today_start, _ = selectors.day_bounds(today)
    now = timezone.now()
    today_conv = selectors.conversion_rate(today_start, now)

    week_start, _ = selectors.day_bounds(today - timedelta(days=7))
    _, week_end = selectors.day_bounds(today - timedelta(days=1))
    week_conv = selectors.conversion_rate(week_start, week_end)

    delta_pp = (today_conv - week_conv) * 100.0
    if delta_pp > CONV_SLUMP_DELTA_PP:
        return []
    return [
        _candidate(
            alert_type="conv_today_slump",
            priority="red",
            dedup_key="daily",
            dedup_window_minutes=24 * 60,
            payload={
                "today_conv": today_conv,
                "week_conv": week_conv,
                "delta_pp": delta_pp,
            },
            message_text=(
                f"🚨 <b>Bugun conv tushgan — {delta_pp:+.1f}pp</b>\n"
                f"Hozir {today_conv*100:.1f}% vs 7-kun avg {week_conv*100:.1f}%."
            ),
        )
    ]


# ---------------------------------------------------------------------------
# 10 — reminder_overdue_spike
# ---------------------------------------------------------------------------
def check_reminder_overdue_spike() -> list[dict[str, Any]]:
    cnt = selectors.overdue_reminders_count_today()
    if cnt < REMINDER_OVERDUE_SPIKE:
        return []
    return [
        _candidate(
            alert_type="reminder_overdue_spike",
            priority="yellow",
            dedup_key="daily",
            dedup_window_minutes=4 * 60,
            payload={"overdue_count": cnt},
            message_text=(
                f"⚠️ <b>{cnt} ta followup reminder kechikdi</b>\n"
                "Operatorlar reminder'larni unutib qo'yishyapti."
            ),
        )
    ]


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------
ALL_CHECKS: list[tuple[str, Callable[[], list[dict[str, Any]]]]] = [
    ("qimmatli_long_wait", check_qimmatli_long_wait),
    ("leads_queue_overflow", check_leads_queue_overflow),
    ("operator_conv_drop", check_operator_conv_drop),
    ("followup_rate_low", check_followup_rate_low),
    ("partner_share_shift", check_partner_share_shift),
    ("big_sale_celebrate", check_big_sale_celebrate),
    ("operator_silent", check_operator_silent),
    ("missed_qimmatli_call", check_missed_qimmatli_call),
    ("conv_today_slump", check_conv_today_slump),
    ("reminder_overdue_spike", check_reminder_overdue_spike),
]


def _is_duplicate(alert_type: str, dedup_key: str, window_minutes: int) -> bool:
    since = timezone.now() - timedelta(minutes=window_minutes)
    return AlertLog.objects.filter(
        alert_type=alert_type,
        dedup_key=dedup_key,
        created_at__gte=since,
    ).exists()


def run_all_alerts(*, persist: bool = True) -> list[dict[str, Any]]:
    """
    Run every alert check, drop duplicates within each trigger's dedup window,
    persist survivors to ``AlertLog`` (unless ``persist=False``) and return
    the new candidates as plain dicts for the caller to TG-push.
    """
    new_alerts: list[dict[str, Any]] = []
    for name, fn in ALL_CHECKS:
        try:
            candidates = fn()
        except Exception:
            logger.exception("ROP alert check %s crashed", name)
            continue
        for c in candidates:
            if _is_duplicate(c["alert_type"], c["dedup_key"], c["dedup_window_minutes"]):
                continue
            if persist:
                row = AlertLog.objects.create(
                    alert_type=c["alert_type"],
                    priority=c["priority"],
                    dedup_key=c["dedup_key"],
                    payload=c["payload"],
                    message_text=c["message_text"],
                )
                c["alert_log_id"] = row.id
            new_alerts.append(c)
    return new_alerts
