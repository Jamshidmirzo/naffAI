import pytest

from apps.common.validators import normalize_uz_phone


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("+998901234567", "+998901234567"),
        ("998901234567", "+998901234567"),
        ("998 90 123 45 67", "+998901234567"),
        ("90 123 45 67", "+998901234567"),
        ("(90) 123-45-67", "+998901234567"),
        ("+998-90-123-4567", "+998901234567"),
        ("Тел: 90 123 45 67", "+998901234567"),
    ],
)
def test_normalize_valid_variants(raw, expected):
    normalized, valid = normalize_uz_phone(raw)
    assert valid is True
    assert normalized == expected


@pytest.mark.parametrize(
    "raw",
    ["", None, "12345", "abcdef", "+998", "0"],
)
def test_normalize_invalid(raw):
    normalized, valid = normalize_uz_phone(raw)
    assert valid is False
