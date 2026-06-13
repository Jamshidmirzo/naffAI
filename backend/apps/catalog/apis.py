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
