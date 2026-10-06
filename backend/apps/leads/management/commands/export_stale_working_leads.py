"""
Excel-выгрузка «застрявших» лидов: тех что сидят в рабочих статусах
(javob bermadi 1/2, sms yuborildi, qayta qong'iroq) и не тронуты
последние N дней (по умолчанию 5).

Мотивация: менеджер хочет глазами пробежаться по хвосту, который
операторы не добивают — понять кто сорит и добить кластер вручную.
Sheet-экспорт из `retry_export_to_sheet()` рядом не помогает: он
включает всех кандидатов без гейта по «сколько дней тишина», и
уезжает в Google Sheets, а не в .xlsx.

Пример:
    python manage.py export_stale_working_leads \\
        --days 5 \\
        --out /tmp/stale_leads.xlsx

Читает только, ничего не пишет в БД — безопасно на prod.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db.models import OuterRef, Subquery
from django.utils import timezone

from apps.common.excel import new_workbook, write_sheet
from apps.leads.models import Lead, LeadAssignment

# Рабочие статусы, для которых «тишина 5+ дней» = сигнал что оператор
# лид не добил. Совпадает с дефолтом `get_retry_export_statuses()` минус
# `contacted_telegram` (там уводят разговор в TG и это не «не отработал»,
# а «отдал на handoff»).
DEFAULT_STATUSES = (
    "no_answer",           # javob bermadi (1)
    "no_answer_2",         # javob bermadi (2)
    "dokonga_keladi",      # dokonga keladi
    "callback_scheduled",  # qayta qong'iroq
)

STATUS_LABEL_UZ = {
    "no_answer": "Javob bermadi (1)",
    "no_answer_2": "Javob bermadi (2)",
    "dokonga_keladi": "Dokonga keladi",
    "callback_scheduled": "Qayta qong'iroq",
    "sms_jonatildi": "SMS jonatildi",
}


class Command(BaseCommand):
    help = (
        "Excel-выгрузка лидов в рабочих статусах, которые не тронули N дней."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--days",
            type=int,
            default=5,
            help="Порог тишины в днях (по умолчанию 5).",
        )
        parser.add_argument(
            "--out",
            type=str,
            default="",
            help=(
                "Путь к .xlsx на выходе. По умолчанию — "
                "./stale_leads_YYYYMMDD.xlsx в текущем cwd."
            ),
        )
        parser.add_argument(
            "--statuses",
            type=str,
            default=",".join(DEFAULT_STATUSES),
            help=(
                "Список статусов через запятую. По умолчанию "
                "no_answer,no_answer_2,sms_jonatildi,callback_scheduled."
            ),
        )

    def handle(self, *args, **opts):
        days: int = opts["days"]
        if days < 0:
            raise CommandError("--days должно быть >= 0")
        statuses = [s.strip() for s in opts["statuses"].split(",") if s.strip()]
        if not statuses:
            raise CommandError("Список --statuses пуст")

        now = timezone.now()
        # Окно: последние N дней НЕ считая сегодня. Считаем в локальном
        # времени (у нас Asia/Tashkent) — «сегодня» это по местному
        # календарю, не по UTC.
        today_local_start = timezone.localtime(now).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        window_start = today_local_start - dt.timedelta(days=days)

        # «Оператор не отработал» ≠ «updated_at не менялся» — updated_at
        # бампают фоновые джобы (auto-close, retry-check, лейбл-refresh),
        # поэтому по нему всегда 0. Меряем по возрасту активного назначения:
        # когда лид ушёл к текущему оператору. Гейтим окном
        # [сегодня-Nдн, сегодня 00:00) — сегодняшние назначения свежие,
        # оператор их ещё не мог обработать, справедливо не ругать.
        active_asg_ts = (
            LeadAssignment.objects
            .filter(lead=OuterRef("pk"), active=True)
            .order_by("-created_at")
            .values("created_at")[:1]
        )
        qs = (
            Lead.objects
            .filter(status__in=statuses)
            .annotate(active_assigned_at=Subquery(active_asg_ts))
            .filter(
                active_assigned_at__gte=window_start,
                active_assigned_at__lt=today_local_start,
            )
            .select_related("operator", "sheet_source")
            .order_by("active_assigned_at")  # дольше всех висит — сверху
        )

        rows = []
        for lead in qs.iterator(chunk_size=500):
            asg_at = lead.active_assigned_at
            days_silent = (now - asg_at).days if asg_at else 0
            operator = ""
            if lead.operator_id:
                op = lead.operator
                operator = (
                    (op.full_name or "").strip()
                    or (op.phone or "").strip()
                    or f"op#{op.id}"
                )
            sheet = ""
            if lead.sheet_source_id:
                sheet = (lead.sheet_source.name or "").strip() or (
                    lead.sheet_source.worksheet_name
                    or lead.sheet_source.spreadsheet_id
                    or ""
                )
            meta = lead.metadata or {}
            izoh = str(meta.get("IZOH") or meta.get("izoh") or "").strip()
            sheet_status = str(meta.get("STATUS") or meta.get("status") or "").strip()
            bitrix = str(meta.get("bitrix_deal_id") or "").strip()
            rows.append([
                (asg_at or lead.updated_at).astimezone().strftime("%Y-%m-%d %H:%M"),
                days_silent,
                STATUS_LABEL_UZ.get(lead.status, lead.status),
                lead.full_name or "",
                lead.phone or "",
                lead.phone_alt or "",
                lead.phone_raw or "",
                lead.product_hint or "",
                lead.has_card or "",
                lead.postpone_reason or "",
                izoh,
                sheet_status,
                bitrix,
                operator,
                sheet,
                lead.sheet_row_index or "",
                f"https://naff.flek.uz/leads/{lead.id}",
            ])

        wb = new_workbook()
        write_sheet(
            wb,
            title=f"Oxirgi {days} kun (bugun yoq)",
            headers=[
                "Operatorga berildi",
                "Sukut kuni",
                "Status",
                "F.I.Sh.",
                "Telefon",
                "Telefon 2",
                "Telefon (xom)",
                "Qanday telefon",
                "Karta",
                "Kechiktirish sababi",
                "IZOH (sheet)",
                "STATUS (sheet)",
                "Bitrix deal",
                "Operator",
                "Manba",
                "Qator",
                "Havola",
            ],
            rows=rows,
            int_columns=(1, 15),
        )

        out_path = opts["out"].strip()
        if not out_path:
            out_path = f"stale_leads_{now.strftime('%Y%m%d')}.xlsx"
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        wb.save(out_path)

        self.stdout.write(
            self.style.SUCCESS(
                f"Yozildi: {out_path} ({len(rows)} lead, "
                f"oxirgi {days} kun (bugun yoq), status: {', '.join(statuses)})"
            )
        )
