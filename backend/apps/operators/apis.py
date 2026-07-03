import datetime as dt

from django.utils.dateparse import parse_datetime
from rest_framework import serializers
from rest_framework.exceptions import ValidationError
from rest_framework.generics import ListCreateAPIView, RetrieveUpdateAPIView
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.analytics.selectors import resolve_period
from apps.users.permissions import IsTeamLead, IsTeamLeadOrManagerReadOnly

from .models import Operator
from .selectors import operator_get, operator_list, operator_plan_progress, operator_stats
from .services import (
    operator_create,
    operator_deactivate,
    operator_delete,
    operator_plan_upsert,
    operator_reactivate,
    operator_update,
)


class OperatorSerializer(serializers.ModelSerializer):
    plan_target = serializers.DecimalField(
        max_digits=16, decimal_places=2, read_only=True, allow_null=True, required=False, default=None
    )
    plan_actual = serializers.DecimalField(
        max_digits=16, decimal_places=2, read_only=True, required=False, default=None
    )

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
            "plan_target",
            "plan_actual",
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
            with_plan=True,
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


class OperatorPlanApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request, pk: int):
        op = operator_get(pk)
        if not op:
            return Response({"detail": "Not found"}, status=404)
        today = dt.date.today()
        year = int(request.query_params.get("year", today.year))
        month = int(request.query_params.get("month", today.month))
        return Response(operator_plan_progress(operator=op, year=year, month=month))

    def put(self, request, pk: int):
        if not IsTeamLead().has_permission(request, self):
            return Response(status=403)
        op = operator_get(pk)
        if not op:
            return Response({"detail": "Not found"}, status=404)
        today = dt.date.today()
        year = int(request.data.get("year", today.year))
        month = int(request.data.get("month", today.month))
        target = request.data.get("target_amount")
        if target is None:
            raise ValidationError({"target_amount": "Required"})
        operator_plan_upsert(operator=op, year=year, month=month, target_amount=target, user=request.user)
        return Response(operator_plan_progress(operator=op, year=year, month=month))


def _parse(value):
    return parse_datetime(value) if value else None


class OperatorStatsApi(APIView):
    """
    Full statistics for one operator inside a period window.

    Query params (all optional):
      - `period=day|week|month` — auto-derived window (defaults to `month`)
      - `date_from` / `date_to` — explicit ISO datetimes (override `period`)
      - `include_payroll=0` — skip the monthly payroll block

    Returns a compound payload built by `operator_stats(...)`, plus an
    optional `payroll` block for the current calendar month.
    """

    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request, pk: int):
        op = operator_get(pk)
        if not op:
            return Response({"detail": "Not found"}, status=404)

        period = request.query_params.get("period")
        date_from, date_to = _parse(request.query_params.get("date_from")), _parse(
            request.query_params.get("date_to")
        )
        if date_from is not None or date_to is not None:
            effective_period = "custom"
        elif period == "all":
            effective_period = "all"
            date_from, date_to = None, None
        else:
            effective_period = period or "all"
            if effective_period != "all":
                p_from, p_to = resolve_period(effective_period)
                date_from, date_to = p_from, p_to

        payload = operator_stats(operator=op, date_from=date_from, date_to=date_to)
        payload["period"] = effective_period

        today = dt.date.today()
        payload["plan"] = operator_plan_progress(operator=op, year=today.year, month=today.month)

        include_payroll = request.query_params.get("include_payroll", "1") != "0"
        if include_payroll:
            from apps.payroll.services import compute_monthly_payroll

            lines = compute_monthly_payroll(
                year=today.year, month=today.month, operators=[op]
            )
            payload["payroll"] = lines[0].as_dict() if lines else None
        return Response(payload)
