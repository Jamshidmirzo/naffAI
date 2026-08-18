"""
Add two new related models to Sale:

- `SaleAssignedManager` — до 2 менеджеров-партнёров, «прикреплённых»
  оператором к продаже при её создании. Для аналитики / co-ownership,
  на payroll не влияет.
- `SaleContractPhoto` — до 5 фото договора. Живёт параллельно с legacy
  `Sale.contract_photo` (single); legacy остаётся как fallback, чтобы
  старый prod-фронт продолжал работать.

Обе таблицы add-only, ничего в существующей `Sale` не меняется.
"""

from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0010_pending_workflow"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="SaleAssignedManager",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "manager",
                    models.ForeignKey(
                        on_delete=models.deletion.PROTECT,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "sale",
                    models.ForeignKey(
                        on_delete=models.deletion.CASCADE,
                        related_name="assigned_managers",
                        to="sales.sale",
                    ),
                ),
            ],
            options={
                "ordering": ["id"],
                "unique_together": {("sale", "manager")},
            },
        ),
        migrations.CreateModel(
            name="SaleContractPhoto",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "photo",
                    models.ImageField(upload_to="sales/contracts/%Y/%m/"),
                ),
                ("position", models.PositiveSmallIntegerField(default=0)),
                ("uploaded_at", models.DateTimeField(auto_now_add=True)),
                (
                    "sale",
                    models.ForeignKey(
                        on_delete=models.deletion.CASCADE,
                        related_name="contract_photos_all",
                        to="sales.sale",
                    ),
                ),
            ],
            options={
                "ordering": ["position", "id"],
            },
        ),
    ]
