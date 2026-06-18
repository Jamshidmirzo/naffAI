from rest_framework import serializers
from rest_framework.generics import ListCreateAPIView, RetrieveUpdateAPIView
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.users.permissions import IsTeamLead, IsTeamLeadOrManagerReadOnly

from .models import Operator
from .selectors import operator_get, operator_list
from .services import (
    operator_create,
    operator_deactivate,
    operator_delete,
    operator_reactivate,
    operator_update,
)


class OperatorSerializer(serializers.ModelSerializer):
    class Meta:
        model = Operator
        fields = [
            "id",
            "full_name",
            "phone",
            "status",
            "hired_at",
            "note",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]


class OperatorListCreateApi(ListCreateAPIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]
    serializer_class = OperatorSerializer

    def get_queryset(self):
        return operator_list(
            search=self.request.query_params.get("search"),
            status=self.request.query_params.get("status"),
            include_inactive=self.request.query_params.get("include_inactive", "1") != "0",
        )

    def perform_create(self, serializer):
        instance = operator_create(user=self.request.user, **serializer.validated_data)
        serializer.instance = instance


class OperatorDetailApi(RetrieveUpdateAPIView):
    permission_classes = [IsTeamLead]
    serializer_class = OperatorSerializer
    queryset = Operator.objects.all()

    def perform_update(self, serializer):
        instance = operator_update(
            operator=serializer.instance, user=self.request.user, **serializer.validated_data
        )
        serializer.instance = instance


class OperatorDeactivateApi(APIView):
    permission_classes = [IsTeamLead]

    def post(self, request, pk: int):
        op = operator_get(pk)
        if not op:
            return Response({"detail": "Not found"}, status=404)
        operator_deactivate(operator=op, user=request.user)
        return Response(OperatorSerializer(op).data)


class OperatorReactivateApi(APIView):
    permission_classes = [IsTeamLead]

    def post(self, request, pk: int):
        op = operator_get(pk)
        if not op:
            return Response({"detail": "Not found"}, status=404)
        operator_reactivate(operator=op, user=request.user)
        return Response(OperatorSerializer(op).data)


class OperatorDeleteApi(APIView):
    permission_classes = [IsTeamLead]

    def delete(self, request, operator_id: int):
        op = operator_get(operator_id)
        if not op:
            return Response({"detail": "Not found"}, status=404)
        operator_delete(operator=op, user=request.user)
        return Response(status=204)
