"""
Flexible parsing of inbound webhook lead payloads (pure functions, no DB).

LeadPixel («Своя CRM») has no public documentation of what it POSTs, and
other tools (Make, Zapier, Tilda, raw Meta Lead Ads) each use their own
shape. So instead of one schema we accept what is commonly seen:

* a flat object: ``{"name": "...", "phone": "...", "campaign_name": ...}``;
* Meta Lead Ads (Graph API lead object):
  ``{"id": ..., "form_id": ..., "field_data": [{"name": "phone_number",
  "values": ["+998..."]}, ...]}`` — also nested under ``lead`` / ``data``;
* the Meta webhook envelope:
  ``{"object": "page", "entry": [{"changes": [{"value": {...}}]}]}``;
* an array of any of the above, or ``{"leads": [...]}``.

Keys are matched case-insensitively after normalisation (punctuation and
spaces → ``_``), with ru/en/uz variants. Everything we could not map to a
lead field lands in ``extra`` (bounded) so the raw shape can be studied
from the CRM side.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# Сколько записей максимум принимаем из одного запроса (массив / envelope).
MAX_RECORDS = 100
# Ограничители для metadata["extra"].
MAX_EXTRA_KEYS = 40
MAX_VALUE_LEN = 500

PHONE_KEYS: tuple[str, ...] = (
    "phone",
    "phone_number",
    "phonenumber",
    "phone_raw",
    "tel",
    "telephone",
    "mobile",
    "mobile_phone",
    "contact_phone",
    "client_phone",
    "customer_phone",
    "телефон",
    "номер",
    "номер_телефона",
    "мобильный",
    "telefon",
    "telefon_raqam",
    "telefon_raqami",
    "telefon_raqamingiz",
    "telefoningiz",
    "raqam",
    "raqamingiz",
)
# Токены для «мягкого» поиска телефона по имени ключа (только если
# значение действительно похоже на номер — «qanday_telefon_…» это вопрос
# про модель, а не номер).
PHONE_KEY_TOKENS: frozenset[str] = frozenset(
    {"phone", "tel", "telephone", "mobile", "телефон", "номер", "telefon", "raqam",
     "raqami", "raqamingiz", "telefoningiz"}
)

NAME_KEYS: tuple[str, ...] = (
    "full_name",
    "fullname",
    "name",
    "fio",
    "client_name",
    "customer_name",
    "contact_name",
    "lead_name",
    "фио",
    "имя",
    "имя_фамилия",
    "ваше_имя",
    "ism",
    "ismingiz",
    "ism_familiya",
    "ismi",
    "to_liq_ism",
    "toliq_ism",
)
FIRST_NAME_KEYS: tuple[str, ...] = ("first_name", "firstname", "имя_клиента", "ism")
LAST_NAME_KEYS: tuple[str, ...] = ("last_name", "lastname", "surname", "фамилия", "familiya")

PRODUCT_KEYS: tuple[str, ...] = (
    "product_hint",
    "product",
    "product_name",
    "question",
    "вопрос",
    "model",
    "phone_model",
    "модель",
    "товар",
    "qanday_telefon_xarid_qilmoqchisiz",
    "qaysi_telefon",
    "qanday_telefon",
    "comment",
    "комментарий",
    "izoh",
)
PRODUCT_KEY_TOKENS: frozenset[str] = frozenset(
    {"product", "model", "модель", "товар", "qanday", "qaysi", "вопрос", "question"}
)

HAS_CARD_KEYS: tuple[str, ...] = (
    "has_card",
    "plastik_kartangiz_bormi",
    "plastik_karta",
    "karta",
    "карта",
    "есть_карта",
)

# Атрибуция рекламы → metadata["ad"]. Ключ = как храним, значения = как
# может прийти (после нормализации).
AD_KEYS: dict[str, tuple[str, ...]] = {
    "leadgen_id": ("leadgen_id", "leadgenid"),
    "lead_id": ("lead_id", "leadid"),
    "id": ("id",),
    "form_id": ("form_id", "formid"),
    "form_name": ("form_name", "formname", "form"),
    "campaign_id": ("campaign_id", "campaignid"),
    "campaign_name": ("campaign_name", "campaignname", "campaign"),
    "adset_id": ("adset_id", "adsetid", "adgroup_id"),
    "adset_name": ("adset_name", "adsetname", "adgroup_name"),
    "ad_id": ("ad_id", "adid"),
    "ad_name": ("ad_name", "adname"),
    "page_id": ("page_id", "pageid"),
    "platform": ("platform", "source_platform"),
    "created_time": ("created_time", "createdtime", "created_at"),
    "is_organic": ("is_organic",),
    "utm_source": ("utm_source",),
    "utm_medium": ("utm_medium",),
    "utm_campaign": ("utm_campaign",),
    "utm_content": ("utm_content",),
    "utm_term": ("utm_term",),
}

# Вложенные «обёртки», содержимое которых поднимаем на верхний уровень.
_WRAPPER_KEYS = ("lead", "data", "fields", "answers", "contact", "client", "customer", "custom_fields")
# Списки вида [{"name": ..., "values": [...]}] (Meta field_data и похожие).
_FIELD_LIST_KEYS = ("field_data", "fields", "answers", "custom_fields", "questions")
# Служебные ключи envelope'а — не тащим в extra.
_ENVELOPE_KEYS = frozenset({"object", "entry", "changes", "field", "time", "leads"})


@dataclass
class ParsedLead:
    full_name: str = ""
    phone_raw: str = ""
    product_hint: str = ""
    has_card: str = ""
    external_id: str = ""
    ad: dict[str, str] = field(default_factory=dict)
    extra: dict[str, str] = field(default_factory=dict)

    @property
    def is_empty(self) -> bool:
        return not self.phone_raw and not self.full_name


def normalize_key(key: Any) -> str:
    """'Номер телефона?' → 'номер_телефона'; 'Phone-Number' → 'phone_number'."""
    s = str(key or "").strip().lower()
    s = re.sub(r"[^\w]+", "_", s, flags=re.UNICODE)
    return re.sub(r"_+", "_", s).strip("_")


def _scalar_text(value: Any) -> str:
    """Values may be lists (Meta `values`), numbers, bools — fold to text."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, tuple)):
        parts = [_scalar_text(v) for v in value if not isinstance(v, (dict, list, tuple))]
        return ", ".join(p for p in parts if p)
    if isinstance(value, dict):
        return ""
    return str(value).strip()


def _field_list_to_dict(items: list) -> dict[str, str]:
    """[{"name": "phone_number", "values": ["+998…"]}] → {"phone_number": "+998…"}."""
    out: dict[str, str] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        name = item.get("name") or item.get("key") or item.get("field") or item.get("label")
        if not name:
            continue
        if "values" in item:
            val = item.get("values")
        elif "value" in item:
            val = item.get("value")
        else:
            val = item.get("answer")
        key = normalize_key(name)
        if key and key not in out:
            out[key] = _scalar_text(val)
    return out


def flatten_record(record: dict, _depth: int = 0) -> dict[str, str]:
    """
    One lead record → flat {normalized_key: text}. Top-level keys win over
    nested ones; field-lists and wrapper objects are merged in without
    overriding. Bounded depth — webhook bodies are untrusted.
    """
    flat: dict[str, str] = {}
    nested: list[tuple[str, dict]] = []
    for raw_key, value in record.items():
        key = normalize_key(raw_key)
        if not key:
            continue
        if isinstance(value, list) and value and all(isinstance(v, dict) for v in value):
            if key in _FIELD_LIST_KEYS:
                for k, v in _field_list_to_dict(value).items():
                    flat.setdefault(k, v)
            continue
        if isinstance(value, dict):
            if _depth < 3:
                nested.append((key, value))
            continue
        if key in _ENVELOPE_KEYS:
            continue
        flat.setdefault(key, _scalar_text(value))
    for key, sub in nested:
        # `lead` / `data` / … — обёртки: поднимаем как есть. Прочие объекты
        # ({"ad": {"id": 1, "name": "x"}}) — с префиксом: ad_id, ad_name.
        # Без префикса вложенный `page.id` перебил бы id лида и сломал
        # идемпотентность.
        prefix = "" if key in _WRAPPER_KEYS else f"{key}_"
        for k, v in flatten_record(sub, _depth + 1).items():
            flat.setdefault(f"{prefix}{k}", v)
    return flat


def extract_records(body: Any) -> list[dict]:
    """
    Split a request body into lead records:
      * list → each dict element (envelopes inside are expanded too);
      * ``{"entry": [{"changes": [{"value": {...}}]}]}`` → each change value;
      * ``{"leads": [...]}`` → each element;
      * any other dict → itself.
    Capped at MAX_RECORDS.
    """
    out: list[dict] = []

    def _walk(node: Any, depth: int = 0) -> None:
        if len(out) >= MAX_RECORDS or depth > 3:
            return
        if isinstance(node, list):
            for item in node:
                _walk(item, depth + 1)
            return
        if not isinstance(node, dict):
            return
        entries = node.get("entry")
        if isinstance(entries, list):
            values = [
                ch.get("value")
                for e in entries
                if isinstance(e, dict)
                for ch in (e.get("changes") or [])
                if isinstance(ch, dict) and isinstance(ch.get("value"), dict)
            ]
            if values:
                for v in values:
                    _walk(v, depth + 1)
                return
        leads = node.get("leads")
        if isinstance(leads, list) and leads and all(isinstance(x, dict) for x in leads):
            for item in leads:
                _walk(item, depth + 1)
            return
        out.append(node)

    _walk(body)
    return out[:MAX_RECORDS]


def _first(flat: dict[str, str], keys: tuple[str, ...]) -> tuple[str, str]:
    for k in keys:
        v = flat.get(k)
        if v:
            return k, v
    return "", ""


_PHONE_CHARS_RE = re.compile(r"^[\d\s+\-().]{9,24}$")


def looks_like_uz_phone(value: str) -> bool:
    """
    Stricter than `normalize_uz_phone` (which takes the last 9 digits of
    anything ≥ 9 digits — a 15-digit leadgen_id would «pass»): only phone
    characters, and 9 digits or 12 starting with 998.
    """
    if not value or not _PHONE_CHARS_RE.match(value.strip()):
        return False
    digits = re.sub(r"\D", "", value)
    return len(digits) == 9 or (len(digits) == 12 and digits.startswith("998"))


def _ad_key_set() -> frozenset[str]:
    return frozenset(k for variants in AD_KEYS.values() for k in variants)


def _pick_phone(flat: dict[str, str]) -> tuple[str, str]:
    key, val = _first(flat, PHONE_KEYS)
    if val:
        return key, val
    ad_keys = _ad_key_set()
    # 2. Ключ «похож на телефон» по токенам и значение похоже на номер.
    for k, v in flat.items():
        if k in ad_keys or not v:
            continue
        if PHONE_KEY_TOKENS & set(k.split("_")) and looks_like_uz_phone(v):
            return k, v
    # 3. Любое значение, похожее на узбекский номер (кастомные вопросы).
    for k, v in flat.items():
        if k in ad_keys or not v:
            continue
        if looks_like_uz_phone(v):
            return k, v
    return "", ""


def _pick_product(flat: dict[str, str], used: set[str]) -> tuple[str, str]:
    key, val = _first(flat, PRODUCT_KEYS)
    if val:
        return key, val
    for k, v in flat.items():
        if k in used or not v:
            continue
        if PRODUCT_KEY_TOKENS & set(k.split("_")):
            return k, v
    return "", ""


def _clip(value: str, n: int = MAX_VALUE_LEN) -> str:
    return value[:n]


def parse_lead(record: dict) -> ParsedLead:
    """One record (already split by `extract_records`) → `ParsedLead`."""
    flat = flatten_record(record if isinstance(record, dict) else {})
    used: set[str] = set()

    phone_key, phone = _pick_phone(flat)
    if phone_key:
        used.add(phone_key)

    name_key, full_name = _first(flat, NAME_KEYS)
    if name_key:
        used.add(name_key)
    else:
        fk, first = _first(flat, FIRST_NAME_KEYS)
        lk, last = _first(flat, LAST_NAME_KEYS)
        full_name = " ".join(p for p in (first, last) if p)
        used.update(k for k in (fk, lk) if k)

    card_key, has_card = _first(flat, HAS_CARD_KEYS)
    if card_key:
        used.add(card_key)

    ad: dict[str, str] = {}
    for target, variants in AD_KEYS.items():
        k, v = _first(flat, variants)
        if v:
            ad[target] = _clip(v, 256)
            used.add(k)

    product_key, product = _pick_product(flat, used)
    if product_key:
        used.add(product_key)
    elif ad.get("form_name"):
        product = ad["form_name"]

    external_id = ad.get("leadgen_id") or ad.get("lead_id") or ad.get("id") or ""

    extra: dict[str, str] = {}
    for k, v in flat.items():
        if k in used or not v:
            continue
        if len(extra) >= MAX_EXTRA_KEYS:
            break
        extra[k[:64]] = _clip(v)

    return ParsedLead(
        full_name=_clip(full_name, 128),
        phone_raw=_clip(phone, 64),
        product_hint=_clip(product, 256),
        has_card=_clip(has_card, 64),
        external_id=_clip(external_id, 128),
        ad=ad,
        extra=extra,
    )
