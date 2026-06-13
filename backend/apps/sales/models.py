from django.conf import settings
from django.db import models

from apps.common.models import TimestampedModel


class SaleStatus(models.TextChoices):
    PENDING = "pending", "На подтверждении"
    CONFIRMED = "confirmed", "Подтверждена"


class Sale(TimestampedModel):
    """
    A single device sale. `amount` is the gross price the customer paid in UZS,
    inclusive of any gifts — gifts never reduce the operator-credited amount.
    """

    imei = models.CharField(max_length=15, db_index=True)
    phone_model = models.CharField(max_length=128)
    operator = models.ForeignKey(
        "operators.Operator",
        on_delete=models.PROTECT,
        related_name="sales",
    )
    channel = models.ForeignKey(
        "catalog.Channel",
        on_delete=models.PROTECT,
        related_name="sales",
    )
    amount = models.DecimalField(max_digits=14, decimal_places=2)
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

    class Meta:
        ordering = ["-sold_at"]
        indexes = [
            models.Index(fields=["sold_at", "operator"]),
            models.Index(fields=["is_returned", "is_deleted"]),
            models.Index(fields=["status"]),
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
