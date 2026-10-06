"""
Диагностика: за окно [сегодня-N дней, сегодня 00:00) взять всех лидов в
`status='lost'` и разложить по конкретному источнику закрытия. Отвечает
на вопрос менеджера: «операторы их не закрывают вручную — это система?».

Read-only. Ничего не пишет в БД, только SELECT + локальная запись .xlsx.

Категории (первое совпадение выигрывает):
  1. system_deactivate       — metadata.lost_by == "system:operator_deactivate"
  2. system_migration        — metadata.lost_by == "system:mark_stranded_as_system_lost"
  3. qimmatlik_exhausted     — последний AuditLog про смену статуса на lost
                                имеет user=NULL И comment содержит "qimmatlik"
  4. system_other            — AuditLog user=NULL, но ни deactivate/migration/qimmatlik
                                (например: старый auto_close_stale_leads до его отключения)
  5. operator_manual         — AuditLog user IS NOT NULL (реальный оператор нажал)
  6. unknown                 — нет AuditLog вообще (миграция без аудита, ручной SQL, etc.)

Пример:
    python manage.py audit_lost_leads --days 5 --out /tmp/lost_audit.xlsx
"""

from __future__ import annotations

import datetime as dt
from collections import Counter
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db.models import OuterRef, Subquery
from django.utils import timezone

from apps.audit.models import AuditLog
from apps.common.excel import new_workbook, write_sheet
from apps.leads.models import Lead, LeadAssignment


CATEGORY_LABELS = {
    "system_deactivate":  "Sistema — operator ochirilgan",
    "system_migration":   "Sistema — bir marta migration",
    "qimmatlik_exhausted": "Qimmatlik retry tugagan",
    "system_other":       "Sistema (boshqa)",
    "operator_manual":    "Operator qol bilan",
    "unknown":            "Nomalum (audit yoq)",
}


class Command(BaseCommand):
    help = "Диагностика — кто/что закрыл лидов как lost за N дней."

    def add_arguments(self, parser):
        parser.add_argument("--days", type=int, default=5)
        parser.add_argument("--out", type=str, default="")

    def handle(self, *args, **opts):
        days: int = opts["days"]
        if days <= 0:
            raise CommandError("--days должно быть > 0")

        now = timezone.now()
        today_local_start = timezone.localtime(now).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        window_start = today_local_start - dt.timedelta(days=days)

        active_asg = (
            LeadAssignment.objects
            .filter(lead=OuterRef("pk"), active=True)
            .order_by("-created_at")
            .values("created_at")[:1]
        )
        qs = (
            Lead.objects
            .filter(status="lost")
            .annotate(active_assigned_at=Subquery(active_asg))
            .filter(
                active_assigned_at__gte=window_start,
                active_assigned_at__lt=today_local_start,
            )
            .select_related("operator")
        )

        # Prefetch last "status → lost" AuditLog per lead in bulk.
        lead_ids = list(qs.values_list("id", flat=True))
        audit_by_lead = _fetch_last_lost_audit(lead_ids)

        buckets: dict[str, list[list]] = {k: [] for k in CATEGORY_LABELS}
        by_original_operator = Counter()

        for lead in qs.iterator(chunk_size=500):
            meta = lead.metadata or {}
            lost_by = str(meta.get("lost_by") or "").strip()
            lost_reason = str(meta.get("lost_reason") or "").strip()
            orig_op = str(meta.get("lost_original_operator_name") or "").strip()
            orig_status = str(meta.get("lost_original_status") or "").strip()
            lost_at = str(meta.get("lost_at") or "").strip()
            audit = audit_by_lead.get(str(lead.id))
            audit_user = getattr(audit, "user", None)
            audit_comment = (getattr(audit, "comment", "") or "").lower()
            asg_at = lead.active_assigned_at

            # Categorize (first match wins)
            if lost_by == "system:operator_deactivate":
                cat = "system_deactivate"
            elif lost_by == "system:mark_stranded_as_system_lost":
                cat = "system_migration"
            elif audit is not None and audit_user is None and "qimmatlik" in audit_comment:
                cat = "qimmatlik_exhausted"
            elif audit is not None and audit_user is None:
                cat = "system_other"
            elif audit is not None and audit_user is not None:
                cat = "operator_manual"
            else:
                cat = "unknown"

            if cat.startswith("system_") and orig_op:
                by_original_operator[orig_op] += 1

            operator_now = ""
            if lead.operator_id:
                op = lead.operator
                operator_now = (
                    (op.full_name or "").strip()
                    or (op.phone or "").strip()
                    or f"op#{op.id}"
                )
            audit_user_name = ""
            if audit_user is not None:
                audit_user_name = (
                    (getattr(audit_user, "full_name", "") or "").strip()
                    or (getattr(audit_user, "username", "") or "").strip()
                    or f"user#{audit_user.pk}"
                )
            audit_ts = audit.created_at.astimezone().strftime("%Y-%m-%d %H:%M") if audit else ""

            buckets[cat].append([
                (asg_at or lead.updated_at).astimezone().strftime("%Y-%m-%d %H:%M"),
                lead.full_name or "",
                lead.phone or "",
                lead.product_hint or "",
                orig_status,
                orig_op,
                lost_reason,
                lost_by,
                lost_at,
                audit_ts,
                audit_user_name,
                (audit.comment[:80] if audit else "") or "",
                operator_now,
                f"https://naff.flek.uz/leads/{lead.id}",
            ])

        # --- Build workbook ---
        wb = new_workbook()

        # Sheet 1: Xulosa
        total = sum(len(v) for v in buckets.values())
        summary_rows = []
        for cat_key, label in CATEGORY_LABELS.items():
            n = len(buckets[cat_key])
            pct = f"{100.0*n/total:.1f}%" if total else "0%"
            summary_rows.append([label, n, pct])
        summary_rows.append(["JAMI", total, "100%"])
        write_sheet(
            wb,
            title="Xulosa",
            headers=["Sabab", "Soni", "Ulush"],
            rows=summary_rows,
            int_columns=(1,),
        )

        # Sheet 1b: original operator breakdown (only leads with system-close AND orig_op)
        if by_original_operator:
            write_sheet(
                wb,
                title="Original operatorlar",
                headers=["Original operator (o'chirilgan)", "Sistema tomonidan yopilgan"],
                rows=[[k, v] for k, v in by_original_operator.most_common()],
                int_columns=(1,),
            )

        # Sheets per category
        headers = [
            "Operatorga berildi", "F.I.Sh.", "Telefon", "Qanday telefon",
            "Original status", "Original operator", "Lost reason", "Lost by",
            "Lost at (meta)", "Audit vaqti", "Audit foydalanuvchi",
            "Audit izoh", "Hozirgi operator", "Havola",
        ]
        for cat_key, label in CATEGORY_LABELS.items():
            rows = buckets[cat_key]
            if not rows:
                # still write an empty sheet so менеджер видит категорию с 0
                rows = []
            write_sheet(
                wb,
                title=label[:31],  # openpyxl limit
                headers=headers,
                rows=rows,
            )

        out_path = opts["out"].strip() or f"lost_audit_{now.strftime('%Y%m%d')}.xlsx"
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        wb.save(out_path)

        self.stdout.write(self.style.SUCCESS(
            f"Yozildi: {out_path} — jami {total} lost lead, "
            f"oxirgi {days} kun (bugun yoq)."
        ))
        for cat_key, label in CATEGORY_LABELS.items():
            n = len(buckets[cat_key])
            if n:
                self.stdout.write(f"  {label}: {n}")


def _fetch_last_lost_audit(lead_ids: list) -> dict:
    """
    Для каждого lead-id найти ПОСЛЕДНЮЮ AuditLog запись, где
    changes["status"]["new"] == "lost". Возвращает {lead_id_str: AuditLog}.

    JSONField-lookup через `changes__status__new` (Postgres JSONB path).
    Пакетно — одним запросом, потом группировка в память.
    """
    if not lead_ids:
        return {}
    str_ids = [str(x) for x in lead_ids]
    entries = (
        AuditLog.objects
        .filter(
            entity="leads.Lead",
            entity_id__in=str_ids,
            changes__status__new="lost",
        )
        .select_related("user")
        .order_by("entity_id", "-created_at")
    )
    result: dict = {}
    for entry in entries:
        # Первый (самый свежий) per entity_id благодаря ORDER BY.
        if entry.entity_id not in result:
            result[entry.entity_id] = entry
    return result
