from django.conf import settings
from django.db import models

from apps.common.models import TimestampedModel


class SaleStatus(models.TextChoices):
    PENDING = "pending", "На подтверждении"
    CONFIRMED = "confirmed", "Подтверждена"
    REJECTED = "rejected", "Отклонена"


class Sale(TimestampedModel):
    """
    A single device sale. `amount` is the gross price the customer paid in UZS,
    inclusive of any gifts — gifts never reduce the operator-credited amount.
    """

    imei = models.CharField(max_length=15, db_index=True)
    phone_model = models.CharField(max_length=128)
    operator = models.ForeignKey(
        "operators.Operator",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="sales",
    )
    channel = models.ForeignKey(
        "catalog.Channel",
        on_delete=models.PROTECT,
        related_name="sales",
    )
    quantity = models.PositiveSmallIntegerField(
        default=1,
        help_text=(
            "Количество единиц товара в этой продаже. По умолчанию 1 — "
            "поле не участвует в расчётах суммы (сумма считается уже с "
            "учётом штук), а служит для отчётности «сколько штук продано»."
        ),
    )
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    discount = models.DecimalField(
        max_digits=14,
        decimal_places=2,
        default=0,
        help_text=(
            "Скидка на эту продажу в UZS. Уменьшает кредит операторов "
            "пропорционально их долям (Σ SaleOperator.amount = amount − discount)."
        ),
    )
    client_name = models.CharField(max_length=128, blank=True, default="")
    client_phone = models.CharField(max_length=32, blank=True, default="")
    comment = models.TextField(blank=True, default="")
    sold_at = models.DateTimeField(db_index=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_sales",
    )

    is_returned = models.BooleanField(default=False)
    returned_at = models.DateTimeField(null=True, blank=True)
    return_reason = models.TextField(blank=True, default="")

    is_deleted = models.BooleanField(default=False)
    deleted_at = models.DateTimeField(null=True, blank=True)

    status = models.CharField(
        max_length=16, choices=SaleStatus.choices, default=SaleStatus.CONFIRMED
    )

    # Pre-sale linkage: if a Lead converted into this Sale, it stays linked.
    # Nullable — most historical sales don't have an originating Lead.
    lead = models.ForeignKey(
        "leads.Lead",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="sales",
    )
    # Denormalised copy of `lead.sheet_source` at the moment of sale creation.
    # Kept separately so per-source analytics survive lead deletion and so
    # direct sales (without a lead) can still be attributed to a source by
    # the manager. Auto-populated in lead_convert_to_sale; can be set
    # manually elsewhere later if needed.
    sheet_source = models.ForeignKey(
        "leads.SheetSource",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="sales",
    )
    # Free-form note about a bonus, promo, or other one-off deal condition
    # the operator wants to flag to the manager. Separate from `comment`
    # so aggregations / notifications can pick it up cleanly.
    bonus_note = models.TextField(blank=True, default="")

    # Attached contract photo — usually uploaded by the operator when creating
    # a pending sale (paste-from-clipboard or file picker). Nullable because
    # historical / manager-created sales don't have one.
    contract_photo = models.ImageField(
        upload_to="sales/contracts/%Y/%m/",
        null=True,
        blank=True,
        help_text="Фото договора, приложенное оператором при создании pending-продажи.",
    )

    # Manager's rejection payload (only meaningful when status == REJECTED).
    rejection_reason = models.TextField(blank=True, default="")
    rejected_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-sold_at"]
        indexes = [
            models.Index(fields=["sold_at", "operator"]),
            models.Index(fields=["is_returned", "is_deleted"]),
            models.Index(fields=["status"]),
            # Wave-1 (2026-08-22): ускоряет /sales/pending/ (status=pending
            # + order by -sold_at) и analytics lead-stats split-metric,
            # где выборка идёт по (status, sold_at window).
            models.Index(fields=["status", "sold_at"], name="sale_status_sold_at_idx"),
            # /my/sales — оператор видит только свои по статусу.
            models.Index(
                fields=["created_by", "status"], name="sale_created_by_status_idx"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.imei} {self.phone_model} → {self.operator_id}"


class GiftItem(models.Model):
    """A complimentary item bundled inside the sale amount. `cost` is for margin only."""

    sale = models.ForeignKey(Sale, on_delete=models.CASCADE, related_name="gifts")
    name = models.CharField(max_length=128)
    cost = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)

    def __str__(self) -> str:
        return f"{self.name} (sale#{self.sale_id})"


class SaleOperator(models.Model):
    """
    Allocation row: one of possibly several operators credited on a Sale,
    each with their own share of the sale amount (for payroll splits).
    """

    sale = models.ForeignKey(Sale, on_delete=models.CASCADE, related_name="operator_lines")
    operator = models.ForeignKey(
        "operators.Operator",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="sale_lines",
    )
    amount = models.DecimalField(max_digits=14, decimal_places=2)

    class Meta:
        ordering = ["id"]
        indexes = [models.Index(fields=["sale", "operator"])]

    def __str__(self) -> str:
        return f"{self.operator_id} = {self.amount} (sale#{self.sale_id})"


class SalePartner(models.Model):
    """
    Allocation row: one of possibly several partners (Alif / Birzum / Hamroh /
    cash / ...) the customer used to pay, each with their own share.
    """

    sale = models.ForeignKey(Sale, on_delete=models.CASCADE, related_name="partner_lines")
    partner = models.ForeignKey(
        "catalog.Channel",
        on_delete=models.PROTECT,
        related_name="sale_lines",
    )
    amount = models.DecimalField(max_digits=14, decimal_places=2)

    class Meta:
        ordering = ["id"]
        indexes = [models.Index(fields=["sale", "partner"])]

    def __str__(self) -> str:
        return f"{self.partner_id} = {self.amount} (sale#{self.sale_id})"


class SaleContractPhoto(models.Model):
    """
    Одна из до 5 фотографий договора, приложенных оператором к продаже.

    Легаси-поле `Sale.contract_photo` (single) оставлено как fallback —
    старый prod-фронт и старые записи продолжают работать; при чтении
    приоритет у related-набора `contract_photos_all`.
    """

    sale = models.ForeignKey(
        Sale, on_delete=models.CASCADE, related_name="contract_photos_all"
    )
    photo = models.ImageField(upload_to="sales/contracts/%Y/%m/")
    position = models.PositiveSmallIntegerField(default=0)
    uploaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["position", "id"]

    def __str__(self) -> str:
        return f"photo#{self.id} (sale#{self.sale_id})"
