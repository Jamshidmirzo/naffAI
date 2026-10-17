"""
360° spin frames: upload / replace / delete through
POST|DELETE /api/catalog/phones/<id>/spin/, and the color upsert that
keeps frames alive across a phone PATCH.
"""

from __future__ import annotations

import io
import random
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from PIL import Image
from rest_framework.test import APIClient

from apps.catalog.models import PhoneColor, PhoneModel, PhoneSpinFrame
from apps.catalog.services import _natural_key
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _media(settings, tmp_path):
    settings.MEDIA_ROOT = str(tmp_path / "media")


@pytest.fixture
def manager_client():
    user = User.objects.create_user(username="mgr_spin", password="x")
    Profile.objects.create(user=user, role=Role.MANAGER)
    c = APIClient()
    c.force_authenticate(user)
    return c


@pytest.fixture
def operator_client():
    op = Operator.objects.create(full_name="Op spin", status="active")
    user = User.objects.create_user(username="op_spin", password="x")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=op)
    c = APIClient()
    c.force_authenticate(user)
    return c


@pytest.fixture
def phone():
    p = PhoneModel.objects.create(
        brand="Apple", model_name="iPhone 16", storage_gb=128, price=Decimal("12000000.00")
    )
    PhoneColor.objects.create(phone=p, name="Black", hex_code="#000000", sort_order=0)
    PhoneColor.objects.create(phone=p, name="White", hex_code="#ffffff", sort_order=1)
    return p


def _img(name: str, *, value: int = 128, size=(1600, 900), fmt="JPEG", mode="RGB"):
    """Solid image whose red channel encodes `value` (to check frame order)."""
    color = (value, 40, 200, 0) if mode == "RGBA" else (value, 40, 200)
    buf = io.BytesIO()
    Image.new(mode, size, color).save(buf, format=fmt)
    ctype = {"JPEG": "image/jpeg", "PNG": "image/png"}[fmt]
    return SimpleUploadedFile(name, buf.getvalue(), content_type=ctype)


def _upload(client, phone, files, color_id=None):
    data = {"frames": files}
    if color_id is not None:
        data["color_id"] = str(color_id)
    return client.post(f"/api/catalog/phones/{phone.id}/spin/", data, format="multipart")


def _red(frame: PhoneSpinFrame) -> int:
    with default_storage.open(frame.image.name) as fh, Image.open(fh) as im:
        return im.convert("RGB").getpixel((im.width // 2, im.height // 2))[0]


def test_natural_key_sorts_numbers_by_value():
    names = ["10.jpg", "2.jpg", "1.jpg", "frame_011.JPG", "frame_9.jpg"]
    assert sorted(names, key=_natural_key) == [
        "1.jpg",
        "2.jpg",
        "10.jpg",
        "frame_9.jpg",
        "frame_011.JPG",
    ]


def test_upload_natural_order_webp_and_width(manager_client, phone):
    black = phone.colors.get(name="Black")
    files = [_img(f"{n}.jpg", value=n * 20) for n in range(1, 11)]
    random.Random(7).shuffle(files)

    r = _upload(manager_client, phone, files, color_id=black.id)
    assert r.status_code == 201, r.data
    assert r.data["color_id"] == black.id
    assert len(r.data["frames"]) == 10
    assert all(u.startswith("http://testserver/media/catalog/spin/") for u in r.data["frames"])

    frames = list(PhoneSpinFrame.objects.filter(phone=phone, color=black).order_by("index"))
    assert [f.index for f in frames] == list(range(10))
    # 10.jpg (red≈200) is the last frame, not the second one.
    reds = [_red(f) for f in frames]
    for n, red in enumerate(reds, start=1):
        assert abs(red - n * 20) <= 8, reds
    with default_storage.open(frames[0].image.name) as fh, Image.open(fh) as im:
        assert im.format == "WEBP"
        assert im.size == (1200, 675)
    assert frames[0].image.name.endswith(".webp")


def test_small_images_are_not_upscaled_and_alpha_is_flattened(manager_client, phone):
    files = [_img(f"{n}.png", size=(400, 300), fmt="PNG", mode="RGBA") for n in range(8)]
    r = _upload(manager_client, phone, files)  # colorless set
    assert r.status_code == 201, r.data
    assert r.data["color_id"] is None
    frame = PhoneSpinFrame.objects.get(phone=phone, color__isnull=True, index=0)
    with default_storage.open(frame.image.name) as fh, Image.open(fh) as im:
        assert im.size == (400, 300)
        # Fully transparent pixels → white background.
        assert all(ch >= 245 for ch in im.convert("RGB").getpixel((10, 10)))


def test_replace_removes_old_frames_and_files(
    manager_client, phone, django_capture_on_commit_callbacks
):
    white = phone.colors.get(name="White")
    with django_capture_on_commit_callbacks(execute=True):
        assert _upload(manager_client, phone, [_img(f"{n}.jpg") for n in range(8)], white.id).status_code == 201
    old_names = list(
        PhoneSpinFrame.objects.filter(color=white).values_list("image", flat=True)
    )
    assert all(default_storage.exists(n) for n in old_names)

    with django_capture_on_commit_callbacks(execute=True):
        r = _upload(manager_client, phone, [_img(f"{n}.jpg") for n in range(12)], white.id)
    assert r.status_code == 201
    new_names = set(PhoneSpinFrame.objects.filter(color=white).values_list("image", flat=True))
    assert len(new_names) == 12
    assert not new_names & set(old_names)
    assert not any(default_storage.exists(n) for n in old_names)
    # Other sets untouched.
    assert PhoneSpinFrame.objects.filter(phone=phone).exclude(color=white).count() == 0


def test_color_of_another_phone_400(manager_client, phone):
    other = PhoneModel.objects.create(brand="Samsung", model_name="S25", price=Decimal("1"))
    foreign = PhoneColor.objects.create(phone=other, name="Gray")
    r = _upload(manager_client, phone, [_img(f"{n}.jpg") for n in range(8)], foreign.id)
    assert r.status_code == 400
    assert r.data["field"] == "color_id"
    assert PhoneSpinFrame.objects.count() == 0
    r = manager_client.delete(f"/api/catalog/phones/{phone.id}/spin/?color_id={foreign.id}")
    assert r.status_code == 400


@pytest.mark.parametrize("count", [0, 7, 121])
def test_frame_count_bounds_400(manager_client, phone, count):
    files = [_img(f"{n}.jpg", size=(16, 16)) for n in range(count)]
    r = _upload(manager_client, phone, files)
    assert r.status_code == 400
    assert r.data["field"] == "frames"
    assert PhoneSpinFrame.objects.count() == 0


def test_not_an_image_400(manager_client, phone):
    files = [_img(f"{n}.jpg") for n in range(7)]
    files.append(SimpleUploadedFile("8.jpg", b"definitely not a jpeg", content_type="image/jpeg"))
    r = _upload(manager_client, phone, files)
    assert r.status_code == 400
    assert r.data["file"] == "8.jpg"


def test_operator_cannot_upload_or_delete(operator_client, phone):
    r = _upload(operator_client, phone, [_img(f"{n}.jpg") for n in range(8)])
    assert r.status_code == 403
    r = operator_client.delete(f"/api/catalog/phones/{phone.id}/spin/")
    assert r.status_code == 403


def test_delete_spin_set(manager_client, phone, django_capture_on_commit_callbacks):
    black = phone.colors.get(name="Black")
    _upload(manager_client, phone, [_img(f"{n}.jpg") for n in range(8)], black.id)
    _upload(manager_client, phone, [_img(f"{n}.jpg") for n in range(8)])
    names = list(PhoneSpinFrame.objects.filter(color=black).values_list("image", flat=True))

    with django_capture_on_commit_callbacks(execute=True):
        r = manager_client.delete(f"/api/catalog/phones/{phone.id}/spin/?color_id={black.id}")
    assert r.status_code == 204
    assert not PhoneSpinFrame.objects.filter(color=black).exists()
    assert not any(default_storage.exists(n) for n in names)
    # The colorless set is a different set.
    assert PhoneSpinFrame.objects.filter(phone=phone, color__isnull=True).count() == 8
    r = manager_client.delete(f"/api/catalog/phones/{phone.id}/spin/")
    assert r.status_code == 204
    assert PhoneSpinFrame.objects.count() == 0


def test_internal_serializer_exposes_spin_frames(manager_client, phone):
    black = phone.colors.get(name="Black")
    _upload(manager_client, phone, [_img(f"{n}.jpg") for n in range(8)], black.id)
    _upload(manager_client, phone, [_img(f"{n}.jpg") for n in range(9)])
    d = manager_client.get(f"/api/catalog/phones/{phone.id}/").data
    by_name = {c["name"]: c for c in d["colors"]}
    assert len(by_name["Black"]["spin_frames"]) == 8
    assert by_name["White"]["spin_frames"] == []
    assert len(d["spin_frames"]) == 9
    assert d["show_on_site"] is False
    assert d["site_slug"] == "apple-iphone-16-128gb"


# ---------------------------------------------------------------------------
# PATCH with colors — upsert by name keeps spin frames
# ---------------------------------------------------------------------------


def test_patch_colors_keeps_spin_frames_of_kept_colors(
    manager_client, phone, django_capture_on_commit_callbacks
):
    black = phone.colors.get(name="Black")
    white = phone.colors.get(name="White")
    _upload(manager_client, phone, [_img(f"{n}.jpg") for n in range(8)], black.id)
    _upload(manager_client, phone, [_img(f"{n}.jpg") for n in range(8)], white.id)
    white_files = list(PhoneSpinFrame.objects.filter(color=white).values_list("image", flat=True))

    body = {
        "colors": [
            # Same name, new hex / price / order — same row, frames stay.
            {
                "name": "Black",
                "hex_code": "#111111",
                "price_override": "12500000.00",
                "is_available": True,
                "sort_order": 1,
            },
            {"name": "Blue", "hex_code": "#0000ff", "price_override": None, "is_available": True, "sort_order": 0},
        ]
    }
    with django_capture_on_commit_callbacks(execute=True):
        r = manager_client.patch(f"/api/catalog/phones/{phone.id}/", body, format="json")
    assert r.status_code == 200, r.data

    black.refresh_from_db()
    assert black.hex_code == "#111111"
    assert black.price_override == Decimal("12500000.00")
    assert black.sort_order == 1
    assert black.spin_frames.count() == 8
    assert not PhoneColor.objects.filter(pk=white.pk).exists()
    assert not PhoneSpinFrame.objects.filter(color_id=white.pk).exists()
    assert not any(default_storage.exists(n) for n in white_files)
    assert sorted(phone.colors.values_list("name", flat=True)) == ["Black", "Blue"]
    by_name = {c["name"]: c for c in r.data["colors"]}
    assert len(by_name["Black"]["spin_frames"]) == 8
    assert by_name["Blue"]["spin_frames"] == []

    # A PATCH without `colors` leaves them alone.
    r = manager_client.patch(f"/api/catalog/phones/{phone.id}/", {"price": "1.00"}, format="json")
    assert r.status_code == 200
    assert black.spin_frames.count() == 8


def test_phone_delete_removes_spin_files(manager_client, phone, django_capture_on_commit_callbacks):
    _upload(manager_client, phone, [_img(f"{n}.jpg") for n in range(8)])
    names = list(PhoneSpinFrame.objects.values_list("image", flat=True))
    with django_capture_on_commit_callbacks(execute=True):
        assert manager_client.delete(f"/api/catalog/phones/{phone.id}/").status_code == 204
    assert PhoneSpinFrame.objects.count() == 0
    assert not any(default_storage.exists(n) for n in names)
