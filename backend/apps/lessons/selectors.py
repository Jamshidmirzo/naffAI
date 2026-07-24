from __future__ import annotations

import datetime as dt
from collections import Counter
from decimal import Decimal

from django.utils import timezone

from apps.operators.models import Operator, OperatorMonthlyPlan
from apps.sales.selectors import operator_sales_aggregate
from apps.tg_userclient.models import TgChat, TgMessage, TgAiInsight
from apps.calls.models import CallbackReminder, CallbackReminderStatus
from apps.leads.models import Lead, LeadStatus


def collect_yesterday_facts(operator: Operator, date: dt.date) -> dict:
    """Collect all facts, stats, and dialog excerpts for LLM daily lessons."""
    tz = timezone.get_current_timezone()
    start_dt = dt.datetime.combine(date, dt.time.min, tzinfo=tz)
    end_dt = dt.datetime.combine(date, dt.time.max, tzinfo=tz)

    # 1. Sales Yesterday and 30d baseline
    date_from_30d = date - dt.timedelta(days=30)
    date_to_30d = date - dt.timedelta(days=1)
    start_30d = dt.datetime.combine(date_from_30d, dt.time.min, tzinfo=tz)
    end_30d = dt.datetime.combine(date_to_30d, dt.time.max, tzinfo=tz)

    agg_30d = operator_sales_aggregate(operator_id=operator.id, date_from=start_30d, date_to=end_30d)
    avg_revenue_30d = agg_30d["total"] / Decimal("30")
    avg_count_30d = agg_30d["count"] / Decimal("30")

    yesterday_agg = operator_sales_aggregate(operator_id=operator.id, date_from=start_dt, date_to=end_dt)
    yesterday_revenue = yesterday_agg["total"]
    yesterday_count = yesterday_agg["count"]

    avg_check = yesterday_revenue / yesterday_count if yesterday_count > 0 else Decimal("0")
    delta_revenue = yesterday_revenue - avg_revenue_30d
    delta_count = yesterday_count - avg_count_30d

    # Brand mix count
    from apps.sales.models import SaleOperator
    sales_yesterday = SaleOperator.objects.filter(
        operator_id=operator.id,
        sale__sold_at__gte=start_dt,
        sale__sold_at__lte=end_dt,
        sale__is_returned=False,
        sale__is_deleted=False,
        sale__status="confirmed",
    ).select_related("sale")

    brand_mix = {}
    for so in sales_yesterday:
        model = so.sale.phone_model
        brand_mix[model] = brand_mix.get(model, 0) + 1

    # 2. Dialogs
    chat_ids_yesterday = TgMessage.objects.filter(
        chat__session__operator=operator,
        sent_at__gte=start_dt,
        sent_at__lte=end_dt,
    ).values_list("chat_id", flat=True).distinct()

    dialogs_count = len(chat_ids_yesterday)

    insights_yesterday = TgAiInsight.objects.filter(
        session__operator=operator,
        until__gte=start_dt,
        until__lte=end_dt,
    )
    quality_scores = [ins.quality_score for ins in insights_yesterday if ins.quality_score is not None]
    avg_quality = sum(quality_scores) / len(quality_scores) if quality_scores else 0.0

    all_red_flags = []
    all_highlights = []
    for ins in insights_yesterday:
        if isinstance(ins.red_flags, list):
            all_red_flags.extend(ins.red_flags)
        if isinstance(ins.highlights, list):
            all_highlights.extend(ins.highlights)

    top_3_red_flags = [item for item, _ in Counter(all_red_flags).most_common(3)]
    top_3_highlights = [item for item, _ in Counter(all_highlights).most_common(3)]

    # 3. Callbacks
    callbacks_yesterday = CallbackReminder.objects.filter(
        operator=operator,
        remind_at__gte=start_dt,
        remind_at__lte=end_dt,
    )
    callbacks_missed = callbacks_yesterday.filter(status=CallbackReminderStatus.OVERDUE).count()
    callbacks_on_time = callbacks_yesterday.filter(status=CallbackReminderStatus.DONE).count()

    done_callbacks = callbacks_yesterday.filter(done_at__isnull=False)
    delays = []
    for cb in done_callbacks:
        delay = (cb.done_at - cb.remind_at).total_seconds() / 60.0
        delays.append(max(0.0, delay))
    avg_delay_min = sum(delays) / len(delays) if delays else 0.0

    # 4. Leads
    won_leads = Lead.objects.filter(
        operator=operator,
        status=LeadStatus.WON,
        updated_at__gte=start_dt,
        updated_at__lte=end_dt,
    ).count()

    lost_leads = Lead.objects.filter(
        operator=operator,
        status=LeadStatus.LOST,
        updated_at__gte=start_dt,
        updated_at__lte=end_dt,
    ).count()

    stalled_leads = Lead.objects.filter(
        operator=operator,
        updated_at__lt=start_dt - dt.timedelta(hours=24),
    ).exclude(status__in=[LeadStatus.WON, LeadStatus.LOST, LeadStatus.ARCHIVED]).count()

    # 5. Context
    plan_year = date.year
    plan_month = date.month
    monthly_plan = OperatorMonthlyPlan.objects.filter(
        operator=operator,
        year=plan_year,
        month=plan_month,
    ).first()
    threshold = monthly_plan.target_amount if monthly_plan else Decimal("50000000")

    start_month = dt.datetime(plan_year, plan_month, 1, 0, 0, 0, tzinfo=tz)
    month_agg = operator_sales_aggregate(operator_id=operator.id, date_from=start_month, date_to=end_dt)
    month_total = month_agg["total"]
    month_progress_pct = float(month_total) / float(threshold) * 100.0 if threshold else 0.0

    import calendar
    last_day_of_month = calendar.monthrange(plan_year, plan_month)[1]
    days_to_threshold = last_day_of_month - date.day
    personal_baseline_30d = agg_30d["total"]

    # 6. Chat Examples
    chats_active = TgChat.objects.filter(id__in=chat_ids_yesterday)[:5]
    chat_examples = []
    for chat in chats_active:
        msgs = TgMessage.objects.filter(
            chat=chat,
            sent_at__gte=start_dt,
            sent_at__lte=end_dt,
        ).order_by("sent_at")[:10]

        lines = []
        for m in msgs:
            role_label = "Клиент" if m.direction == "in" else "Оператор"
            lines.append(f"{role_label}: {m.text}")
        excerpt = "\n".join(lines)

        insight = TgAiInsight.objects.filter(
            chat=chat,
            until__gte=start_dt,
            until__lte=end_dt,
        ).first()
        issue = ""
        if insight and insight.red_flags:
            issue = insight.red_flags[0]
        elif insight and insight.summary:
            issue = insight.summary[:100]

        chat_examples.append({
            "chat": chat.title or chat.partner_name or "Без имени",
            "excerpt": excerpt,
            "issue": issue or "нет явных ошибок",
        })

    return {
        "sales": {
            "count": yesterday_count,
            "revenue": float(yesterday_revenue),
            "avg_check": float(avg_check),
            "brand_mix": brand_mix,
            "delta_revenue": float(delta_revenue),
            "delta_count": float(delta_count),
        },
        "dialogs": {
            "count": dialogs_count,
            "avg_quality_score": float(avg_quality),
            "top_3_red_flags": top_3_red_flags,
            "top_3_highlights": top_3_highlights,
        },
        "callbacks": {
            "missed": callbacks_missed,
            "on_time": callbacks_on_time,
            "avg_delay_min": avg_delay_min,
        },
        "leads": {
            "won": won_leads,
            "lost": lost_leads,
            "stalled": stalled_leads,
        },
        "context": {
            "month_progress_pct": min(month_progress_pct, 999.0),
            "days_to_threshold": max(0, days_to_threshold),
            "personal_baseline_30d": float(personal_baseline_30d),
        },
        "chat_examples": chat_examples,
    }
