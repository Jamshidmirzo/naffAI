from rest_framework import serializers, status
from rest_framework.generics import ListCreateAPIView, RetrieveUpdateAPIView
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.users.permissions import IsTeamLead, IsTeamLeadOrManagerReadOnly

from .imei_service import imei_lookup
from .models import Channel
from .selectors import channel_list
from .services import channel_create, channel_update


class ChannelSerializer(serializers.ModelSerializer):
    class Meta:
        model = Channel
        fields = ["id", "name", "is_active", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class ChannelListCreateApi(ListCreateAPIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]
    serializer_class = ChannelSerializer

    def get_queryset(self):
        active_only = self.request.query_params.get("active_only") == "1"
        return channel_list(active_only=active_only)

    def perform_create(self, serializer):
        instance = channel_create(
            user=self.request.user,
            name=serializer.validated_data["name"],
            is_active=serializer.validated_data.get("is_active", True),
        )
        serializer.instance = instance


class ChannelDetailApi(RetrieveUpdateAPIView):
    permission_classes = [IsTeamLead]
    serializer_class = ChannelSerializer
    queryset = Channel.objects.all()

    def perform_update(self, serializer):
        instance = channel_update(
            channel=serializer.instance,
            user=self.request.user,
            **serializer.validated_data,
        )
        serializer.instance = instance


class ImeiLookupApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request, imei: str):
        result = imei_lookup(imei)
        if not result.valid:
            return Response(
                {"valid": False, "detail": "IMEI должен быть из 6–15 цифр"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(result.as_dict())


class PhoneModelSuggestApi(APIView):
    """
    Returns up to ~50 distinct phone-model names known to the system,
    sorted by how often they've been sold. Optional `?q=` substring
    filter so the frontend datalist can be searched. Used by the
    "model" combobox on the Sale create form.
    """

    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        from django.db.models import Count

        from apps.sales.models import Sale

        q = (request.query_params.get("q") or "").strip()
        qs = (
            Sale.objects.exclude(phone_model__in=["", "Не определена"])
            .values("phone_model")
            .annotate(n=Count("id"))
            .order_by("-n", "phone_model")
        )
        if q:
            qs = qs.filter(phone_model__icontains=q)

        from_sales = [r["phone_model"] for r in qs[:50]]

        # If we still have spare slots, mix in TAC-catalog brand+model
        # strings so a brand-new shop sees suggestions even on day one.
        if len(from_sales) < 50:
            from .models import TacLookup

            tac_qs = TacLookup.objects.all()
            if q:
                tac_qs = tac_qs.filter(brand__icontains=q) | tac_qs.filter(model__icontains=q)
            tac_names = [f"{t.brand} {t.model}".strip() for t in tac_qs[: 50 - len(from_sales)]]
            seen = set(from_sales)
            for name in tac_names:
                if name not in seen:
                    seen.add(name)
                    from_sales.append(name)

        return Response({"results": from_sales})
