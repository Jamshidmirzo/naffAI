from apps.common.validators import extract_tac, is_valid_imei


def test_valid_imei_accepts_any_15_digits():
    assert is_valid_imei("490154203237518")
    assert is_valid_imei("490154203237519")  # checksum no longer enforced
    assert is_valid_imei("123456789012345")


def test_invalid_imei_rejects_wrong_shape():
    assert not is_valid_imei("")
    assert not is_valid_imei("12345678901234")  # 14 digits
    assert not is_valid_imei("4901542032375180")  # 16 digits
    assert not is_valid_imei("abc154203237518")  # has letters


def test_extract_tac():
    assert extract_tac("490154203237518") == "49015420"
