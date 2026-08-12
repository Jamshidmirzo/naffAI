"""
Build the "copy-and-paste" quote for a catalog phone.

Called by the /catalog/phones/<id>/quote/ endpoint; the frontend puts
the returned text into `ClipboardItem` as `text/plain` alongside the
cover image (`image/png`) so operators can paste both into a TG chat in
one gesture.

Format (uz):

    📱 iPhone 17 Pro Max
    💾 256GB / 8GB RAM
    🎨 Ranglar: Deep Blue, Silver

    💰 Narxi: 22 500 000 so'm

    📊 Bo'lib-bo'lib to'lash:
      • Alif 6 oy — 4 125 000 so'm/oy
      • Alif 12 oy — 2 156 250 so'm/oy

    📞 Buyurtma uchun bog'laning
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

from .models import InstallmentPlan, PhoneModel


def _tr(ru: str, uz: str, language: str) -> str:
    return uz if language == "uz" else ru


def _fmt_money(value: Decimal, language: str) -> str:
    unit = _tr("сум", "so'm", language)
    n = int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return f"{n:,}".replace(",", " ") + f" {unit}"


def installment_rows(phone: PhoneModel) -> list[dict]:
    """
    Return the [{bank, term_months, monthly, total, overpay}] matrix
    for all active plans. Ordered by bank.sort_order then term_months.
    """
    price = phone.price or Decimal(0)
    plans = InstallmentPlan.objects.filter(is_active=True, bank__is_active=True).select_related(
        "bank"
    )
    rows: list[dict] = []
    for p in plans:
        total = (price * p.multiplier).quantize(Decimal("0.01"))
        monthly = (total / p.term_months).quantize(Decimal("0.01"))
        rows.append(
            {
                "bank": p.bank.name,
                "bank_icon": p.bank.icon,
                "term_months": p.term_months,
                "multiplier": float(p.multiplier),
                "monthly": monthly,
                "total": total,
                "overpay": (total - price).quantize(Decimal("0.01")),
            }
        )
    rows.sort(key=lambda r: (r["bank"], r["term_months"]))
    return rows


def build_phone_quote(phone: PhoneModel, language: str = "uz") -> str:
    lang = language or "uz"
    lines: list[str] = []
    lines.append(f"📱 <b>{phone.brand} {phone.model_name}</b>".replace("<b>", "").replace("</b>", ""))
    # Config line
    cfg_parts: list[str] = []
    if phone.storage_gb:
        cfg_parts.append(f"{phone.storage_gb}GB")
    if phone.ram_gb:
        cfg_parts.append(f"{phone.ram_gb}GB RAM")
    if cfg_parts:
        lines.append(f"💾 {' / '.join(cfg_parts)}")

    # Colors
    color_qs = phone.colors.filter(is_available=True).order_by("sort_order", "name")
    color_names = [c.name for c in color_qs]
    if color_names:
        lines.append(f"🎨 {_tr('Цвета', 'Ranglar', lang)}: {', '.join(color_names)}")

    lines.append("")
    lines.append(f"💰 {_tr('Цена', 'Narxi', lang)}: {_fmt_money(phone.price, lang)}")

    rows = installment_rows(phone)
    if rows:
        lines.append("")
        installments_label = _tr("Рассрочка", "Bo'lib-bo'lib to'lash", lang)
        lines.append(f"📊 {installments_label}:")
        for r in rows:
            month_word = _tr("мес", "oy", lang)
            per_month = _tr("/ мес", "/oy", lang)
            monthly_fmt = _fmt_money(r["monthly"], lang)
            lines.append(
                f"  • {r['bank']} {r['term_months']} {month_word} — {monthly_fmt}{per_month}"
            )

    if phone.description:
        lines.append("")
        lines.append(phone.description.strip())

    lines.append("")
    contact_call = _tr("Свяжитесь для оформления", "Buyurtma uchun bog'laning", lang)
    lines.append(f"📞 {contact_call}")

    return "\n".join(lines)
