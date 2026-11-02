"""
Кабинет SMM-специалиста (таргетолога): его лиды, продажи и реклама Meta.

Привязка: лид принадлежит SMM, если пришёл из его источника
(`SheetSource.smm` — Google-таблица или вебхук LeadPixel). Продажи SMM —
подтверждённые продажи по его лидам (+ продажи без лида, у которых
`Sale.sheet_source` — его источник). Склейка рекламы с CRM — по
`Lead.metadata["ad"]["ad_id"]` ↔ `MetaAdInsightDaily.ad_id`.

Когорта: «продажи периода» = продажи по лидам, созданным в периоде (как в
`analytics.selectors.marketing_source_breakdown`) — так цена лида, конверсия
и ROMI считаются по одним и тем же людям. Выручка нетто = amount − discount.
"""

from __future__ import annotations

import datetime as dt
from collections import defaultdict
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db.models import Q
from django.db.models.fields.json import KT
from django.utils import timezone

from apps.leads.models import Lead, LeadStatus, LeadStatusLabel, SheetSource
from apps.leads.selectors import exclude_system_lost
from apps.sales.models import Sale
from apps.users.models import Role

from .integrations.meta.fx import FxTable
from .models import MetaAd, MetaAdAccount, MetaAdInsightDaily

User = get_user_model()

NO_AD = "__none__"
_ZERO = Decimal("0")


# ---- scope ---------------------------------------------------------------


def smm_users_qs():
    return (
        User.objects.filter(profile__role=Role.SMM)
        .select_related("profile")
        .order_by("first_name", "last_name", "username")
    )


def smm_display_name(user) -> str:
    return user.get_full_name() or user.username


def smm_leads_q(smm_id: int) -> Q:
    """Единственное место, где решается «чей лид». Используют отчёты и права."""
    return Q(sheet_source__smm_id=smm_id)


def smm_sales_q(smm_id: int) -> Q:
    return Q(lead__sheet_source__smm_id=smm_id) | Q(
        lead__isnull=True, sheet_source__smm_id=smm_id
    )


def _confirmed_sales():
    return Sale.objects.filter(is_deleted=False, is_returned=False, status="confirmed")


def _dt_range(date_from: dt.date, date_to: dt.date) -> tuple[dt.datetime, dt.datetime]:
    tz = timezone.get_current_timezone()
    return (
        dt.datetime.combine(date_from, dt.time.min, tzinfo=tz),
        dt.datetime.combine(date_to, dt.time.max, tzinfo=tz),
    )


def _net(row: dict) -> Decimal:
    return Decimal(str(row.get("amount") or 0)) - Decimal(str(row.get("discount") or 0))


def _local_date(value: dt.datetime) -> dt.date:
    return timezone.localtime(value).date() if timezone.is_aware(value) else value.date()


# ---- metric math ---------------------------------------------------------


def _pct(num, den, nd: int = 2) -> float | None:
    if not den:
        return None
    return round(float(num) * 100.0 / float(den), nd)


def _div(num, den) -> Decimal | None:
    if not den:
        return None
    return Decimal(num) / Decimal(den)


def _s(v: Decimal | None, q: str = "0.01") -> str | None:
    if v is None:
        return None
    return str(v.quantize(Decimal(q)))


def _empty_bucket() -> dict:
    return {
        "spend": _ZERO,
        "spend_uzs": _ZERO,
        "spend_uzs_known": True,
        "impressions": 0,
        "reach": 0,
        "clicks": 0,
        "link_clicks": 0,
        "meta_leads": 0,
        "video_3s": 0,
        "thruplays": 0,
        "video_p25": 0,
        "video_p50": 0,
        "video_p75": 0,
        "video_p100": 0,
        "_watch_weighted": _ZERO,
        "crm_leads": 0,
        "converted": 0,
        "sales": 0,
        "revenue": _ZERO,
    }


def _finish(b: dict) -> dict:
    """Сырые суммы → метрики (строки для денег, float для процентов)."""
    spend, spend_uzs = b["spend"], b["spend_uzs"] if b["spend_uzs_known"] else None
    impressions = b["impressions"]
    has_spend = spend > 0
    out = {
        "spend": _s(spend),
        "spend_uzs": _s(spend_uzs, "1"),
        "impressions": impressions,
        "reach": b["reach"],
        "clicks": b["clicks"],
        "link_clicks": b["link_clicks"],
        "ctr": _pct(b["link_clicks"], impressions),
        "cpm": _s(_div(spend * 1000, impressions)) if has_spend else None,
        "cpc": _s(_div(spend, b["link_clicks"])) if has_spend else None,
        "meta_leads": b["meta_leads"],
        "crm_leads": b["crm_leads"],
        # Цена лида — по лидам CRM (реально дошедшим), а не по счётчику Meta.
        "cpl": _s(_div(spend, b["crm_leads"])) if has_spend else None,
        "cpl_uzs": _s(_div(spend_uzs, b["crm_leads"]), "1") if has_spend and spend_uzs else None,
        "meta_cpl": _s(_div(spend, b["meta_leads"])) if has_spend else None,
        "converted": b["converted"],
        "sales": b["sales"],
        "conv_rate": _pct(b["converted"], b["crm_leads"]),
        "revenue": _s(b["revenue"], "1"),
        "cost_per_sale_uzs": (
            _s(_div(spend_uzs, b["sales"]), "1") if has_spend and spend_uzs else None
        ),
        "romi_pct": (
            round(float((b["revenue"] - spend_uzs) * 100 / spend_uzs), 1)
            if has_spend and spend_uzs
            else None
        ),
        "video_3s": b["video_3s"],
        # Hook rate — сколько показов досмотрели до 3 сек; hold — из них до ThruPlay.
        "hook_rate": _pct(b["video_3s"], impressions),
        "thruplays": b["thruplays"],
        "hold_rate": _pct(b["thruplays"], b["video_3s"]),
        "video_p25": b["video_p25"],
        "video_p50": b["video_p50"],
        "video_p75": b["video_p75"],
        "video_p100": b["video_p100"],
        "video_avg_watch_sec": (
            _s(b["_watch_weighted"] / b["video_3s"], "0.1") if b["video_3s"] else None
        ),
    }
    return out


def _add_insight(b: dict, r: dict, spend_uzs: Decimal | None) -> None:
    b["spend"] += r["spend"]
    if spend_uzs is None:
        b["spend_uzs_known"] = False
    else:
        b["spend_uzs"] += spend_uzs
    for k in (
        "impressions", "reach", "clicks", "link_clicks", "meta_leads", "video_3s",
        "thruplays", "video_p25", "video_p50", "video_p75", "video_p100",
    ):
        b[k] += r[k] or 0
    b["_watch_weighted"] += Decimal(str(r["video_avg_watch_sec"] or 0)) * (r["video_3s"] or 0)


# ---- data loading --------------------------------------------------------


def _load(smm_id: int, date_from: dt.date, date_to: dt.date) -> dict:
    start, end = _dt_range(date_from, date_to)

    leads = list(
        Lead.objects.filter(smm_leads_q(smm_id), created_at__gte=start, created_at__lte=end)
        .annotate(
            ad_id=KT("metadata__ad__ad_id"),
            ad_name=KT("metadata__ad__ad_name"),
            adset_name=KT("metadata__ad__adset_name"),
            campaign_name=KT("metadata__ad__campaign_name"),
            campaign_id=KT("metadata__ad__campaign_id"),
        )
        .values(
            "id", "created_at", "status", "postpone_reason", "metadata",
            "ad_id", "ad_name", "adset_name", "campaign_name", "campaign_id",
        )
    )
    lead_ids = [r["id"] for r in leads]
    sales = list(
        _confirmed_sales()
        .filter(lead_id__in=lead_ids)
        .values("id", "lead_id", "amount", "discount", "sold_at")
    )
    orphan_sales = list(
        _confirmed_sales()
        .filter(lead__isnull=True, sheet_source__smm_id=smm_id, sold_at__gte=start, sold_at__lte=end)
        .values("id", "lead_id", "amount", "discount", "sold_at")
    )

    accounts = list(MetaAdAccount.objects.filter(smm_id=smm_id).order_by("name"))
    insights = list(
        MetaAdInsightDaily.objects.filter(
            ad_account__smm_id=smm_id, date__gte=date_from, date__lte=date_to
        ).values(
            "ad_id", "date", "currency", "ad_name", "campaign_id", "campaign_name",
            "adset_id", "adset_name", "spend", "impressions", "reach", "clicks",
            "link_clicks", "meta_leads", "video_3s", "thruplays", "video_p25",
            "video_p50", "video_p75", "video_p100", "video_avg_watch_sec",
        )
    )
    fx = FxTable({a.currency for a in accounts} | {r["currency"] for r in insights}, date_from, date_to)
    ad_ids = {r["ad_id"] for r in insights} | {r["ad_id"] for r in leads if r["ad_id"]}
    ads = {a.ad_id: a for a in MetaAd.objects.filter(ad_id__in=ad_ids)}
    return {
        "leads": leads,
        "sales": sales,
        "orphan_sales": orphan_sales,
        "accounts": accounts,
        "insights": insights,
        "fx": fx,
        "ads": ads,
    }


# ---- dashboard -----------------------------------------------------------


def _status_labels(lang: str) -> dict[str, str]:
    labels = {c.value: str(c.label) for c in LeadStatus}
    for code, ru, uz in LeadStatusLabel.objects.values_list("code", "label_ru", "label_uz"):
        labels[code] = (uz if lang == "uz" and uz else ru) or labels.get(code, code)
    return labels


def _lost_reason(lead: dict) -> str:
    text = (lead.get("postpone_reason") or "").strip()
    if not text:
        meta = lead.get("metadata") or {}
        for k in ("lost_comment", "IZOH", "izoh", "comment"):
            v = str(meta.get(k, "") or "").strip()
            if v:
                text = v[:120]
                break
    return text or "Причина не указана"


def smm_dashboard(
    *, smm_id: int, date_from: dt.date, date_to: dt.date, lang: str = "ru"
) -> dict:
    data = _load(smm_id, date_from, date_to)
    leads, fx = data["leads"], data["fx"]

    totals = _empty_bucket()
    per_ad: dict[str, dict] = defaultdict(_empty_bucket)
    per_day: dict[dt.date, dict] = defaultdict(_empty_bucket)
    ad_meta: dict[str, dict] = {}
    currencies: set[str] = set()

    # Реклама.
    for r in data["insights"]:
        currencies.add(r["currency"])
        spend_uzs = fx.to_uzs(r["spend"], r["currency"], r["date"])
        for b in (totals, per_ad[r["ad_id"]], per_day[r["date"]]):
            _add_insight(b, r, spend_uzs)
        ad_meta.setdefault(r["ad_id"], {
            "ad_name": r["ad_name"], "campaign_id": r["campaign_id"],
            "campaign_name": r["campaign_name"], "adset_id": r["adset_id"],
            "adset_name": r["adset_name"],
        })

    # Лиды CRM.
    lead_ad: dict[int, str] = {}
    lead_day: dict[int, dt.date] = {}
    for r in leads:
        key = r["ad_id"] or NO_AD
        lead_ad[r["id"]] = key
        lead_day[r["id"]] = _local_date(r["created_at"])
        for b in (totals, per_ad[key], per_day[lead_day[r["id"]]]):
            b["crm_leads"] += 1
        if r["ad_id"]:
            ad_meta.setdefault(r["ad_id"], {
                "ad_name": r["ad_name"] or "", "campaign_id": r["campaign_id"] or "",
                "campaign_name": r["campaign_name"] or "", "adset_id": "",
                "adset_name": r["adset_name"] or "",
            })

    # Продажи (когорта лидов периода + продажи без лида).
    converted_leads: set[int] = set()
    for s in data["sales"]:
        key = lead_ad.get(s["lead_id"], NO_AD)
        net = _net(s)
        first = s["lead_id"] not in converted_leads
        converted_leads.add(s["lead_id"])
        for b in (totals, per_ad[key]):
            b["sales"] += 1
            b["revenue"] += net
            if first:
                b["converted"] += 1
        day = _local_date(s["sold_at"]) if s["sold_at"] else lead_day.get(s["lead_id"])
        if day and date_from <= day <= date_to:
            per_day[day]["sales"] += 1
            per_day[day]["revenue"] += net
    for s in data["orphan_sales"]:
        net = _net(s)
        for b in (totals, per_ad[NO_AD]):
            b["sales"] += 1
            b["revenue"] += net
        day = _local_date(s["sold_at"])
        per_day[day]["sales"] += 1
        per_day[day]["revenue"] += net

    # Объявления.
    in_insights = {r["ad_id"] for r in data["insights"]}
    ads_out = []
    for ad_id, b in per_ad.items():
        if ad_id == NO_AD:
            continue
        ad = data["ads"].get(ad_id)
        meta = ad_meta.get(ad_id, {})
        ads_out.append({
            "ad_id": ad_id,
            "name": (ad.name if ad else "") or meta.get("ad_name") or ad_id,
            "status": ad.status if ad else "",
            "campaign_id": (ad.campaign_id if ad else "") or meta.get("campaign_id", ""),
            "campaign_name": (ad.campaign_name if ad else "") or meta.get("campaign_name", ""),
            "adset_id": (ad.adset_id if ad else "") or meta.get("adset_id", ""),
            "adset_name": (ad.adset_name if ad else "") or meta.get("adset_name", ""),
            "thumbnail_url": ad.thumbnail_url if ad else "",
            "image_url": ad.image_url if ad else "",
            "video_id": ad.video_id if ad else "",
            "preview_url": ad.preview_url if ad else "",
            "in_meta": ad is not None or ad_id in in_insights,
            **_finish(b),
        })
    ads_out.sort(key=lambda a: (-(Decimal(a["spend"] or 0)), -a["crm_leads"]))

    # Кампании (группировка объявлений).
    camp_buckets: dict[str, dict] = defaultdict(_empty_bucket)
    camp_names: dict[str, str] = {}
    camp_ads: dict[str, int] = defaultdict(int)
    for a in ads_out:
        ckey = a["campaign_id"] or a["campaign_name"] or "—"
        a["campaign_key"] = ckey
        camp_names.setdefault(ckey, a["campaign_name"] or ckey)
        camp_ads[ckey] += 1
        cb = camp_buckets[ckey]
        b = per_ad[a["ad_id"]]
        for k, v in b.items():
            if k == "spend_uzs_known":
                cb[k] = cb[k] and v
            else:
                cb[k] += v
    campaigns = [
        {"key": k, "name": camp_names[k], "ads": camp_ads[k], **_finish(b)}
        for k, b in camp_buckets.items()
    ]
    campaigns.sort(key=lambda c: (-(Decimal(c["spend"] or 0)), -c["crm_leads"]))

    # По дням — сплошной ряд.
    daily = []
    day = date_from
    while day <= date_to:
        b = per_day.get(day) or _empty_bucket()
        f = _finish(b)
        daily.append({
            "date": day.isoformat(),
            "spend": f["spend"],
            "spend_uzs": f["spend_uzs"],
            "meta_leads": f["meta_leads"],
            "crm_leads": f["crm_leads"],
            "sales": b["sales"],
            "revenue": f["revenue"],
            "cpl": f["cpl"],
        })
        day += dt.timedelta(days=1)

    # Статусы и причины отказа.
    labels = _status_labels(lang)
    status_counts: dict[str, int] = defaultdict(int)
    for r in leads:
        status_counts[r["status"]] += 1
    statuses = [
        {"status": code, "label": labels.get(code, code), "count": n}
        for code, n in sorted(status_counts.items(), key=lambda x: -x[1])
    ]
    lost_ids = set(
        exclude_system_lost(Lead.objects.filter(id__in=[r["id"] for r in leads]))
        .filter(status__in=("lost", "archived"))
        .values_list("id", flat=True)
    )
    reasons: dict[str, int] = defaultdict(int)
    for r in leads:
        if r["id"] in lost_ids:
            reasons[_lost_reason(r)] += 1
    rejection_reasons = [
        {"text": t, "count": n, "pct": _pct(n, len(lost_ids), 1)}
        for t, n in sorted(reasons.items(), key=lambda x: -x[1])[:8]
    ]

    single_currency = next(iter(currencies)) if len(currencies) == 1 else (
        data["accounts"][0].currency if not currencies and data["accounts"] else None
    )
    no_ad = per_ad.get(NO_AD)
    return {
        "period": {
            "start": date_from.isoformat(),
            "end": date_to.isoformat(),
            "days": (date_to - date_from).days + 1,
        },
        "currency": single_currency,
        "meta_connected": any(a.is_active for a in data["accounts"]),
        "ad_accounts": [
            {
                "id": a.id,
                "account_id": a.account_id,
                "name": a.name,
                "currency": a.currency,
                "is_active": a.is_active,
                "last_synced_at": a.last_synced_at.isoformat() if a.last_synced_at else None,
                "last_sync_error": a.last_sync_error,
            }
            for a in data["accounts"]
        ],
        "sources": list(
            SheetSource.objects.filter(smm_id=smm_id).values("id", "name", "kind", "active")
        ),
        "totals": _finish(totals),
        "daily": daily,
        "campaigns": campaigns,
        "ads": ads_out,
        "no_ad": _finish(no_ad) if no_ad else None,
        "statuses": statuses,
        "rejection_reasons": rejection_reasons,
    }


def smm_card(user) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "name": smm_display_name(user),
        "is_active": user.is_active,
    }


def smm_overview(*, date_from: dt.date, date_to: dt.date) -> list[dict]:
    """Все SMM рядом — для владельца."""
    out = []
    for user in smm_users_qs():
        d = smm_dashboard(smm_id=user.id, date_from=date_from, date_to=date_to)
        top = next((a for a in d["ads"] if a["crm_leads"] or a["spend"] != "0.00"), None)
        out.append({
            **smm_card(user),
            "currency": d["currency"],
            "meta_connected": d["meta_connected"],
            "sources": d["sources"],
            "ad_accounts": d["ad_accounts"],
            "totals": d["totals"],
            "top_ad": {"ad_id": top["ad_id"], "name": top["name"], "thumbnail_url": top["thumbnail_url"]} if top else None,
        })
    return out


# ---- leads list ----------------------------------------------------------


def smm_leads_qs(
    *,
    smm_id: int,
    date_from: dt.date | None = None,
    date_to: dt.date | None = None,
    status: str | None = None,
    ad_id: str | None = None,
    campaign: str | None = None,
    source_id: int | None = None,
    search: str | None = None,
):
    qs = Lead.objects.filter(smm_leads_q(smm_id)).select_related("operator", "sheet_source")
    if date_from:
        qs = qs.filter(created_at__gte=_dt_range(date_from, date_from)[0])
    if date_to:
        qs = qs.filter(created_at__lte=_dt_range(date_to, date_to)[1])
    if status:
        qs = qs.filter(status__in=[s for s in status.split(",") if s])
    if ad_id == NO_AD:
        qs = qs.filter(Q(metadata__ad__ad_id__isnull=True) | Q(metadata__ad__ad_id=""))
    elif ad_id:
        qs = qs.filter(metadata__ad__ad_id=ad_id)
    if campaign:
        qs = qs.filter(
            Q(metadata__ad__campaign_id=campaign) | Q(metadata__ad__campaign_name=campaign)
        )
    if source_id:
        qs = qs.filter(sheet_source_id=source_id)
    if search:
        s = search.strip()
        digits = "".join(ch for ch in s if ch.isdigit())
        cond = Q(full_name__icontains=s)
        if digits:
            cond |= Q(phone__contains=digits)
        qs = qs.filter(cond)
    return qs.order_by("-created_at", "-id")


def smm_lead_rows(leads: list[Lead], *, lang: str = "ru") -> list[dict]:
    labels = _status_labels(lang)
    sales_by_lead: dict[int, list[dict]] = defaultdict(list)
    for s in (
        _confirmed_sales()
        .filter(lead_id__in=[lead.id for lead in leads])
        .values("lead_id", "amount", "discount", "phone_model", "sold_at")
        .order_by("sold_at")
    ):
        sales_by_lead[s["lead_id"]].append(s)
    rows = []
    for lead in leads:
        ad = (lead.metadata or {}).get("ad") or {}
        sales = sales_by_lead.get(lead.id, [])
        rows.append({
            "id": lead.id,
            "full_name": lead.full_name,
            "phone": lead.phone,
            "status": lead.status,
            "status_label": labels.get(lead.status, lead.status),
            "product_hint": lead.product_hint,
            "created_at": lead.created_at.isoformat(),
            "operator_name": lead.operator.full_name if lead.operator_id and lead.operator else None,
            "source_id": lead.sheet_source_id,
            "source_name": lead.sheet_source.name if lead.sheet_source_id else None,
            "ad": {
                "ad_id": ad.get("ad_id") or "",
                "ad_name": ad.get("ad_name") or "",
                "adset_name": ad.get("adset_name") or "",
                "campaign_name": ad.get("campaign_name") or "",
                "form_name": ad.get("form_name") or "",
                "platform": ad.get("platform") or "",
            },
            "lost_reason": (
                _lost_reason({"postpone_reason": lead.postpone_reason, "metadata": lead.metadata})
                if lead.status in ("lost", "archived")
                else None
            ),
            "sales": [
                {
                    "amount": _s(_net(s), "1"),
                    "phone_model": s["phone_model"] or "",
                    "sold_at": s["sold_at"].isoformat() if s["sold_at"] else None,
                }
                for s in sales
            ],
        })
    return rows


__all__ = [
    "NO_AD",
    "smm_card",
    "smm_dashboard",
    "smm_display_name",
    "smm_lead_rows",
    "smm_leads_q",
    "smm_leads_qs",
    "smm_overview",
    "smm_sales_q",
    "smm_users_qs",
]
