# QR-attendance — доработки: админ-статистика, 10ч-warning, ручное закрытие

Спека для builder-агента. Дополнение к основной `/Users/user/Desktop/mp/ai/naff/docs/qr-attendance-spec.md` (базовая фича QR check-in/out + TG-канал уже реализована). Здесь — три требования, которые нужно закрыть в едином waves-е.

**Контекст**: Проект `/Users/user/Desktop/mp/ai/naff/`. Django 5 + DRF + React + Vite + TS. App уже существует — `apps/attendance/` (models/services/apis/urls/admin/tests). Единый сервис `process_attendance_event(...)` уже есть — переиспользовать. Никаких эмодзи в коде.

Регресс на момент старта: **254 passed**. После этой волны должно быть **не меньше 266 passed** (+12 новых тестов из этой спеки).

---

## Что переиспользуем

| Инфра | Файл | Зачем |
|---|---|---|
| Единый сервис attendance | `apps/attendance/services.py::process_attendance_event` | Ручное закрытие и авто-checkout через callback дёргают этот же сервис |
| TG-нотификации | `apps/tg_bot/notify.py` | 10ч-warning DM оператору и тимлиду |
| Excel-экспорт | `apps/sales/export_apis.py` + `openpyxl` (посмотри реальный паттерн проекта) | Экспорт отчёта посещаемости |
| Audit | `apps/audit/services.py` | Записи `attendance.log_closed_manually`, `attendance.long_shift_warning_sent` |
| Systemd-таймеры | `deploy/systemd/naff-daily-lessons-*.timer` (образец) | Новый таймер `naff-attendance-long-shift-check` |
| Permissions | `apps/common/permissions.py::IsTeamLeadOrManager` | Все новые endpoint'ы |
| TG runner + link_operator | `apps/tg_bot/runner.py` | Callback handler'ы `attendance:auto_checkout_confirm:*` и `attendance:continue_working:*` |
| Существующая страница `/attendance/today` | `frontend/src/pages/AttendanceToday.tsx` | Дополнить кнопкой «Закрыть смену» |
| Компонент RoleGate | `frontend/src/components/RoleGate.tsx` | Скрыть кнопки от operator-роли |

---

## 1. Расширение модели `AttendanceLog`

В `apps/attendance/models.py` добавить в `AttendanceLog`:

```python
long_shift_warning_sent_at = models.DateTimeField(
    null=True, blank=True,
    help_text="Момент отправки предупреждения о длинной смене — защита от повторов",
)
warning_dismissed_at = models.DateTimeField(
    null=True, blank=True,
    help_text="Оператор нажал 'Нет, продолжаю' — не шлём повтор",
)
manually_closed = models.BooleanField(default=False)
manually_closed_by = models.ForeignKey(
    "auth.User", null=True, blank=True,
    on_delete=models.SET_NULL, related_name="+",
    help_text="Кто из TL/Manager закрыл смену руками",
)
manual_close_note = models.CharField(max_length=280, blank=True, default="")
```

В `AttendanceSettings`:

```python
long_shift_warning_hours = models.PositiveSmallIntegerField(
    default=10,
    help_text="После скольких часов открытой смены слать warning",
)
```

Миграция `0002_long_shift_and_manual_close.py`.

---

## 2. Управление предупреждением о длинной смене

### 2.1 Management command

`apps/attendance/management/commands/attendance_long_shift_check.py`:

```
python manage.py attendance_long_shift_check [--dry-run]
```

Логика (одной транзакцией на лог):
1. Взять `AttendanceLog.objects.filter(check_out__isnull=True, long_shift_warning_sent_at__isnull=True, warning_dismissed_at__isnull=True)`.
2. Отфильтровать те, у которых `check_in <= now() - settings.long_shift_warning_hours * hour`.
3. Для каждого:
   - Взять оператора; если есть привязка TG (см. `apps/tg_bot/` — как определяется TG user_id оператора) → шлём **DM оператору** с inline-кнопками:
     - «Отметить уход» → `callback_data=f"attendance:auto_checkout_confirm:{log.id}"`
     - «Нет, продолжаю» → `callback_data=f"attendance:continue_working:{log.id}"`
     - Текст: «{name}, ты работаешь уже {hours} часов. Забыла отметить уход?»
   - Если у оператора есть `Operator.team_lead` (или как связь названа — уточнить в коде) → **DM тимлиду**: «{name} работает уже {hours} часов без check-out. Проверь.»
   - Проставить `log.long_shift_warning_sent_at = now()`
   - Написать audit-запись `attendance.long_shift_warning_sent` с meta `{log_id, hours, sent_to: ["operator", "team_lead"]}`
4. Edge cases:
   - Нет TG у оператора → DM только тимлиду, в тексте пометка «(нет TG у оператора)», аудит `sent_to: ["team_lead"]`
   - Нет team_lead у оператора → DM только оператору, аудит `sent_to: ["operator"]`
   - Нет ни того, ни другого → аудит `attendance.warning_skipped_no_recipients`, поле `long_shift_warning_sent_at` **не** трогаем (чтобы если позже привяжется TG — предупреждение всё-таки ушло)

Команда идемпотентная в пределах одного лога — `long_shift_warning_sent_at IS NULL` защищает.

### 2.2 Systemd-таймер

`deploy/systemd/naff-attendance-long-shift-check.service`:
```ini
[Unit]
Description=naffAI attendance long-shift warning
After=network.target

[Service]
Type=oneshot
WorkingDirectory=/opt/naffAI
EnvironmentFile=/opt/naffAI/.env
ExecStart=/opt/naffAI/.venv/bin/python manage.py attendance_long_shift_check
StandardOutput=append:/var/log/naffAI/attendance-long-shift.log
StandardError=append:/var/log/naffAI/attendance-long-shift.log
```

`deploy/systemd/naff-attendance-long-shift-check.timer`:
```ini
[Unit]
Description=naffAI attendance long-shift warning (every 30 min)

[Timer]
OnCalendar=*:00/30
Persistent=true
Unit=naff-attendance-long-shift-check.service

[Install]
WantedBy=timers.target
```

Обнови `deploy/README.md` — команда для установки:
```
systemctl daemon-reload
systemctl enable --now naff-attendance-long-shift-check.timer
```

И проверка: `systemctl list-timers | grep naff-attendance`.

### 2.3 TG callback handlers

В `apps/tg_bot/runner.py` (или, если делаешь чисто — вынеси в `apps/tg_bot/handlers/attendance.py`):

- `@dp.callback_query(F.data.startswith("attendance:auto_checkout_confirm:"))`
  1. Распарсить `log_id`
  2. Проверить, что нажавший TG-user привязан именно к оператору этого лога — иначе `answer("Это не твоя смена", show_alert=True)`
  3. Дёрнуть `process_attendance_event(operator=op, source="tg", action="check_out")` (или как в API — просто скан приведёт к check-out; если сервис принимает явное action — использовать)
  4. Ответ: «Хорошего вечера, {name}. Смена {duration}.»
  5. Убрать inline-клавиатуру у исходного сообщения (`edit_reply_markup(None)`)

- `@dp.callback_query(F.data.startswith("attendance:continue_working:"))`
  1. Распарсить `log_id`, проверить принадлежность
  2. `log.warning_dismissed_at = now(); log.save(update_fields=["warning_dismissed_at"])`
  3. Ответ: «Ок, продолжай. Повторно не побеспокою.»
  4. Убрать inline-клавиатуру

Оба callback handler'а — тонкие; вся бизнес-логика в сервисе.

---

## 3. Ручное закрытие смены через UI

### 3.1 Endpoint

`POST /api/attendance/logs/<log_id>/close/`
- Permission: `IsTeamLeadOrManager`
- Body: `{"note": "<optional string, max 280>"}`
- Логика:
  - Найти лог по id, 404 если нет
  - Если `check_out IS NOT NULL` → 409 Conflict `{detail: "Лог уже закрыт"}`
  - Транзакцией: `check_out=now()`, `manually_closed=True`, `manually_closed_by=request.user`, `manual_close_note=note`
  - Audit-запись `attendance.log_closed_manually` с meta `{log_id, operator_id, closed_by, note}`
- Ответ 200: сериализованный лог с `duration_min` и всеми флагами

### 3.2 UI

**`AttendanceToday.tsx`** — в строке каждого «на смене» оператора добавить кнопку **«Закрыть смену»** справа. Клик → confirm-модалка:
- Заголовок: «Закрыть смену Севары?»
- Поле textarea для note (плейсхолдер «Комментарий (не обязателен)»)
- Кнопки «Отмена» / «Закрыть»
- POST → invalidate query → строка перерисуется как «Закрыта в HH:MM, TL»

**`OperatorDetail.tsx`** — в секции «Посещаемость» на строках истории:
- Для открытых логов — кнопка «Закрыть смену» (та же модалка)
- Для закрытых логов — визуальный бейдж рядом с длительностью:
  - `qr` (source) — без бейджа, это норма
  - `tg` — маленький бейдж «TG»
  - `manually_closed=True` — синий бейдж «TL: {username}» с тултипом `manual_close_note`
  - `auto_closed=True` — жёлтый бейдж «Авто-закрыто в 23:00»

**Скрыть кнопки от operator-роли** через `<RoleGate allow={["team_lead","manager"]}>`.

---

## 4. Админ-статистика посещаемости

### 4.1 Endpoint отчёта

`GET /api/attendance/report/?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&operator=<id>&format=json|xlsx`
- Permission: `IsTeamLeadOrManager`
- Query params:
  - `date_from`, `date_to` — обязательные, включительно
  - `operator` — опциональный (если не задан → все активные операторы)
  - `format=xlsx` → возвращает Excel-файл через существующий export-паттерн (посмотри `apps/sales/export_apis.py`); default `json`
- Ответ (json), сгруппировано по оператору:
  ```json
  {
    "period": {"from": "2026-07-01", "to": "2026-07-24"},
    "rows": [
      {
        "operator_id": 3,
        "operator_name": "Севара",
        "days_expected": 20,
        "days_present": 18,
        "days_absent": 2,
        "late_count": 4,
        "avg_late_minutes": 12,
        "auto_closed_count": 3,
        "manually_closed_count": 1,
        "avg_shift_minutes": 528,
        "total_worked_hours": 158.4,
        "heatmap": [
          {"date": "2026-07-01", "status": "on_time"},
          {"date": "2026-07-02", "status": "late"},
          {"date": "2026-07-03", "status": "absent"},
          {"date": "2026-07-04", "status": "weekend"},
          ...
        ]
      }
    ]
  }
  ```
- `days_expected` — рабочие дни диапазона по календарю; выходные — из `AttendanceSettings` (если такое поле там есть; если нет — считать пн-сб рабочими)
- `heatmap.status` — enum `on_time|late|absent|weekend|auto_closed|manually_closed`

Селектор в `apps/attendance/selectors.py::attendance_report(operator_ids, date_from, date_to)`.

### 4.2 Страница `/attendance/report`

`frontend/src/pages/AttendanceReport.tsx` — новый route (защищён `RoleGate allow=["team_lead","manager"]`).

Layout:
1. **Фильтры сверху**: DateRangePicker (по умолчанию текущий месяц), MultiSelect операторов, кнопка «Экспорт в Excel».
2. **Табличная сводка** — колонки: Оператор, Дней явился/должен, Опозданий (среднее), Auto/Manual-closed, Средняя длина смены, Итого часов.
   - Сортировка по клику на заголовок.
   - Клик по строке оператора → раскрывается heatmap (по образцу GitHub contribution graph, 30 клеток минимум).
3. **Heatmap-легенда**: зелёный = on_time, жёлтый = late, красный = absent, серый = weekend, жёлто-полосатый = auto_closed, синий = manually_closed.
4. Кнопка «Экспорт в Excel» → POST/GET с `format=xlsx` → скачивает файл `attendance_YYYY-MM-DD_to_YYYY-MM-DD.xlsx`.

**На `OperatorDetail.tsx`** в существующей секции «Посещаемость» (P1 из предыдущей приёмки) — добавить эту же сводку по одному оператору за последние 30 дней + heatmap. Не дублировать код: вынести `<AttendanceStatsCard operator={id} from={...} to={...}/>` в `frontend/src/components/AttendanceStatsCard.tsx`, использовать в обоих местах.

### 4.3 Excel-формат

Один sheet «Attendance», колонки как в json (без heatmap — heatmap идёт вторым sheet'ом «Heatmap»: строка = оператор, колонки = даты, значения = статус).

Использовать `openpyxl` через тот же слой, что и `apps/sales/export_apis.py`.

---

## 5. Тесты

`apps/attendance/tests/`:

1. `test_long_shift_warning_command_sends_dms` — открытый лог 10ч+ без warning → команда шлёт 2 DM (оператору + TL), проставляет `long_shift_warning_sent_at`. Мокать `apps/tg_bot/notify.py`.
2. `test_long_shift_warning_not_re_sent` — второй прогон команды не шлёт повторно (по идемпотентности через `long_shift_warning_sent_at IS NOT NULL`).
3. `test_long_shift_warning_no_tg_operator_notifies_tl_only` — у оператора нет TG-привязки → шлём только TL, meta.sent_to = ["team_lead"].
4. `test_long_shift_warning_no_tl_notifies_operator_only` — у оператора нет `team_lead` → шлём только оператору.
5. `test_long_shift_warning_no_recipients_skipped` — нет ни TG у оператора, ни TL → audit `warning_skipped_no_recipients`, поле `long_shift_warning_sent_at` НЕ проставляется.
6. `test_operator_confirms_auto_checkout_via_callback` — оператор нажал inline-кнопку «Отметить уход» → callback handler → лог закрыт с `source="tg"`, ответ бота «Хорошего вечера».
7. `test_operator_dismisses_warning_no_repeat` — оператор нажал «Нет, продолжаю» → `warning_dismissed_at` заполнен, повтор команды через час не шлёт DM.
8. `test_manual_close_endpoint_closes_log` — TL POST → лог закрыт, `manually_closed=True`, `manually_closed_by=<TL user>`, note записан, audit есть.
9. `test_manual_close_by_operator_forbidden` — operator-роль → 403.
10. `test_manual_close_already_closed_returns_409` — уже закрытый лог → 409.
11. `test_report_endpoint_returns_period_stats` — фикстуры на неделю + 3 операторов → GET report → корректная агрегация (`days_expected`, `late_count`, `avg_shift_minutes` и т.д.).
12. `test_report_endpoint_permission` — operator → 403; team_lead / manager → 200.

Итого +12 тестов; отдельный `test_report_xlsx_export` **опционален** (если экспорт-паттерн уже покрыт тестами в `apps/sales/tests/`, дублировать не надо — только smoke: content-type = `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`).

---

## 6. Что НЕ делаем

- Не шлём warning раньше 10ч (если TL хочет 8ч — меняет `AttendanceSettings.long_shift_warning_hours` через админку). Не хардкодим порог.
- Не пробуем «угадать», когда оператор реально ушёл — при auto-close (23:00) и при ручном закрытии `check_out = now()`, честно. Обратное было бы враньём в статистику посещаемости.
- Не шлём SMS / не звоним, если оператор не отвечает на DM. Единственный канал уведомления — TG. Эскалация выше 10ч — только тимлиду. Если TL тоже не отреагировал — не наша забота, пусть манагер видит в отчёте.
- Не даём оператору закрывать чужие или свои смены через API «руками» — единственный путь check-out для оператора это QR-скан или TG-команда. Ручное закрытие — привилегия TL/Manager (по существу это административное действие).
- Не строим прогноз (типа «Севара обычно уходит в 20:00, сейчас 20:30, спроси через час») — считаем только фактические 10ч от `check_in`.
- Не считаем «выходные» гибко (per-operator schedule) — единый календарь пн-сб рабочие, воскресенье выходной (или как решено в `AttendanceSettings`). Кастомные графики — отдельная фича.

---

## 7. Порядок работ

1. Миграция `AttendanceLog` (+4 поля) + `AttendanceSettings.long_shift_warning_hours`. Прогнать `pytest apps/attendance/` — regressive должен быть зелёный (25 → 25 passed).
2. Endpoint `POST /api/attendance/logs/<id>/close/` + сервис + audit + 3 теста (`manual_close_*`).
3. Management command `attendance_long_shift_check` + selector отбора логов + 5 тестов (`long_shift_warning_*`).
4. TG-callback handler'ы `attendance:auto_checkout_confirm:*` и `attendance:continue_working:*` + 2 теста (`test_operator_confirms_*`, `test_operator_dismisses_*`).
5. Systemd-таймер `naff-attendance-long-shift-check` (service + timer) + обновление `deploy/README.md` + строка в `deploy/deploy.sh`.
6. Selector `attendance_report(...)` + endpoint `GET /api/attendance/report/` + 2 теста (`test_report_*`).
7. Excel-экспорт `?format=xlsx` через существующий паттерн — smoke-тест на content-type.
8. Компонент `AttendanceStatsCard` (переиспользуемый).
9. Страница `AttendanceReport.tsx` с DateRangePicker + MultiSelect + сортируемой таблицей + heatmap + кнопкой экспорта.
10. Кнопка «Закрыть смену» + confirm-модалка на `AttendanceToday.tsx`.
11. Секция «Посещаемость» на `OperatorDetail.tsx`: подключить `AttendanceStatsCard` + список логов с кнопкой «Закрыть смену» + бейджами source/auto/manual.
12. Прогнать полный pytest — должно быть **≥ 266 passed**. Прогнать `pytest apps/attendance/` — должно быть **≥ 37 passed** (было 25 + 12 новых).
13. Обновить README: раздел «QR check-in», подразделы «Warning о длинной смене», «Ручное закрытие», «Отчёт посещаемости», ссылка на новый systemd-таймер.

---

## 8. Deploy на VPS `46.101.112.215`

После merge и деплоя основного кода:
```
scp deploy/systemd/naff-attendance-long-shift-check.{service,timer} root@46.101.112.215:/etc/systemd/system/
ssh root@46.101.112.215 'systemctl daemon-reload && systemctl enable --now naff-attendance-long-shift-check.timer && systemctl list-timers | grep naff-attendance'
```

Не забыть, что на VPS должен быть создан `/var/log/naffAI/` с правами на запись пользователю, под которым крутится сервис (посмотри как у `naff-daily-lessons-*`).
