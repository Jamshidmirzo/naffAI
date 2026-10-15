"""
Pure unit tests for the flexible webhook payload parser
(apps/leads/integrations/webhook/parse.py, 2026-10-15).

LeadPixel has no public docs, so the parser has to cope with flat JSON,
Meta `field_data`, the Meta webhook envelope, arrays and form posts.
"""

from __future__ import annotations

from apps.leads.integrations.webhook.parse import (
    MAX_EXTRA_KEYS,
    extract_records,
    looks_like_uz_phone,
    normalize_key,
    parse_lead,
)


def test_normalize_key_variants():
    assert normalize_key("Phone-Number") == "phone_number"
    assert normalize_key(" Номер телефона? ") == "номер_телефона"
    assert normalize_key("qanday_telefon_xarid_qilmoqchisiz?") == "qanday_telefon_xarid_qilmoqchisiz"


def test_flat_json_english_keys():
    p = parse_lead(
        {
            "Name": "Ali Valiyev",
            "Phone": "+998 90 123-45-67",
            "product": "iPhone 15",
            "campaign_name": "Oktabr",
            "ad_id": "777",
            "lead_id": "L-1",
            "utm_source": "fb",
        }
    )
    assert p.full_name == "Ali Valiyev"
    assert p.phone_raw == "+998 90 123-45-67"
    assert p.product_hint == "iPhone 15"
    assert p.external_id == "L-1"
    assert p.ad == {"lead_id": "L-1", "campaign_name": "Oktabr", "ad_id": "777", "utm_source": "fb"}
    assert p.extra == {}


def test_flat_russian_and_uzbek_keys():
    p = parse_lead({"ФИО": "Иван", "Телефон": "901234567", "Вопрос": "Samsung A55"})
    assert (p.full_name, p.phone_raw, p.product_hint) == ("Иван", "901234567", "Samsung A55")

    p = parse_lead({"ismingiz": "Bobur", "telefon_raqamingiz": "998901112233"})
    assert (p.full_name, p.phone_raw) == ("Bobur", "998901112233")


def test_first_and_last_name_are_joined():
    p = parse_lead({"first_name": "Ali", "last_name": "Valiyev", "phone": "901234567"})
    assert p.full_name == "Ali Valiyev"


def test_meta_field_data_with_question_about_phone_model():
    """`qanday_telefon_…` is the product question, not the number."""
    p = parse_lead(
        {
            "id": "123456789012345",
            "created_time": "2026-10-15T10:00:00+0000",
            "form_id": "f1",
            "form_name": "Telefon forma",
            "field_data": [
                {"name": "qanday_telefon_xarid_qilmoqchisiz?", "values": ["iPhone 16 Pro"]},
                {"name": "full_name", "values": ["Dilshod"]},
                {"name": "phone_number", "values": ["+998901234567"]},
                {"name": "plastik_kartangiz_bormi?", "values": ["ha"]},
            ],
        }
    )
    assert p.full_name == "Dilshod"
    assert p.phone_raw == "+998901234567"
    assert p.product_hint == "iPhone 16 Pro"
    assert p.has_card == "ha"
    assert p.external_id == "123456789012345"
    assert p.ad["form_name"] == "Telefon forma"
    assert p.ad["created_time"].startswith("2026-10-15")


def test_meta_field_data_nested_under_lead_and_data():
    for wrapper in ("lead", "data"):
        p = parse_lead(
            {
                wrapper: {
                    "leadgen_id": "999",
                    "field_data": [
                        {"name": "name", "values": ["Aziz"]},
                        {"name": "phone", "values": ["90 111 22 33"]},
                    ],
                }
            }
        )
        assert p.full_name == "Aziz"
        assert p.phone_raw == "90 111 22 33"
        assert p.external_id == "999"


def test_nested_non_wrapper_objects_are_prefixed():
    """`page.id` must not become the lead's id (would break idempotency)."""
    p = parse_lead(
        {
            "name": "X",
            "phone": "901234567",
            "page": {"id": "PAGE-1"},
            "ad": {"id": "AD-1", "name": "Banner"},
        }
    )
    assert p.external_id == ""
    assert p.ad["page_id"] == "PAGE-1"
    assert p.ad["ad_id"] == "AD-1"
    assert p.ad["ad_name"] == "Banner"


def test_extract_records_meta_envelope_and_array():
    body = {
        "object": "page",
        "entry": [
            {"id": "p", "changes": [{"field": "leadgen", "value": {"leadgen_id": "1", "phone": "901234567"}}]},
            {"id": "p", "changes": [{"field": "leadgen", "value": {"leadgen_id": "2", "phone": "901234568"}}]},
        ],
    }
    recs = extract_records(body)
    assert [parse_lead(r).external_id for r in recs] == ["1", "2"]

    assert len(extract_records([{"a": 1}, {"b": 2}, "junk"])) == 2
    assert len(extract_records({"leads": [{"a": 1}, {"b": 2}]})) == 2
    assert extract_records({"a": 1}) == [{"a": 1}]
    assert extract_records("text") == []


def test_phone_fallback_only_for_phone_like_values():
    # Нет «телефонного» ключа, но кастомный вопрос с номером → найдём.
    p = parse_lead({"name": "A", "aloqa_uchun": "+998 (90) 123 45 67"})
    assert p.phone_raw == "+998 (90) 123 45 67"
    # 15-значный id — не телефон, хоть normalize_uz_phone и «съел» бы его.
    p = parse_lead({"name": "A", "leadgen_id": "123456789012345", "something": "123456789012345"})
    assert p.phone_raw == ""


def test_looks_like_uz_phone():
    assert looks_like_uz_phone("901234567")
    assert looks_like_uz_phone("+998 90 123 45 67")
    assert not looks_like_uz_phone("123456789012345")
    assert not looks_like_uz_phone("call me 901234567")


def test_product_falls_back_to_form_name_and_extra_is_bounded():
    rec = {"name": "A", "phone": "901234567", "form_name": "Kredit forma"}
    rec.update({f"q{i}": f"v{i}" for i in range(MAX_EXTRA_KEYS + 10)})
    p = parse_lead(rec)
    assert p.product_hint == "Kredit forma"
    assert len(p.extra) == MAX_EXTRA_KEYS
    assert "name" not in p.extra and "phone" not in p.extra


def test_missing_phone():
    assert parse_lead({}).missing_phone
    assert parse_lead({"foo": "bar"}).missing_phone
    assert parse_lead({"name": "Only name"}).missing_phone
    assert not parse_lead({"phone": "901234567"}).missing_phone


# ---- LeadPixel official payload (2026-10-15) ----------------------------

LEADPIXEL_BODY = {
    "name": "Ali Valiyev",
    "phone": "+998901234567",
    "email": None,
    "source": "Meta Ads",
    "meta_lead_id": "1023323200742493",
    "ad_id": "120249319606330361",
    "ad_name": "Video 1",
    "adset_name": "Toshkent 18-35",
    "campaign_name": "Sentyabr",
    "form_id": "900112233",
    "created_at": "2026-09-07T07:12:31.000Z",
    "utm_source": "facebook",
    "utm_medium": "cpc",
    "utm_campaign": "Sentyabr",
    "utm_content": "120249319606330361",
    "comment": "Заявка из формы Meta · кампания «Сентябрь» · Meta lead id 1023323200742493",
    "fields": [
        {"name": "full_name", "value": "Ali Valiyev"},
        {"name": "phone_number", "value": "+998901234567"},
        {"name": "qaysi_kurs", "value": "Frontend"},
    ],
}


def test_leadpixel_payload():
    p = parse_lead(LEADPIXEL_BODY)
    assert p.full_name == "Ali Valiyev"
    assert p.phone_raw == "+998901234567"
    assert p.external_id == "1023323200742493"
    # Нет известного product-ключа → первый «не контактный» ответ формы.
    assert p.product_hint == "qaysi_kurs: Frontend"
    assert p.comment.startswith("Заявка из формы Meta")
    assert p.email == ""
    assert p.ad == {
        "meta_lead_id": "1023323200742493",
        "form_id": "900112233",
        "campaign_name": "Sentyabr",
        "adset_name": "Toshkent 18-35",
        "ad_id": "120249319606330361",
        "ad_name": "Video 1",
        "created_at": "2026-09-07T07:12:31.000Z",
        "source": "Meta Ads",
        "utm_source": "facebook",
        "utm_medium": "cpc",
        "utm_campaign": "Sentyabr",
        "utm_content": "120249319606330361",
    }
    assert p.answers == LEADPIXEL_BODY["fields"]
    # Ответы формы лежат в answers — в extra не дублируются.
    assert p.extra == {}


def test_leadpixel_empty_top_level_name_falls_back_to_fields():
    body = {
        "name": "",
        "phone": "",
        "meta_lead_id": "1",
        "fields": [
            {"name": "name", "value": "Dilnoza"},
            {"name": "phone_number", "value": "+998 90 765 43 21"},
            {"name": "email", "value": "d@example.uz"},
        ],
    }
    p = parse_lead(body)
    assert (p.full_name, p.phone_raw, p.email) == ("Dilnoza", "+998 90 765 43 21", "d@example.uz")


def test_product_known_key_inside_fields_wins():
    body = {
        "phone": "901234567",
        "campaign_name": "Kampaniya",
        "fields": [
            {"name": "qaysi_shahar", "value": "Toshkent"},
            {"name": "qanday_telefon_xarid_qilmoqchisiz?", "value": "iPhone 16"},
        ],
    }
    assert parse_lead(body).product_hint == "iPhone 16"


def test_product_falls_back_to_campaign_then_ad_name():
    assert parse_lead({"phone": "901234567", "campaign_name": "C", "ad_name": "A"}).product_hint == "C"
    assert parse_lead({"phone": "901234567", "ad_name": "A"}).product_hint == "A"
    # Только контактные ответы → к кампании.
    body = {"phone": "901234567", "ad_name": "A", "fields": [{"name": "full_name", "value": "X"}]}
    assert parse_lead(body).product_hint == "A"


def test_external_id_order():
    assert parse_lead({"phone": "1", "meta_lead_id": "M", "id": "I"}, idempotency_key="H").external_id == "M"
    assert parse_lead({"phone": "1", "leadgen_id": "G"}, idempotency_key="H").external_id == "H"
    assert parse_lead({"phone": "1", "leadgen_id": "G", "id": "I"}).external_id == "G"
