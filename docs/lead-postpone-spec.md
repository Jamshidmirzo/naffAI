# Отложенные лиды — «На потом» для операторов

Спека для builder-агента. Одна волна, ~1 день работы.

**Контекст**: Проект `/Users/user/Desktop/mp/ai/naff/`. Django 5 + DRF + React (Vite + TS). Оператор работает с лидами на `/my` (страница `MyLeads.tsx` → endpoint `GET /api/leads/my/` → `LeadMyListApi` → селектор `leads_for_operator(operator, include_archived=False)`).

Проблема, которую закрываем: сейчас оператор видит **весь** свой pipeline лидов подряд — активные, callback'и, «подумаю» вперемешку. Нужна кнопка «Отложить на потом» и три фильтра-таба «Активные / На потом / Все», чтобы разгрузить основной экран и не терять «холодных» лидов.

Не менять существующие `LeadStatus` — postpone это **ортогональный флаг**, а не новый статус (лид может быть `IN_PROGRESS` и одновременно `postponed` — оператор отложил обработку до конца дня).

Регресс до этой волны: **284 passed** (после последнего мержа). Целевой регресс: **≥ 289 passed** (+5 новых тестов).

---

## Что переиспользуем

| Инфра | Файл | Зачем |
|---|---|---|
| Селектор `leads_for_operator` | `apps/leads/selectors.py:75` | Добавляем параметр `include_postponed` и `only_postponed` |
| Endpoint `LeadMyListApi` | `apps/leads/apis.py:224` | Расширяем query-param `view=active\|postponed\|all` |
| Модель `Lead` + миграция | `apps/leads/models.py` | +3 поля |
| Существующий `lead_reassign` | `apps/leads/services.py` | При переназначении сбрасывать postpone-поля (у нового оператора чистый лист) |
| Audit-логирование | `apps/audit/services.py::audit_log_create` | Пишем `lead.postponed` / `lead.unpostponed` |
| Frontend страница | `frontend/src/pages/MyLeads.tsx` | Три таба + кнопка на карточке |
| RoleGate | `frontend/src/components/RoleGate.tsx` | Не требуется — эндпоинт уже под `IsOperator` |

---

## 1. Модель

В `apps/leads/models.py::Lead` добавить:

```python
postponed_at = models.DateTimeField(
    null=True, blank=True, db_index=True,
    help_text="Когда оператор нажал 'Отложить на потом'. NULL = активный.",
)
postponed_by = models.ForeignKey(
    "operators.Operator",
    null=True, blank=True,
    on_delete=models.SET_NULL,
    related_name="+",
    help_text="Кто отложил (для аудита; при reassign сбрасывается).",
)
postpone_reason = models.CharField(
    max_length=280, blank=True, default="",
    help_text="Опциональная заметка оператора: 'вернуться после обеда', 'ждёт зарплату', ...",
)
```

Миграция `apps/leads/migrations/0002_lead_postpone.py`.

Никаких `Meta.constraints` не надо — все три поля могут быть NULL/пустыми одновременно.

---

## 2. Селектор

`apps/leads/selectors.py::leads_for_operator` — расширить сигнатуру:

```python
def leads_for_operator(
    operator: Operator,
    *,
    include_archived: bool = False,
    view: str = "active",  # "active" | "postponed" | "all"
) -> QuerySet[Lead]:
    ...
```

Логика фильтрации:
- `view="active"` (default) — `postponed_at__isnull=True`
- `view="postponed"` — `postponed_at__isnull=False`
- `view="all"` — не фильтруем по postpone

`include_archived` продолжает работать как раньше — ортогонально view.

Сортировка для `view="postponed"` — `-postponed_at` (последние отложенные сверху); для остальных — как сейчас.

---

## 3. Сервисы

Новый файл `apps/leads/services.py` (или расширить существующий) — две функции + аудит:

```python
@transaction.atomic
def lead_postpone(*, lead: Lead, operator: Operator, reason: str = "", user=None) -> Lead:
    if lead.postponed_at is not None:
        raise ApplicationError("Лид уже отложен")
    lead.postponed_at = timezone.now()
    lead.postponed_by = operator
    lead.postpone_reason = (reason or "").strip()[:280]
    lead.save(update_fields=["postponed_at", "postponed_by", "postpone_reason", "updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="leads.Lead",
        entity_id=lead.id,
        changes={"postponed_at": str(lead.postponed_at), "operator_id": operator.id, "reason": lead.postpone_reason},
        comment="postponed by operator",
    )
    return lead


@transaction.atomic
def lead_unpostpone(*, lead: Lead, user=None) -> Lead:
    if lead.postponed_at is None:
        raise ApplicationError("Лид не отложен")
    old = {"postponed_at": str(lead.postponed_at), "postponed_by_id": lead.postponed_by_id}
    lead.postponed_at = None
    lead.postponed_by = None
    lead.postpone_reason = ""
    lead.save(update_fields=["postponed_at", "postponed_by", "postpone_reason", "updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="leads.Lead",
        entity_id=lead.id,
        changes={"unpostponed": old},
        comment="unpostponed by operator",
    )
    return lead
```

**Важно**: в существующем `lead_reassign(...)` — сбросить `postponed_at/by/reason = None/None/""` в одной транзакции с переназначением. У нового оператора не должно всплывать «отложенное» от старого — он видит лид как свежий. Написать это ЯВНО в коде и покрыть тестом.

---

## 4. API

`apps/leads/apis.py`:

### Расширить `LeadMyListApi.get()`

Читать query-param `view` (default `"active"`), передавать в селектор:

```python
view = request.query_params.get("view", "active")
if view not in ("active", "postponed", "all"):
    return Response({"detail": "view must be active|postponed|all"}, status=400)
qs = leads_for_operator(operator, include_archived=include_archived, view=view)
```

Добавить в envelope счётчики (для бейджей в UI):

```python
return Response({
    "operator": {...},
    "counts": {
        "active": leads_for_operator(operator, view="active").count(),
        "postponed": leads_for_operator(operator, view="postponed").count(),
    },
    "results": LeadSerializer(qs, many=True).data,
})
```

### Два новых endpoint'а

```
POST /api/leads/<pk>/postpone/    body: {"reason": "..."}   permission: IsOperator + own lead
POST /api/leads/<pk>/unpostpone/  body: {}                  permission: IsOperator + own lead
```

`urls.py`:
```python
path("leads/<int:pk>/postpone/", LeadPostponeApi.as_view()),
path("leads/<int:pk>/unpostpone/", LeadUnpostponeApi.as_view()),
```

Проверка «own lead»: `lead.operator_id == operator_id_of(request.user)` — иначе 403. Не делать через `IsTeamLead` — TL сам себе не откладывает лиды, эта фича только для операторов.

Ответ 200: сериализованный `Lead` + флаг `postponed_at`.

### Расширить `LeadSerializer`

Добавить поля в вывод: `postponed_at`, `postpone_reason`, `postponed_by` (только `id` + `full_name`).

---

## 5. Frontend

### `MyLeads.tsx` — три таба сверху

Панель под шапкой:
```
[ Активные (N) ]  [ На потом (M) ]  [ Все ]
```
- Активный таб — сплошная заливка бренд-цветом; неактивные — контурная
- Счётчик в скобках берётся из `counts` в response envelope
- Клик по табу меняет query `view=active|postponed|all`, invalidate query, перерисовка списка

### Каждая карточка лида — кебаб-меню

Правый верхний угол карточки — иконка `MoreVertical`. Клик открывает меню:
- **Если `postponed_at is null`**: пункт «Отложить на потом» → confirm-модалка с полем `Причина (не обязательно)`, textarea max 280 char + счётчик, кнопка «Отложить» → POST `/api/leads/<id>/postpone/` → invalidate → карточка исчезает из активного списка (или переходит в postponed таб).
- **Если `postponed_at != null`**: пункт «Вернуть в активные» → POST `/api/leads/<id>/unpostpone/` → invalidate.

### Визуально отложенные карточки

На табе «На потом» карточки:
- Плашка сверху бледно-жёлтая: `⏸ Отложено {relative_time} • {postpone_reason || "без комментария"}`
- Немного приглушённые (opacity 0.85) чтобы не сливались с активными на табе «Все»

### Пустое состояние

- «Активные» пусто + «На потом > 0» → «Все активные лиды разобраны. Открой таб „На потом" — там ещё N лидов ждут».
- «На потом» пусто → «Нет отложенных лидов».

### На табе «Все»

Смешанный список: активные сверху (по `-updated_at`), потом отложенные с плашкой. Разделитель с текстом «— Отложенные —».

---

## 6. Тесты

`apps/leads/tests/test_postpone.py` — 5 тестов:

1. `test_lead_postpone_sets_fields` — оператор дёргает `POST /leads/<id>/postpone/` с reason → `postponed_at != None`, `postponed_by == operator`, `postpone_reason` записан, audit есть.
2. `test_lead_postpone_wrong_operator_forbidden` — оператор пытается отложить чужой лид → 403, лид не тронут.
3. `test_lead_unpostpone_clears_fields` — после `unpostpone` все три поля обнулены + audit.
4. `test_leads_for_operator_view_filter` — фикстуры: 3 активных + 2 отложенных. `view=active` возвращает 3, `view=postponed` возвращает 2, `view=all` — 5.
5. `test_lead_reassign_clears_postpone` — оператор A отложил лид → TL переназначил на оператора B → у B лид виден в активных (не в отложенных), поля обнулены. Audit `lead.reassign` + `lead.postpone_cleared_by_reassign` (или один комбинированный).

Опционально 6-й: `test_lead_my_response_has_counts` — `GET /api/leads/my/` возвращает `counts.active` и `counts.postponed` корректно.

---

## 7. Что НЕ делаем

- **Не создаём новый статус `POSTPONED`** — постpone это ортогональный флаг, статус остаётся тем, каким был.
- **Не автоматически «поднимаем» postponed через N дней** — не делаем cron который через 24ч возвращает лид в активные. Оператор сам решает когда вернуться. Если позже понадобится — сделать отдельной волной с полем `postponed_until` и командой.
- **Не открываем postpone для TL/Manager** — только оператор может отложить свой лид. TL если очень надо — сделает `lead_reassign` (существующий инструмент).
- **Не хардкодим max количество отложенных** — оператор может отложить хоть всё, это его проблема (в счётчике будет видно).
- **Не показываем postpone-историю в UI карточки** — audit пишется, но детальный просмотр «кто-когда-отложил-раз-отложил-два» — off scope. Одна пара `postponed_at + reason` актуальна, история — в `/audit`.
- **Не двигаем postponed лиды в отдельный queryset для аналитики/marketing** — они по-прежнему считаются в общей воронке. Флаг чисто UI-навигационный.

---

## 8. Порядок работ

1. Модель + миграция + тест на shape (`test_lead_postpone_sets_fields` полу-готов — просто проверяет что поля есть и `save()` не падает).
2. Сервисы `lead_postpone` / `lead_unpostpone` + правка `lead_reassign` (clear postpone) + audit — тесты #1, #3, #5.
3. Селектор `leads_for_operator` c параметром `view` — тест #4.
4. Endpoint'ы `LeadPostponeApi` / `LeadUnpostponeApi` + расширить `LeadMyListApi` (view + counts) — тест #2, опциональный #6.
5. Frontend: расширить типы, добавить `useMyLeadsQuery({view})`, три таба, кебаб-меню, confirm-модалка с textarea, empty-states.
6. Прогон `pytest apps/leads/` — должно быть **≥ 13 passed** (было 8 + 5 новых). Полный regressive — **≥ 289 passed**.
7. Обновить README: раздел «Оператор → Мои лиды» — добавить абзац про «На потом».

---

## 9. Как это влияет на существующее

- `LeadSerializer` теперь возвращает 3 новых поля во всех местах (список лидов админа, deteil-view, MyLeads). Проверить, что фронтенд-код не падает на неизвестных полях (TS-типы обновить).
- `leads_for_operator` вызывается только из `LeadMyListApi` — новый параметр `view="active"` по умолчанию сохраняет прежнее поведение везде.
- `lead_reassign` теперь всегда чистит postpone-поля. Если раньше был race «переназначили пока оператор откладывал», теперь новый оператор получает чистый лид, а старый через websocket/polling увидит что лид уехал.
- Google Sheets sync не создаёт лидов с проставленным postponed — новые лиды по умолчанию активны.
