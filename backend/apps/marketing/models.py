"""
Marketing models.

- `MarketingInsight` — one row per LLM analysis run for a period. Rich
  `structured_output` JSON field holds the marketer-persona payload
  (summary + highlights + recommendations + questions) while the old
  fields (`summary`, `targeting_recommendations`, `top_products`,
  `lead_quality_by_source`) are still populated for back-compat with the
  original Marketing.tsx page.
- `AdSpend` — per-period ad-spend record per acquisition source. Feeds
  CAC / ROI calculation in the source breakdown.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models

from apps.common.models import TimestampedModel


class MarketingInsight(TimestampedModel):
    period_start = models.DateField()
    period_end = models.DateField()
    lead_quality_by_source = models.JSONField(default=dict)
    targeting_recommendations = models.JSONField(default=list)
    top_products = models.JSONField(default=list)
    summary = models.TextField(blank=True, default="")
    model_version = models.CharField(max_length=64, default="")
    provider_used = models.CharField(max_length=32, blank=True, default="")

    # Rich marketer-persona output — JSON schema:
    #   {"summary": str, "highlights": [...], "recommendations": [...],
    #    "questions_for_owner": [...]}
    structured_output = models.JSONField(default=dict, blank=True)
    # Recommendation indices the team lead has marked "done".
    actions_taken = models.JSONField(default=list, blank=True)
    # Snapshot of the raw data payload we sent to the LLM. Kept so the FE
    # can render the dashboard consistently even if underlying data
    # changes later (e.g. leads reassigned).
    dashboard_payload_snapshot = models.JSONField(default=dict, blank=True)

    class Meta:
        unique_together = [("period_start", "period_end")]
        indexes = [models.Index(fields=["-period_start"])]
        ordering = ["-period_start"]

    def __str__(self) -> str:
        return f"Insight {self.period_start}..{self.period_end}"


class AdSpend(TimestampedModel):
    """
    Ad-spend record for a period + source. Used by CAC/ROI calculation.

    - `source` FK is optional — for sheet sources we bind by FK, for
      BOT/MANUAL/custom labels we store the label string in `source_label`.
      One of the two MUST be set.
    - `period_start` / `period_end` are inclusive dates.
    - `amount` in UZS (Decimal). Positive numbers only.
    """

    period_start = models.DateField()
    period_end = models.DateField()
    source = models.ForeignKey(
        "leads.SheetSource",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="ad_spend_rows",
        help_text="If bound to a sheet source, use FK. Otherwise leave null and set source_label.",
    )
    source_label = models.CharField(
        max_length=128,
        blank=True,
        default="",
        help_text="For BOT / MANUAL / custom acquisition channels not modelled as SheetSource.",
    )
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    currency = models.CharField(max_length=8, default="UZS")
    note = models.TextField(blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )

    class Meta:
        ordering = ["-period_start", "-id"]
        indexes = [
            models.Index(fields=["period_start", "period_end"]),
            models.Index(fields=["source", "period_start"]),
        ]

    def __str__(self) -> str:
        who = self.source.name if self.source_id else (self.source_label or "?")
        return f"AdSpend {who}: {self.amount} {self.currency} ({self.period_start}..{self.period_end})"

    @property
    def resolved_label(self) -> str:
        if self.source_id and self.source:
            return self.source.name
        return self.source_label or "Другое"


# ---- Meta Ads (Marketing API) ----------------------------------------
#
# Реальные данные рекламы таргетологов. Таргетолог расшаривает свой
# рекламный аккаунт на бизнес владельца → владелец вставляет токен
# (системного пользователя или личный) в `MetaConnection` → `check`
# показывает доступные аккаунты → каждый `MetaAdAccount` назначается
# своему SMM → `sync_meta_ads` раз в час тянет дневную статистику по
# объявлениям в `MetaAdInsightDaily`. Склейка с лидами CRM — по `ad_id`
# (`Lead.metadata["ad"]["ad_id"]`).


class MetaConnection(TimestampedModel):
    """Один токен Graph API. Хранится зашифрованным (`meta_token_vault`)."""

    name = models.CharField(max_length=128, blank=True, default="")
    token_ciphertext = models.BinaryField()
    token_key_version = models.PositiveSmallIntegerField(default=1)
    meta_user_id = models.CharField(max_length=64, blank=True, default="")
    meta_user_name = models.CharField(max_length=255, blank=True, default="")
    # None = бессрочный (системный пользователь) или ещё не проверяли.
    token_expires_at = models.DateTimeField(null=True, blank=True)
    last_checked_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )

    class Meta:
        ordering = ["id"]

    def __str__(self) -> str:
        return f"MetaConnection #{self.pk} {self.meta_user_name or self.name}"


class MetaAdAccount(TimestampedModel):
    connection = models.ForeignKey(
        MetaConnection, on_delete=models.CASCADE, related_name="ad_accounts"
    )
    # Как отдаёт Graph API: "act_1234567890".
    account_id = models.CharField(max_length=64, unique=True)
    name = models.CharField(max_length=255, blank=True, default="")
    currency = models.CharField(max_length=8, blank=True, default="USD")
    timezone_name = models.CharField(max_length=64, blank=True, default="")
    account_status = models.PositiveSmallIntegerField(null=True, blank=True)
    smm = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="smm_ad_accounts",
        limit_choices_to={"profile__role": "smm"},
    )
    # Синхронизировать только включённые (и назначенные SMM) аккаунты.
    is_active = models.BooleanField(default=False)
    last_synced_at = models.DateTimeField(null=True, blank=True)
    last_sync_error = models.TextField(blank=True, default="")
    # Самая ранняя дата, за которую статистика уже скачана. None = ни разу.
    synced_since = models.DateField(null=True, blank=True)

    class Meta:
        ordering = ["name", "id"]

    def __str__(self) -> str:
        return f"{self.name or self.account_id} ({self.account_id})"


class MetaAd(TimestampedModel):
    """Объявление + креатив (превью/видео). Обновляется при каждом синке."""

    ad_account = models.ForeignKey(
        MetaAdAccount, on_delete=models.CASCADE, related_name="ads"
    )
    ad_id = models.CharField(max_length=64, unique=True)
    name = models.CharField(max_length=512, blank=True, default="")
    status = models.CharField(max_length=32, blank=True, default="")
    campaign_id = models.CharField(max_length=64, blank=True, default="")
    campaign_name = models.CharField(max_length=512, blank=True, default="")
    adset_id = models.CharField(max_length=64, blank=True, default="")
    adset_name = models.CharField(max_length=512, blank=True, default="")
    creative_id = models.CharField(max_length=64, blank=True, default="")
    thumbnail_url = models.TextField(blank=True, default="")
    image_url = models.TextField(blank=True, default="")
    video_id = models.CharField(max_length=64, blank=True, default="")
    preview_url = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:
        return f"{self.name} ({self.ad_id})"


class MetaAdInsightDaily(models.Model):
    """Дневная статистика одного объявления (Insights API, level=ad)."""

    ad_account = models.ForeignKey(
        MetaAdAccount, on_delete=models.CASCADE, related_name="insights"
    )
    date = models.DateField()
    ad_id = models.CharField(max_length=64)
    ad_name = models.CharField(max_length=512, blank=True, default="")
    campaign_id = models.CharField(max_length=64, blank=True, default="")
    campaign_name = models.CharField(max_length=512, blank=True, default="")
    adset_id = models.CharField(max_length=64, blank=True, default="")
    adset_name = models.CharField(max_length=512, blank=True, default="")
    # В валюте рекламного аккаунта (`currency`).
    spend = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    currency = models.CharField(max_length=8, blank=True, default="USD")
    impressions = models.PositiveBigIntegerField(default=0)
    reach = models.PositiveBigIntegerField(default=0)
    clicks = models.PositiveBigIntegerField(default=0)
    link_clicks = models.PositiveBigIntegerField(default=0)
    # Лиды по данным Meta (action_type lead / onsite_conversion.lead_grouped).
    meta_leads = models.PositiveIntegerField(default=0)
    # Видео: 3-секундные просмотры (action video_view), ThruPlay, досмотры.
    video_3s = models.PositiveBigIntegerField(default=0)
    thruplays = models.PositiveBigIntegerField(default=0)
    video_p25 = models.PositiveBigIntegerField(default=0)
    video_p50 = models.PositiveBigIntegerField(default=0)
    video_p75 = models.PositiveBigIntegerField(default=0)
    video_p100 = models.PositiveBigIntegerField(default=0)
    video_avg_watch_sec = models.DecimalField(max_digits=8, decimal_places=2, default=0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-date", "ad_id"]
        constraints = [
            models.UniqueConstraint(
                fields=["ad_account", "ad_id", "date"], name="uniq_meta_insight_ad_day"
            )
        ]
        indexes = [
            models.Index(fields=["ad_account", "date"]),
            models.Index(fields=["ad_id"]),
        ]

    def __str__(self) -> str:
        return f"{self.ad_id} {self.date}: {self.spend} {self.currency}"


class MetaPage(TimestampedModel):
    """
    Страница Facebook специалиста с лид-формами. Когда `leads_enabled`, воркер
    `sync_meta_leads` раз в минуту забирает новые заявки всех её форм и кладёт
    их в `source` (webhook-источник без HTTP-приёма) — дальше как обычный лид:
    раздача операторам, дедуп по телефону, `metadata["ad"]` с ad_id.
    """

    connection = models.ForeignKey(
        MetaConnection, on_delete=models.CASCADE, related_name="pages"
    )
    page_id = models.CharField(max_length=64, unique=True)
    name = models.CharField(max_length=255, blank=True, default="")
    # Права токена на странице (MANAGE / ADVERTISE / …) — для подсказки в UI.
    tasks = models.JSONField(default=list, blank=True)
    smm = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="smm_meta_pages",
        limit_choices_to={"profile__role": "smm"},
    )
    source = models.ForeignKey(
        "leads.SheetSource",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="meta_pages",
    )
    leads_enabled = models.BooleanField(default=False)
    # Берём только заявки, созданные позже этого момента (ставится при включении).
    leads_since = models.DateTimeField(null=True, blank=True)
    last_polled_at = models.DateTimeField(null=True, blank=True)
    last_poll_error = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name", "id"]

    def __str__(self) -> str:
        return f"{self.name or self.page_id} ({self.page_id})"


class MetaLeadForm(TimestampedModel):
    page = models.ForeignKey(MetaPage, on_delete=models.CASCADE, related_name="forms")
    form_id = models.CharField(max_length=64, unique=True)
    name = models.CharField(max_length=512, blank=True, default="")
    status = models.CharField(max_length=32, blank=True, default="")
    # Время самой свежей заявки, которую уже забрали (created_time из Meta).
    last_lead_at = models.DateTimeField(null=True, blank=True)
    leads_imported = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["page", "name"]

    def __str__(self) -> str:
        return f"{self.name or self.form_id} ({self.form_id})"


class FxRate(models.Model):
    """Курс ЦБ Узбекистана: сколько сумов за 1 единицу `currency` на `date`."""

    date = models.DateField()
    currency = models.CharField(max_length=8)
    rate = models.DecimalField(max_digits=14, decimal_places=4)
    fetched_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-date"]
        constraints = [
            models.UniqueConstraint(fields=["date", "currency"], name="uniq_fx_rate_day")
        ]

    def __str__(self) -> str:
        return f"{self.currency}={self.rate} UZS ({self.date})"
