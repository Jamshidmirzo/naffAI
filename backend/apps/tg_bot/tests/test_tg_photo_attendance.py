"""
Cover the sync helpers `_bot_attendance_precheck` and
`_bot_attendance_scan_with_photo` used by the runner's `/checkin` /
`/checkout` + photo handlers. Aiogram runtime is not booted here — we
exercise the pure Django code paths that the async handlers delegate to.
"""

from __future__ import annotations

import io
import pytest
from PIL import Image
from django.contrib.auth import get_user_model

from apps.attendance.models import AttendanceLog, AttendanceSettings
from apps.operators.models import Operator
from apps.tg_bot.runner import (
    _bot_attendance_precheck,
    _bot_attendance_scan_with_photo,
)
from apps.users.models import Profile, Role


User = get_user_model()


def _tiny_jpeg(color: tuple[int, int, int] = (100, 100, 200), *, seed: int = 0) -> bytes:
    """Generate a JPEG with a coarse noise pattern so distinct calls produce
    distinct perceptual hashes (a flat-color image has an identical phash
    regardless of the fill, defeating the dup check in tests)."""
    from PIL import Image, ImageDraw
    import random

    img = Image.new("RGB", (64, 64), color)
    d = ImageDraw.Draw(img)
    rng = random.Random(seed or (color[0] * 31 + color[1] * 17 + color[2] * 7))
    for _ in range(24):
        x = rng.randint(0, 60)
        y = rng.randint(0, 60)
        d.rectangle([x, y, x + 4, y + 4], fill=(rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255)))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return buf.getvalue()


@pytest.fixture
def op_with_tg(db):
    op = Operator.objects.create(full_name="Оп Тг", status="active", phone="+998900000001")
    u = User.objects.create_user(username="tgop", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op, telegram_user_id=777001)
    # Disable face-check so synthetic images always pass — dup detection
    # is tested separately via monkey-patching the hash function.
    s = AttendanceSettings.objects.get_or_create(pk=1)[0]
    s.require_face = False
    s.save()
    return op


@pytest.mark.django_db
def test_precheck_rejects_unlinked_tg_user():
    res = _bot_attendance_precheck(9999999, "check_in")
    assert res["ok"] is False
    assert "привяжите" in res["text"].lower()


@pytest.mark.django_db
def test_precheck_check_in_when_no_open_log(op_with_tg):
    res = _bot_attendance_precheck(777001, "check_in")
    assert res["ok"] is True


@pytest.mark.django_db
def test_precheck_check_in_when_shift_already_open(op_with_tg):
    from django.utils import timezone
    AttendanceLog.objects.create(operator=op_with_tg, checked_in_at=timezone.now())
    res = _bot_attendance_precheck(777001, "check_in")
    assert res["ok"] is False
    assert "уже открыта" in res["text"].lower()


@pytest.mark.django_db
def test_precheck_check_out_without_open_log(op_with_tg):
    res = _bot_attendance_precheck(777001, "check_out")
    assert res["ok"] is False


@pytest.mark.django_db
def test_scan_with_photo_check_in_ok(op_with_tg):
    photo = _tiny_jpeg(color=(30, 200, 30))
    res = _bot_attendance_scan_with_photo(777001, "tgop", "check_in", photo)
    assert res["ok"] is True, res["text"]
    assert "смена начата" in res["text"].lower()
    log = AttendanceLog.objects.get(operator=op_with_tg)
    assert log.checkin_photo, "photo file should be saved on the log"
    assert log.checkin_photo_phash


@pytest.mark.django_db
def test_scan_with_photo_check_in_then_out_ok(op_with_tg):
    _bot_attendance_scan_with_photo(777001, "tgop", "check_in", _tiny_jpeg(seed=1))
    log = AttendanceLog.objects.get(operator=op_with_tg)
    # Wait past scan cooldown so second event isn't rate-limited.
    from django.test.utils import override_settings
    with override_settings(ATTENDANCE_SCAN_COOLDOWN_SECONDS=0):
        res = _bot_attendance_scan_with_photo(
            777001, "tgop", "check_out", _tiny_jpeg(seed=999)
        )
    assert res["ok"] is True, res["text"]
    assert "смена завершена" in res["text"].lower()
    log.refresh_from_db()
    assert log.checked_out_at is not None
    assert log.checkout_photo


@pytest.mark.django_db
def test_scan_with_photo_rejects_duplicate(op_with_tg):
    from django.utils import timezone
    known_phash = "0000000000000001"
    AttendanceLog.objects.create(
        operator=op_with_tg,
        checked_in_at=timezone.now(),
        checkin_photo_phash=known_phash,
    )
    # Force hash to always match the seeded one.
    from apps.attendance import face as face_mod
    orig = face_mod.perceptual_hash
    face_mod.perceptual_hash = lambda b: known_phash
    try:
        # Because the open log already exists, action would be check_out.
        # Our helper will short-circuit "already open" for check_in — but
        # here we test check_out with a duplicate photo.
        res = _bot_attendance_scan_with_photo(
            777001, "tgop", "check_out", _tiny_jpeg((99, 99, 99))
        )
        assert res["ok"] is False
        assert "уже использ" in res["text"].lower()
    finally:
        face_mod.perceptual_hash = orig


@pytest.mark.django_db
def test_scan_with_photo_no_face_rejected(op_with_tg):
    # Enable face-check and monkey-patch detector to always say "no face".
    s = AttendanceSettings.objects.get_or_create(pk=1)[0]
    s.require_face = True
    s.save()
    from apps.attendance import face as face_mod
    orig = face_mod.detect_face
    face_mod.detect_face = lambda b: False
    try:
        res = _bot_attendance_scan_with_photo(
            777001, "tgop", "check_in", _tiny_jpeg()
        )
        assert res["ok"] is False
        assert "лицо" in res["text"].lower() or "face" in res["text"].lower()
    finally:
        face_mod.detect_face = orig
