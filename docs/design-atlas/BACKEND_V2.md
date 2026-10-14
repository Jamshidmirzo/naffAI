# Бэкенд для нового дизайна — контракт (добавочно, ничего существующего не меняем)

Все эндпоинты под `/api/`, авторизация как у соседних (Token). Права и скоупинг — как у ближайших существующих эндпоинтов. Фронт должен работать и БЕЗ этих эндпоинтов (404/500 → graceful fallback), потому что прод-бэкенд их пока не имеет.

## 1. Пульт зала — `GET /api/operators/floor/`
Права: IsManager (manager, team_lead, super_manager, superadmin). Скоуп: `visible_operator_ids(request.user)`. Параметр `?manager_id=<user_id>` (опц., только для super_manager/superadmin) — оставить операторов с `managed_by_id=manager_id`; `?manager_id=none` — без менеджера.
```json
{
  "generated_at": "2026-10-14T14:22:05+05:00",
  "pin_verified": true,
  "rr_batch_size": 5,
  "operators": [
    {
      "id": 12, "full_name": "Jasur Toshmatov", "status": "active|trainee",
      "managed_by_id": 7, "avatar_url": null,
      "state": "call|wait|pause|late|absent|off|dayoff",
      "call_started_at": "…|null",      // открытый Call (outcome="" и ended_at null) младше 15 мин
      "call_is_estimate": true,
      "paused_at": "…|null",
      "checked_in_at": "…|null",        // null, если pin_verified=false
      "late_minutes": 33,               // null, если не опоздал или pin_verified=false
      "working_count": 4, "quota": 5,
      "sales_today": 3, "sales_today_amount": "31500000",
      "overdue_callbacks": 1,
      "plan_target": 30, "plan_actual": 18
    }
  ]
}
```
Правило `state` (по порядку): approved day-off сегодня или weekly_day_off → `dayoff`; `is_paused` → `pause`; открытый Call < 15 мин → `call`; нет check-in сегодня: если после `shift_start+grace` → `absent`, иначе `off`; check-in с опозданием и < 60 мин назад → `late` (иначе как обычно); иначе `wait`. Без PIN-сессии check-in/опоздания берутся только для `state` (персональные `checked_in_at`/`late_minutes` = null), `pin_verified=false`.

## 2. Подписки на уведомления — `GET/PATCH /api/notifications/preferences/`
Модель `NotificationPreference(user FK, kind CharField(choices=NotificationKind), in_app bool default True, telegram bool default False, unique(user, kind))`.
GET → `{"items":[{"kind":"sale_created","in_app":true,"telegram":false}, …]}` — по всем kind, применимым к роли пользователя (недостающие строки = defaults). PATCH `{"items":[{"kind":"…","in_app":false}]}` → тот же формат. `notification_broadcast` пропускает получателей с `in_app=False` для этого kind.

## 3. Супер-менеджер получает `sale_created` и `birthday`
В `sales/services.py` (seniors для SALE_CREATED) и `operators/management/commands/birthday_notify.py` добавить `Role.SUPER_MANAGER` в список ролей получателей.

## 4. Массовый перенос операторов — `POST /api/operators/bulk-set-manager/`
Body `{"operator_ids":[1,2,3], "managed_by_id": 7|null}`. Права и проверки — как у PATCH `/operators/<id>/` с `managed_by_id`. Атомарно; ответ `{"updated":[1,2,3], "errors":[{"id":4,"detail":"…"}]}`. Audit-лог как у одиночного PATCH.

## 5. Поиск продаж по клиенту
`GET /api/sales/?search=` — дополнительно искать по `client_phone` и `client_name` (или как называются поля клиента в модели Sale).

## 6. План оператора виден ему самому
`GET /api/leads/my/status/` — добавить поля `plan_target` (int|null), `plan_actual` (int) за текущий месяц (тот же расчёт, что `plan_actual` в `/operators/`).

## 7. Фильтр по менеджеру для пульта ветки
`GET /api/analytics/dashboard-summary/` и `GET /api/analytics/leaderboard/` — опц. `?manager_id=<id>|none` (только super_manager/superadmin): ограничить операторов `managed_by_id`. Без параметра — поведение не меняется.

## Миграции
Только `notifications/00xx_notificationpreference.py` (новая таблица). Больше миграций не добавлять.

## Тесты
pytest в стиле `apps/*/tests`: на каждый эндпоинт — права, скоуп, формат; на `state` — все ветки; на preferences — фильтрация в broadcast; на bulk — частичные ошибки.

---

## Implemented (ветка `feat/design-atlas`, 2026-10-14)

Всё добавочно; существующие поля/поведение не менялись, кроме явно оговорённого в спеке (п.3 — получатели, п.5 — поиск, п.6–7 — опц. поля/параметр). Одна новая миграция: `notifications/0005_notificationpreference.py`.

### 1. `GET /api/operators/floor/`
- Права: `IsAuthenticated + IsManager` (team_lead / manager / super_manager / superadmin / Django superuser). Оператор → 403, аноним → 401.
- Скоуп: `visible_operator_ids(user)`, операторы со `status=inactive` не выводятся. Сортировка — `full_name, id`.
- `?manager_id=<user_id>|none` (`null`/`unassigned` — синонимы `none`) — только super_manager/superadmin/superuser; у остальных ролей **молча игнорируется** (ответ как без параметра). Не-число → 400 `{"manager_id": "..."}`.
- Ответ — ровно как в спеке: `generated_at`, `pin_verified`, `rr_batch_size`, `operators[]` с полями `id, full_name, status, managed_by_id, avatar_url, state, call_started_at, call_is_estimate, paused_at, checked_in_at, late_minutes, working_count, quota, sales_today, sales_today_amount, overdue_callbacks, plan_target, plan_actual`.
- Детали расчёта:
  - `state` — порядок из спеки, плюс одна доп. ветка (**отклонение**): если check-in сегодня был, но все сегодняшние смены закрыты (checkout) → `off` (иначе ушедший домой висел бы как `wait`).
  - grace для `absent` и для `late_minutes` = `AttendanceSettings.late_threshold_min` (тот же, что ставит `was_late` и считает `attendance_late_notification`); `shift_start` — персональный, иначе глобальный. `late_minutes = checked_in_at − (shift_start + late_threshold_min)` в минутах, только если `was_late`.
  - `dayoff`: approved `OperatorDayOff` на сегодня ИЛИ `weekday == (operator.weekly_day_off ?? AttendanceSettings.default_weekly_day_off)`.
  - `call`: `CallAttempt` с `outcome=""` и `ended_at IS NULL`, у которого `coalesce(started_at, created_at)` в последние 15 мин. `call_started_at` — самый свежий такой старт; `call_is_estimate` = `true`, когда `call_started_at` не null (время всегда выводится из открытого CallAttempt, не из телефонии), иначе `false`.
  - `paused_at` — только если `is_paused`, иначе null.
  - `checked_in_at` — первый check-in за сегодня (локальная дата).
  - `working_count` — та же аннотация, что `operators_distribution_status` (non-carry, не postponed, active-today); `quota` = `rr_batch_size` = `settings.RR_BATCH_SIZE`.
  - `sales_today` / `sales_today_amount` — по `SaleOperator` (multi-op credit, как leaderboard): confirmed, не удалённые, не возвращённые, `sold_at` сегодня. Сумма — строка целых сум (`"31500000"`).
  - `overdue_callbacks` — `CallbackReminder` в статусах pending/overdue/snoozed с `remind_at <= now − CALLBACK_OVERDUE_GRACE_MINUTES` (без учёта per-operator gate-флага).
  - `plan_target` / `plan_actual` — та же аннотация, что `/operators/` (`operator_list(with_plan=True)`), но **int** (сумы, без копеек), а не decimal-строка. Это суммы денег, не штуки. `plan_target=null`, если плана на месяц нет.
  - `avatar_url` — абсолютный URL или null.
- `pin_verified`: superadmin — всегда `true`; иначе валидная `AttendancePinSession` (< 30 мин), та же проверка, что `IsAttendancePinVerified` (без raise — хелпер `apps.attendance.permissions.attendance_pin_access_granted`). Сам endpoint PIN не требует.

### 2. `GET/PATCH /api/notifications/preferences/`
- Права: любой залогиненный с ролью (`IsAuthenticatedAnyRole`).
- Модель `NotificationPreference(user, kind, in_app=True, telegram=False, created_at, updated_at)`, `UniqueConstraint(user, kind)`.
- Kind'ы по роли (порядок стабильный):
  - senior (team_lead/manager/super_manager/superadmin): `sale_created, sale_returned, birthday, system`;
  - operator: `lead_assigned, callback_overdue, sale_rejected, sale_celebration, system`.
  - `snapshot_request` **не настраивается** и никогда не фильтруется (служебная команда «сделай снимок»).
- PATCH: `{"items":[{"kind","in_app"?,"telegram"?}]}`; непереданные флаги не трогаются. Kind вне списка роли → 400 (ничего не сохраняется). Ответ — полный список, как GET.
- Фильтрация: `notification_broadcast` выкидывает получателей с `in_app=False` для этого kind (если все выкинуты — 0 строк). Дополнительно (**сверх спеки**) `birthday_notify` применяет тот же фильтр к своему in-app `bulk_create` (он не ходит через broadcast). Прямые `Notification.objects.create(...)` других мест (system-напоминания attendance, morning-gate callback_overdue в `/leads/my/`) фильтр **не** применяют.
- `telegram` пока только хранится: TG-рассылки его не читают.

### 3. super_manager получает `sale_created` и `birthday`
`Role.SUPER_MANAGER` добавлен в списки получателей в `sales/services.py::_broadcast_new_sale` и `operators/management/commands/birthday_notify.py` — и для in-app, и для TG DM (если у профиля есть `telegram_user_id`).

### 4. `POST /api/operators/bulk-set-manager/`
- Права: `IsAuthenticated + IsTeamLead` (как `OperatorDetailApi`). Валидация `managed_by_id` — тем же `OperatorSerializer.validate`, что у PATCH; недопустимый владелец / несуществующий user → **400 целиком** (`{"managed_by_id": [...]}`), ничего не меняется.
- Body: `operator_ids` (1..500 int), `managed_by_id` (int | null, обязателен).
- Ответ `200 {"updated":[...], "errors":[{"id", "detail"}]}`; порядок — как во входе, дубликаты схлопываются.
- **Отклонение (строже PATCH)**: оператор вне `visible_operator_ids(user)` → в `errors` («Нет доступа к этому оператору»), несуществующий → «Оператор не найден».
- Атомарно (одна транзакция). Audit — через `operator_update` (`action=update`, `entity=operators.Operator`), как у PATCH. Если владелец уже совпадает — id в `updated`, но записи/аудита нет.

### 5. Поиск продаж
`GET /api/sales/?search=` дополнительно ищет по `client_name` и `client_phone` (icontains); если в строке ≥3 цифр и есть разделители — ещё и по digits-only (`"90 123-45-67"` → `901234567`).

### 6. `GET /api/leads/my/status/`
Добавлены `plan_target` (int|null) и `plan_actual` (int) — суммы за текущий месяц, тот же расчёт, что в `/operators/` (int вместо decimal-строки).

### 7. `?manager_id=` для `dashboard-summary` и `leaderboard`
- Только super_manager/superadmin/superuser; у остальных игнорируется. Мусор → 400.
- leaderboard: allowlist = `visible_operator_ids ∩ managed_by`.
- dashboard-summary с фильтром идёт **мимо кэша**; сужаются: `today`, `pending_count`/`to_review`/`on_review`, `turnover.actual`, `conversion` (лиды по `Lead.operator`, продажи по оператору), `shift` (`on_shift`/`expected`/`late_today`), `timeseries`, `attention.stranded_on_inactive`, `top_operators`. **Не** сужаются: `attention.orphans` (у сирот нет оператора) и `turnover.target` / `target_daily_count` (SalesTarget глобальный). Без параметра — байт-в-байт прежнее поведение и кэш.

### Как фронту детектить старый прод-бэкенд
| Фича | Признак отсутствия |
|---|---|
| `/operators/floor/` | 404. **Внимание**: на старом бэке `floor/` не матчится ни одним роутом → 404 (не 405). |
| `/operators/bulk-set-manager/` | 404 (POST). Fallback — N× `PATCH /operators/<id>/`. |
| `/notifications/preferences/` | 404. |
| `plan_target`/`plan_actual` в `/leads/my/status/` | ключей нет в ответе (`undefined`, а не `null`). |
| `?manager_id=` в analytics | старый бэк молча игнорирует — отличить нельзя; использовать только если `/operators/floor/` не вернул 404. |
| поиск по клиенту | старый бэк просто вернёт меньше результатов. |
| super_manager в получателях | невидимо фронту. |

### Миграции
- `notifications/0005_notificationpreference.py`: `CreateModel NotificationPreference` + `AlterField Notification.kind` (только `choices` — дрейф, накопленный до этой ветки: `snapshot_request` не был в миграциях; в БД no-op).
- `makemigrations --check` показывает ещё дрейф в `attendance`, `catalog`, `operators` — он **существовал до этой ветки** (rename индексов / choices / validators), не трогался.

### Тесты
`apps/operators/tests/test_floor_api.py`, `apps/operators/tests/test_bulk_set_manager.py`, `apps/notifications/tests/test_preferences.py`, `apps/sales/tests/test_sale_search_client.py`, `apps/leads/tests/test_my_status_plan.py`, `apps/analytics/tests/test_manager_filter.py`.
