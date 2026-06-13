from django.db import models

from apps.common.models import TimestampedModel


class Channel(TimestampedModel):
    name = models.CharField(max_length=64, unique=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class TacLookup(models.Model):
    """
    Local mapping: TAC (first 8 digits of IMEI) -> brand + model.
    Populated by the `seed_tac` management command from public datasets
    (Osmocom TAC DB or MoazEb/tac-database).
    """

    tac = models.CharField(max_length=8, primary_key=True)
    brand = models.CharField(max_length=64)
    model = models.CharField(max_length=128)
    device_type = models.CharField(max_length=32, blank=True, default="")

    class Meta:
        ordering = ["brand", "model"]
        indexes = [models.Index(fields=["brand", "model"])]

    def __str__(self) -> str:
        return f"{self.tac} {self.brand} {self.model}"
