from __future__ import annotations

import calendar as _cal
import datetime as dt
from decimal import Decimal

from django.http import Http404
from django.db.models import Count, DecimalField, F, OuterRef, Q, QuerySet, Subquery, Sum, Value
from django.db.models.functions import Coalesce, TruncDate, TruncMonth
from django.utils import timezone

from apps.sales.models import Sale, SaleOperator, SalePartner

from .models import Operator, OperatorMonthlyPlan, OperatorStatus


def operator_get_by_id_or_404(operator_id: int) -> Operator:
    try:
        return Operator.objects.get(pk=operator_id)
    except Operator.DoesNotExist:
        raise Http404("Operator not found")


def operator_list(
    *,
    search: str | None = None,
    status: str | None = None,
    include_inactive: bool = True,
    with_plan: bool = False,
    visible_operator_ids: list[int] | None = None,
    managed_by: int | str | None = None,
) -> QuerySet[Operator]:
    """
    Base queryset for the operators list. Optional ownership filter.

    `visible_operator_ids` — allowlist from
    `apps.users.selectors.visible_operator_ids(actor)`. When provided, the
    queryset is sliced to that set. An empty list intentionally returns
    zero rows so a user without any visible operators sees nothing. Pass
    `None` to skip the gate.

    `managed_by` — секундарный фильтр поверх visible-scope:
      * int (user_id) → `managed_by_id=<id>`;
      * строка "null"/"none"/"unassigned" → `managed_by_id IS NULL`
        (legacy pool, не привязанный ни к одному менеджеру);
      * None → не фильтровать.
    """
    qs = Operator.objects.all()
    if visible_operator_ids is not None:
        if not visible_operator_ids:
            return qs.none()
        qs = qs.filter(id__in=visible_operator_ids)
    if managed_by is not None:
        if isinstance(managed_by, str):
            s = managed_by.strip().lower()
            if s in ("null", "none", "unassigned", ""):
                qs = qs.filter(managed_by__isnull=True)
            else:
                try:
                    qs = qs.filter(managed_by_id=int(s))
                except (TypeError, ValueError):
                    pass
        else:
            qs = qs.filter(managed_by_id=managed_by)
    if not include_inactive:
        qs = qs.exclude(status="inactive")
    if status:
        qs = qs.filter(status=status)
    if search:
        qs = qs.filter(Q(full_name__icontains=search) | Q(phone__icontains=search))
    if with_plan:
        today = dt.date.today()
        plan_subq = OperatorMonthlyPlan.objects.filter(
            operator_id=OuterRef("pk"), year=today.year, month=today.month
        ).values("target_amount")[:1]
        actual_subq = (
            SaleOperator.objects.filter(
                operator_id=OuterRef("pk"),
                sale__is_deleted=False,
                sale__is_returned=False,
                sale__status="confirmed",
                sale__sold_at__year=today.year,
                sale__sold_at__month=today.month,
            )
            .values("operator_id")
            .annotate(s=Sum("amount"))
            .values("s")[:1]
        )
        qs = qs.annotate(
            plan_target=Subquery(plan_subq, output_field=DecimalField()),
            plan_actual=Coalesce(
                Subquery(actual_subq, output_field=DecimalField()),
                Value(Decimal("0")),
            ),
        )
    return qs


def operator_plan_progress(*, operator: Operator, year: int, month: int) -> dict:
    plan = OperatorMonthlyPlan.objects.filter(operator=operator, year=year, month=month).first()
    target = plan.target_amount if plan else None
    actual = (
        SaleOperator.objects.filter(
            operator=operator,
            sale__is_deleted=False,
            sale__is_returned=False,
            sale__status="confirmed",
            sale__sold_at__year=year,
            sale__sold_at__month=month,
        ).aggregate(total=Sum("amount"))["total"]
        or Decimal("0")
    )
    percent = int(actual / target * 100) if target and target > 0 else 0
    return {
        "year": year,
        "month": month,
        "target": str(target) if target is not None else None,
        "actual": str(actual),
        "percent": min(percent, 100),
    }


def operator_get(pk: int) -> Operator | None:
    return Operator.objects.filter(pk=pk).first()


def _sales_streak(*, operator: Operator) -> int:
    """Count consecutive calendar days with ≥1 sale, ending at today (or yesterday)."""
    tz = timezone.get_current_timezone()
    today = timezone.localdate()
    window_start = dt.datetime.combine(today - dt.timedelta(days=90), dt.time.min, tzinfo=tz)

    raw = (
        SaleOperator.objects.filter(
            operator=operator,
            sale__is_deleted=False,
            sale__is_returned=False,
            sale__status="confirmed",
            sale__sold_at__gte=window_start,
        )
        .annotate(day=TruncDate("sale__sold_at"))
        .values_list("day", flat=True)
        .distinct()
    )
    dates = {d if isinstance(d, dt.date) else d.date() for d in raw}

    streak = 0
    check = today
    while check in dates:
        streak += 1
        check -= dt.timedelta(days=1)
    if streak == 0:
        check = today - dt.timedelta(days=1)
        while check in dates:
            streak += 1
            check -= dt.timedelta(days=1)
    return streak


def operator_achievements(*, operator: Operator, year: int, month: int) -> list[dict]:
    """
    Returns earned badges for the operator in the given year/month.
    Each entry: {"slug": str, "emoji": str, "label": str}
    """
    tz = timezone.get_current_timezone()
    today = timezone.localdate()
    badges: list[dict] = []

    # 🔥 Best today — highest sales amount today (always relative to now)
    today_start = dt.datetime.combine(today, dt.time.min, tzinfo=tz)
    today_end = today_start + dt.timedelta(days=1)
    top_today = (
        SaleOperator.objects.filter(
            sale__sold_at__gte=today_start,
            sale__sold_at__lt=today_end,
            sale__is_deleted=False,
            sale__is_returned=False,
            sale__status="confirmed",
        )
        .values("operator_id")
        .annotate(total=Sum("amount"))
        .order_by("-total")
        .first()
    )
    if top_today and top_today["operator_id"] == operator.id and top_today["total"]:
        badges.append({"slug": "best_today", "emoji": "🔥", "label": "Лучший сегодня"})

    # ⚡ Personal record month — this month's total ≥ any previous month
    month_start = dt.datetime(year, month, 1, tzinfo=tz)
    next_month = (month % 12) + 1
    next_year = year + (1 if month == 12 else 0)
    month_end = dt.datetime(next_year, next_month, 1, tzinfo=tz)

    this_total = (
        SaleOperator.objects.filter(
            operator=operator,
            sale__sold_at__gte=month_start,
            sale__sold_at__lt=month_end,
            sale__is_deleted=False,
            sale__is_returned=False,
            sale__status="confirmed",
        ).aggregate(total=Sum("amount"))["total"]
        or Decimal("0")
    )
    prev_best = (
        SaleOperator.objects.filter(
            operator=operator,
            sale__sold_at__lt=month_start,
            sale__is_deleted=False,
            sale__is_returned=False,
            sale__status="confirmed",
        )
        .annotate(mo=TruncMonth("sale__sold_at"))
        .values("mo")
        .annotate(s=Sum("amount"))
        .order_by("-s")
        .values_list("s", flat=True)
        .first()
    )
    if this_total > 0 and (prev_best is None or this_total >= prev_best):
        badges.append({"slug": "record_month", "emoji": "⚡", "label": "Рекорд месяца"})

    # ✅ Plan complete
    plan = operator_plan_progress(operator=operator, year=year, month=month)
    if plan["target"] is not None and plan["percent"] >= 100:
        badges.append({"slug": "plan_done", "emoji": "✅", "label": "План выполнен"})

    # 📈 Consecutive-days streak
    streak = _sales_streak(operator=operator)
    if streak >= 2:
        badges.append({"slug": "streak", "emoji": "📈", "label": f"+{streak} дней подряд"})

    return badges


# ---- per-operator statistics (dashboard drill-in) ---------------------

# NET on the Sale side = gross amount − discount. On the SaleOperator side
# it's already net (see apps.sales.services._apply_discount_to_operator_lines).
NET_AMOUNT = F("amount") - F("discount")


def _sale_qs_for_operator(
    *,
    operator_id: int,
    date_from: dt.datetime | None,
    date_to: dt.datetime | None,
) -> QuerySet[Sale]:
    """
    Every confirmed, non-returned, non-deleted Sale this operator is on —
    either as the legacy primary FK, or via a SaleOperator allocation row.
    """
    qs = Sale.objects.filter(
        is_deleted=False,
        is_returned=False,
        status="confirmed",
    ).filter(
        Q(operator_id=operator_id) | Q(operator_lines__operator_id=operator_id)
    ).distinct()
    if date_from:
        qs = qs.filter(sold_at__gte=date_from)
    if date_to:
        qs = qs.filter(sold_at__lte=date_to)
    return qs


def _operator_line_qs(
    *,
    operator_id: int,
    date_from: dt.datetime | None,
    date_to: dt.datetime | None,
) -> QuerySet[SaleOperator]:
    """
    SaleOperator lines for this operator, gated to confirmed/non-returned/non-deleted
    sales. This is the source of truth for the operator's credited share.
    """
    qs = SaleOperator.objects.filter(
        operator_id=operator_id,
        sale__is_deleted=False,
        sale__is_returned=False,
        sale__status="confirmed",
    )
    if date_from:
        qs = qs.filter(sale__sold_at__gte=date_from)
    if date_to:
        qs = qs.filter(sale__sold_at__lte=date_to)
    return qs


def operator_stats(
    *,
    operator: Operator,
    date_from: dt.datetime | None,
    date_to: dt.datetime | None,
    top_limit: int = 20,
) -> dict:
    """
    Full statistics slice for one operator in the given window:
      - totals  → credited sum + sale count (from SaleOperator allocations)
      - by_model    → per-model count/total from Sales the op was on
      - by_partner  → per-partner count/total from SalePartner lines on those sales
      - by_day      → daily count/total from Sales the op was on
    """
    # 1) totals from SaleOperator (multi-op aware, already net of discount)
    line_qs = _operator_line_qs(
        operator_id=operator.id, date_from=date_from, date_to=date_to
    )
    totals = line_qs.aggregate(
        total=Sum("amount"),
        count=Count("sale", distinct=True),
    )
    total_credited = totals["total"] or Decimal("0")
    sales_count = totals["count"] or 0

    # 2) Sale-side aggregates — this operator's sales set
    sale_qs = _sale_qs_for_operator(
        operator_id=operator.id, date_from=date_from, date_to=date_to
    )

    # by model — count is # of sales, total is net gross of that model
    by_model_rows = (
        sale_qs.values("phone_model")
        .annotate(count=Count("id"), total=Sum(NET_AMOUNT))
        .order_by("-count", "-total")[:top_limit]
    )
    by_model = [
        {
            "phone_model": r["phone_model"],
            "count": r["count"],
            "total": str(r["total"] or Decimal("0")),
        }
        for r in by_model_rows
    ]

    # by partner — sum SalePartner allocations from this op's sales
    partner_rows = (
        SalePartner.objects.filter(sale__in=sale_qs)
        .values("partner_id", "partner__name")
        .annotate(count=Count("sale", distinct=True), total=Sum("amount"))
        .order_by("-total")
    )
    by_partner = [
        {
            "partner_id": r["partner_id"],
            "partner_name": r["partner__name"],
            "count": r["count"],
            "total": str(r["total"] or Decimal("0")),
        }
        for r in partner_rows
    ]

    # by day — buckets of the sale set, net
    day_rows = (
        sale_qs.annotate(day=TruncDate("sold_at"))
        .values("day")
        .annotate(count=Count("id"), total=Sum(NET_AMOUNT))
        .order_by("day")
    )
    by_day = [
        {
            "day": r["day"].isoformat(),
            "count": r["count"],
            "total": str(r["total"] or Decimal("0")),
        }
        for r in day_rows
    ]

    return {
        "operator": {
            "id": operator.id,
            "full_name": operator.full_name,
            "phone": operator.phone,
            "status": operator.status,
            "is_trainee": operator.status == OperatorStatus.TRAINEE,
            "hired_at": operator.hired_at.isoformat() if operator.hired_at else None,
            "note": operator.note,
        },
        "window": {
            "date_from": date_from.isoformat() if date_from else None,
            "date_to": date_to.isoformat() if date_to else None,
        },
        "totals": {
            "total": str(total_credited),
            "count": sales_count,
        },
        "by_model": by_model,
        "by_partner": by_partner,
        "by_day": by_day,
    }


# ---------------------------------------------------------------------------
# Birthdays
# ---------------------------------------------------------------------------


def _birthday_effective_month_day(today: dt.date) -> tuple[int, int]:
    """
    Возвращает (month, day) — какие день/месяц считаем «сегодняшним ДР»
    для матчинга с birth_date.
    Обычный случай: сам (today.month, today.day).
    Edge-case високосного года: если сегодня 28 февраля в НЕвисокосный
    год, дополнительно матчим 29 февраля (для операторов, родившихся
    29.02). Это делается в `operators_with_birthday_today` через OR-ветку.
    """
    return (today.month, today.day)


def operators_with_birthday_today(*, today: dt.date | None = None) -> QuerySet[Operator]:
    """
    Активные (или стажёры) операторы с ДР сегодня. Год ДР игнорируется.

    Правило 29 февраля: в невисокосный год «29-февральские» именинники
    празднуют 28 февраля — включаем их в выборку 28-го.

    Inactive операторы исключены — мы не поздравляем уволенных.
    """
    if today is None:
        today = timezone.localdate()

    month, day = today.month, today.day
    qs = Operator.objects.filter(
        status__in=(OperatorStatus.ACTIVE, OperatorStatus.TRAINEE),
        birth_date__isnull=False,
    )

    day_filter = Q(birth_date__month=month, birth_date__day=day)
    # 28 февраля в невисокосный год → тянем и «29 фев» именинников.
    if month == 2 and day == 28 and not _cal.isleap(today.year):
        day_filter |= Q(birth_date__month=2, birth_date__day=29)
    return qs.filter(day_filter).order_by("full_name")


def operators_with_birthday_today_public(*, today: dt.date | None = None) -> list[dict]:
    """
    Тонкий проекция-хелпер для API `birthdays-today` (менеджер-only):
    возвращает только те поля, что рендерятся на dashboard-карточке.
    Возраст считается по birth_date.year, но само значение года наружу
    не отдаём — только `age`.
    """
    if today is None:
        today = timezone.localdate()
    ops = operators_with_birthday_today(today=today)
    out: list[dict] = []
    for op in ops:
        bd = op.birth_date
        # На всякий случай — не должно быть None, но защита от гонок.
        if bd is None:
            continue
        age = _age_years(bd, today)
        out.append(
            {
                "operator_id": op.id,
                "full_name": op.full_name,
                "phone": op.phone or "",
                "age": age,
                "status": op.status,
            }
        )
    return out


def deleted_operators_history(*, limit: int = 500) -> list[dict]:
    """
    Собирает историю удалённых операторов из `AuditLog` (entity='operators.Operator',
    action='delete'). Для каждой записи:
      - `snapshot` (full_name, phone, status, hired_at) из `audit.changes`.
      - `deleted_at` = audit.created_at.
      - `deleted_by_user_id` + `deleted_by_username` — кто удалил.
      - `comment` — причина (пусто для исторических записей до 2026-10-07).
      - `sales_count` / `sales_total` — продажи этого оператора (находим
        по username в созданных им Sale.created_by за последние 90 дней
        до удаления, т.к. при hard-delete FK obnuled и прямой связи нет).
      - `restored_sales_count` — сколько уже восстановлено после удаления
        (помечены в sale.comment как `[RESTORED after operator delete]`).
      - `deleted_related` — счётчики из audit (sales_soft_deleted_count,
        sales_shrunk_count и т.д.) — что сервис тронул при удалении.

    Используется страницей `/team/deleted-operators` для super_manager /
    superadmin — чтобы можно было увидеть и аудитировать «кто кого спрятал».
    """
    from django.contrib.auth import get_user_model
    from apps.audit.models import AuditLog
    from apps.sales.models import Sale

    User = get_user_model()

    audits = (
        AuditLog.objects.filter(
            entity__iexact="operators.Operator",
            action="delete",
        )
        .order_by("-created_at")[:limit]
    )

    # Prefetch всех users одним запросом, не per-row.
    actor_ids = {a.user_id for a in audits if a.user_id}
    actors_map: dict[int, str] = {}
    if actor_ids:
        for u in User.objects.filter(id__in=actor_ids).only("id", "username"):
            actors_map[u.id] = u.username or f"user#{u.id}"

    out: list[dict] = []
    for audit in audits:
        snapshot = (audit.changes or {}).get("snapshot") or {}
        deleted_related = (audit.changes or {}).get("deleted_related") or {}

        full_name = snapshot.get("full_name") or ""
        phone = snapshot.get("phone") or ""

        # Продажи, которые этот удалённый оператор создавал от своего
        # имени за последние 90 дней до удаления. При hard-delete FK
        # `sale.operator` обнуляется, прямой связи нет — ловим через
        # created_by.username = phone (у оператора username = phone).
        sales_qs = Sale.objects.none()
        if phone:
            window_start = audit.created_at - dt.timedelta(days=90)
            sales_qs = Sale.objects.filter(
                created_by__username=phone,
                sold_at__gte=window_start,
                sold_at__lt=audit.created_at + dt.timedelta(hours=1),
            )
        agg = sales_qs.aggregate(
            count=Count("id"),
            total=Coalesce(
                Sum("amount"),
                Value(0, output_field=DecimalField(max_digits=16, decimal_places=2)),
            ),
        )

        # Восстановленные (хотя бы часть) sales — считаем по пометке в comment.
        restored_count = (
            sales_qs.filter(comment__contains="[RESTORED after operator delete]").count()
            if phone else 0
        )

        actor_name = (
            actors_map.get(audit.user_id, "system") if audit.user_id else "system"
        )
        op_id_num = int(audit.entity_id) if str(audit.entity_id).isdigit() else None
        dr = deleted_related  # short alias for the dict below
        out.append(
            {
                "audit_id": audit.id,
                "operator_id": op_id_num,
                "snapshot": {
                    "full_name": full_name,
                    "phone": phone,
                    "status": snapshot.get("status") or "",
                    "hired_at": snapshot.get("hired_at"),
                },
                "deleted_at": audit.created_at.isoformat(),
                "deleted_by_user_id": audit.user_id,
                "deleted_by_username": actor_name,
                "comment": audit.comment or "",
                "sales_count": int(agg["count"] or 0),
                "sales_total": str(agg["total"] or 0),
                "restored_sales_count": int(restored_count),
                "deleted_related": {
                    "sales_soft_deleted_count": int(dr.get("sales_soft_deleted_count") or 0),
                    "sales_shrunk_count": int(dr.get("sales_shrunk_count") or 0),
                    "sales_unlinked": int(dr.get("sales_unlinked") or 0),
                    "lead_assignments_detached": int(dr.get("lead_assignments_detached") or 0),
                    "call_attempts_detached": int(dr.get("call_attempts_detached") or 0),
                },
            }
        )
    return out


def _age_years(birth_date: dt.date, today: dt.date) -> int:
    """
    Полное число лет на сегодня. Для 29-февральских именинников в
    невисокосный год трактуем «сегодняшний ДР» как 28 февраля.
    Никогда не возвращаем отрицательное — если birth_date почему-то
    в будущем (data-glitch), возвращаем 0.
    """
    if birth_date > today:
        return 0
    age = today.year - birth_date.year
    # Точный порог: если день/месяц ДР ещё не наступил в этом году —
    # минус один. Для 29.02 в невисокосный: считаем ДР наступившим 28.02.
    bd_month, bd_day = birth_date.month, birth_date.day
    if bd_month == 2 and bd_day == 29 and not _cal.isleap(today.year):
        bd_month, bd_day = 2, 28
    if (today.month, today.day) < (bd_month, bd_day):
        age -= 1
    return max(0, age)


# ---------------------------------------------------------------------------
# 2026-10-14 (design-atlas V2): plan helper + «Пульт зала» floor snapshot.
# ---------------------------------------------------------------------------


def _money_int(value) -> int:
    """UZS → int (без тийинов). None → 0."""
    if value is None:
        return 0
    return int(Decimal(value).quantize(Decimal("1")))


def operator_plan_current_month(*, operator: Operator) -> dict:
    """
    `plan_target` / `plan_actual` за текущий месяц — РОВНО тот же расчёт,
    что и аннотация `with_plan=True` в `operator_list` (её и переиспользуем),
    только отдаём int'ами (UZS без копеек):

      * `plan_target` — `OperatorMonthlyPlan.target_amount` или None;
      * `plan_actual` — сумма `SaleOperator.amount` по confirmed,
        не удалённым и не возвращённым продажам за текущий месяц.
    """
    row = (
        operator_list(visible_operator_ids=[operator.id], with_plan=True)
        .values("plan_target", "plan_actual")
        .first()
    )
    if row is None:
        return {"plan_target": None, "plan_actual": 0}
    target = row["plan_target"]
    return {
        "plan_target": _money_int(target) if target is not None else None,
        "plan_actual": _money_int(row["plan_actual"]),
    }


class FloorState:
    CALL = "call"
    WAIT = "wait"
    PAUSE = "pause"
    LATE = "late"
    ABSENT = "absent"
    OFF = "off"
    DAYOFF = "dayoff"


# Открытый CallAttempt старше этого окна считаем «забытым» (оператор не
# закрыл карточку звонка) — в state=call он не превращается.
FLOOR_OPEN_CALL_WINDOW = dt.timedelta(minutes=15)
# Сколько минут после опоздавшего check-in'а держим state=late.
FLOOR_LATE_WINDOW = dt.timedelta(minutes=60)


def _as_time(value) -> dt.time:
    """AttendanceSettings, только что созданный get_or_create'ом, держит
    default'ы строкой («10:00») — приводим к `time`."""
    if isinstance(value, dt.time):
        return value
    h, m = map(int, str(value).split(":")[:2])
    return dt.time(hour=h, minute=m)


def floor_state_resolve(
    *,
    is_day_off: bool,
    is_paused: bool,
    has_recent_open_call: bool,
    first_checkin_at: dt.datetime | None,
    first_checkin_was_late: bool,
    has_open_shift: bool,
    late_deadline: dt.datetime,
    now: dt.datetime,
) -> str:
    """
    Чистая функция правила `state` (порядок важен):

      1. approved day-off сегодня / weekly_day_off → dayoff
      2. is_paused                                → pause
      3. открытый CallAttempt < 15 мин            → call
      4. нет check-in сегодня: после shift_start+grace → absent, иначе off
      5. все смены за сегодня закрыты (checkout)  → off
      6. check-in с опозданием < 60 мин назад     → late
      7. иначе                                    → wait
    """
    if is_day_off:
        return FloorState.DAYOFF
    if is_paused:
        return FloorState.PAUSE
    if has_recent_open_call:
        return FloorState.CALL
    if first_checkin_at is None:
        return FloorState.ABSENT if now > late_deadline else FloorState.OFF
    if not has_open_shift:
        return FloorState.OFF
    if first_checkin_was_late and (now - first_checkin_at) < FLOOR_LATE_WINDOW:
        return FloorState.LATE
    return FloorState.WAIT


def operators_floor_snapshot(
    *,
    operator_ids: list[int],
    pin_verified: bool,
    now: dt.datetime | None = None,
) -> dict:
    """
    «Пульт зала» — живой срез по каждому не-inactive оператору из
    `operator_ids` (caller передаёт уже scope-нутый allowlist).

    Все агрегаты — bulk (один запрос на домен), без N+1:
      day-offs, open CallAttempt'ы, AttendanceLog за сегодня,
      просроченные CallbackReminder'ы, SaleOperator за сегодня,
      working_count (та же аннотация, что `operators_distribution_status`),
      plan (та же аннотация, что `operator_list(with_plan=True)`).

    `pin_verified=False` → персональные `checked_in_at` / `late_minutes`
    отдаются null (attendance-данные под PIN-гейтом), но в расчёт `state`
    check-in всё равно входит.

    `avatar_url` — относительный (`/media/...`); абсолютным его делает API.
    """
    from django.conf import settings as dj_settings
    from django.db.models import Max

    from apps.attendance.models import AttendanceLog
    from apps.attendance.selectors import attendance_settings_get
    from apps.calls.models import CallAttempt, CallbackReminder, CallbackReminderStatus
    from apps.leads.selectors import (
        _leads_active_today_filter,
        _rr_batch_size,
        active_lead_status_codes,
        carry_over_status_codes,
        terminal_lead_status_codes,
    )

    from .models import DayOffStatus, OperatorDayOff

    now = now or timezone.now()
    now_local = timezone.localtime(now)
    today = now_local.date()
    tz = timezone.get_current_timezone()
    day_start = dt.datetime.combine(today, dt.time.min, tzinfo=tz)
    day_end = day_start + dt.timedelta(days=1)
    quota = _rr_batch_size()

    base = {
        "generated_at": now_local.isoformat(),
        "pin_verified": bool(pin_verified),
        "rr_batch_size": quota,
        "operators": [],
    }

    terminal = set(terminal_lead_status_codes())
    carry = set(carry_over_status_codes())
    workable = list(set(active_lead_status_codes()) - terminal - carry)

    ops = list(
        operator_list(
            visible_operator_ids=operator_ids,
            include_inactive=False,
            with_plan=True,
        )
        .annotate(
            _working_count=Count(
                "leads",
                filter=Q(
                    leads__status__in=workable,
                    leads__postponed_at__isnull=True,
                )
                & _leads_active_today_filter(),
            )
        )
        .order_by("full_name", "id")
    )
    if not ops:
        return base
    ids = [op.id for op in ops]

    settings_obj = attendance_settings_get()
    default_shift_start = _as_time(settings_obj.shift_start)
    default_weekly_day_off = settings_obj.default_weekly_day_off
    late_threshold = dt.timedelta(minutes=int(settings_obj.late_threshold_min or 0))

    day_off_ids = set(
        OperatorDayOff.objects.filter(
            operator_id__in=ids, date=today, status=DayOffStatus.APPROVED
        ).values_list("operator_id", flat=True)
    )

    open_calls = dict(
        CallAttempt.objects.filter(
            operator_id__in=ids, outcome="", ended_at__isnull=True
        )
        .annotate(_start=Coalesce("started_at", "created_at"))
        .filter(_start__gte=now - FLOOR_OPEN_CALL_WINDOW, _start__lte=now)
        .values("operator_id")
        .annotate(latest=Max("_start"))
        .values_list("operator_id", "latest")
    )

    first_log: dict[int, AttendanceLog] = {}
    has_open: set[int] = set()
    for log in AttendanceLog.objects.filter(
        operator_id__in=ids, checked_in_at__gte=day_start, checked_in_at__lt=day_end
    ).only("id", "operator_id", "checked_in_at", "checked_out_at", "was_late").order_by(
        "checked_in_at", "id"
    ):
        first_log.setdefault(log.operator_id, log)
        if log.checked_out_at is None:
            has_open.add(log.operator_id)

    grace = getattr(dj_settings, "CALLBACK_OVERDUE_GRACE_MINUTES", 30)
    overdue = dict(
        CallbackReminder.objects.filter(
            operator_id__in=ids,
            status__in=(
                CallbackReminderStatus.PENDING,
                CallbackReminderStatus.OVERDUE,
                CallbackReminderStatus.SNOOZED,
            ),
            remind_at__lte=now - dt.timedelta(minutes=grace),
        )
        .values("operator_id")
        .annotate(n=Count("id"))
        .values_list("operator_id", "n")
    )

    sales: dict[int, dict] = {
        r["operator_id"]: r
        for r in SaleOperator.objects.filter(
            operator_id__in=ids,
            sale__is_deleted=False,
            sale__is_returned=False,
            sale__status="confirmed",
            sale__sold_at__gte=day_start,
            sale__sold_at__lt=day_end,
        )
        .values("operator_id")
        .annotate(n=Count("sale", distinct=True), s=Sum("amount"))
    }

    rows: list[dict] = []
    for op in ops:
        weekly = op.weekly_day_off if op.weekly_day_off is not None else default_weekly_day_off
        is_day_off = op.id in day_off_ids or (
            weekly is not None and today.weekday() == int(weekly)
        )
        shift_start = _as_time(op.shift_start) if op.shift_start else default_shift_start
        shift_start_dt = dt.datetime.combine(today, shift_start, tzinfo=tz)
        late_deadline = shift_start_dt + late_threshold

        log = first_log.get(op.id)
        call_started_at = open_calls.get(op.id)
        state = floor_state_resolve(
            is_day_off=is_day_off,
            is_paused=bool(op.is_paused),
            has_recent_open_call=call_started_at is not None,
            first_checkin_at=log.checked_in_at if log else None,
            first_checkin_was_late=bool(log and log.was_late),
            has_open_shift=op.id in has_open,
            late_deadline=late_deadline,
            now=now,
        )

        checked_in_at = None
        late_minutes = None
        if pin_verified and log is not None:
            checked_in_at = timezone.localtime(log.checked_in_at).isoformat()
            if log.was_late:
                # Та же формула, что в `attendance_late_notification`:
                # опоздание считаем от shift_start + late_threshold_min.
                late_minutes = max(
                    0, int((log.checked_in_at - late_deadline).total_seconds() // 60)
                )

        avatar_url = None
        if op.avatar:
            try:
                avatar_url = op.avatar.url
            except Exception:
                avatar_url = None

        sale_row = sales.get(op.id) or {}
        plan_target = getattr(op, "plan_target", None)
        rows.append(
            {
                "id": op.id,
                "full_name": op.full_name,
                "status": op.status,
                "managed_by_id": op.managed_by_id,
                "avatar_url": avatar_url,
                "state": state,
                "call_started_at": (
                    timezone.localtime(call_started_at).isoformat() if call_started_at else None
                ),
                # Звонок выводится из открытого CallAttempt (телефонии нет),
                # поэтому время старта — всегда оценка.
                "call_is_estimate": call_started_at is not None,
                "paused_at": (
                    timezone.localtime(op.paused_at).isoformat()
                    if op.is_paused and op.paused_at
                    else None
                ),
                "checked_in_at": checked_in_at,
                "late_minutes": late_minutes,
                "working_count": int(op._working_count),  # type: ignore[attr-defined]
                "quota": quota,
                "sales_today": int(sale_row.get("n") or 0),
                "sales_today_amount": str(_money_int(sale_row.get("s"))),
                "overdue_callbacks": int(overdue.get(op.id, 0)),
                "plan_target": _money_int(plan_target) if plan_target is not None else None,
                "plan_actual": _money_int(getattr(op, "plan_actual", None)),
            }
        )
    base["operators"] = rows
    return base
