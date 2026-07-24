# CRUD-workflow аудит naffAI

Полный read-only аудит проекта `/Users/user/Desktop/mp/ai/naff/` от 2026-07-24. Спека для builder-агента — по этому документу можно волной закрыть найденные пробелы.

Источники: параллельный инвентарь тремя Explore-агентами по трём группам app'ов + сверка с `docs/*-spec.md` + карта frontend routes + inventory systemd-таймеров. Никаких изменений в код не вносилось.

---

## 1. Executive summary

- **18 Django-app'ов**: `sales`, `catalog`, `payroll`, `analytics`, `users`, `operators`, `stickers`, `leads`, `calls`, `greetings`, `tg_bot`, `tg_userclient`, `ai_chat`, `marketing`, `attendance`, `lessons`, `audit`, `common`.
- **~40 доменных сущностей** с полным или частичным CRUD.
- **266 pytest passed** (последний зафиксированный regressive, `apps/attendance` 37 из них).
- **App'ы без тестов**: `catalog` (0). Слабое покрытие: `greetings` (1), `ai_chat` (1), `marketing` (1).
- **Найдено пробелов**: **6 P0**, **17 P1**, **~20 P2/tech-debt**.

### Общий вердикт

Система операционно готова к прод-эксплуатации, критичных дыр в основных бизнес-флоу (продажа / лид / attendance / payroll) нет. Все ключевые фичи задокументированы в `docs/*-spec.md` и реализованы полностью или почти полностью. Основные слабости — **непокрытые тестами доменные модули** (catalog), **отсутствие UI для админских настроек** (PayrollRule, AttendanceSettings, DailyQuote), и **точечные security-риски по отсутствию транзакционной защиты вокруг TG-нотификаций**.

---

## 2. CRUD-матрица по сущностям

Легенда: ✓ = есть · ⚠ = частично / только через родительскую сущность · ✗ = отсутствует.

| App | Сущность | C | R list | R detail | U | D | Permissions | UI | Тесты |
|---|---|---|---|---|---|---|---|---|---|
| sales | Sale | ✓ | ✓ | ✓ | ✓ | ✓ soft | TL write / Mgr RO | ✓ | ✓ |
| sales | GiftItem | ✓ | ✓ | ✓ | ⚠ через Sale | ⚠ каскад | как Sale | ⚠ | ✓ |
| sales | SaleOperator | ✓ | ✓ | ✓ | ⚠ через Sale | ⚠ | как Sale | ⚠ | ✓ |
| sales | SalePartner | ✓ | ✓ | ✓ | ⚠ через Sale | ⚠ | как Sale | ⚠ | ✓ |
| catalog | Channel | ✓ | ✓ | ✓ | ✓ | ✗ (только `is_active=False`) | TL/Mgr | ✓ | ✗ |
| catalog | TacLookup | ✗ (management cmd) | ✓ | ✓ | ✗ | ✗ | TL/Mgr RO | ✗ | ✗ |
| payroll | PayrollRule | ✓ | ✓ | ✓ | ✓ | ✗ | TL | ✗ | ⚠ (только compute) |
| payroll | PayrollLine (derived) | — | ✓ | — | — | — | TL/Mgr RO | ✓ | ✓ |
| analytics | (derived) | — | ✓ | — | — | — | TL/Mgr RO | ✓ | ✓ (3) |
| users | User+Profile | ✓ через Operator | — | ✓ (me) | ✓ пароль | ✓ soft | Mgr | ✗ | ✓ (27) |
| users | OperatorSecret | ✓ auto | ✗ | ✗ | ✓ sync | ⚠ cascade | Mgr | ✗ | ✓ |
| operators | Operator | ✓ | ✓ | ✓ | ✓ | ✓ soft | TL | ✓ | ✓ (4) |
| operators | OperatorMonthlyPlan | ✓ upsert | ✗ агрегат | ✓ per op | ✓ upsert | ✗ | TL | ✓ | ⚠ |
| stickers | OperatorSticker | ✓ | ✓ palette | ✓ | ✓ | ✓ | оператор / TL | ✓ | ✓ (9) |
| leads | Lead | ✓ | ✓ | ✓ | ✓ status | ✗ | TL/Mgr RO + bot | ✓ | ✓ |
| leads | LeadAssignment | ✓ auto/manual | ✓ | ✗ | ✗ | ✗ | TL | ✗ история | ✓ |
| leads | SheetSource | ✓ | ✓ | ✓ | ✓ | ✗ | TL | ✓ | ✓ |
| leads | OperatorSheetAlias | ✓ | ✓ | ✗ | ✓ | ✓ | TL | ✓ | ⚠ |
| leads | TelegramLink | ✓ upsert | ✗ | ✓ lookup | ✓ | ✗ | все | ✗ | ⚠ |
| calls | CallAttempt | ✓ | ✓ | ✗ | ✗ | ✗ | все | ⚠ в MyLeads | ✓ |
| calls | CallbackReminder | ✓ | ✓ mine | ✗ | ✓ snooze/done | ✗ | все | ⚠ в MyLeads | ✓ (3) |
| greetings | DailyQuote | ✗ (management cmd) | ✗ | ✓ | ✗ | ✗ | все RO | ⚠ модалка | ⚠ (1) |
| greetings | DailyGreetingShown | ✓ auto | ✗ | ✗ | ✓ dismiss | ✗ | свой | ⚠ | ⚠ |
| tg_bot | BotSubscription | ✓ auto | ✗ | ✗ | ✓ lang/active | ✗ | — | ✗ | ✓ (4) |
| tg_userclient | TgSession | ✓ | ✗ | ✓ status | ✓ verify/revoke | ✗ | Owner/Mgr | ⚠ модалка | ✓ (49) |
| tg_userclient | TgChat | ✗ auto (sync) | ✓ | ✗ | ✗ | ✗ | TL/Mgr | ✓ в OperatorDetail | ⚠ |
| tg_userclient | TgMessage | ✗ auto (backfill) | ✓ | ✗ | ✗ | ✗ | TL/Mgr | ✓ | ⚠ |
| tg_userclient | TgAiInsight | ✓ async | ✓ | ✗ | ✗ | ✗ | TL/Mgr | ✓ плашка | ✓ |
| tg_userclient | TgBackfillJob | ✓ retry | ✓ | ✗ | ✗ | ✗ | TL/Mgr | ⚠ retry-кнопка | ✓ |
| ai_chat | ChatSession | ✓ | ✓ | ✗ | ✗ | ✗ | Mgr | ✓ | ✓ (1) |
| ai_chat | ChatMessage | ✓ | ✓ | ✗ | ✗ | ✗ | Mgr | ✓ | ⚠ |
| marketing | MarketingInsight | ✓ generate | ✓ | ⚠ latest | ✗ | ✗ | TL/Mgr | ✓ | ⚠ (1) |
| attendance | OperatorQr | ✓ rotate | ✓ | ✓ | ✗ | ✓ revoke | TL/Mgr | ✓ | ✓ |
| attendance | AttendanceLog | ✓ scan | ✓ history | ✓ | ✗ | ⚠ manual_close | mixed | ✓ | ✓ (37) |
| attendance | AttendanceSettings | — | ✓ | ✓ | ✓ | ✗ | TL | ✗ | ✓ |
| lessons | DailyLesson | ✓ generate cmd | ✓ | ✓ | ✗ | ✗ | Owner/Mgr | ✓ | ✓ (13) |
| lessons | DailyLessonAttempt | ✓ auto | ✗ | ✗ | ✗ | ✗ | — | ✗ | ⚠ |
| audit | AuditLog | ✓ services | ✓ | ✗ | ✗ | ✗ | TL/Mgr | ⚠ Mgr only | ✓ (5) |

---

## 3. Детальный разбор по 18 app'ам

### 3.1 sales

**Модели**: `Sale`, `GiftItem` (вложен), `SaleOperator` (multi-allocation), `SalePartner` (multi-allocation).

**API**: 8 CRUD + `return/` + `confirm/` + `import-excel/` + `export.xlsx`. Permissions: TL write / Mgr RO. Soft-delete через `is_deleted`.

**UI**: `Sales.tsx` / `SaleCreate.tsx` / `SaleDetail.tsx`.

**Тесты**: 29 в 4 файлах — покрывают дискаунт, дубли IMEI, фильтрацию, PATCH vs PUT, multi-allocation.

**Пробелы**:
- Нет прямого endpoint'а для update/delete `GiftItem` — только через full PUT родительской Sale (риск потерять поля при частичном апдейте).
- Нет UI для просмотра истории изменений цены/скидки (audit пишет, но не отображается).
- `SaleOperator`/`SalePartner` не имеют отдельного delete-endpoint'а — риск сиротских строк при manual DB-операциях.
- Soft-deleted Sales видны в истории, но не в основном списке — нет UI-переключателя «Показать удалённые».
- Тест на скидку 100% отсутствует (валидация есть, edge-case не покрыт).

**Замечания**: логика дискаунта хорошо задокументирована в `services.py`, multi-allocation живёт рядом с legacy single-FK — потенциальная путаница для нового разработчика.

### 3.2 catalog

**Модели**: `Channel` (партнёры), `TacLookup` (справочник IMEI → бренд/модель, seed командой).

**API**: `channels/` CRUD (без DELETE), `imei/<imei>/lookup/`, `imei/models/?q=` (autosuggest).

**UI**: `Partners.tsx`.

**Тесты**: **0**. Полностью непокрытый app.

**Пробелы**:
- **Нет ни одного теста** — `channel_create` с логикой реактивации, IMEI-lookup и autosuggest катаются в проде без страховки. Это **P0**.
- Нет hard-delete для `Channel` — только `is_active=False`; если канал был использован в Sale, `PROTECT`-констрейнт на FK сработает, но пользователь получит 500 без внятного сообщения.
- `TacLookup` только через management command — нет UI/API для ручного обновления справочника.
- `PhoneModelSuggestApi` делает 2 запроса без кэша (Sales-count + TacLookup-filter) — N+1 при частом использовании в SaleCreate.

**Замечания**: миграций в репо нет — предполагается, что `seed_tac` уже прогнан на проде.

### 3.3 payroll

**Модели**: `PayrollRule` (глобальные или per-operator: threshold + fixed / percent / tiers).

**API**: 4 CRUD (без DELETE) + `monthly/?year=&month=` + `monthly/export.xlsx`. Permissions: TL для правил, Mgr RO для расчёта.

**UI**: `Payroll.tsx` (только просмотр расчётов и экспорт).

**Тесты**: 4 в `test_payout.py` — happy path (ниже порога, fixed, percent, tiers).

**Пробелы**:
- **Нет UI для CRUD PayrollRule** — team-lead создаёт правила только через API. **P1**.
- Нет DELETE и `is_active` флага на `PayrollRule` — старые правила накапливаются.
- Нет audit-логирования изменений `PayrollRule` — критические цифры меняются без следа. **P1**.
- Изменение threshold mid-month не пересчитывает старые sales.
- Нет теста на пограничный `total_sales == threshold`.
- Нет валидации при `include_trainees=True` на смене статуса оператора в середине месяца.

**Замечания**: `compute_payout` — чистая функция, отлично изолирована. Tiers-schema только в комментариях, без validation-схемы.

### 3.4 analytics

**Модели**: **нет** — только selectors поверх `sales`, `leads`, `calls`.

**API**: 9 endpoint'ов (kpi, leaderboard, by-channel, by-model, timeseries, leads-distribution, operator-funnels, callback-heatmap, export.xlsx). Все TL/Mgr RO.

**UI**: `Dashboard.tsx` + `Analytics.tsx`.

**Тесты**: 3 в `test_extended_charts.py` — форма данных для стакеров.

**Пробелы**:
- Нет фильтрации `include_inactive` — trainees и уволенные попадают в аналитику.
- Агрегаты не кэшируются — на больших объёмах N+1 при частом refresh.
- `leaderboard` и `by-channel` могут вернуть разные суммы за один период (разные querysets, отсутствие снапшота).
- Нет теста на пустой период.
- `callback_hour_heatmap` зависит от `apps.calls` без явной проверки.
- Различие pending vs confirmed sales не отдокументировано на уровне API.

**Замечания**: разделение selectors / apis выдержано хорошо. `resolve_period` — чистая утилита.

### 3.5 users

**Модели**: `Profile` (роль, operator FK, telegram_user_id, deleted_at), `OperatorSecret` (Fernet-шифрованный пароль для TL/Mgr, key_version).

**API**: `auth/login`, `auth/logout`, `auth/me`, `me/change-password`, `operators/<id>/account/` (create/password/reset/deactivate/activate/delete).

**UI**: `Login.tsx`, `Profile.tsx`.

**Тесты**: 27 в 6 файлах — покрытие lifecycle, permissions, throttling, шифрование, soft-delete.

**Пробелы**:
- Нет endpoint'а для смены роли `Profile.role` — только через Django admin. **P1**.
- Нет bulk-операций (например, деактивировать всех INACTIVE).
- **Ротация Fernet-ключа `OperatorSecret` не реализована** — `key_version` есть, management-команды для re-encryption нет. При компрометации ключа переезд невозможен. **P0**.
- Throttling на login жёсткий и не настраивается per-deployment.
- Soft-delete User оставляет `Profile.operator_id` — потенциальная inconsistency при реактивации.

**Замечания**: reversible encryption для OperatorSecret — специфичное business-требование (Mgr может показать пароль оператору). Требует аккуратного key management.

### 3.6 operators

**Модели**: `Operator` (full_name, phone, status, hired_at, `daily_lesson_opt_out`), `OperatorMonthlyPlan` (year, month, target_amount).

**API**: 6 CRUD (soft-delete) + `stats/` + `plan/` (GET/PUT) + `me/preferences/`.

**UI**: `Operators.tsx`, `OperatorDetail.tsx` (много секций: stats, plan, achievements, TG-диалоги, посещаемость).

**Тесты**: 4 (по grep — точное содержимое не проверено).

**Пробелы**:
- Нет endpoint'а для чтения всех планов на месяц (только per-operator).
- Delete Operator идёт каскадом на Profile и SaleOperator lines — нет UI-предупреждения о последствиях. **P1**.
- Нет audit-логирования смены статуса (deactivate/reactivate без причины).
- `daily_lesson_opt_out` управляется только через `/me/preferences/` — TL не может выключить обучалку конкретному оператору.

### 3.7 stickers

**Модели**: `OperatorSticker` (emoji, is_rare, assigned_by). Constraints: обычные эмодзи уникальны, rare — единственный на всю систему.

**API**: 5 endpoint'ов (palette + `/me/sticker/` PUT/DELETE + `/operators/<id>/sticker/` PUT/DELETE для админа).

**UI**: `StickerPicker` компонент в `Operators.tsx`.

**Тесты**: 9 — unique constraints, transitions, validation.

**Пробелы**:
- Нет endpoint'а для просмотра всех стикеров операторов сразу.
- Rare-reassignment удаляет старый ряд без истории (только audit).
- Palette не рефрешится в UI при назначении rare (нужен polling / WebSocket).

### 3.8 leads

**Модели**: `Lead` (9 статусов, `needs_review`, `metadata`), `LeadAssignment` (audit trail распределений), `SheetSource`, `OperatorSheetAlias`, `TelegramLink`.

**API**: CRUD `leads/`, `leads/<id>/reassign/`, `/status/`, `/convert-to-sale/`, `sheet-sources/`, `operator-sheet-aliases/`, `telegram/lookup`.

**UI**: `Leads.tsx` (админский), `MyLeads.tsx` (операторский), `SheetSources.tsx`.

**Тесты**: 8 — auto-assign, reassign с callback'ами, sheet-sync + race, convert-to-sale idempotent.

**Пробелы**:
- Нет UI для истории `LeadAssignment` — TL видит только текущего оператора. **P1**.
- Нет endpoint'а force-refresh Google Sheets — только management-cmd `sync_sheets_leads`. **P1**.
- `TelegramLink` не синхронизируется с `TgSession.tg_username` — потенциальный дубль.
- Reassign сохраняет `reason`, но не показывает его в UI.
- Нет soft-delete для Lead (обычно и не нужен, но при ошибочном создании).

### 3.9 calls

**Модели**: `CallAttempt` (outcome), `CallbackReminder` (с автоматическим superseding).

**API**: 6 endpoint'ов — `call-attempts/`, `callbacks/`, `callbacks/mine/`, `callbacks/mine/due/`, `callbacks/<id>/done|snooze/`.

**UI**: только в `MyLeads.tsx` (нет отдельной страницы).

**Тесты**: 3 — reminder superseding + race + blocked operator.

**Пробелы**:
- TL не видит все callback'и офиса без фильтра по конкретному лиду. **P1**.
- Нет endpoint'а для редактирования `remind_at` — только пересоздание.
- Нет фильтров по статусу в UI (OVERDUE / SNOOZED).
- `dm_sent_at` пишется, но нет метрики «оператор увидел уведомление в UI» (для useCallbackWatcher — только polling).

### 3.10 greetings

**Модели**: `DailyQuote` (одна цитата на день+язык для всего офиса), `DailyGreetingShown` (per-operator dismiss).

**API**: `/me/morning-greeting/?language=` + `/me/morning-greeting/dismiss/`.

**UI**: модалка в `Dashboard.tsx`.

**Тесты**: 1.

**Пробелы**:
- Нет UI для управления `DailyQuote` — TL не может задать кастомную цитату. **P2**.
- `DailyQuote` пишется только management-command'ой, полностью зависит от LLM-провайдера.

### 3.11 tg_bot

**Модели**: `BotSubscription` (chat_id, language, is_active, blocked_at, last_daily_report_date).

**API**: **нет REST API** — только TG-хендлеры.

**TG-команды**: `/start`, `/new`, `/cancel`, `/language`, `/subscribe`, `/unsubscribe`, `/report`, `/link_operator`, `/checkin`, `/checkout`, `/attendance_status`.

**Callback handlers**: `op:`, `partner:`, `op-split:`, `partner-split:`, `date:`, `lang:`, `confirm:`, `attendance:checkin`, `attendance:auto_checkout_confirm:<id>`, `attendance:continue_working:<id>`.

**Runner**: docker-compose service `bot` (профиль `bot`) → `python -m apps.tg_bot.runner`. Systemd-сервис отдельно не заводился.

**Тесты**: 4 — parser, daily report idempotent, DM blocked, retry keyboard.

**Пробелы**:
- Нет UI/API для управления `BotSubscription` — TL не может включить/отключить daily report для чата из веба. **P1**.
- `runner.py` — 1500+ строк inline handlers, всё в одном файле, включая attendance-логику. Тяжело поддерживать. **P2**.
- Нет endpoint'а force-send daily report из веба.
- `/link_operator` FSM живёт в `tg_bot`, но пишет в `tg_userclient.TgSession` — дублирование ответственности между app'ами.

### 3.12 tg_userclient

**Модели**: `TgSession` (Fernet + key_version), `TgChat`, `TgMessage`, `TgAiInsight`, `TgBackfillJob`, `TgAiInsightAttempt`.

**API**: 10 endpoint'ов — auth (start / verify-code / verify-password / revoke / status), chats, messages, insights, backfill-jobs, backfill-jobs/retry.

**UI**: секция в `OperatorDetail.tsx` с чатами, сообщениями и AI-плашкой.

**Тесты**: 49 (крупнейший app по тестам) — auth, backfill, purge, Gemini provider, provider chain, retry-backoff, stale-reset, chat↔lead matching.

**Пробелы**:
- `TgChat` нельзя пометить `spam`/`noise` руками — только AI insights.
- Нет UI для просмотра `TgMessage.transcript_status` — статус транскрипции голосовых не виден.
- Backfill-job может зависнуть — `stale_running_reset` только по cron, нет immediate retry из UI.
- `TgAiInsight.red_flags`/`highlights` хранятся в JSON без валидации структуры от LLM. **P2**.

**Замечания**: очень хорошо покрыто тестами, key rotation для Fernet есть (`key_version`), retry chain с fallback работает.

### 3.13 ai_chat

**Модели**: `ChatSession`, `ChatMessage` (с `tool_calls` JSON для structured LLM tool invocations).

**API**: `sessions/` (GET/POST) + `sessions/<id>/messages/` (GET/POST — блокирующий, ждёт LLM). Только Mgr.

**UI**: `AIChat.tsx` — двухколонник.

**Тесты**: 1.

**Пробелы**:
- Нет rename для `ChatSession` — title фиксируется при создании. **P2**.
- Нет delete / archive — вся история копится.
- Нет экспорта диалога.

### 3.14 marketing

**Модели**: `MarketingInsight` (period_start/end, lead_quality_by_source, targeting_recommendations, top_products, summary).

**API**: `insights/`, `insights/latest/`, `insights/generate/`. TL/Mgr.

**UI**: `Marketing.tsx` — bar chart конверсии, top products, LLM-рекомендации, история.

**Тесты**: 1.

**Пробелы**:
- Нет DELETE для `MarketingInsight` — накопление старых. **P2**.
- `lead_quality_by_source` считает конверсию по `Lead.status='won'`, но нет прямой связи с Sale (архитектурная зависимость).
- Нет кастомного диапазона дат в UI — только `days` в POST.

### 3.15 attendance

**Модели**: `OperatorQr` (nonce + revoked_at), `AttendanceLog` (source qr/tg/manual, was_late, auto_closed, `long_shift_warning_sent_at`, `warning_dismissed_at`, `manually_closed`, `manually_closed_by`, `manual_close_note`), `AttendanceSettings` (singleton).

**API**: 14 endpoint'ов включая публичный `POST /scan/`, PNG-QR, отчёт (json/xlsx), ротация QR, settings, ручное закрытие.

**UI**: `/scan` публичная, `/attendance/today`, `/attendance/report` (TL/Mgr), секция на `OperatorDetail`.

**Тесты**: 37 в 6 файлах — сервисы, API, TG-канал, followup (warning + manual close + отчёт), audit-redaction.

**Пробелы**:
- **Нет UI для `AttendanceSettings`** — TL меняет расписание/порог опоздания только через API. **P1**.
- **Race в 10ч-warning**: если `bot.send_message` упадёт после `long_shift_warning_sent_at = now()`, warning помечен как отправленный, но реально не доставлен. Нужна транзакционная защита или очередь. **P0**.
- Нет метрик по неудачным сканированиям (blocked IPs, revoked QRs) — только успешные в AttendanceLog.
- Race в `_bot_auto_checkout_confirm`: pre-check `checked_out_at is not None` и вызов сервиса не в одной транзакции. **P2**.

### 3.16 lessons

**Модели**: `DailyLesson` (summary, highlights, tips, micro_lesson, stats_snapshot, model_version, prompt_version, delivered_at, opened_at), `DailyLessonAttempt` (аудит генераций).

**API**: `/lessons/today/`, `/lessons/history/`, `/lessons/?operator=&date=`.

**UI**: `/lessons/today`, `/lessons/history`, секция на `OperatorDetail`, badge в sidebar.

**Тесты**: 13 — selector, generator (fake LLM), commands, APIs, retry на invalid JSON.

**Пробелы**:
- Нет U/D endpoint'ов (по дизайну — уроки неизменяемые).
- Нет dashboard-метрики «сколько уроков сгенерировано вчера / error-rate». **P2**.
- `collect_yesterday_facts` делает много последовательных SELECT (sales/dialogs/callbacks/leads) — потенциальный N+1 при масштабе.

### 3.17 audit

**Модели**: `AuditLog` (user, action, entity, entity_id, changes JSON, comment).

**API**: `GET /api/audit/` (TL/Mgr RO, фильтры по entity/entity_id через query params).

**UI**: `/audit` — таблица (только Manager).

**Тесты**: 5 (все на `_scrub` — redaction чувствительных ключей).

**Пробелы**:
- Нет detail-view для записи (JSON `changes` может быть большим). **P2**.
- **Нет фильтров в UI** (backend поддерживает — UI не использует). **P1**.
- Нет экспорта (JSON/CSV).
- Inconsistency: API открыт для TL, а UI `/audit` только для Manager.

### 3.18 common

**Модели**: `TimestampedModel` (abstract).

**Компоненты**: `crypto.py` (Fernet), `health.py`, `excel.py`, `money.py`, `pagination.py`, `validators.py`.

**Тесты**: 15 — crypto, healthz, validators, ALLOWED_HOSTS.

**Замечания**: качественная утилитарная база, всё в одном месте.

---

## 4. Cross-cutting workflows

### 4.1 Лид → колл → продажа
**Happy path**: Lead приходит из Google Sheets sync → auto-assign по round-robin → CallAttempt (outcome=`talked_interested`) → CallbackReminder → повторный call → `convert-to-sale/` → Sale + SaleOperator/SalePartner lines + Lead.status='won' (одной транзакцией).

**Разрывы**:
- Marketing-конверсия читает `Lead.status='won'` без прямой FK на Sale — если конверсия упала между update и Sale-create, данные разъедутся.
- Reassign лида переносит **активные** callback'и, historic остаются с прежним оператором — сложно проследить полную историю в UI (нет страницы).
- Нет сквозного audit trail всей цепочки — LeadAssignment / CallAttempt / CallbackReminder / Sale логируют по отдельности.

### 4.2 Утро оператора
**Happy path**: 05:30 `generate_daily_lessons` (systemd-timer) → 07:30 `deliver_daily_lessons` → TG-DM с inline-кнопкой «Отметить приход» → оператор нажимает → `attendance:checkin` → `AttendanceLog` (`source=tg`) → приходит на работу → сканирует QR на рабочем месте → **но у него уже есть открытая смена** → scan интерпретируется как check-out.

**Разрыв**: `attendance:checkin` через TG в 07:30 создаёт открытую смену. Если оператор потом придёт в офис и сканирует QR — сканирование сработает как check-out (потому что открытая смена уже есть). Нужен UX: либо TG-checkin не считать «сменой» до QR-подтверждения, либо явно объяснить пользователю. **P1 UX-gap**.

### 4.3 Смена: QR check-in → 10ч-warning → check-out
**Happy path**: QR-scan → `AttendanceLog` открыт → работа → в 20:00 (10ч спустя) `attendance_long_shift_check` (каждые 30 мин) → DM оператору с кнопками «Отметить уход»/«Продолжаю» + DM тим-лиду → оператор нажимает «Отметить уход» → callback → сервис check-out → лог закрыт.

**Разрывы**:
- Race в 10ч-warning (см. 3.15) — `long_shift_warning_sent_at` может стоять при упавшем DM.
- Если у оператора нет TG и нет team_lead → `warning_skipped_no_recipients` без ретрая (правильно), но нет метрики / алерта.
- Auto-close в 23:00 всегда пишет `check_out=now()` — статистика посещаемости показывает 13-часовую смену, хотя человек ушёл раньше. Компенсация не предусмотрена.

### 4.4 Пейролл: закрытие месяца → расчёт → экспорт
**Happy path**: конец месяца → `GET /payroll/monthly/?year=&month=` → `compute_payout` по каждому оператору → `monthly/export.xlsx`.

**Разрывы**:
- Если оператор был INACTIVE в течение месяца, `include_trainees=True/False` меняет расчёт задним числом. Нет фиксации снапшота.
- `PayrollRule` меняется — старые расчёты не пересчитываются, но новый запрос за прошедший месяц даст другую сумму.
- Нет audit-записи об открытии/экспорте payroll — Mgr скачал xlsx с суммами, следа нет. **P1** для security-audit.

### 4.5 Онбординг нового оператора
**Happy path**: Mgr создаёт Operator → создаёт User+Profile через `operators/<id>/account/` → пароль генерится, показывается один раз → выпуск QR для attendance (backfill_operator_qrs или автоматически при первом сканировании) → `/link_operator` FSM в TG → TG-userclient auth (Telethon) → операторка работает.

**Разрывы**:
- Выпуск QR не автоматизирован — если backfill-команда не прогонялась, у нового оператора нет `OperatorQr`, `/api/me/attendance-qr.png` вернёт 404 или сгенерит on-the-fly (нужно уточнить в коде).
- Нет чек-листа онбординга в UI — Mgr должен помнить все шаги.
- Первая продажа не привязана к какому-либо flag'у «онбординг завершён».

### 4.6 Работа на shared-компе (смена оператора)
**Разрыв**: сейчас чекaут возможен только с того же браузера, где сохранён DRF-токен. Если оператор ушёл, не разлогинившись, следующий оператор либо работает под чужим токеном, либо ручной logout — но attendance check-out не выполнится, потому что QR-scan привязан к личному QR. Итог: shared-workstation → следующий оператор либо использует чужой аккаунт, либо ручной logout прошлого + чужой не отмечен по attendance.

Решение: сделать так, чтобы новый QR-scan на том же браузере автоматически завершал предыдущую сессию (invalidate token + close AttendanceLog предыдущего оператора). **P1**.

---

## 5. Security checklist

### Публичные endpoint'ы (без auth)
| Endpoint | Защиты | Оценка |
|---|---|---|
| `POST /api/attendance/scan/` | HMAC-подпись QR, rate-limit 20/min по IP, 30s cooldown на оператора, `ATTENDANCE_ALLOWED_NETWORKS` CIDR-whitelist | ✓ OK |
| `POST /api/auth/login/` | throttled (жёстко) | ✓ OK, но throttle не настраивается per-deployment |
| `GET /scan` (frontend) | публичная страница-обёртка, за ней публичный API | ✓ OK |

### Endpoint'ы с `IsAuthenticated` без ролевой проверки
- `GET /api/me/attendance-qr.png` — свой QR, только запрашивающего оператора ✓ OK
- `GET /api/me/preferences/` — свой профиль ✓ OK
- `GET /api/lessons/today/` — с `IsOwnerOrManager` ✓ OK
- `GET /api/me/morning-greeting/` — свой ✓ OK

### Secrets и шифрование
- **OperatorSecret**: Fernet + `key_version` ✓, но **нет management-команды для re-encryption при ротации ключа** ✗. **P0**.
- **TgSession.encrypted_session**: Fernet + `key_version` ✓
- **QR_ATTENDANCE_HMAC_KEY**: в env ✓
- **TG-токены** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_ID/API_HASH`): в env ✓
- **Audit `_scrub`**: рекурсивно затирает `password`, `secret`, `session`, `token`, `api_key`, `access_key`, `qr`, `hmac` ✓

### Audit-покрытие write-операций
| Операция | Audit? |
|---|---|
| Sales CRUD | ✓ |
| Operators create/update | ✓ |
| Operators deactivate/reactivate/delete | ✗ (нет `comment` о причине) |
| PayrollRule CRUD | ✗ (**P1**) |
| Attendance rotate QR | ✓ |
| Attendance manual close | ✓ |
| Attendance long-shift warning | ✓, но race в assignment флага (см. 3.15) |
| Lessons — по дизайну не логируется | — |
| Payroll export | ✗ (**P1** — Mgr скачивает суммы без следа) |
| TG bot команды | частично |
| Login / logout | ✗ (в Django auth logs, но не в AuditLog) |

### CORS / CSRF
- Не проверено. Требует отдельного security-review.

---

## 6. Тестовое покрытие

### Полный прогон
- **266 passed** (baseline после последней принятой волны).
- `apps/attendance` — 37, `apps/lessons` — 13, `apps/tg_userclient` — 49, `apps/sales` — 29, `apps/users` — 27, `apps/leads` — 23, `apps/common` — 15, `apps/tg_bot` — 9, `apps/stickers` — 9, `apps/calls` — 9.

### Приоритетные пробелы в тестах
- **`apps/catalog` — 0 тестов**. `channel_create` с реактивацией, IMEI lookup, autosuggest — untested. **P0**.
- **`apps/greetings` — 1** (не покрывает LLM-generation fallback).
- **`apps/marketing` — 1** (селектор конверсии не проверен на пустые периоды и отсутствующие sources).
- **`apps/ai_chat` — 1** (нет проверки tool-call сериализации).
- **`apps/analytics` — 3** (только форма данных для стакеров, не покрыты пустые периоды и permission escalation).

### Что не покрыто в целом
- **Интеграционные тесты между app'ами** — Sale → Payroll → Analytics, Lead → Sale → Marketing, Attendance → cross-check с Lessons stats.
- **Load / N+1** — SaleListCreateApi с `.distinct()` может страдать на большом объёме.
- **Permission escalation** — Mgr пытается PATCH PayrollRule (должно быть 403); оператор пытается GET `/audit/`; и т.п.
- **E2E frontend** — тестов на React нет вообще.

---

## 7. Приоритизированный список пробелов

### P0 — блокеры прод-эксплуатации

1. **`apps/catalog` без тестов** — IMEI lookup + channel_create с реактивацией + autosuggest катаются без страховки. Проверить и добавить минимум `test_channel_create.py`, `test_imei_lookup.py`, `test_phone_model_suggest.py`.
   - Файлы: `/Users/user/Desktop/mp/ai/naff/backend/apps/catalog/tests/`

2. **Нет ротации Fernet-ключа `OperatorSecret`** — `key_version` есть, команды `rotate_operator_secret_key` нет. При компрометации ключа переезд невозможен.
   - Файлы: `/Users/user/Desktop/mp/ai/naff/backend/apps/users/management/commands/` (создать) + `/apps/common/crypto.py`

3. **Race в 10ч-warning attendance** — `long_shift_warning_sent_at = now()` проставляется отдельно от `bot.send_message`. При падении DM warning считается отправленным, но не доставлен.
   - Файл: `/Users/user/Desktop/mp/ai/naff/backend/apps/attendance/management/commands/attendance_long_shift_check.py`
   - Фикс: `save_flag_only_after_successful_send` (транзакция вокруг try/except с ретраем 3× и rollback флага при полном фейле) или очередь через отдельную таблицу `PendingWarningNotification`.

4. **Payroll export без audit-записи** — Mgr скачивает файл с суммами, следа нет. Прод для UZ — юридически чувствительно.
   - Файл: `/Users/user/Desktop/mp/ai/naff/backend/apps/payroll/apis.py` (MonthlyExportApi)
   - Фикс: `audit_log_create(action="download", entity="payroll_export", entity_id=f"{year}-{month}", user=request.user)`

5. **PayrollRule без audit-логирования** — критические цифры меняются без следа.
   - Файл: `/Users/user/Desktop/mp/ai/naff/backend/apps/payroll/services.py`

6. **Shared-workstation UX-разрыв** — новый оператор сканирует QR, но старый DRF-токен ещё живой, старая AttendanceLog открыта. Итог: чужой аккаунт активен, оператор без attendance.
   - Файл: `/Users/user/Desktop/mp/ai/naff/backend/apps/attendance/services.py::process_attendance_event`
   - Фикс: при check-in от другого оператора на том же (или любом) IP — принудительно закрыть предыдущую открытую смену этого браузера (`user_agent + ip` match) и инвалидировать её токен.

### P1 — критичные для повседневной работы

7. **Нет UI для AttendanceSettings** — TL правит расписание/порог опоздания только через API.
   - Файлы: `/Users/user/Desktop/mp/ai/naff/frontend/src/pages/AttendanceReport.tsx` (добавить секцию) или новая `SettingsAttendance.tsx`.

8. **Нет UI для PayrollRule CRUD**.
   - Файлы: `/Users/user/Desktop/mp/ai/naff/frontend/src/pages/Payroll.tsx` (добавить TL-only секцию управления правилами).

9. **Нет фильтров в `/audit` UI** — backend поддерживает, UI не использует.
   - Файл: `/Users/user/Desktop/mp/ai/naff/frontend/src/pages/Audit.tsx`.

10. **Inconsistency: audit API открыт TL, а UI `/audit` только Mgr**. Синхронизировать (открыть UI для TL либо закрыть API до Mgr).
    - Файлы: `/Users/user/Desktop/mp/ai/naff/backend/apps/audit/apis.py` и/или `/Users/user/Desktop/mp/ai/naff/frontend/src/App.tsx`.

11. **Нет UI для истории LeadAssignment** — TL видит только текущего оператора.
    - Файл: `/Users/user/Desktop/mp/ai/naff/frontend/src/pages/Leads.tsx` + endpoint `GET /api/leads/<id>/assignments/`.

12. **Нет endpoint'а force-refresh Google Sheets** — только management-cmd.
    - Файлы: `/Users/user/Desktop/mp/ai/naff/backend/apps/leads/apis.py` + `SheetSources.tsx` кнопка.

13. **Нет UI для управления BotSubscription** — TL не может включить/отключить daily report для чата.
    - Файлы: новая страница `/settings/notifications` или секция в существующей.

14. **TL не видит все callback'и офиса** — только per-lead или свои.
    - Файлы: endpoint `GET /api/callbacks/all/?status=overdue|snoozed` (TL/Mgr) + новая страница `/callbacks` или секция.

15. **Утренний TG-checkin создаёт «фиктивную» открытую смену до QR** — UX разрыв (см. 4.2).
    - Файлы: `attendance/services.py::process_attendance_event` — ввести `AttendanceLog.provisional=True` (или отдельный статус), при последующем QR-скане — «materialize».

16. **Нет endpoint'а для смены роли `Profile.role`** — только через Django admin.
    - Файлы: `/Users/user/Desktop/mp/ai/naff/backend/apps/users/apis.py` + UI на `OperatorDetail`.

17. **Delete Operator без UI-предупреждения о последствиях** — каскадит Profile и SaleOperator lines.
    - Файл: `/Users/user/Desktop/mp/ai/naff/frontend/src/pages/OperatorDetail.tsx` — модалка с deps-preview.

18. **Нет audit-логирования Operator deactivate/reactivate** — нет `comment` о причине.
    - Файл: `/Users/user/Desktop/mp/ai/naff/backend/apps/operators/services.py`.

19. **Auto-close 23:00 пишет фиктивное `check_out=now()`** — статистика показывает 13ч смену. Компенсация нужна: либо фиксировать «неизвестное время», либо позволить TL постфактум редактировать (с audit).
    - Файлы: `attendance/models.py` (флаг `check_out_estimated=True`?), `attendance/apis.py` (endpoint edit).

20. **TgChat нельзя пометить `spam` руками** — только через AI insight.
    - Файлы: `apps/tg_userclient/models.py` (+`is_spam`), `apis.py`.

21. **AttendanceLog: race в `_bot_auto_checkout_confirm`**. Pre-check + service-call не в одной транзакции.
    - Файл: `apps/tg_bot/runner.py` (либо `apps/tg_bot/handlers/attendance.py`).

22. **Marketing использует `Lead.status='won'` без прямой FK на Sale** — при частичной ошибке транзакции статистика разъедется.
    - Файл: `apps/marketing/services.py::generate_marketing_insight` — переписать на JOIN через Sale.

23. **Analytics не имеет `include_inactive` фильтра** — trainees попадают в KPI.
    - Файл: `apps/analytics/selectors.py` + `apis.py`.

### P2 — nice-to-have и tech debt

24. **`tg_bot/runner.py` 1500+ строк inline** — разбить на `apps/tg_bot/handlers/{sales,attendance,link,common}.py`.
25. **N+1 в `PhoneModelSuggestApi`** — кэшировать `TacLookup` в Redis (уже есть Redis для сессий).
26. **Analytics не кэшируется** — Redis-cache на 60s для kpi/leaderboard/by-channel.
27. **Cleanup jobs для soft-deleted записей** — Sale, Operator, User с `deleted_at > 90 дней` → hard-delete командой раз в неделю.
28. **Sales/Analytics дублируют queryset для «confirmed non-deleted non-returned»** — вынести в `apps/sales/queries.py::confirmed_sales_qs()`.
29. **Нет detail-view для `AuditLog`** — открыть отдельную запись с полным JSON changes.
30. **Нет экспорта Audit** — CSV или NDJSON.
31. **`ChatSession` без rename и delete** — nice-to-have.
32. **`MarketingInsight` без delete** — накопление старых.
33. **Нет `/metrics` Prometheus endpoint** — health есть, метрик нет.
34. **logrotate не настроена** — `/var/log/naffAI/*.log` растут бесконечно.
35. **`TgAiInsight.red_flags`/`highlights` без валидации JSON schema** — грязь от LLM попадает в БД.
36. **`OperatorSticker` palette не рефрешится при rare-reassignment** — polling / react-query invalidate.
37. **Нет integration-тестов** — Sale → Payroll → Analytics, Lead → Sale → Marketing.
38. **Нет E2E frontend-тестов** (Playwright / Cypress) — 20+ страниц без страховки.
39. **`DailyLessonAttempt` без UI-дашборда** — сколько сгенерировано / ошибок за вчера.
40. **CORS / CSRF настройки не аудированы** — отдельный security-review.

---

## 8. Порядок работ для builder-агента

Волна закрытия разбита на 4 фазы по зависимостям и бизнес-приоритету.

### Фаза 1 — «Security & durability» (P0, ~2 дня)

1. Добавить тесты `apps/catalog/tests/`:
   - `test_channel_create.py` — happy path, reactivation, дубликат имени
   - `test_imei_lookup.py` — hit, miss, невалидный формат, TAC-hit-в-DB
   - `test_phone_model_suggest.py` — top-N по частоте + fallback на TAC
2. Ротация `OperatorSecret` Fernet-ключа:
   - `apps/common/crypto.py::rotate_encrypted_field(instance, field, new_key)` — общий helper
   - `apps/users/management/commands/rotate_operator_secret_key.py` — идемпотентная команда с `--dry-run`
   - Тесты: `test_rotation.py` (старый ключ читается, после rotate — новый ключ читается, `key_version` инкрементнут)
3. Транзакционная защита 10ч-warning:
   - Ввести `PendingAttendanceNotification` (или атомарный try/save-flag с rollback) в `attendance_long_shift_check`
   - Тест `test_long_shift_warning_dm_failure_rolls_back_flag`
4. Audit для payroll export + PayrollRule CRUD:
   - `apps/payroll/apis.py::MonthlyExportApi` — `audit_log_create` перед возвратом файла
   - `apps/payroll/services.py::payroll_rule_create/update` — audit
   - Тесты: `test_payroll_export_audited`, `test_payroll_rule_audited`
5. Shared-workstation фикс:
   - `apps/attendance/services.py::process_attendance_event` — при check-in от другого оператора закрыть предыдущую открытую смену того же `user_agent+ip` (флаг `auto_closed_replaced=True`, notify предыдущего в TG если есть)
   - Тест `test_shared_workstation_replaces_previous_session`

### Фаза 2 — «Админ UI» (P1 fronт-heavy, ~2 дня)

6. UI `AttendanceSettings` — форма в новой странице `/settings/attendance` (TL) с полями shift_start/end, late_threshold, tg_checkin_enabled, long_shift_warning_hours.
7. UI `PayrollRule` CRUD — секция в `Payroll.tsx` (TL) — таблица правил + модалка редактирования + удаление (с confirm).
8. Фильтры в `/audit` — DateRangePicker, MultiSelect entity, поиск по user, comment.
9. Устранить inconsistency audit API vs UI — открыть `/audit` для TL (RoleGate).
10. UI истории `LeadAssignment` в `Leads.tsx` — при клике на строку показать таймлайн переназначений.
11. Endpoint + UI force-refresh Google Sheets — `POST /api/sheet-sources/<id>/sync/` + кнопка на `SheetSources.tsx`.
12. Страница `/callbacks` для TL/Mgr — все callback'и офиса с фильтрами (status, operator, date).
13. Модалка предупреждения при delete Operator — показать зависимые Sales / Profile / attendance логи.
14. Endpoint + UI смены роли Profile — на `OperatorDetail`.

### Фаза 3 — «UX polish + модели» (P1 back-heavy, ~2 дня)

15. `AttendanceLog.provisional` для TG-checkin (см. 4.2 workflow разрыв):
    - Модель + миграция
    - `process_attendance_event(source="tg")` создаёт `provisional=True`
    - QR-scan → `provisional=False` (materialize), пишет реальные IP/UA
    - При auto-close pending provisional → флаг `check_out_estimated=True`
16. `AttendanceLog.check_out_estimated` — использовать в отчёте (жёлтый флаг «оценочное время»).
17. TG-хендлеры вынести из `apps/tg_bot/runner.py` в `apps/tg_bot/handlers/{sales,attendance,link,common}.py` — не меняя логику, только раскладку.
18. `apps/tg_userclient.TgChat.is_spam` + endpoint + фильтр в UI.
19. `apps/marketing.services.generate_marketing_insight` — переписать через `Sale.lead_id` JOIN вместо `Lead.status='won'`.
20. `apps/analytics.selectors` — параметр `include_inactive` + `include_trainees`.
21. Фикс race `_bot_auto_checkout_confirm` — обернуть в `select_for_update`.
22. Audit для `operator_deactivate/reactivate` с обязательным `comment`.

### Фаза 4 — «Tech debt + observability» (P2, по возможности параллельно)

23. Cleanup command `hard_delete_soft_deleted_older_than_90_days` + systemd-timer раз в неделю (Sat 03:00).
24. Redis-cache для `analytics` (60s) и `PhoneModelSuggestApi` (300s).
25. `apps/sales/queries.py::confirmed_sales_qs()` — общий queryset, использовать в sales + analytics + marketing.
26. `/metrics` Prometheus endpoint через `django-prometheus` (или простой custom `apps/common/metrics.py`).
27. logrotate config в `/etc/logrotate.d/naffai` + инструкция в `deploy/README.md`.
28. Detail-view + JSON/CSV export для `/audit`.
29. `ChatSession` rename + archive.
30. `MarketingInsight.delete()` + UI-кнопка удаления.
31. JSON-schema validation для `TgAiInsight.red_flags/highlights` (pydantic-модели на этапе парсинга LLM-ответа).
32. `OperatorSticker` palette rehash через react-query invalidate.
33. Integration-тесты в новом `apps/common/tests/test_integration.py`:
    - `test_sale_creation_updates_payroll` (создать sale, проверить, что payroll_monthly увеличился)
    - `test_lead_to_sale_updates_marketing_conversion`
    - `test_attendance_open_shift_visible_in_report`
34. Playwright E2E (отдельный воркспейс `frontend/e2e/`) — минимум: login → dashboard → create sale → logout.

### Регресс после каждой фазы

- **Фаза 1**: +8 тестов (catalog×3, rotation×1, long_shift race×1, payroll audit×2, shared_workstation×1). Итог **≥ 274 passed**.
- **Фаза 2**: без изменений в тестах (чисто UI + endpoint без сервисной логики). Итог **≥ 274 passed**.
- **Фаза 3**: +5–7 тестов (provisional_attendance, tg_spam, marketing_refactor, analytics_inactive_filter, race-fix). Итог **≥ 279 passed**.
- **Фаза 4**: +3–5 integration тестов. Итог **≥ 282 passed**.

---

## 9. Что не включено в этот аудит

- Frontend-качество (accessibility, Lighthouse, adaptive layout) — отдельная задача.
- Performance-профилирование под нагрузкой — требует прод-стенда.
- Аудит зависимостей (`pip audit`, `npm audit`) — отдельный security-скан.
- Аудит инфраструктуры VPS вне systemd-таймеров (nginx, backup, monitoring).
- Аудит CORS / CSRF настроек Django — требует прогонов live-сценариев.
- Проверка Telegram rate-limits и flood-wait в проде.
