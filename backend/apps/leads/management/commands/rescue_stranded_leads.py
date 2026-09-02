"""
Разовая (идемпотентная) уборка «пропавших лидов», зависших на уволенных
операторах.

История: до этой команды `operator_deactivate` возвращал в общий пул
только untouched-лиды (`new`/`assigned`), а всё, что оператор уже
«трогал» (in_progress / no_answer / phone_on / has_debt / …) оставалось
на нём. Пока оператор был `INACTIVE`, автораздача / refill / morning-
split игнорировали его — 482 non-terminal лидa на проде на 2026-09-02
были заминированы и не выдавались никому.

Что делает команда (за один прогон, идемпотентно, per-operator транзакции):

  A) Untouched (`status in {new, assigned}`) на inactive-операторе:
     → operator = NULL,
     → старый LeadAssignment.active = False,
     → новый LeadAssignment(operator=NULL, source=sheet_manual, active=True,
       reason='rescued from deactivated operator ${name}').
     Автораздача сама разберёт: morning-split / refill / distribute-watcher.

  B) Non-terminal «touched» на inactive-операторе
     (in_progress / no_answer / no_answer_2 / phone_on / callback_scheduled /
      dokonga_keladi / has_debt / sms_jonatildi / waiting_salary /
      notogri_raqam / shunchaki_qiziqdi / boshqa_joydan_xarid_qilgan /
      contacted_telegram / kartsi_yoq / qimmatlik_qildi):
     → operator = NULL,
     → needs_review = True (менеджер разберёт через /leads/orphans?kind=needs_review),
     → assignment audit (тот же паттерн, что и в A),
     → сам `status` НЕ меняем — сохраняем контекст «где оператор был в разговоре».

  C) Terminal (won / lost / archived / needs_review) не трогаем — там уже
     всё закрыто. Их наличие на inactive-операторе — нормальная история.

Флаг `--dry-run` обязателен: SELECT'ит и печатает те же цифры, но не
делает UPDATE. Идемпотентен: повторный запуск ничего не найдёт (лиды
уже без оператора).
"""

from __future__ import annotations

from collections import defaultdict

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.leads.selectors import (
    stranded_touched_non_terminal_leads,
    stranded_untouched_leads,
)
from apps.leads.services import rescue_stranded_leads_for_operator
from apps.operators.models import Operator, OperatorStatus


# Non-terminal «touched» статусы — оператор уже вступил в контакт, но
# сделка не закрыта. Держим как явный список, а не «всё что не terminal
# и не untouched», потому что LeadStatusLabel — динамический и менеджер
# может создать новый статус, а мы хотим предсказуемое поведение rescue.
#
# `LeadStatusLabel.is_terminal=True` мы всё равно исключаем на уровне
# селектора — тут просто перечисление «что мы точно считаем touched
# non-terminal». Если менеджер завёл кастомный код — он попадёт под
# «touched» ветку через селектор (не untouched && не terminal).
TOUCHED_NON_TERMINAL_STATUSES = (
    "in_progress",
    "no_answer",
    "no_answer_2",
    "phone_on",
    "callback_scheduled",
    "dokonga_keladi",
    "has_debt",
    "sms_jonatildi",
    "waiting_salary",
    "notogri_raqam",
    "shunchaki_qiziqdi",
    "boshqa_joydan_xarid_qilgan",
    "contacted_telegram",
    "kartsi_yoq",
    "qimmatlik_qildi",
)


class Command(BaseCommand):
    help = (
        "Уборка «пропавших лидов» с уволенных операторов: untouched → пул, "
        "touched non-terminal → needs_review + пул. Идемпотентно, --dry-run "
        "обязателен."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Показать сколько лидов и куда переместилось бы, БД не менять.",
        )

    def handle(self, *args, **opts):
        dry_run = bool(opts.get("dry_run"))
        mode_label = "dry-run" if dry_run else "APPLY"
        self.stdout.write(f"[rescue] mode: {mode_label}")

        inactive_ops = list(
            Operator.objects.filter(status=OperatorStatus.INACTIVE).order_by("id")
        )
        if not inactive_ops:
            self.stdout.write("[rescue] нет неактивных операторов — nothing to do")
            return

        total_untouched = 0
        total_touched = 0
        per_op_untouched: dict[int, int] = defaultdict(int)
        per_op_touched: dict[int, int] = defaultdict(int)
        # Разбивка «сколько touched по каждому статусу» — суммарно по всем
        # уволенным. Полезно менеджеру: понять, сколько `in_progress` попадёт
        # в needs_review, чтобы не пугаться.
        per_status_touched: dict[str, int] = defaultdict(int)

        for op in inactive_ops:
            untouched_qs = stranded_untouched_leads(operator_id=op.id)
            touched_qs = stranded_touched_non_terminal_leads(operator_id=op.id)

            untouched_count = untouched_qs.count()
            # Разбивка по статусам — счётчики читаем до апдейта, чтобы после
            # применения увидеть, куда и сколько уехало.
            touched_by_status = list(touched_qs.values_list("status", flat=True))
            touched_count = len(touched_by_status)

            if not untouched_count and not touched_count:
                continue

            per_op_untouched[op.id] = untouched_count
            per_op_touched[op.id] = touched_count
            total_untouched += untouched_count
            total_touched += touched_count
            for st in touched_by_status:
                per_status_touched[st] += 1

            self.stdout.write(
                f"[rescue] op#{op.id} '{op.full_name}': untouched={untouched_count}, "
                f"touched non-terminal={touched_count}"
            )

            if dry_run:
                continue

            # Per-operator transaction — если что-то упадёт посреди, не
            # оставим полу-перемещённых.
            with transaction.atomic():
                rescue_stranded_leads_for_operator(operator=op)

        self.stdout.write("")
        self.stdout.write(f"[rescue] ИТОГО untouched → пул: {total_untouched}")
        self.stdout.write(
            f"[rescue] ИТОГО touched non-terminal → needs_review: {total_touched}"
        )
        if per_status_touched:
            self.stdout.write("[rescue] touched — разбивка по статусам:")
            for st, n in sorted(
                per_status_touched.items(), key=lambda kv: (-kv[1], kv[0])
            ):
                self.stdout.write(f"[rescue]   {st}: {n}")

        style = self.style.NOTICE if dry_run else self.style.SUCCESS
        self.stdout.write(
            style(
                f"[rescue] {'would move' if dry_run else 'moved'}: "
                f"{total_untouched} untouched + {total_touched} touched"
            )
        )
