import datetime as dt

from django.shortcuts import get_object_or_404
from rest_framework import serializers, status
from rest_framework.generics import ListCreateAPIView, RetrieveUpdateAPIView
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.excel import new_workbook, workbook_response, write_sheet
from apps.operators.models import Operator
from apps.users.permissions import IsManager, IsTeamLead, IsTeamLeadOrManagerReadOnly

from .models import PayoutType, PayrollRule, PayrollScope
from .services import (
    compute_monthly_payroll,
    operator_payroll_rule_delete,
    operator_payroll_rule_upsert,
    payroll_rule_create,
    payroll_rule_update,
)
from apps.audit.services import audit_log_create


class PayrollRuleSerializer(serializers.ModelSerializer):
    class Meta:
        model = PayrollRule
        fields = [
            "id",
            "scope",
            "operator",
            "threshold",
            "payout_type",
            "payout_value",
            "tiers",
            "period",
            "is_active",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]


class PayrollRuleListCreateApi(ListCreateAPIView):
    permission_classes = [IsTeamLead]
    serializer_class = PayrollRuleSerializer
    queryset = PayrollRule.objects.all()

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        rule = payroll_rule_create(user=request.user, **serializer.validated_data)
        return Response(self.get_serializer(rule).data, status=201)


class PayrollRuleDetailApi(RetrieveUpdateAPIView):
    permission_classes = [IsTeamLead]
    serializer_class = PayrollRuleSerializer
    queryset = PayrollRule.objects.all()

    def perform_update(self, serializer):
        payroll_rule_update(rule=serializer.instance, user=self.request.user, **serializer.validated_data)


def _ym(request) -> tuple[int, int]:
    today = dt.date.today()
    year = int(request.query_params.get("year") or today.year)
    month = int(request.query_params.get("month") or today.month)
    return year, month


class PayrollMonthlyApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        year, month = _ym(request)
        include_trainees = request.query_params.get("include_trainees", "1") != "0"
        lines = compute_monthly_payroll(year=year, month=month, include_trainees=include_trainees)
        return Response(
            {
                "year": year,
                "month": month,
                "lines": [line.as_dict() for line in lines],
            }
        )


class PayrollMonthlyExportApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        year, month = _ym(request)
        lines = compute_monthly_payroll(year=year, month=month)
        wb = new_workbook()
        rows = []
        total_sales, total_payout = 0.0, 0.0
        for line in lines:
            rows.append(
                [
                    line.operator_name,
                    "Стажёр" if line.is_trainee else "Сотрудник",
                    line.sales_count,
                    float(line.total_sales),
                    float(line.threshold),
                    "да" if line.threshold_reached else "нет",
                    f"{line.payout_type} {line.payout_value}",
                    float(line.payout),
                ]
            )
            total_sales += float(line.total_sales)
            total_payout += float(line.payout)
        write_sheet(
            wb,
            title=f"Payroll {year}-{month:02d}",
            headers=[
                "Оператор",
                "Тип",
                "Кол-во продаж",
                "Сумма продаж",
                "Порог",
                "Порог достигнут",
                "Формула",
                "Выплата",
            ],
            rows=rows,
            money_columns=[3, 4, 7],
            int_columns=[2],
            totals_row=["ИТОГО", "", "", total_sales, "", "", "", total_payout],
        )
        audit_log_create(
            user=request.user,
            action="override",
            entity="payroll.PayrollExport",
            entity_id=f"{year}-{month:02d}",
            changes={"year": year, "month": month}
        )
        return workbook_response(wb, f"payroll_{year}_{month:02d}.xlsx")


def _rule_as_dict(rule: PayrollRule | None) -> dict | None:
    if rule is None:
        return None
    return {
        "id": rule.id,
        "scope": rule.scope,
        "operator_id": rule.operator_id,
        "threshold": str(rule.threshold),
        "payout_type": rule.payout_type,
        "payout_value": str(rule.payout_value),
        "tiers": rule.tiers or [],
        "period": rule.period,
        "is_active": rule.is_active,
    }


class OperatorPayrollRuleUpsertSerializer(serializers.Serializer):
    """
    Полезная нагрузка на PUT для operator-scoped rule.

    - `reset: true` — стереть override (вернуться к глобальному правилу).
      В таком режиме остальные поля игнорируются.
    - иначе создаётся/обновляется override с указанными параметрами.
    """

    reset = serializers.BooleanField(required=False, default=False)
    threshold = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False, min_value=0
    )
    payout_type = serializers.ChoiceField(
        choices=PayoutType.choices, required=False
    )
    payout_value = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False, min_value=0
    )
    tiers = serializers.ListField(child=serializers.DictField(), required=False)

    def validate(self, attrs):
        if attrs.get("reset"):
            # На reset остальные поля не нужны — сбросим их сразу.
            return {"reset": True}
        # Хотя бы одно поле должно быть указано, чтобы иметь смысл.
        if not any(k in attrs for k in ("threshold", "payout_type", "payout_value", "tiers")):
            raise serializers.ValidationError(
                "Укажите хотя бы одно поле или `reset: true`."
            )
        return attrs


class OperatorPayrollRuleApi(APIView):
    """
    GET  /api/payroll/rules/operator/{operator_id}/
        → { effective, source, override, global }
        Возвращает эффективное правило (override приоритетнее глобального),
        источник, а также сырые override + global для UI-формы.

    PUT  /api/payroll/rules/operator/{operator_id}/
        Body: { reset: true }                  — удалить override
        Body: { threshold, payout_type, payout_value, tiers? } — upsert
    """

    permission_classes = [IsManager]

    def _payload(self, operator_id: int) -> dict:
        override = (
            PayrollRule.objects.filter(
                scope=PayrollScope.OPERATOR,
                operator_id=operator_id,
                is_active=True,
            )
            .order_by("-id")
            .first()
        )
        global_rule = (
            PayrollRule.objects.filter(scope=PayrollScope.GLOBAL, is_active=True)
            .order_by("-id")
            .first()
        )
        effective = override or global_rule
        source = "override" if override else ("global" if global_rule else "none")
        return {
            "operator_id": operator_id,
            "source": source,
            "effective": _rule_as_dict(effective),
            "override": _rule_as_dict(override),
            "global": _rule_as_dict(global_rule),
        }

    def get(self, request, operator_id: int):
        get_object_or_404(Operator, id=operator_id)
        return Response(self._payload(operator_id))

    def put(self, request, operator_id: int):
        operator = get_object_or_404(Operator, id=operator_id)
        serializer = OperatorPayrollRuleUpsertSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        if data.get("reset"):
            operator_payroll_rule_delete(operator=operator, user=request.user)
            return Response(self._payload(operator_id))

        # Собираем поля для upsert.
        fields = {}
        for key in ("threshold", "payout_type", "payout_value", "tiers"):
            if key in data:
                fields[key] = data[key]
        operator_payroll_rule_upsert(
            operator=operator, user=request.user, **fields
        )
        return Response(self._payload(operator_id), status=status.HTTP_200_OK)
