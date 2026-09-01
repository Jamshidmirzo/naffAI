"""
Rule-engine — набор проверок (operator, state) → Suggestion | None.

Каждое правило — чистая функция, без SQL-запросов внутри: всё берётся
из preloaded `state`-dict, который `services.build_operator_state`
собирает одним batch'ем. Это гарантирует, что даже когда правил станет
30, число SQL-запросов на /api/helper/operator-suggestions/ останется
константным.

Порядок в RULES влияет только на порядок «внутри одной severity» —
итоговая сортировка в services (urgent → warning → info) стабильна.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Suggestion — read-model, который улетает во фронт.
# ---------------------------------------------------------------------------


@dataclass
class Suggestion:
    id: str
    severity: str  # "info" | "warning" | "urgent"
    title_ru: str
    title_uz: str
    body_ru: str
    body_uz: str
    action_label_ru: str | None = None
    action_label_uz: str | None = None
    action_href: str | None = None
    count: int | None = None  # for UI badge / word-form

    # Machine-readable payload — фронт может использовать для micro-cta
    # (например показать «Сегодня N лидов» без парсинга title). Пока
    # оставлено пустым; правила заполняют по необходимости.
    meta: dict = field(default_factory=dict)


RuleFn = Callable[[object, dict], Suggestion | None]


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------


def check_full_working_queue(op, state) -> Suggestion | None:
    """
    #1 (WARNING) — тот самый вчерашний кейс с Мухлисой.

    `working_count` считает только non-carry сегодняшние лиды — если их
    >= RR_BATCH_SIZE (5), distribute-watcher не даёт новых. Оператору
    надо закрыть/обработать хотя бы один, чтобы получить свежий.

    Meta payload `lead_ids` (top-10 старейших) едет во фронт: при клике
    на action фронт скроллит к первому лиду и подсвечивает все
    (см. `SuggestionCard` + `MyLeads` highlight parser). Это заменяет
    старое «Показать очередь» — оператор сразу видит, ЧТО закрывать.
    """
    working = int(state.get("working_count") or 0)
    if working < 5:
        return None
    lead_ids = list(state.get("blocking_quota_lead_ids") or [])
    need_close = max(working - 5 + 1, 1)
    # Deep-link `/my?view=active&quota=1` — MyLeads переключается в
    # quota-режим: показывает ТОЛЬКО лиды, занимающие квоту (без
    # carry-хвоста), с баннером «закройте минимум N». Одно число везде:
    # подсказка, баннер, список.
    href = "/my?view=active&quota=1"
    return Suggestion(
        id="full_working_queue",
        severity="warning",
        title_ru=f"Новые лиды не приходят: {working} лидов занимают квоту (лимит 5)",
        title_uz=f"Yangi lidlar kelmayapti: {working} ta lid kvotani band qilgan (limit 5)",
        body_ru=(
            f"Закройте минимум {need_close} из них (WON / LOST / нужный статус) — "
            "и система сразу выдаст свежие. Нажмите кнопку: покажем только те "
            "лиды, которые надо закрыть."
        ),
        body_uz=(
            f"Ulardan kamida {need_close} tasini yoping (WON / LOST / kerakli "
            "status) — tizim darhol yangilarini beradi. Tugmani bosing: faqat "
            "yopish kerak bo'lgan lidlarni ko'rsatamiz."
        ),
        action_label_ru=f"Показать эти {working} лидов",
        action_label_uz=f"Shu {working} ta lidni ko'rsatish",
        action_href=href,
        count=working,
        meta={"working_count": working, "need_close": need_close, "lead_ids": lead_ids},
    )


def check_old_assigned_leads(op, state) -> Suggestion | None:
    """
    #2 (WARNING) — 3+ лида в `assigned`, updated_at > 24ч.

    Значит оператор давно не открывал карточку — либо забыл, либо
    новый батч разлит утром и он не заметил. Свежие лиды «стынут».
    Deep-link `highlight` — MyLeads подсветит именно эти карточки.
    """
    stale = int(state.get("stale_assigned") or 0)
    if stale < 3:
        return None
    lead_ids = list(state.get("stale_assigned_lead_ids") or [])
    href = "/my?view=active"
    if lead_ids:
        href = f"/my?view=active&highlight={','.join(str(i) for i in lead_ids)}"
    return Suggestion(
        id="old_assigned",
        severity="warning",
        title_ru=f"У вас {stale} лидов в assigned без действия > 24ч",
        title_uz=f"Sizda {stale} ta lid 24 soatdan beri tegilmagan (assigned)",
        body_ru=(
            "Эти лиды раздали давно, а вы ещё не позвонили. Откройте их "
            "и хотя бы отметьте no_answer / phone_on — иначе тимлид увидит "
            "просрочку в отчёте."
        ),
        body_uz=(
            "Bu lidlar allaqachon berilgan, lekin siz hali qo'ng'iroq qilmagansiz. "
            "Ochib, hech bo'lmasa no_answer / phone_on qo'ying — aks holda "
            "tim-lider hisobotda kechikish ko'radi."
        ),
        action_label_ru="Открыть и подсветить",
        action_label_uz="Ochish va belgilash",
        action_href=href,
        count=stale,
        meta={"stale_assigned": stale, "lead_ids": lead_ids},
    )


def check_stale_no_answer(op, state) -> Suggestion | None:
    """
    #3 (INFO) — 3+ лида в `no_answer`, updated_at > 12ч.

    Классика: клиент не взял утром, оператор поставил no_answer и забыл.
    Мягкое напоминание: перезвонить или закрыть.
    """
    stale = int(state.get("stale_no_answer") or 0)
    if stale < 3:
        return None
    return Suggestion(
        id="stale_no_answer",
        severity="info",
        title_ru=f"{stale} лидов в no_answer давно не трогали",
        title_uz=f"{stale} ta lidga no_answer qo'yilgan, ancha vaqt bo'ldi",
        body_ru="Попробуйте перезвонить ещё раз или закройте (lost) — они висят в carry-хвосте.",
        body_uz="Yana bir marta qo'ng'iroq qiling yoki lost qilib yoping — ular carry-ro'yxatida turibdi.",
        action_label_ru="Открыть лиды",
        action_label_uz="Lidlarni ochish",
        action_href="/my?view=active",
        count=stale,
        meta={"stale_no_answer": stale},
    )


def check_overdue_callbacks(op, state) -> Suggestion | None:
    """
    #4 (URGENT) — просроченные callback'и.

    Клиент попросил перезвонить в 14:00, сейчас 15:30 — оператор
    подводит клиента. Отдельно urgent, чтобы sort-by-severity
    подтянул наверх.
    """
    overdue = int(state.get("overdue_callbacks") or 0)
    if overdue < 1:
        return None
    return Suggestion(
        id="overdue_callbacks",
        severity="urgent",
        title_ru=f"У вас {overdue} просроченных callback'ов",
        title_uz=f"Sizda {overdue} ta muddati o'tgan callback bor",
        body_ru="Клиент ждёт вашего звонка. Позвоните сейчас или переназначьте время.",
        body_uz="Mijoz qo'ng'iroqingizni kutmoqda. Hoziroq qo'ng'iroq qiling yoki vaqtini o'zgartiring.",
        action_label_ru="Перейти к callback'ам",
        action_label_uz="Callback'larga o'tish",
        action_href="/my?view=active",
        count=overdue,
        meta={"overdue_callbacks": overdue},
    )


def check_not_checked_in_today(op, state) -> Suggestion | None:
    """
    #5 (URGENT) — оператор ещё не отметился на смене, а уже > 10:00 Ташкент.

    Смена начинается в 10:00 (AttendanceSettings.shift_start), после
    этого no-check-in считается опозданием. Показываем только когда
    время сработало — чтобы утренняя login-сессия не спамила.
    """
    if state.get("checked_in_today"):
        return None
    if not state.get("shift_started_now"):
        return None
    return Suggestion(
        id="not_checked_in",
        severity="urgent",
        title_ru="Вы ещё не отметились на смене",
        title_uz="Siz smenaga hali belgilanmadingiz",
        body_ru=(
            "Смена уже началась — отметьтесь через QR у менеджера или у себя в профиле, "
            "иначе рабочее время не засчитается."
        ),
        body_uz=(
            "Smena boshlandi — menejerdagi QR orqali yoki profilingiz orqali belgilaning, "
            "aks holda ish vaqti hisobga olinmaydi."
        ),
        action_label_ru="Открыть профиль",
        action_label_uz="Profilni ochish",
        action_href="/profile",
        meta={"shift_started": True},
    )


def check_postponed_stale(op, state) -> Suggestion | None:
    """
    #6 (INFO) — postponed-хвост > 3 дней.

    Оператор отложил лиды и забыл про них. Иногда там реальные
    клиенты «после зарплаты» — надо разобрать.
    """
    stale = int(state.get("stale_postponed") or 0)
    if stale < 1:
        return None
    return Suggestion(
        id="postponed_stale",
        severity="info",
        title_ru=f"{stale} отложенных лидов старше 3 дней",
        title_uz=f"{stale} ta kechiktirilgan lid 3 kundan ko'p vaqtdan beri turibdi",
        body_ru="Загляните в раздел «Отложено» и разберитесь — вернуть в работу или закрыть.",
        body_uz="«Kechiktirilgan» bo'limiga kirib ko'ring — ishga qaytaring yoki yoping.",
        action_label_ru="Открыть отложенные",
        action_label_uz="Kechiktirilganlarni ochish",
        action_href="/my?view=postponed",
        count=stale,
        meta={"stale_postponed": stale},
    )


def check_pending_sales(op, state) -> Suggestion | None:
    """
    #7 (INFO) — pending-продажи ждут approve менеджера.

    Оператор создал продажу с фото, менеджер ещё не подтвердил.
    Показываем чтобы оператор не забывал добить (фото ретаком если
    отклонили и т.п.).
    """
    pending = int(state.get("pending_sales") or 0)
    if pending < 1:
        return None
    return Suggestion(
        id="pending_sales",
        severity="info",
        title_ru=f"{pending} ваших продаж ждут approve менеджера",
        title_uz=f"{pending} ta sotuvingiz menejer tasdig'ini kutmoqda",
        body_ru=(
            "Пока менеджер не подтвердит — они не идут в зарплату. "
            "Обычно это в течение дня; если висит долго — напишите менеджеру."
        ),
        body_uz=(
            "Menejer tasdiqlaguncha — bu sotuvlar oyligingizga tushmaydi. "
            "Odatda kun davomida tasdiqlanadi; agar uzoq turaversa — menejerga yozing."
        ),
        action_label_ru="Мои продажи",
        action_label_uz="Mening sotuvlarim",
        action_href="/my/sales",
        count=pending,
        meta={"pending_sales": pending},
    )


# ---------------------------------------------------------------------------
# Registry — ORDER matters только внутри одной severity (см. services).
# ---------------------------------------------------------------------------

RULES: list[RuleFn] = [
    check_full_working_queue,   # WARNING — вчерашний кейс, вверху warning-группы
    check_old_assigned_leads,   # WARNING
    check_overdue_callbacks,    # URGENT — поднимется наверх сортировкой
    check_not_checked_in_today,  # URGENT
    check_stale_no_answer,      # INFO
    check_postponed_stale,      # INFO
    check_pending_sales,        # INFO
]
