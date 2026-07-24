import datetime as dt

from rest_framework import serializers
from rest_framework.generics import ListCreateAPIView, RetrieveUpdateAPIView
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.excel import new_workbook, workbook_response, write_sheet
from apps.users.permissions import IsTeamLead, IsTeamLeadOrManagerReadOnly

from .models import PayrollRule
from .services import compute_monthly_payroll, payroll_rule_create, payroll_rule_update
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
