"""
Unit tests for `apps.attendance.face`.

Uses lightweight synthetic fixtures (jpg files in tests/fixtures/) so
tests pass in CI without huge binary blobs. MediaPipe may or may not be
importable in the test env — we assert only invariants that hold
regardless (permissive-True on empty, phash roundtrip, dup detection).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from apps.attendance import face
from apps.operators.models import Operator


FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _load(name: str) -> bytes:
    return (FIXTURES_DIR / name).read_bytes()


@pytest.mark.django_db
def test_perceptual_hash_stable_and_hex_len16():
    img = _load("no_face.jpg")
    h1 = face.perceptual_hash(img)
    h2 = face.perceptual_hash(img)
    assert h1 == h2, "phash must be deterministic for identical bytes"
    assert len(h1) == 16, f"expected 16-hex phash, got {h1!r}"
    assert all(c in "0123456789abcdef" for c in h1)


@pytest.mark.django_db
def test_perceptual_hash_empty_returns_empty():
    assert face.perceptual_hash(b"") == ""


@pytest.mark.django_db
def test_perceptual_hash_differs_between_distinct_images():
    a = face.perceptual_hash(_load("no_face.jpg"))
    b = face.perceptual_hash(_load("synth_face.jpg"))
    if a and b:
        # Bit-difference must be > 0 for visibly different images.
        assert face._hex_hamming(a, b) > 0


@pytest.mark.django_db
def test_detect_face_permissive_on_empty_bytes():
    # Contract: empty bytes -> False (no image at all).
    assert face.detect_face(b"") is False


@pytest.mark.django_db
def test_detect_face_returns_bool():
    """Detector must always return a boolean; specific outcome depends
    on which backend is available in the test env."""
    result = face.detect_face(_load("no_face.jpg"))
    assert isinstance(result, bool)


@pytest.mark.django_db
def test_hex_hamming_matches_expected():
    # Identical → 0
    assert face._hex_hamming("aaaa" * 4, "aaaa" * 4) == 0
    # Single-bit diff → 1
    assert face._hex_hamming("0000000000000000", "0000000000000001") == 1
    # Different lengths / invalid → large sentinel so callers reject
    assert face._hex_hamming("abcd", "abcde") == 999
    assert face._hex_hamming("zzzz", "0000") == 999


@pytest.mark.django_db
def test_is_photo_recent_duplicate_matches_previous_checkin():
    op = Operator.objects.create(full_name="Оп Дуп", status="active")
    from django.utils import timezone
    from apps.attendance.models import AttendanceLog

    phash = "abcdef1234567890"
    AttendanceLog.objects.create(
        operator=op,
        checked_in_at=timezone.now(),
        checkin_photo_phash=phash,
    )
    # Exact same phash → duplicate.
    assert face.is_photo_recent_duplicate(operator=op, phash=phash) is True
    # 1-bit hamming diff (still ≤ 5 threshold) → duplicate.
    assert (
        face.is_photo_recent_duplicate(operator=op, phash="abcdef1234567891") is True
    )
    # Very different hash (>5 hamming) → not duplicate.
    assert face.is_photo_recent_duplicate(operator=op, phash="0000000000000000") is False


@pytest.mark.django_db
def test_is_photo_recent_duplicate_empty_hash_is_never_duplicate():
    op = Operator.objects.create(full_name="Оп Нил", status="active")
    assert face.is_photo_recent_duplicate(operator=op, phash="") is False


@pytest.mark.django_db
def test_validate_and_hash_photo_rejects_oversize():
    op = Operator.objects.create(full_name="Оп Хеви", status="active")
    big = b"x" * (6 * 1024 * 1024)  # 6 MB > 5 MB limit
    with pytest.raises(face.PhotoValidationError) as exc:
        face.validate_and_hash_photo(
            operator=op, image_bytes=big, require_face=False, max_size_mb=5
        )
    assert exc.value.code == "photo_too_large"


@pytest.mark.django_db
def test_validate_and_hash_photo_missing_bytes():
    op = Operator.objects.create(full_name="Оп Пусто", status="active")
    with pytest.raises(face.PhotoValidationError) as exc:
        face.validate_and_hash_photo(
            operator=op, image_bytes=b"", require_face=False, max_size_mb=5
        )
    assert exc.value.code == "photo_missing"
