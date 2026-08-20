"""
Phone catalog API — CRUD for PhoneModel + PhoneColor + quote endpoint.

GET (list/detail/quote) is open to any authenticated user (operators
need read access to send offers to clients). Writes are manager-only
(team_lead role kept for backward-compat but hidden from UI — see
`project_naffai_roles` in agent memory).
"""

from __future__ import annotations

from rest_framework import serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import BasePermission
from rest_framework.response import Response

from apps.users.permissions import IsAuthenticatedAnyRole, IsManager

from decimal import Decimal

from .models import InstallmentTier, PhoneColor, PhoneGalleryPhoto, PhoneModel
from .quote_builder import (
    _ceil_thousand,
    build_marketing_text,
    build_phone_quote,
    installment_rows,
)


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
    class Meta:
        model = PhoneColor
        fields = ["id", "name", "hex_code", "price_override", "is_available", "sort_order"]


class PhoneGalleryPhotoSerializer(serializers.ModelSerializer):
    photo_url = serializers.SerializerMethodField()

    class Meta:
        model = PhoneGalleryPhoto
        fields = ["id", "position", "photo_url", "uploaded_at"]
        read_only_fields = fields

    def get_photo_url(self, obj: PhoneGalleryPhoto) -> str | None:
        if not obj.photo:
            return None
        request = self.context.get("request")
        url = obj.photo.url
        return request.build_absolute_uri(url) if request else url


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
            "colors",
            "gallery",
            "marketing_text_uz",
            "installment_preview",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "cover_image_url",
            "gallery",
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
        }

    def get_cover_image_url(self, obj: PhoneModel) -> str | None:
        if not obj.cover_image:
            return None
        request = self.context.get("request")
        url = obj.cover_image.url
        return request.build_absolute_uri(url) if request else url

    def get_marketing_text_uz(self, obj: PhoneModel) -> str:
        try:
            return build_marketing_text(obj, language="uz")
        except Exception:
            return ""

    def get_installment_preview(self, obj: PhoneModel) -> list[dict]:
        price = obj.price or Decimal("0")
        if price <= 0:
            return []
        tiers = InstallmentTier.objects.filter(
            is_active=True, show_in_marketing=True
        ).order_by("sort_order", "months")
        out: list[dict] = []
        for t in tiers:
            if not t.months:
                continue
            total = price * (Decimal("1") + t.commission_pct / Decimal("100"))
            monthly = total / Decimal(t.months)
            rounded = _ceil_thousand(monthly)
            if rounded <= 0:
                continue
            out.append({"months": int(t.months), "monthly": rounded})
        return out

    def create(self, validated_data):
        colors_data = validated_data.pop("colors", None) or []
        phone = PhoneModel.objects.create(**validated_data)
        for c in colors_data:
            PhoneColor.objects.create(phone=phone, **c)
        return phone

    def update(self, instance, validated_data):
        colors_data = validated_data.pop("colors", None)
        for k, v in validated_data.items():
            setattr(instance, k, v)
        instance.save()
        if colors_data is not None:
            # Full replace on PATCH — simpler than diffing incoming ids.
            instance.colors.all().delete()
            for c in colors_data:
                PhoneColor.objects.create(phone=instance, **c)
        return instance


class PhoneModelViewSet(viewsets.ModelViewSet):
    permission_classes = [WritesManager]
    parser_classes = [JSONParser, MultiPartParser, FormParser]
    serializer_class = PhoneModelSerializer

    def get_queryset(self):
        qs = PhoneModel.objects.all().prefetch_related("colors")
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
