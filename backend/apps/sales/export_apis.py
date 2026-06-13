from decimal import Decimal

from django.utils.dateparse import parse_datetime
from rest_framework.views import APIView

from apps.common.excel import new_workbook, workbook_response, write_sheet
from apps.users.permissions import IsTeamLeadOrManagerReadOnly

from .selectors import sale_list


class SaleExportApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        params = request.query_params
        qs = sale_list(
            search=params.get("search"),
            operator_id=params.get("operator") or None,
            channel_id=params.get("channel") or None,
            date_from=parse_datetime(params.get("date_from")) if params.get("date_from") else None,
            date_to=parse_datetime(params.get("date_to")) if params.get("date_to") else None,
        )

        wb = new_workbook()
        rows, total = [], Decimal("0")
        for s in qs.iterator(chunk_size=500):
            rows.append(
                [
                    s.id,
                    s.sold_at.strftime("%Y-%m-%d %H:%M"),
                    s.imei,
                    s.phone_model,
                    s.operator.full_name,
                    s.channel.name,
                    float(s.amount),
                    "да" if s.is_returned else "нет",
                    s.comment or "",
                ]
            )
            if not s.is_returned:
                total += s.amount

        write_sheet(
            wb,
            title="Продажи",
            headers=[
                "ID",
                "Дата",
                "IMEI",
                "Модель",
                "Оператор",
                "Канал",
                "Сумма, сум",
                "Возврат",
                "Комментарий",
            ],
            rows=rows,
            money_columns=[6],
            totals_row=["", "", "", "", "", "ИТОГО (без возвратов)", float(total), "", ""],
        )

        return workbook_response(wb, "sales.xlsx")
