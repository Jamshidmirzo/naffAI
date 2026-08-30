"""
One-shot cleanup: merge duplicate `Lead` rows that share the same
normalized phone. Companion to the sheet-import dedup shipped in
`apps.leads.services.lead_create_from_sheet_row` — that fix stops NEW
dupes from being created, but the DB still carries hundreds of
historical dupe-groups from before the fix landed.

Winner-selection rule (per phone group):

    1. status_priority DESC   (won > active > sms_jonatildi > … > lost)
    2. updated_at DESC         (most recently touched wins ties)
    3. id DESC                 (stable tiebreaker)

Losers are folded into the winner:
  - Sale / CallAttempt / CallbackReminder / LeadAssignment / TgChat FKs
    are re-pointed at the winner (we don't leave orphans behind — Sale.lead
    is `SET_NULL` on delete, so a delete without repointing would erase
    the linkage).
  - `winner.metadata["merged_from"]` gets one entry per loser (audit
    trail: lead id, status, operator, sheet row, updated_at).
  - An `AuditAction.UPDATE` audit entry names each merged loser so the
    audit log timeline records the merge.
  - Loser row is `.delete()`d after the FK moves (CASCADE targets are
    empty, so nothing further gets destroyed).

Everything for a single phone group runs inside `transaction.atomic()`,
so a failure inside one group only rolls back that group. Batches of
`--batch-size` groups are committed independently so a 4-hour run
against prod isn't one giant transaction.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Count

from apps.audit.services import AuditAction, audit_log_create
from apps.leads.models import Lead
from apps.leads.selectors import TERMINAL_LEAD_STATUSES

logger = logging.getLogger("leads.dedup")


# Priority of statuses for winner selection. Higher = keeps.
#
# Rationale:
#   `won` beats everything — a converted sale is the strongest signal
#     that this is the "real" card.
#   any active/in-progress bucket (status not in TERMINAL, not in the
#     downgrade set below) sits at 80 — the operator is currently
#     working the lead.
#   `sms_jonatildi` = «closed via SMS after 2 no-answers» — closed, but
#     more recent signal than `lost`.
#   `contacted_telegram` = TG handoff, operator done for now, similar
#     tier to sms.
#   `needs_review` = ambiguous, low priority.
#   `lost`, `archived` = deep terminal.
#   Unknown status codes fall to 40 (mid-tier — safer than dropping).
_STATUS_PRIORITY_OVERRIDES: dict[str, int] = {
    "won": 100,
    "sms_jonatildi": 60,
    "contacted_telegram": 55,
    "needs_review": 30,
    "lost": 10,
    "archived": 5,
}
_ACTIVE_PRIORITY = 80
_UNKNOWN_PRIORITY = 40


def _status_priority(status: str) -> int:
    if status in _STATUS_PRIORITY_OVERRIDES:
        return _STATUS_PRIORITY_OVERRIDES[status]
    if status in set(TERMINAL_LEAD_STATUSES):
        # Terminal we didn't explicitly rank — treat as unknown mid.
        return _UNKNOWN_PRIORITY
    # Anything else is "the operator is still working it".
    return _ACTIVE_PRIORITY


def _pick_winner(leads: list[Lead]) -> tuple[Lead, list[Lead]]:
    """
    Sort by (status_priority DESC, updated_at DESC, id DESC).
    Returns (winner, losers).
    """
    ordered = sorted(
        leads,
        key=lambda lead: (
            _status_priority(lead.status),
            lead.updated_at,
            lead.id,
        ),
        reverse=True,
    )
    winner, *losers = ordered
    return winner, losers


def _merge_loser_into_winner(*, winner: Lead, loser: Lead) -> dict[str, int]:
    """
    Repoint every FK-to-Lead we care about from `loser` to `winner`, then
    delete `loser`. Returns per-relation move counts for the report.

    Imports happen inside the function to avoid pulling half the ORM at
    module load — the command is rarely invoked and every model is used
    exactly once per loser.
    """
    from apps.calls.models import CallAttempt, CallbackReminder
    from apps.leads.models import LeadAssignment
    from apps.sales.models import Sale
    from apps.tg_userclient.models import TgChat

    moves = {
        "sales": Sale.objects.filter(lead=loser).update(lead=winner),
        "call_attempts": CallAttempt.objects.filter(lead=loser).update(lead=winner),
        "callback_reminders": CallbackReminder.objects.filter(lead=loser).update(
            lead=winner
        ),
        "lead_assignments": LeadAssignment.objects.filter(lead=loser).update(
            lead=winner
        ),
        "tg_chats": TgChat.objects.filter(lead=loser).update(lead=winner),
    }

    # Trail: what did we absorb? Kept on the winner as searchable JSON so
    # a manager can trace "where did lead #27812 go" without reading the
    # audit log.
    metadata = dict(winner.metadata or {})
    trail = list(metadata.get("merged_from") or [])
    trail.append(
        {
            "lead_id": loser.id,
            "status": loser.status,
            "operator_id": loser.operator_id,
            "sheet_source_id": loser.sheet_source_id,
            "sheet_row_index": loser.sheet_row_index,
            "updated_at": loser.updated_at.isoformat() if loser.updated_at else None,
            "moves": moves,
        }
    )
    metadata["merged_from"] = trail
    winner.metadata = metadata
    winner.save(update_fields=["metadata", "updated_at"])

    audit_log_create(
        user=None,
        action=AuditAction.UPDATE,
        entity="leads.Lead",
        entity_id=winner.id,
        changes={
            "merged_loser_id": loser.id,
            "loser_status": loser.status,
            "loser_operator_id": loser.operator_id,
            "moves": moves,
        },
        comment="dedup_leads: слияние дубля по phone",
    )

    loser.delete()
    return moves


class Command(BaseCommand):
    help = (
        "Слить дубли Lead по нормализованному phone. Winner = самый "
        "«живой» лид (высокий status_priority, свежий updated_at). "
        "Loser-FK (Sale/CallAttempt/CallbackReminder/LeadAssignment/"
        "TgChat) перевешиваются на winner, затем loser удаляется. "
        "--dry-run печатает план без записи."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help=(
                "Показать план (winner + losers + перевязки) без записи. "
                "Ничего в БД не мутирует."
            ),
        )
        parser.add_argument(
            "--phone",
            type=str,
            default="",
            help=(
                "Обработать только конкретный normalized phone (например "
                "+998901112233). Полезно для точечной проверки/rollback'a "
                "одной группы."
            ),
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=0,
            help=(
                "Ограничить число обрабатываемых phone-групп. 0 (default) — "
                "без лимита. Первый прод-прогон стоит запускать с --limit."
            ),
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=50,
            help=(
                "Сколько phone-групп коммитить в одной transaction.atomic. "
                "Меньше — безопаснее (короче потенциальный rollback), "
                "больше — быстрее. Default 50."
            ),
        )
        parser.add_argument(
            "--min-dupes",
            type=int,
            default=2,
            help=(
                "Минимальное число лидов на phone, чтобы группа считалась "
                "дублем. Default 2 (любая группа ≥2). Ставьте 3+, чтобы "
                "сначала разобраться только с самыми запущенными случаями."
            ),
        )

    def handle(self, *args, **opts):
        dry_run: bool = bool(opts.get("dry_run"))
        phone_filter: str = (opts.get("phone") or "").strip()
        limit: int = int(opts.get("limit") or 0)
        batch_size: int = int(opts.get("batch_size") or 50)
        min_dupes: int = int(opts.get("min_dupes") or 2)

        if batch_size < 1:
            raise CommandError("--batch-size must be >= 1")
        if min_dupes < 2:
            raise CommandError("--min-dupes must be >= 2")

        phones = self._find_dupe_phones(
            phone_filter=phone_filter, min_dupes=min_dupes
        )
        total_groups = len(phones)
        if not total_groups:
            self.stdout.write(self.style.NOTICE("Нет дублей по phone — БД чистая."))
            return

        self.stdout.write(
            self.style.WARNING(
                f"Найдено {total_groups} phone-групп с ≥{min_dupes} лидами."
            )
        )
        if limit:
            phones = phones[:limit]
            self.stdout.write(f"[limit={limit}] обрабатываем первые {len(phones)}.")

        total_losers = 0
        total_moves: dict[str, int] = defaultdict(int)
        processed_groups = 0

        for batch_start in range(0, len(phones), batch_size):
            batch = phones[batch_start : batch_start + batch_size]
            batch_losers, batch_moves = self._process_batch(
                phones=batch, dry_run=dry_run
            )
            total_losers += batch_losers
            for k, v in batch_moves.items():
                total_moves[k] += v
            processed_groups += len(batch)
            if not dry_run:
                self.stdout.write(
                    f"[commit] прогресс {processed_groups}/{len(phones)} "
                    f"групп, накопительно losers={total_losers}"
                )

        self._print_summary(
            dry_run=dry_run,
            groups=len(phones),
            losers=total_losers,
            moves=dict(total_moves),
        )

    # ---- internals ------------------------------------------------------

    def _find_dupe_phones(
        self, *, phone_filter: str, min_dupes: int
    ) -> list[str]:
        """
        Return the sorted list of phones that carry ≥`min_dupes` Lead rows.
        `phone_filter` narrows to one specific number (bypasses the
        min_dupes gate — you asked for that phone specifically).
        """
        qs = Lead.objects.exclude(phone="").values("phone")
        if phone_filter:
            qs = qs.filter(phone=phone_filter)
        dupes = (
            qs.annotate(n=Count("id"))
            .filter(n__gte=(1 if phone_filter else min_dupes))
            .order_by("phone")
        )
        return [row["phone"] for row in dupes]

    def _process_batch(
        self, *, phones: list[str], dry_run: bool
    ) -> tuple[int, dict[str, int]]:
        """
        Handle a batch of phones. Each phone-group runs inside its own
        atomic transaction so a failure isolates to that group.
        """
        losers_deleted = 0
        moves_agg: dict[str, int] = defaultdict(int)

        for phone in phones:
            leads = list(
                Lead.objects.filter(phone=phone).select_for_update()
                if not dry_run
                else Lead.objects.filter(phone=phone)
            )
            if len(leads) < 2:
                # Race: another writer merged this since our discovery
                # scan. Skip.
                continue

            winner, losers = _pick_winner(leads)

            if dry_run:
                self._print_group_plan(
                    phone=phone,
                    winner=winner,
                    losers=losers,
                )
                losers_deleted += len(losers)
                continue

            try:
                with transaction.atomic():
                    group_moves = self._merge_group(
                        winner=winner, losers=losers
                    )
                    losers_deleted += len(losers)
                    for k, v in group_moves.items():
                        moves_agg[k] += v
            except Exception:
                logger.exception(
                    "dedup_leads: FAILED phone=%s winner=%s losers=%s",
                    phone,
                    winner.id,
                    [lead.id for lead in losers],
                )
                self.stderr.write(
                    self.style.ERROR(
                        f"[FAIL] phone={phone}: группа откачена, продолжаем."
                    )
                )

        return losers_deleted, dict(moves_agg)

    def _merge_group(
        self, *, winner: Lead, losers: list[Lead]
    ) -> dict[str, int]:
        """Fold every loser into `winner`. Returns aggregated FK-move counts."""
        agg: dict[str, int] = defaultdict(int)
        for loser in losers:
            moves = _merge_loser_into_winner(winner=winner, loser=loser)
            for k, v in moves.items():
                agg[k] += v
        return dict(agg)

    def _print_group_plan(
        self, *, phone: str, winner: Lead, losers: list[Lead]
    ) -> None:
        from apps.calls.models import CallAttempt, CallbackReminder
        from apps.leads.models import LeadAssignment
        from apps.sales.models import Sale
        from apps.tg_userclient.models import TgChat

        loser_ids = [lead.id for lead in losers]
        counts = {
            "sales": Sale.objects.filter(lead_id__in=loser_ids).count(),
            "call_attempts": CallAttempt.objects.filter(lead_id__in=loser_ids).count(),
            "callback_reminders": CallbackReminder.objects.filter(
                lead_id__in=loser_ids
            ).count(),
            "lead_assignments": LeadAssignment.objects.filter(
                lead_id__in=loser_ids
            ).count(),
            "tg_chats": TgChat.objects.filter(lead_id__in=loser_ids).count(),
        }
        losers_desc = ", ".join(
            f"{lead.id}({lead.status})" for lead in losers
        )
        moves_desc = ", ".join(f"{k}={v}" for k, v in counts.items() if v)
        self.stdout.write(
            f"[dry-run] phone={phone} "
            f"winner={winner.id}({winner.status}, upd {winner.updated_at:%Y-%m-%d}) "
            f"losers=[{losers_desc}] "
            f"moves: {moves_desc or 'none'}"
        )

    def _print_summary(
        self,
        *,
        dry_run: bool,
        groups: int,
        losers: int,
        moves: dict[str, int],
    ) -> None:
        verb = "would delete" if dry_run else "deleted"
        style = self.style.NOTICE if dry_run else self.style.SUCCESS
        self.stdout.write(
            style(
                f"TOTAL: {groups} groups processed, {losers} leads {verb}."
            )
        )
        if moves and not dry_run:
            move_desc = ", ".join(
                f"{k}={v}" for k, v in sorted(moves.items()) if v
            )
            if move_desc:
                self.stdout.write(f"FK moves: {move_desc}")
