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
