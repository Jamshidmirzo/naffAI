"""
Phone catalog API — CRUD for PhoneModel + PhoneColor + quote endpoint.

GET (list/detail/quote) is open to any authenticated user (operators
need read access to send offers to clients). Writes are manager-only
(team_lead role kept for backward-compat but hidden from UI — see
`project_naffai_roles` in agent memory).
"""

from __future__ import annotations

import re

from django.db import transaction
from rest_framework import serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import BasePermission
from rest_framework.response import Response

from apps.common.exceptions import ApplicationError
from apps.users.permissions import IsAuthenticatedAnyRole, IsManager

from .models import PhoneColor, PhoneGalleryPhoto, PhoneModel
from .quote_builder import (
    build_marketing_text,
    build_phone_quote,
    installment_monthly_rows,
    installment_rows,
)
from .selectors import installment_tiers_for_marketing
from .services import (
    phone_colors_sync,
    phone_spin_clear,
    phone_spin_files_cleanup,
    phone_spin_replace,
)

_SITE_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _abs_url(request, field) -> str | None:
    if not field:
        return None
    url = field.url
    return request.build_absolute_uri(url) if request else url


class WritesManager(BasePermission):
    def has_permission(self, request, view):
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return IsAuthenticatedAnyRole().has_permission(request, view)
        return IsManager().has_permission(request, view)


# Legacy alias — kept so downstream imports don't break if anything else
# in the codebase references `WritesTeamLead`. Both classes now behave
# identically: manager-only writes.
WritesTeamLead = WritesManager


class PhoneColorSerializer(serializers.ModelSerializer):
    # 360° frames of this color (urls, rotation order). Read-only: frames
    # are managed through POST/DELETE /catalog/phones/<id>/spin/.
    spin_frames = serializers.SerializerMethodField()

    class Meta:
        model = PhoneColor
        fields = [
            "id",
            "name",
            "hex_code",
            "price_override",
            "is_available",
            "sort_order",
            "spin_frames",
        ]

    def get_spin_frames(self, obj: PhoneColor) -> list[str]:
        request = self.context.get("request")
        return [_abs_url(request, f.image) for f in obj.spin_frames.all()]


class PhoneGalleryPhotoSerializer(serializers.ModelSerializer):
    photo_url = serializers.SerializerMethodField()

    class Meta:
        model = PhoneGalleryPhoto
        fields = ["id", "position", "photo_url", "uploaded_at"]
        read_only_fields = fields

    def get_photo_url(self, obj: PhoneGalleryPhoto) -> str | None:
        return _abs_url(self.context.get("request"), obj.photo)


class PhoneModelSerializer(serializers.ModelSerializer):
    colors = PhoneColorSerializer(many=True, required=False)
    cover_image_url = serializers.SerializerMethodField()
    gallery = PhoneGalleryPhotoSerializer(many=True, read_only=True)
    # Pre-baked marketing text so the frontend copy-to-clipboard button
    # can call navigator.clipboard.writeText SYNCHRONOUSLY in the click
    # handler — awaiting a fetch first would drop the user gesture on
    # Safari/iOS and the browser blocks the paste with "not allowed by
    # the user agent." Payload cost: ~700 bytes/phone; acceptable at
    # catalog scale (~dozens of items).
    marketing_text_uz = serializers.SerializerMethodField()
    # Pre-computed monthly payments for the tiers flagged
    # `show_in_marketing`. Rendered as a compact "6 oy → 750 000 · 12 oy
    # → 414 000" strip under the price on the catalog card so the
    # operator sees ready-to-quote monthly instalments at a glance
    # without opening a calculator or the marketing text.
    installment_preview = serializers.SerializerMethodField()
    # Colorless 360° set (phones without colors); per-color sets live in
    # `colors[].spin_frames`.
    spin_frames = serializers.SerializerMethodField()

    class Meta:
        model = PhoneModel
        fields = [
            "id",
            "brand",
            "model_name",
            "storage_gb",
            "ram_gb",
            "price",
            "cover_image",
            "cover_image_url",
            "description",
            "tagline",
            "camera_mp",
            "battery_mah",
            "specs_json",
            "stock_status",
            "is_active",
            "sort_order",
            "show_on_site",
            "site_slug",
            "description_ru",
            "colors",
            "gallery",
            "spin_frames",
            "marketing_text_uz",
            "installment_preview",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "cover_image_url",
            "gallery",
            "spin_frames",
            "marketing_text_uz",
            "installment_preview",
            "created_at",
            "updated_at",
        ]
        extra_kwargs = {
            "cover_image": {"write_only": True, "required": False, "allow_null": True},
            "tagline": {"required": False, "allow_blank": True},
            "camera_mp": {"required": False, "allow_null": True},
            "battery_mah": {"required": False, "allow_null": True},
            "specs_json": {"required": False},
            # Empty / null → auto-generated from brand + model + storage.
            "site_slug": {"required": False, "allow_null": True, "allow_blank": True},
            "description_ru": {"required": False, "allow_blank": True},
        }

    def validate_site_slug(self, value: str | None) -> str | None:
        value = (value or "").strip().lower()
        if not value:
            return None
        if not _SITE_SLUG_RE.match(value):
            raise serializers.ValidationError(
                "Только латиница в нижнем регистре, цифры и дефис (apple-iphone-16-pro-256gb)"
            )
        taken = PhoneModel.objects.filter(site_slug=value)
        if self.instance is not None:
            taken = taken.exclude(pk=self.instance.pk)
        if taken.exists():
            raise serializers.ValidationError("Этот адрес уже занят другим телефоном")
        return value

    def get_cover_image_url(self, obj: PhoneModel) -> str | None:
        return _abs_url(self.context.get("request"), obj.cover_image)

    def get_spin_frames(self, obj: PhoneModel) -> list[str]:
        request = self.context.get("request")
        return [_abs_url(request, f.image) for f in obj.spin_frames.all() if f.color_id is None]

    def get_marketing_text_uz(self, obj: PhoneModel) -> str:
        try:
            return build_marketing_text(obj, language="uz")
        except Exception:
            return ""

    def get_installment_preview(self, obj: PhoneModel) -> list[dict]:
        # Same formula as the marketing text and the public site
        # (quote_builder.installment_monthly_rows). Tiers are read once per
        # response, not once per card.
        tiers = self.context.get("_marketing_tiers")
        if tiers is None:
            tiers = installment_tiers_for_marketing()
            self.context["_marketing_tiers"] = tiers
        return [
            {"months": r["months"], "monthly": r["monthly"]}
            for r in installment_monthly_rows(obj.price, tiers)
        ]

    @transaction.atomic
    def create(self, validated_data):
        colors_data = validated_data.pop("colors", None) or []
        phone = PhoneModel.objects.create(**validated_data)
        phone_colors_sync(phone=phone, colors_data=colors_data)
        return phone

    @transaction.atomic
    def update(self, instance, validated_data):
        colors_data = validated_data.pop("colors", None)
        for k, v in validated_data.items():
            setattr(instance, k, v)
        instance.save()
        if colors_data is not None:
            # Upsert by name — keeps color ids (and their 360° frames) for
            # colors that are still in the list.
            phone_colors_sync(phone=instance, colors_data=colors_data)
        return instance


class PhoneModelViewSet(viewsets.ModelViewSet):
    permission_classes = [WritesManager]
    parser_classes = [JSONParser, MultiPartParser, FormParser]
    serializer_class = PhoneModelSerializer

    def get_queryset(self):
        qs = PhoneModel.objects.all().prefetch_related(
            "colors__spin_frames", "spin_frames", "gallery"
        )
        params = self.request.query_params
        if params.get("search"):
            q = params["search"].strip()
            from django.db.models import Q

            qs = qs.filter(Q(brand__icontains=q) | Q(model_name__icontains=q))
        if params.get("brand"):
            qs = qs.filter(brand__iexact=params["brand"])
        if params.get("stock"):
            qs = qs.filter(stock_status=params["stock"])
        if params.get("only_active") in ("1", "true"):
            qs = qs.filter(is_active=True)
        return qs

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    @transaction.atomic
    def perform_destroy(self, instance):
        phone_spin_files_cleanup(phone=instance)
        instance.delete()

    @action(detail=True, methods=["get"])
    def quote(self, request, pk=None):
        phone = self.get_object()
        lang = request.query_params.get("lang", "uz")
        text = build_phone_quote(phone, language=lang)
        cover_url = None
        if phone.cover_image:
            cover_url = request.build_absolute_uri(phone.cover_image.url)
        return Response(
            {
                "text": text,
                "cover_image_url": cover_url,
                "installments": [
                    {
                        "bank": r["bank"],
                        "bank_icon": r["bank_icon"],
                        "term_months": r["term_months"],
                        "monthly": str(r["monthly"]),
                        "total": str(r["total"]),
                        "overpay": str(r["overpay"]),
                    }
                    for r in installment_rows(phone)
                ],
            }
        )

    @action(detail=True, methods=["post"])
    def upload_photo(self, request, pk=None):
        phone = self.get_object()
        f = request.FILES.get("cover_image") or request.FILES.get("file")
        if not f:
            return Response({"detail": "cover_image file is required"}, status=400)
        phone.cover_image = f
        phone.save(update_fields=["cover_image", "updated_at"])
        return Response(PhoneModelSerializer(phone, context={"request": request}).data)

    @action(detail=True, methods=["post"], url_path="gallery/upload")
    def gallery_upload(self, request, pk=None):
        """Append one gallery photo. Front-end calls this per-file."""
        phone = self.get_object()
        f = request.FILES.get("photo") or request.FILES.get("file")
        if not f:
            return Response({"detail": "photo file is required"}, status=400)
        last = phone.gallery.order_by("-position").first()
        next_pos = (last.position + 1) if last else 0
        item = PhoneGalleryPhoto.objects.create(phone=phone, photo=f, position=next_pos)
        return Response(
            PhoneGalleryPhotoSerializer(item, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )

    @action(
        detail=True,
        methods=["delete"],
        url_path=r"gallery/(?P<photo_id>[0-9]+)",
    )
    def gallery_delete(self, request, pk=None, photo_id=None):
        phone = self.get_object()
        item = phone.gallery.filter(pk=photo_id).first()
        if not item:
            return Response(status=status.HTTP_404_NOT_FOUND)
        item.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    # -- 360° spin -------------------------------------------------------

    def _spin_color(self, phone: PhoneModel, raw) -> PhoneColor | None:
        """`color_id` from the request → PhoneColor of this phone, or None
        (colorless set). Unknown / someone else's color → ApplicationError."""
        if raw in (None, "", "null"):
            return None
        try:
            color_id = int(raw)
        except (TypeError, ValueError):
            raise ApplicationError("color_id должен быть числом", {"field": "color_id"}) from None
        color = phone.colors.filter(pk=color_id).first()
        if color is None:
            raise ApplicationError("Цвет не принадлежит этому телефону", {"field": "color_id"})
        return color

    @action(
        detail=True,
        methods=["post", "delete"],
        url_path="spin",
        parser_classes=[MultiPartParser, FormParser],
    )
    def spin(self, request, pk=None):
        """
        POST   multipart `frames` (8..120 files) + optional `color_id` —
               replaces the 360° set of that color (none → colorless set).
        DELETE ?color_id=<id> — removes the set.
        """
        phone = self.get_object()
        try:
            if request.method == "DELETE":
                color = self._spin_color(phone, request.query_params.get("color_id"))
                phone_spin_clear(phone=phone, color=color, user=request.user)
                return Response(status=status.HTTP_204_NO_CONTENT)
            color = self._spin_color(phone, request.data.get("color_id"))
            frames = phone_spin_replace(
                phone=phone,
                color=color,
                files=request.FILES.getlist("frames"),
                user=request.user,
            )
        except ApplicationError as exc:
            return Response(
                {"detail": exc.message, **exc.extra}, status=status.HTTP_400_BAD_REQUEST
            )
        return Response(
            {
                "color_id": color.id if color else None,
                "frames": [_abs_url(request, f.image) for f in frames],
            },
            status=status.HTTP_201_CREATED,
        )
