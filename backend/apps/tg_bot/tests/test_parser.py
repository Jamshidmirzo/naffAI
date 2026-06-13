from apps.tg_bot.parser import parse_message


def test_parses_typical_message():
    msg = """IMEI: 490154203237518
модель: iPhone 13 Pro
продал: Алишер Каримов
сумма: 12 500 000"""
    p = parse_message(msg)
    assert p.imei == "490154203237518"
    assert p.model == "iPhone 13 Pro"
    assert p.seller_hint == "Алишер Каримов"
    assert p.amount == "12500000"


def test_no_imei_returns_none_imei():
    p = parse_message("Hello there")
    assert p.imei is None


def test_imei_extracted_without_label():
    p = parse_message("Bare 490154203237518 in the middle")
    assert p.imei == "490154203237518"
