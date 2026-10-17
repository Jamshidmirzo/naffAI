from decimal import Decimal

from django.conf import settings
from django.db import models
from django.utils.text import slugify

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


# ---------------------------------------------------------------------------
# Catalog v1 — phone catalog with colors + installment plans (bank matrix).
# Managers curate this list through /catalog on the demo frontend so operators
# can paste ready-made offers (text + cover photo) into client TG chats.
# ---------------------------------------------------------------------------


class PhoneStockStatus(models.TextChoices):
    AVAILABLE = "available", "В наличии"
    ON_ORDER = "on_order", "Под заказ"
    OUT = "out", "Нет в наличии"


class PhoneModel(TimestampedModel):
    """
    Catalog record for one phone configuration (model × storage × RAM).
    Rendered as a card on /catalog. Operators tap "Copy" and get the
    ClipboardItem with both the text-plain quote (name/config/colors/price/
    installments) and the image/png cover photo.
    """

    brand = models.CharField(max_length=64, db_index=True)
    model_name = models.CharField(max_length=128)
    storage_gb = models.PositiveSmallIntegerField(null=True, blank=True)
    ram_gb = models.PositiveSmallIntegerField(null=True, blank=True)
    price = models.DecimalField(max_digits=14, decimal_places=2)
    cover_image = models.ImageField(
        upload_to="catalog/phones/%Y/%m/", null=True, blank=True
    )
    description = models.TextField(blank=True, default="")
    # Extended catalog fields (all optional) — feed the marketing-text
    # builder and the /calculator page. Missing values are dropped from
    # the copy-and-paste template silently.
    tagline = models.CharField(max_length=200, blank=True, default="")
    camera_mp = models.PositiveSmallIntegerField(null=True, blank=True)
    battery_mah = models.PositiveIntegerField(null=True, blank=True)
    specs_json = models.JSONField(default=dict, blank=True)
    stock_status = models.CharField(
        max_length=16,
        choices=PhoneStockStatus.choices,
        default=PhoneStockStatus.AVAILABLE,
        db_index=True,
    )
    is_active = models.BooleanField(default=True, db_index=True)
    sort_order = models.IntegerField(default=0)
    # Public shop site (zetmobile.uz) — the site reads this catalog through
    # /api/public/catalog/ so prices there are the same numbers operators
    # quote. `is_active` hides a phone from operators; `show_on_site` is a
    # separate opt-in for the public site (both must be true there).
    show_on_site = models.BooleanField(default=False, db_index=True)
    # Stable URL key on the site. Filled once from brand/model/storage on
    # first save and never re-derived on rename (links stay alive).
    site_slug = models.SlugField(max_length=160, unique=True, null=True, blank=True)
    # `description` is the uz text (operators paste it); this is the ru one.
    description_ru = models.TextField(blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="created_phones",
    )

    class Meta:
        ordering = ["-sort_order", "brand", "model_name"]
        indexes = [models.Index(fields=["brand", "model_name"])]

    def __str__(self) -> str:
        parts = [self.brand, self.model_name]
        if self.storage_gb:
            parts.append(f"{self.storage_gb}GB")
        return " ".join(parts)

    def save(self, *args, **kwargs):
        if not self.site_slug:
            self.site_slug = phone_site_slug_unique(self)
            update_fields = kwargs.get("update_fields")
            if update_fields is not None and "site_slug" not in update_fields:
                kwargs["update_fields"] = [*update_fields, "site_slug"]
        super().save(*args, **kwargs)


SITE_SLUG_MAX_LENGTH = 160


def phone_site_slug_base(*, brand: str, model_name: str, storage_gb: int | None) -> str:
    """`Apple` + `iPhone 16 Pro` + 256 → `apple-iphone-16-pro-256gb`."""
    parts = [brand or "", model_name or ""]
    if storage_gb:
        parts.append(f"{storage_gb}gb")
    # Leave room for a `-NN` collision suffix.
    base = slugify(" ".join(parts))[: SITE_SLUG_MAX_LENGTH - 8].strip("-")
    return base or "phone"


def phone_site_slug_unique(phone: "PhoneModel") -> str:
    base = phone_site_slug_base(
        brand=phone.brand, model_name=phone.model_name, storage_gb=phone.storage_gb
    )
    taken = set(
        PhoneModel.objects.filter(site_slug__startswith=base)
        .exclude(pk=phone.pk)
        .values_list("site_slug", flat=True)
    )
    slug, n = base, 2
    while slug in taken:
        slug = f"{base}-{n}"
        n += 1
    return slug


class PhoneColor(models.Model):
    """
    One color variant of a phone. `price_override` — nullable per-color
    price (Titanium usually costs more); if null we use parent phone.price.
    """

    phone = models.ForeignKey(
        PhoneModel, on_delete=models.CASCADE, related_name="colors"
    )
    name = models.CharField(max_length=64)
    hex_code = models.CharField(max_length=9, blank=True, default="")
    price_override = models.DecimalField(
        max_digits=14, decimal_places=2, null=True, blank=True
    )
    is_available = models.BooleanField(default=True)
    sort_order = models.IntegerField(default=0)

    class Meta:
        ordering = ["sort_order", "name"]
        constraints = [
            models.UniqueConstraint(fields=["phone", "name"], name="uniq_phone_color"),
        ]

    def __str__(self) -> str:
        return f"{self.phone_id}::{self.name}"


class PhoneSpinFrame(models.Model):
    """
    One frame of a 360° spin for a phone, per color (`color=None` — the
    colorless set, for phones without colors). Frames of one set are
    0..N-1 in rotation order and are always replaced as a whole
    (`services.phone_spin_replace`), so `index=0` is the preview frame.
    Stored as WebP, max 1200 px wide.
    """

    phone = models.ForeignKey(
        PhoneModel, on_delete=models.CASCADE, related_name="spin_frames"
    )
    color = models.ForeignKey(
        PhoneColor,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="spin_frames",
    )
    index = models.PositiveSmallIntegerField()
    image = models.ImageField(upload_to="catalog/spin/%Y/%m/")

    class Meta:
        ordering = ["color_id", "index"]
        constraints = [
            models.UniqueConstraint(
                fields=["phone", "color", "index"], name="uniq_spin_frame"
            ),
            # NULL != NULL inside a unique index — the colorless set needs
            # its own partial constraint.
            models.UniqueConstraint(
                fields=["phone", "index"],
                condition=models.Q(color__isnull=True),
                name="uniq_spin_frame_colorless",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.phone_id}::{self.color_id or '-'}::spin#{self.index}"


class InstallmentBank(TimestampedModel):
    """Installment provider (Alif, Zoodpay, Payme Nasiya, Uzum Nasiya, …)."""

    name = models.CharField(max_length=64, unique=True)
    icon = models.CharField(max_length=8, blank=True, default="")
    is_active = models.BooleanField(default=True)
    sort_order = models.IntegerField(default=0)

    class Meta:
        ordering = ["sort_order", "name"]

    def __str__(self) -> str:
        return self.name


class InstallmentPlan(TimestampedModel):
    """
    One row of the [bank × term_months] matrix. Multiplier is applied to
    the phone's price to compute the total repayable amount:

        total_payable = phone_price × multiplier
        monthly       = total_payable / term_months
        overpay       = phone_price × (multiplier − 1)
    """

    bank = models.ForeignKey(
        InstallmentBank, on_delete=models.CASCADE, related_name="plans"
    )
    term_months = models.PositiveSmallIntegerField()
    multiplier = models.DecimalField(
        max_digits=5, decimal_places=3, default=Decimal("1.000")
    )
    is_active = models.BooleanField(default=True)
    sort_order = models.IntegerField(default=0)

    class Meta:
        ordering = ["bank__sort_order", "term_months"]
        constraints = [
            models.UniqueConstraint(fields=["bank", "term_months"], name="uniq_bank_term"),
        ]

    def __str__(self) -> str:
        return f"{self.bank.name} {self.term_months}m ×{self.multiplier}"


class PhoneGalleryPhoto(models.Model):
    """
    Additional gallery photos for a phone. `cover_image` on PhoneModel is
    the primary; these are extras that don't render in the marketing text
    but appear on the /catalog product card lightbox / editor.
    """

    phone = models.ForeignKey(
        PhoneModel, on_delete=models.CASCADE, related_name="gallery"
    )
    photo = models.ImageField(upload_to="catalog/gallery/%Y/%m/")
    position = models.PositiveSmallIntegerField(default=0)
    uploaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["position", "id"]

    def __str__(self) -> str:
        return f"{self.phone_id}::gallery#{self.position}"


class InstallmentTier(models.Model):
    """
    Global (shop-wide) installment tier used by the /calculator page and
    the marketing-copy template. Distinct from InstallmentBank/InstallmentPlan
    — those live per-bank on the phone card; these tiers are shop-wide
    (Alif/Anor/whoever apply the same 7/15/25/32/38/50 rates).
    """

    months = models.PositiveSmallIntegerField(unique=True)
    commission_pct = models.DecimalField(max_digits=5, decimal_places=2)
    is_active = models.BooleanField(default=True)
    show_in_marketing = models.BooleanField(default=False)
    sort_order = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ["sort_order", "months"]

    def __str__(self) -> str:
        return f"{self.months} мес / {self.commission_pct}%"


class MarketingSettings(models.Model):
    """
    Singleton row (pk=1) holding shop-wide marketing defaults — phones,
    telegram, address, benefits block. Managed by manager through the
    /catalog/marketing-settings admin page; consumed by the
    build_marketing_text() template.
    """

    default_tagline = models.CharField(
        max_length=200, default="Yuqori sifat va yuqori mustahkamlik!"
    )
    phone_primary = models.CharField(max_length=32, blank=True, default="")
    phone_secondary = models.CharField(max_length=32, blank=True, default="")
    telegram_handle = models.CharField(max_length=64, blank=True, default="")
    address = models.CharField(max_length=200, blank=True, default="")
    benefits = models.TextField(
        blank=True,
        default="",
        help_text=(
            "Одна строка = один пункт. Первый символ строки — эмодзи, "
            "дальше — текст."
        ),
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Marketing settings"
        verbose_name_plural = "Marketing settings"

    def save(self, *args, **kwargs):
        # Enforce singleton — always pk=1.
        self.pk = 1
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):  # pragma: no cover
        # Prevent accidental deletion of the singleton.
        pass

    @classmethod
    def load(cls) -> "MarketingSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj

    def __str__(self) -> str:
        return "MarketingSettings (singleton)"
