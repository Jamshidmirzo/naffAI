from apps.common.validators import extract_tac, is_valid_imei, luhn_checksum


def test_luhn_known_good_imeis():
    # Real-world valid IMEIs (each ends in correct checksum digit)
    assert is_valid_imei("490154203237518")
    assert is_valid_imei("356938035643809")


def test_luhn_known_bad_imeis():
    assert not is_valid_imei("490154203237519")  # last digit flipped
    assert not is_valid_imei("12345678901234")  # 14 digits, no checksum
    assert not is_valid_imei("")
    assert not is_valid_imei("abc154203237518")
    assert not is_valid_imei("4901542032375180")  # 16 digits


def test_luhn_checksum_value():
    # Whole 15-digit IMEI computed against the parity rule -> 0 means valid
    assert luhn_checksum("490154203237518") == 0
    # Flipping last digit breaks validity
    assert luhn_checksum("490154203237510") != 0


def test_extract_tac():
    assert extract_tac("490154203237518") == "49015420"
