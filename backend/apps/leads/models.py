"""
Pre-sale domain: Lead + assignments + Google-Sheets sync configuration.

- `Lead` — a prospect from Google Sheets (or manually created) with lifecycle
  status. Idempotency key for sheet-imported rows is
  `(sheet_source, sheet_row_index)`.
- `LeadAssignment` — audit trail of assignments (round-robin, manual, sheet
  alias). Latest active row wins.
- `SheetSource` + `OperatorSheetAlias` — per-worksheet column mapper and
  operator-name aliases used by the sync command.
- `TelegramLink` — phone→username cache so the frontend "Написать в TG"
  button opens `https://t.me/{username}` when we know it, and falls back to
  `tg://resolve?phone=+998…` otherwise.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models

from apps.common.models import TimestampedModel


class LeadStatus(models.TextChoices):
    NEW = "new", "Новый"
    ASSIGNED = "assigned", "Назначен"
    IN_PROGRESS = "in_progress", "В работе"
    CALLBACK_SCHEDULED = "callback_scheduled", "Запланирован callback"
    CONTACTED_TELEGRAM = "contacted_telegram", "Написали в Telegram"
    NO_ANSWER = "no_answer", "Не берёт трубку"
    WON = "won", "Продажа"
    LOST = "lost", "Потерян"
    ARCHIVED = "archived", "Архив"
    NEEDS_REVIEW = "needs_review", "Требует проверки"


class LeadSource(models.TextChoices):
    SHEET = "sheet", "Google Sheets"
    MANUAL = "manual", "Ручной ввод"
    BOT = "bot", "Telegram-бот"


class SheetSource(TimestampedModel):
    """
    Configuration for one Google Sheets worksheet — read once per sync run,
    translated into `Lead`s via `column_map`.

    `column_map` shape (example):
      {
        "full_name": "full_name",
        "phone": "phone_number",
        "product_hint": "qanday_telefon_xarid_qilmoqchisiz?",
        "has_card": "plastik_kartangiz_bormi?",
        "operator_alias": {"column_index": 4},   # unnamed column
        "date": "date",
        "extra": ["STATUS", "IZOH", "bitrix_deal_id", "processed_at"]
      }

    Any string value = header name; `{"column_index": N}` = positional
    lookup (used when the column has no header). Anything under `extra`
    is copied verbatim to `Lead.metadata`.
    """

    name = models.CharField(max_length=128)
    spreadsheet_id = models.CharField(max_length=128)
    gid = models.BigIntegerField(help_text="Google Sheet's tab gid")
    worksheet_name = models.CharField(
        max_length=128,
        blank=True,
        default="",
        help_text="Optional — if set, sync reads by name instead of gid.",
    )
    column_map = models.JSONField(default=dict, blank=True)
    default_status = models.CharField(
        max_length=32, choices=LeadStatus.choices, default=LeadStatus.NEW
    )
    active = models.BooleanField(default=True)
    last_synced_at = models.DateTimeField(null=True, blank=True)
    last_synced_row = models.PositiveIntegerField(
        default=0,
        help_text=(
            "1-based row index of the highest row we've imported so far. "
            "sync_sheets_leads only fetches rows above this and processes new "
            "ones. Set to 0 to force a full re-scan."
        ),
    )

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["spreadsheet_id", "gid"], name="uniq_sheet_source_ss_gid"
            )
        ]

    def __str__(self) -> str:
        return f"{self.name} (gid={self.gid})"


class OperatorSheetAlias(TimestampedModel):
    """
    Maps a plain-text operator name from a sheet cell to an `Operator`.
    A NULL `operator` means the alias is registered (so we know it exists
    in sheets) but the team lead hasn't picked a real operator yet — such
    leads land in `needs_review` until the alias is bound.
    """

    alias_name = models.CharField(max_length=128, unique=True)
    operator = models.ForeignKey(
        "operators.Operator",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="sheet_aliases",
    )

    class Meta:
        ordering = ["alias_name"]

    def __str__(self) -> str:
        target = self.operator.full_name if self.operator else "не привязан"
        return f"{self.alias_name} → {target}"


class Lead(TimestampedModel):
    """
    A prospect that hasn't converted to a `Sale` yet.

    Sheet-imported leads carry `(sheet_source, sheet_row_index)` as their
    de-dup key — sync is idempotent by that pair.
    """

    full_name = models.CharField(max_length=128, blank=True, default="")
    phone_raw = models.CharField(
        max_length=64,
        blank=True,
        default="",
        help_text="Original phone value from the sheet, unnormalized.",
    )
    phone = models.CharField(
        max_length=16,
        blank=True,
        default="",
        db_index=True,
        help_text="Normalized to +998XXXXXXXXX. Empty if unparseable.",
    )
    phone_invalid = models.BooleanField(
        default=False,
        help_text="True if the raw phone could not be normalized to +998 + 9 digits.",
    )
    product_hint = models.CharField(
        max_length=256,
        blank=True,
        default="",
        help_text="What phone the customer said they want (from sheet).",
    )
    has_card = models.CharField(
        max_length=64,
        blank=True,
        default="",
        help_text="Free-text 'plastik kartangiz bormi?' answer.",
    )
    status = models.CharField(
        max_length=32, choices=LeadStatus.choices, default=LeadStatus.NEW, db_index=True
    )
    source = models.CharField(
        max_length=16, choices=LeadSource.choices, default=LeadSource.SHEET
    )
    sheet_source = models.ForeignKey(
        SheetSource,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="leads",
    )
    sheet_row_index = models.PositiveIntegerField(
        null=True,
        blank=True,
        help_text="1-based row index inside the source worksheet.",
    )
    operator = models.ForeignKey(
        "operators.Operator",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="leads",
        help_text="Currently-responsible operator (latest active LeadAssignment).",
    )
    needs_review = models.BooleanField(
        default=False,
        help_text=(
            "Sheet gave us an operator alias we don't know yet, or another "
            "signal the team lead should look at before assigning."
        ),
    )
    metadata = models.JSONField(
        default=dict,
        blank=True,
        help_text="Extra sheet columns (STATUS/IZOH/bitrix_deal_id/…) preserved verbatim.",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="created_leads",
    )

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["status", "operator"]),
            models.Index(fields=["needs_review"]),
            models.Index(fields=["phone_invalid"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["sheet_source", "sheet_row_index"],
                condition=models.Q(sheet_source__isnull=False),
                name="uniq_lead_sheet_source_row",
            )
        ]

    def __str__(self) -> str:
        return f"Lead#{self.pk} {self.full_name or self.phone or 'без имени'}"


class LeadAssignmentSource(models.TextChoices):
    SHEET_MANUAL = "sheet_manual", "Из таблицы (alias)"
    AUTO_ROUND_ROBIN = "auto_round_robin", "Автоматически (RR)"
    ADMIN_REASSIGN = "admin_reassign", "Переназначение админом"


class LeadAssignment(TimestampedModel):
    """
    Audit-friendly history of who was responsible for a lead.

    The most recent row is the current owner; older rows are the trail.
    On reassignment we mark previous rows `active=False`.
    """

    lead = models.ForeignKey(Lead, on_delete=models.CASCADE, related_name="assignments")
    operator = models.ForeignKey(
        "operators.Operator", on_delete=models.PROTECT, related_name="lead_assignments"
    )
    source = models.CharField(
        max_length=32,
        choices=LeadAssignmentSource.choices,
        default=LeadAssignmentSource.AUTO_ROUND_ROBIN,
    )
    active = models.BooleanField(default=True)
    reason = models.CharField(max_length=256, blank=True, default="")

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["lead", "-created_at"])]

    def __str__(self) -> str:
        return f"lead#{self.lead_id} → op#{self.operator_id} ({self.source})"


class TelegramLink(TimestampedModel):
    """
    Cache of phone → Telegram username lookups. Populated opportunistically
    (e.g. from bot interactions) so the frontend can prefer
    `https://t.me/{username}` over the phone-based `tg://resolve` deep-link.
    """

    phone = models.CharField(max_length=16, unique=True)
    username = models.CharField(max_length=64, blank=True, default="")
    verified_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-updated_at"]

    def __str__(self) -> str:
        return f"{self.phone} → @{self.username or '?'}"
