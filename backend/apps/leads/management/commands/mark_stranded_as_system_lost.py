"""
Одноразовая (идемпотентная) массовая маркировка «пропавших лидов» как
`status='lost'` с сохранением причины в `metadata['lost_reason']`.

История: до этой команды операторская «сводка дня» показывала 74
needs_review + 482 non-terminal лидa на уволенных = 556 «фантомов»,
которые:
  * никому не выдавались (уволенный оператор = чёрная дыра);
  * портили аналитику (in_progress «за 3 месяца» — нелепый показатель);
  * загрязняли orphan-пул и чипы `/leads/orphans`.

Что делает команда (одним прогоном, идемпотентно):

  A) Группа A — needs_review-сироты (обычно битые sheet-строки):
     фильтр = `needs_review=True + operator IS NULL`.
     → `lead_mark_system_lost(reason=invalid_phone_from_sheet,
        comment='Битая sheet-строка / телефон невалидный',
        original_operator_name=None,
        original_status=<текущий, обычно needs_review>)`.

  B) Группа B — non-terminal touched на inactive-операторах:
     фильтр = `operator__status=inactive AND NOT status IN (won/lost/archived/needs_review)`.
     → `lead_mark_system_lost(reason=stranded_on_inactive_operator,
        comment='Оператор {name} уволен, клиент долго ждал звонка',
        original_operator_name=<full_name>,
        original_status=<текущий>)`.

  * Terminal (won/lost/archived) не трогаем — там уже закрыто.
  * Идемпотентно: `lead_mark_system_lost` no-op если у лида уже есть
    `metadata['lost_reason']`, так что повторный run ничего не портит.

Флаги:
  * `--dry-run` (по default) — только SELECT + print, БД не меняем.
  * `--apply` — реально пишем.
  * `--only-a` / `--only-b` — сузить до одной группы.
  * `--csv-snapshot=path` — перед --apply дампит CSV с before-state
    (id, name, phone, operator_id, operator_name, status, metadata_json).
    Страховка на случай ручного recovery.

Транзакции:
  * Группа A — одна общая atomic block, транзакция короткая.
  * Группа B — per-operator atomic (если посреди упадём — не оставим
    полу-помеченных на одном операторе).

Печатает сводку: сколько по группам, сколько по operator'ам, сколько по
статусам-source'ам.
"""

from __future__ import annotations

import csv
import json
from collections import defaultdict
from pathlib import Path

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.leads.models import Lead
from apps.leads.selectors import (
    needs_review_leads,
    stranded_on_inactive_operators,
)
from apps.leads.services import (
    LOST_REASON_INVALID_PHONE_FROM_SHEET,
    LOST_REASON_STRANDED_ON_INACTIVE,
    lead_mark_system_lost,
)
from apps.operators.models import Operator, OperatorStatus


class Command(BaseCommand):
    help = (
        "Одноразово маркирует 74 needs_review-сирот + 482 non-terminal "
        "лидa на уволенных как status='lost' с сохранением причины в "
        "metadata. --dry-run по default, --apply для реального прогона."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            default=True,
            help="Показать сколько лидов и куда переместилось бы. По default.",
        )
        parser.add_argument(
            "--apply",
            action="store_true",
            default=False,
            help="Реально применить. Иначе — dry-run.",
        )
        parser.add_argument(
            "--only-a",
            action="store_true",
            default=False,
            help="Только Группа A (needs_review-сироты).",
        )
        parser.add_argument(
            "--only-b",
            action="store_true",
            default=False,
            help="Только Группа B (non-terminal на inactive-операторах).",
        )
        parser.add_argument(
            "--csv-snapshot",
            type=str,
            default="",
            help=(
                "Путь к CSV для дампа before-state (id, name, phone, "
                "operator_id, operator_name, status, metadata). "
                "Работает и с --dry-run, и с --apply."
            ),
        )

    def handle(self, *args, **opts):
        # --apply побеждает --dry-run (пользователь явно попросил применить).
        apply_mode = bool(opts.get("apply"))
        only_a = bool(opts.get("only_a"))
        only_b = bool(opts.get("only_b"))
        if only_a and only_b:
            # Обе — то же самое что «обе» (без флагов).
            only_a = only_b = False
        csv_path = (opts.get("csv_snapshot") or "").strip()

        mode_label = "APPLY" if apply_mode else "dry-run"
        self.stdout.write(f"[mark-lost] mode: {mode_label}")

        run_a = not only_b
        run_b = not only_a

        # --- Group A: needs_review-сироты --------------------------------
        group_a_leads = []
        if run_a:
            group_a_leads = list(needs_review_leads())
            self.stdout.write(
                f"[mark-lost] Group A (needs_review orphans): {len(group_a_leads)}"
            )

        # --- Group B: non-terminal на уволенных --------------------------
        # Сортируем по operator_id, чтобы транзакции per-op были детерминированы
        # и в выводе была стабильная разбивка.
        group_b_leads: list[Lead] = []
        per_op_leads: dict[int, list[Lead]] = defaultdict(list)
        if run_b:
            group_b_leads = list(
                stranded_on_inactive_operators().order_by("operator_id", "id")
            )
            for lead in group_b_leads:
                per_op_leads[lead.operator_id or 0].append(lead)
            self.stdout.write(
                f"[mark-lost] Group B (stranded on inactive): {len(group_b_leads)}"
            )

        # --- CSV snapshot (before-state) ---------------------------------
        if csv_path:
            all_leads = group_a_leads + group_b_leads
            self._dump_csv(csv_path, all_leads)
            self.stdout.write(
                f"[mark-lost] CSV snapshot written: {csv_path} "
                f"({len(all_leads)} rows)"
            )

        # --- Разбивка per-operator для Group B (печатается всегда) -------
        if group_b_leads:
            self.stdout.write("[mark-lost] Group B — по операторам:")
            operators_by_id = {
                op.id: op
                for op in Operator.objects.filter(
                    id__in=[oid for oid in per_op_leads.keys() if oid]
                )
            }
            for op_id, leads in sorted(
                per_op_leads.items(), key=lambda kv: (-len(kv[1]), kv[0])
            ):
                op = operators_by_id.get(op_id)
                name = op.full_name if op else f"?#{op_id}"
                self.stdout.write(f"[mark-lost]   {name} (id={op_id}): {len(leads)}")

        # --- Разбивка по статусам (Group B) ------------------------------
        if group_b_leads:
            per_status: dict[str, int] = defaultdict(int)
            for lead in group_b_leads:
                per_status[lead.status] += 1
            self.stdout.write("[mark-lost] Group B — по статусам:")
            for st, n in sorted(per_status.items(), key=lambda kv: (-kv[1], kv[0])):
                self.stdout.write(f"[mark-lost]   {st}: {n}")

        total = len(group_a_leads) + len(group_b_leads)
        self.stdout.write("")
        self.stdout.write(f"[mark-lost] ИТОГО к пометке: {total}")

        if not apply_mode:
            self.stdout.write(
                self.style.NOTICE(
                    "[mark-lost] dry-run — БД не изменена. "
                    "Запусти с --apply для реального прогона."
                )
            )
            return

        # ============ APPLY =============================================
        applied_a = 0
        applied_b = 0

        # Group A — одной транзакцией (короткой).
        if group_a_leads:
            with transaction.atomic():
                for lead in group_a_leads:
                    comment = self._comment_for_group_a(lead)
                    lead_mark_system_lost(
                        lead=lead,
                        reason=LOST_REASON_INVALID_PHONE_FROM_SHEET,
                        comment=comment,
                        original_operator_name=None,
                        original_status=lead.status,
                        lost_by="system:mark_stranded_as_system_lost",
                    )
                    applied_a += 1
            self.stdout.write(f"[mark-lost] Group A applied: {applied_a}")

        # Group B — per-operator транзакции.
        for op_id, leads in per_op_leads.items():
            op = None
            if op_id:
                op = Operator.objects.filter(id=op_id).first()
            op_name = op.full_name if op else ""
            with transaction.atomic():
                for lead in leads:
                    lead_mark_system_lost(
                        lead=lead,
                        reason=LOST_REASON_STRANDED_ON_INACTIVE,
                        comment=self._comment_for_group_b(lead, op_name),
                        original_operator_name=op_name or None,
                        original_status=lead.status,
                        lost_by="system:mark_stranded_as_system_lost",
                    )
                    applied_b += 1

        if group_b_leads:
            self.stdout.write(f"[mark-lost] Group B applied: {applied_b}")

        self.stdout.write(
            self.style.SUCCESS(
                f"[mark-lost] DONE: A={applied_a} + B={applied_b} = "
                f"{applied_a + applied_b} лидов помечено как system-lost"
            )
        )

    # ---- helpers --------------------------------------------------------

    def _comment_for_group_a(self, lead: Lead) -> str:
        """Читаемое пояснение для needs_review-сироты (обычно битая
        sheet-строка / телефон невалидный)."""
        sheet_name = (
            lead.sheet_source.name if lead.sheet_source_id else "неизвестный источник"
        )
        row = lead.sheet_row_index or "?"
        phone_raw = (lead.phone_raw or "").strip() or "(пусто)"
        return (
            f"Битая sheet-строка из «{sheet_name}» row={row}: телефон "
            f"невалидный ({phone_raw!r}). Клиенту невозможно позвонить — "
            f"закрыто как system-lost."
        )

    def _comment_for_group_b(self, lead: Lead, operator_name: str) -> str:
        """Читаемое пояснение для лида, зависшего на уволенном операторе."""
        who = operator_name or "уволенный оператор"
        return (
            f"Оператор {who} уволен, лид в статусе '{lead.status}' долго "
            f"ждал звонка. Закрыто как system-lost — контекст сохранён в "
            f"metadata.lost_original_status для потенциального recovery."
        )

    def _dump_csv(self, path: str, leads: list[Lead]) -> None:
        """Дамп before-state (нужен как страховка перед --apply)."""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerow([
                "id",
                "full_name",
                "phone",
                "phone_raw",
                "operator_id",
                "operator_name",
                "status",
                "needs_review",
                "sheet_source_id",
                "sheet_source_name",
                "sheet_row_index",
                "created_at",
                "updated_at",
                "metadata_json",
            ])
            for lead in leads:
                writer.writerow([
                    lead.id,
                    lead.full_name or "",
                    lead.phone or "",
                    lead.phone_raw or "",
                    lead.operator_id or "",
                    (lead.operator.full_name if lead.operator else ""),
                    lead.status,
                    "1" if lead.needs_review else "0",
                    lead.sheet_source_id or "",
                    (lead.sheet_source.name if lead.sheet_source else ""),
                    lead.sheet_row_index or "",
                    lead.created_at.isoformat() if lead.created_at else "",
                    lead.updated_at.isoformat() if lead.updated_at else "",
                    json.dumps(lead.metadata or {}, ensure_ascii=False),
                ])
