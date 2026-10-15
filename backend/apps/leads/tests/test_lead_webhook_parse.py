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


def test_empty_record():
    assert parse_lead({"foo": "bar"}).is_empty
    assert not parse_lead({"name": "Only name"}).is_empty
