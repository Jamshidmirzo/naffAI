# naffAI — фичи V2 для дизайнера

Документ описывает **всё, что реально работает** в текущей V2 (prod https://naff.flek.uz)
на момент составления. Составлен на основе исходников `frontend/src/pages/*`,
`backend/apps/*` и docker-compose. Никаких концептов «будущего» — только
существующее поведение, чтобы дизайнер сделал новую оболочку под то, что
уже реализовано.

Ссылки по коду в этом документе — абсолютные, относительно корня репозитория
`/Users/user/Desktop/mp/ai/naff/`.

---

## 1. Обзор проекта

**naffAI** — внутренняя CRM для call-центра магазина телефонов в Ташкенте.
Операторы обзванивают лидов (клиентов, оставивших заявку в Google-таблицах,
Instagram, Telegram, у таргетологов и т.п.), доводят до продажи и оформляют
её. Менеджер контролирует поток лидов, распределение, посещаемость и KPI.

- **URL прод:** https://naff.flek.uz (frontend), API — тот же домен `/api/*`.
- **Стек фронта:** React 18 + Vite + TypeScript + Tailwind + shadcn-подобные
  собственные компоненты (`frontend/src/components/ui/*`), Recharts,
  react-query, zustand, three.js/@react-three/fiber (декоративные сцены
  на дашборде и /screen). Хостинг фронта — Vercel (`vercel.json`).
- **Стек бэка:** Django 5 + Django REST Framework + PostgreSQL. HackSoft
  layering (`models.py` — данные, `services.py` — записи, `selectors.py` —
  чтения, тонкие `apis.py`). Файлы приложения — `backend/apps/*`.
- **Инфра:** Docker Compose, отдельный VPS 46.101.112.215 (см. память
  `project_naffai.md`). В проде крутятся сервисы: `web` (gunicorn),
  `db` (Postgres), `bot` (aiogram Telegram-бот для DM), `userclient`
  (Telethon MTProto для сбора истории чатов операторов), `scheduler`,
  `sheet-sync`, `distribute-watcher`, `morning-splitter`, `auto-closer`,
  `ops-nightly`, `lesson-generator`. Все крон-подобные сервисы — просто
  bash-loops с `sleep`, никакого celery.
- **Языки UI:** русский (по умолчанию) + узбекский на латинице. Выбор
  языка — `TabPill RU/UZ` в правом верхнем углу /login и через настройки
  профиля. Хранится в localStorage через zustand-store `store/lang.ts`.
  Все строки в `frontend/src/lib/i18n.ts` (2700+ строк, ключ вида
  `sidebar.dashboard`).
- **Тема:** light по умолчанию + dark, переключатель в профиле. CSS-переменные
  в `frontend/src/index.css`.

---

## 2. Роли и права

Официально в базе три роли: `team_lead`, `manager`, `operator`
(`backend/apps/users/models.py` → `Role`). **По бизнесу видны две:**
`manager` и `operator`. `team_lead` в UI не отображается как отдельная
роль — это «старший менеджер», для UI он схлопывается в `manager`
(`frontend/src/components/RoleGate.tsx` → `normaliseRole()`,
`backend/apps/users/permissions.py` → `SENIOR_ROLES`). Учётки `team_lead`
существуют, но список ролей в форме создания пользователя показывает
только `manager` (Users.tsx). См. memory `project_naffai_roles.md`.

### 2.1 Оператор (`operator`)

- Логинится **по рабочему телефону** в формате `+998XXXXXXXXX` и паролю
  (Login.tsx, режим «phone»). Пароль выдаёт менеджер.
- Всегда попадает на **`/my` — «Мои лиды»** (App.tsx → `RoleAwareHome`).
- Видит в сайдбаре только 5 пунктов:
  «Мои лиды», «Уведомления», «Уроки — сегодня», «Уроки — история», «Профиль»
  (AppShell.tsx → `useOperatorGroups`).
- Может: работать с назначенными ему лидами (звонить, менять статусы,
  ставить callback, откладывать), конвертировать лид в продажу
  (кнопка «В продажу» на карточке → идёт на `/sales/new?lead=<id>`,
  которая закрыта менеджерским `RoleGate`, поэтому оператор **на самом деле
  дальше не пройдёт** — это баг/ограничение текущего UI: продажи оформляет
  менеджер).
- Может: чекиниться по QR (страница `/scan`, публичная, но привязана к
  оператору через QR-токен).
- Может: читать уроки, смотреть уведомления, менять свой пароль и стикер,
  подключать Telegram-сессию через wizard (Profile.tsx → `TgConnectWizard`).
- Не может: создавать/редактировать продажи напрямую, видеть чужие лиды,
  видеть аналитику, зарплату, аудит, настройки, каталоги, других
  пользователей.

### 2.2 Менеджер (`manager` + внутренне `team_lead`)

- Логинится по логину/паролю (username, не телефон) — вкладка «text» на
  логин-форме.
- Видит **полный сайдбар** — 7 групп, ~25 пунктов
  (AppShell.tsx → `useManagerGroups`).
- Может всё: CRUD операторов, продаж, партнёров, лидов, каналов, статусов
  лидов, зарплатных правил, пользователей, sheet-источников; настройки,
  audit-log, AI-чат, маркетинг-инсайты, TG-очередь, экспорты Excel,
  ручная раздача лидов, разбор сирот.
- Единственное, что менеджер не увидит через UI: страницы, которых нет
  вообще (нет отдельного экрана «настройки уведомлений», нет CRUD
  IMEI-каталога — только сидер `seed_tac`).

### 2.3 Team-lead

Технически = senior. В коде остался, потому что старые учётки, аудит,
DB-роль. **Из UI скрыт**: RoleGate не различает `team_lead` и `manager`
(RoleGate.tsx: «team_lead is a senior with full write access, so we
collapse it into manager for the UI»). Форма создания пользователей
(Users.tsx → `ROLE_LABEL`) показывает `manager` и `team_lead` в дропдауне,
но лейбл `team_lead` берётся из ключа `users.role_team_lead` — дизайнеру
можно эту опцию убрать вообще.

---

## 3. Полная карта экранов

Все роуты — из `frontend/src/App.tsx`. «Доступ» — то, что разрешает
`RoleGate` (собственный компонент, `Navigate` при отсутствии токена/роли).

<details>
<summary><b>Публичные (без токена)</b></summary>

- `/login` — Login.tsx — вход. Поддерживает два режима вкладками:
  «телефон» (для операторов, `+998…`) и «текст» (для менеджеров, username).
  Дополнительно селектор языка RU/UZ, фоном декоративная 3D-сцена
  `BarsScene`. POST `/api/auth/login/` возвращает token+role.
- `/scan` — Scan.tsx — приход/уход оператора по QR-коду. Работает без
  авторизации в браузере — авторизация через QR-токен в URL.
  POST `/api/attendance/scan/`.

</details>

<details>
<summary><b>Общие для оператора и менеджера</b></summary>

- `/` — RoleAwareHome — если оператор, редирект `/my`, иначе Dashboard.
- `/screen` — Screen.tsx — полноэкранное табло топ-5 операторов месяца
  (для монитора в офисе). Открывается из сайдбара новой вкладкой
  (`external: true`). GET `/api/analytics/leaderboard/?period=month&limit=5`,
  автообновление 30 сек.
- `/profile` — Profile.tsx — свой профиль. Оператор видит: аватар, стикер
  (кликабельный — открывает StickerPicker), время смены, кнопку toggle
  чек-ин/аут, QR-код, подключение Telegram-сессии (TgConnectWizard),
  переключатель ежедневного урока on/off, смена пароля, тема, язык, выход.
  Менеджер видит только: язык, тема, смена пароля, выход. Endpoints:
  `/api/auth/me/`, `/api/me/sticker/`, `/api/me/preferences/`,
  `/api/me/attendance-qr.png`, `/api/attendance/me/current/`,
  `/api/attendance/me/toggle/`, `/api/tg-userclient/status/`, `/api/me/change-password/`.
- `/notifications` — Notifications.tsx — лента in-app уведомлений
  (новые лиды в очереди, callback подошёл, ежедневные KPI-сводки).
  Есть счётчик unread в сайдбаре. Подписки на типы уведомлений (пока
  локально в компоненте, не сохраняются на бэке).
  Endpoints: `/api/notifications/`, `/api/notifications/unread-count/`,
  `/api/notifications/mark-read/`, `/api/notifications/mark-all-read/`.
- `/lessons/today` — DailyLesson.tsx — «Урок дня» для оператора.
  Автогенерируемая LLM-сводка вчерашнего дня оператора (продажи, конверсия,
  выручка, качество диалогов из TG, промахи по callback'ам) + микроурок
  и 3-5 tips «как исправить». Первый раз открывается — mark as read.
  GET `/api/lessons/today/`, POST `/api/lessons/today/mark-read/`.
- `/lessons/history` — LessonsHistory.tsx — архив прошлых уроков.
  GET `/api/lessons/history/`.

</details>

<details>
<summary><b>Только оператор</b></summary>

- `/my` — MyLeads.tsx — **главный рабочий экран оператора**. Три вкладки:
  «Активные», «Отложенные», «Все». Hero-блок с количеством активных лидов,
  3D-датчик выполнения дневного плана (условно 20 звонков). Полоса
  overdue-callback'ов сверху (алерт, если есть просроченные callback'и
  или вчерашний backlog). Чипы фильтра статусов (динамические из
  `LeadStatusLabel.show_in_chip`). Список карточек лида. На карточке:
  имя, статус (badge), телефон (клик → tel:), альт-телефон, product hint,
  бейдж «Postponed», retry-бейдж (если этот лид уже пробовал другой оператор),
  callback-время. Кнопки: split-button «Bog'lanish» (Call/TG), кнопки
  быстрых статусов (динамические из `LeadStatusLabel.show_in_button`), Callback,
  Postpone / Return, «В продажу», крестик (Reject).
  Модалки: `ScheduleCallbackModal`, `PostponeModal`, `CallbackDueModal`
  (алерт когда наступило время callback'а).
  Endpoints: `/api/leads/my/`, `/api/leads/{id}/status/`,
  `/api/leads/{id}/postpone/`, `/api/leads/{id}/unpostpone/`,
  `/api/leads/{id}/call-attempts/`, `/api/leads/{id}/callbacks/`,
  `/api/callbacks/mine/due/`, `/api/callbacks/{id}/done/`,
  `/api/callbacks/{id}/snooze/`, `/api/telegram/lookup/`.

</details>

<details>
<summary><b>Только менеджер</b></summary>

Каждый роут — под `RoleGate allow={["manager"]}`, при отсутствии
роли редирект на `/my`.

- `/` — Dashboard.tsx — hero + 4 KPI-карточки (продажи сегодня, сумма
  сегодня, за месяц, на смене) + вкладки период (неделя/месяц/квартал) +
  график продаж (DashChart), лидборд топ-5 операторов, лента последних 8
  продаж. Endpoints: `/api/analytics/kpi/`, `/api/analytics/timeseries/`,
  `/api/analytics/leaderboard/`, `/api/sales/?limit=8`. Кнопка «+ Новая
  продажа» открывает модалку `SalesFormModal`.
- `/sales` — Sales.tsx — все продажи. Вкладки Все / Продажи / Возвраты /
  Подарки, поиск по IMEI/модели/оператору. Экспорт `/api/sales/export.xlsx`.
- `/sales/new` — SaleCreate.tsx — форма создания продажи: IMEI (с TAC-
  autolookup), модель, кол-во, суммы по операторам (split), суммы по
  партнёрам, клиент, комментарий, скидка, бонус-note, override дубля.
- `/sales/:id` — SaleDetail.tsx — карточка продажи, GET `/api/sales/{id}/`.
- `/sales/:id/edit` — та же SaleCreate.tsx в edit-режиме.
- `/sales-today` — SalesToday.tsx — компактная таблица только за сегодня.
- `/leads` — Leads.tsx — все лиды с фильтрами: quick-filter
  Все / Нужна проверка / Без оператора, поиск, фильтр по sheet_source.
  Bulk-select чекбоксами, кнопка «Назначить оператора» → модалка.
  Endpoints: `/api/leads/`, `/api/leads/bulk-reassign/`.
- `/leads/orphans` — OrphanLeads.tsx — «Свободные лиды» (без оператора).
  Показывает распределение: сколько сейчас у каждого активного оператора,
  оценку eligible/reason (что мешает лить). Возможность форс-распределить
  вручную. Endpoints: `/api/leads/orphans/`, `/api/leads/distribution-status/`,
  `/api/leads/distribute-now/`, `/api/leads/bulk-reassign/`.
- `/operators` — Operators.tsx — список операторов. CRUD, деактивация/
  реактивация. Endpoints: `/api/operators/`, `/api/operators/{id}/deactivate/`,
  `/api/operators/{id}/reactivate/`, `/api/operators/{id}/delete/`.
- `/operators/:id` — OperatorDetail.tsx — детальная страница оператора:
  KPI, план на месяц, история продаж, стикер, учётка (сброс пароля,
  просмотр текущего пароля, деактивация), QR-код посещаемости, логи
  посещаемости, alias'ы в google-таблицах.
  Endpoints: `/api/operators/{id}/`, `/api/operators/{id}/stats/`,
  `/api/operators/{id}/plan/`, `/api/operators/{id}/account/*`,
  `/api/operators/{id}/sticker/`, `/api/attendance/operators/{id}/*`.
- `/partners` — Partners.tsx — CRUD партнёров (каналов оплаты: Alif,
  Birzum, Hamroh, наличные, ...). `/api/channels/`.
- `/analytics` — Analytics.tsx — аналитика с MonthPicker: leaderboard,
  по каналам оплаты, по моделям, по источникам (Instagram/Google-Sheets/
  таргетологи), воронки операторов, тепловая карта callback'ов.
  Экспорт `/api/analytics/export.xlsx`.
- `/leads-stats` — LeadsStats.tsx — сколько лидов пришло за период, куда
  ушли по статусам, разбивка по операторам, динамика по дням.
  `/api/analytics/lead-stats/`, `/api/analytics/leads-distribution/`.
- `/reports` — Reports.tsx — 6 карточек-ссылок на разные Excel-экспорты:
  sales, attendance, payroll, leads, calls, channels.
- `/payroll` — Payroll.tsx — начисления операторам за месяц. Правила
  (`PayrollRule`) с порогом 50 млн и типом выплаты (fixed/percent/tiers),
  можно переопределять на конкретного оператора. Ежемесячный отчёт с
  экспортом. Endpoints: `/api/payroll/rules/`, `/api/payroll/monthly/`,
  `/api/payroll/monthly/export.xlsx`.
- `/audit` — Audit.tsx — журнал изменений. Кто, что, когда, JSON-diff.
  `/api/audit/`.
- `/statuses` — LeadStatuses.tsx — **CRUD статусов лида**. Управление
  каталогом `LeadStatusLabel`: label RU/UZ, tone (цвет), emoji, sort_order,
  show_in_chip, show_in_button, is_active, blocks_new_leads,
  carry_over_next_day, is_terminal. Builtin статусы можно переименовать
  и перекрасить, но не удалить. `/api/lead-statuses/`.
- `/sheet-sources` — SheetSources.tsx — CRUD источников из Google Sheets.
  Каждый источник — конкретный worksheet (spreadsheet_id + gid) +
  column_map (какая колонка = имя/телефон/product_hint/alias оператора) +
  distribution_mode (alias_only / alias_or_default / default_only /
  alias_or_rr) + опциональный writeback (пишет ответ в лист).
  `/api/sheet-sources/`, `/api/operator-sheet-aliases/`.
- `/users` — Users.tsx — CRUD веб-учёток (для менеджеров/team_lead'ов).
  Не путать с `/operators` — оператор это сущность из ветки «лиды»,
  а «пользователь» — учётная запись для входа. `/api/users/`.
- `/settings` — Settings.tsx — глобальные настройки. Пока один тумблер:
  «Auto-distribution enabled» (killswitch авто-раздачи).
  `/api/settings/distribution/`.
- `/attendance/today` — AttendanceToday.tsx — кто сейчас на смене.
  Список текущих log'ов, кто пришёл поздно, кто ушёл раньше.
  `/api/attendance/today/`.
- `/attendance/report` — AttendanceReport.tsx — отчёт за период.
  `/api/attendance/report/`.
- `/ai-chat` — AIChat.tsx — чат-ассистент менеджера. Читает данные из CRM
  через safe tool-calls (ai_chat is read-only, memory
  `project_ai_chat_readonly.md`). Мультипровайдерный (OpenAI-compat proxy,
  выбор в UI). Сессии сохраняются. `/api/ai-chat/sessions/`,
  `/api/ai-chat/sessions/{id}/messages/`, `/api/ai-chat/providers/`.
- `/marketing` — Marketing.tsx — LLM-инсайты по маркетингу: качество лидов
  по источникам (какой sheet-source конвертирует лучше), рекомендации
  по таргетингу, топ упоминаемых товаров. Генерация вручную кнопкой.
  `/api/marketing/insights/`, `/api/marketing/insights/generate/`.
- `/tg-queue` — TgQueue.tsx — очередь Telegram: подключенные операторы,
  их сессии, backfill-jobs (подгрузка истории чатов), coaching-подсказки.
  `/api/tg-userclient/*`.
- `/calls` — Placeholder «Звонки» (не реализовано).
- `/catalog` — Placeholder «Каталог / TAC» (только seed_tac команда).
- `/stickers` — Placeholder «Стикеры» (стикеры выдаются, но галереи нет).

</details>

---

## 4. Ключевые сущности

### 4.1 Lead

`backend/apps/leads/models.py` → `Lead`. Клиент, который ещё не купил.
Уникальность внутри одного sheet-источника — `(sheet_source, sheet_row_index)`.
Поля: `full_name`, `phone` (нормализованный `+998XXXXXXXXX`),
`phone_alt`, `phone_raw` (оригинал из листа), `phone_invalid`,
`product_hint` (что хотел клиент), `has_card` (свободный текст),
`status` (FK по коду в `LeadStatusLabel`), `source` (sheet/manual/bot),
`sheet_source`, `sheet_row_index`, `operator` (FK — сейчас ответственный),
`needs_review` (алиас не разобран), `metadata` (JSON — доп колонки),
`postponed_at`, `postponed_by`, `postpone_reason`.

### 4.2 LeadStatusLabel — статус лида

`backend/apps/leads/models.py` → `LeadStatusLabel`. **Всё, что связано со
статусами, живёт здесь.** Менеджер может добавить свой статус или
перекрасить/переименовать встроенный. Поля:

- `code` — иммутабельный (builtin коды защищены).
- `label_ru`, `label_uz` — тексты.
- `tone` — `neutral | info | hot | success | danger` (цвет чипа).
- `emoji` — 1-2 emoji.
- `sort_order`.
- `show_in_chip` — показывать как фильтр-чип на `/my`.
- `show_in_button` — показывать как быструю кнопку на LeadCard.
- `is_active`, `is_builtin`.
- `blocks_new_leads` — если у оператора есть хоть один такой лид, RR его
  пропустит.
- `carry_over_next_day` — «спец-лид», всплывает в /my active раньше свежих
  на следующий день.
- `is_terminal` — «закрыт» (исключён из active, не блокирует RR).

**Builtin статусы** (data migration 0007 + 0010 + 0015):

<details>
<summary>Список всех встроенных кодов и как они себя ведут</summary>

Рабочие (не терминальные):
- `new` — «Новый», ⭐ синий, blocks=false, carry=false.
- `assigned` — «Назначен», синий.
- `in_progress` — «В работе», оранжевый.
- `callback_scheduled` — «Callback», синий, blocks=true, carry=true.
- `no_answer` — «Javob bermadi 1», серый, blocks=true, carry=true.
- `no_answer_2` — «Javob bermadi 2», оранжевый, blocks=true, carry=true.
- `phone_on` — «Telfoni ochiq», синий, blocks=true, carry=true.
- `dokonga_keladi` — «Придёт в магазин» (custom), blocks=true, carry=true.
- `qimmatlik_qildi` — «Показалось дорого», оранжевый (по факту retry-cycle,
  считается терминальным).

Терминальные (закрыты):
- `won` — «Продажа», зелёный.
- `lost` — «Потерян», красный.
- `archived` — «Архив», серый.
- `needs_review` — «Требует проверки», оранжевый.
- `sms_jonatildi` — «SMS отправлен», серый (после 2 no_answer'ов).
- `contacted_telegram` — «TG'га боғланди», синий, carry=true (но is_terminal
  в 0015 → противоречие: и terminal и carry — реально работает как «оператор
  сделал своё дело в TG, лид может ожить»).
- `has_debt` (`qarzi_bor`) — «У клиента долг», красный.
- `harid_qildi` — «Купил» (custom, terminal).
- `kartsi_yoq` — «Нет карты» (custom, terminal).
- `waiting_salary` — «Limit chiqmadi» (custom, terminal).
- `notogri_raqam` — «Не тот номер» (custom, terminal).

</details>

### 4.3 Sale, GiftItem, SaleOperator, SalePartner

`backend/apps/sales/models.py`. Продажа: IMEI (15 цифр, индекс),
`phone_model`, `operator` (FK — для совместимости, кто основной),
`channel` (FK — основной канал), `quantity`, `amount` (Decimal),
`discount`, `client_name`, `client_phone`, `sold_at`, `is_returned`
(soft return с reason), `is_deleted` (soft delete), `status`
(pending/confirmed), `lead` (FK — если конверсия из лида),
`sheet_source` (денорм для аналитики), `bonus_note`.
- `SaleOperator` — сплит между несколькими операторами (у одной продажи
  может быть 2+ операторов с разными долями).
- `SalePartner` — сплит между несколькими способами оплаты (клиент
  заплатил 5М налом + 3М через Alif — две строки).
- `GiftItem` — подарки внутри продажи (не уменьшают кредит, только для
  маржи).

### 4.4 Operator vs Profile

`backend/apps/operators/models.py` → `Operator` — доменная сущность
(имя, рабочий телефон, статус active/trainee/inactive, hired_at,
opt-out от урока дня, месячные планы).

`backend/apps/users/models.py` → `Profile` — связка Django-User ↔
Operator ↔ role. Один Profile = одна веб-учётка. У оператора обычно
`Profile.role='operator'` и `Profile.operator=<...>` (FK на Operator).
У менеджера `Profile.role='manager'` и `operator=NULL`.

`OperatorSecret` — обратимо шифрованная копия пароля (Fernet), чтобы
менеджер мог показать текущий пароль оператору без reset'а. Это
бизнес-требование, не баг: тимлид раздаёт логины руками.

### 4.5 Callback (CallbackReminder)

`backend/apps/calls/models.py`. Напоминание «перезвонить лиду в момент X».
- `lead`, `operator`, `remind_at`, `status`
  (`pending | done | overdue | snoozed | superseded`), `comment`,
  `dm_sent_at` (защита от спама уведомлениями).
- На один лид максимум один активный callback — новый супёрсидит старый.
- Если наступило `remind_at` и не отмечен done, статус переходит в
  `overdue` (крон `check_due_callbacks`).
- Overdue callback'и **блокируют раздачу новых лидов** оператору
  (см. `open_callbacks` + `blocked` в ответе `/api/leads/my/`).

### 4.6 CallAttempt

`backend/apps/calls/models.py`. Один звонок оператора. `outcome` из
{`talked_interested`, `talked_callback`, `no_answer`, `wrong_number`,
`rejected`, `tg_only`}. Каждый быстрый экшн на карточке (позвонил, TG,
отклонил) создаёт CallAttempt через `/api/leads/{id}/call-attempts/`.

### 4.7 LeadAssignment

`backend/apps/leads/models.py`. **Аудит переназначений.** Source:
`sheet_manual | auto_round_robin | admin_reassign | qimmatlik_retry |
morning_split | auto_refill`. Активная = последняя с `active=True`.
При reassign старая помечается `active=False`.

### 4.8 SheetSource + OperatorSheetAlias

`backend/apps/leads/models.py`. Конфиг Google-таблицы: `spreadsheet_id`,
`gid`, `column_map` (JSON — какая колонка = имя/тел/product_hint/alias
оператора), `default_status`, `distribution_mode`, `default_operator`,
`writeback_columns` (пишем ли ответ обратно в лист). Alias — если
в таблице пишут «Sardor» — это какой Operator?

### 4.9 Attendance (посещаемость)

`backend/apps/attendance/*`. Оператор чекинится/чекаутится по QR-коду
(его личный QR в профиле, ротация через `/qr/rotate/`). Крон
`attendance_long_shift_check` каждые 30 минут закрывает открытые log'и,
если смена длится подозрительно долго. Отчёт `attendance/today` показывает
кто сейчас на смене; `attendance/report` — по периоду.

### 4.10 Sticker

`backend/apps/stickers/*` (см. memory `project_sticker_uniqueness.md`).
Один оператор — один активный стикер. `is_rare=True` — уникальный,
только у одного оператора в системе.

### 4.11 Notification, DailyLesson, TgUserclient, AIChatSession, MarketingInsight

- `Notification` — in-app, для senior'ов (новая продажа, callback подошёл).
- `DailyLesson` — сгенерённый LLM урок по вчерашнему дню оператора.
- `TgUserclient` (Telethon) — MTProto-сессия оператора для чтения его
  собственных чатов (backfill истории, анализ качества переписки).
- `AIChatSession/Message` — read-only чат менеджера с ассистентом.
- `MarketingInsight` — snapshot LLM-инсайтов по маркетингу за период.

---

## 5. Жизненный цикл лида

Все переходы идут через `apps.leads.services.lead_update_status` (или
через API `POST /leads/{id}/status/` и `POST /leads/{id}/call-attempts/`).
После смены статуса срабатывает хук `_run_refill_if_empty` — если
у оператора обнулился working_count, попытаться сразу долить пачку.

### 5.1 Появление лида

1. **Из Google-таблицы** (основной путь) — крон `sync_sheets_leads`
   каждые 5 минут читает все активные `SheetSource`, находит новые
   строки, нормализует телефон, создаёт `Lead`. Если в строке есть
   alias оператора и он привязан — сразу назначает. Если alias есть, но
   не привязан — `needs_review=True`. Если alias'а нет —
   зависит от `distribution_mode` источника.
2. **Вручную** — менеджер жмёт создание лида (Leads.tsx, POST `/leads/`).
   `source='manual'`.
3. **Из бота** — `source='bot'` (пока не активно в проде).

### 5.2 Раздача (distribution)

- **Утренняя раздача** — каждый день **08:30 Asia/Tashkent**
  (docker-compose `morning-splitter`, команда `morning_distribute`).
  Сначала одноразово вызывается `sync_sheets_leads`, потом все
  unassigned активные лиды делятся поровну между активными операторами.
  Assignment.source = `morning_split`.
- **Refill** — каждые 5 минут (`distribute-watcher` →
  `refill_idle_operators`) проходит по операторам с `working_count=0` и
  доливает пачку из пула сирот. Assignment.source = `auto_refill`.
  Уважает `SystemSetting.auto_distribution_enabled` (killswitch в /settings).
- **Refill при закрытии лида** — hook `_run_refill_if_empty` вызывается
  внутри `lead_update_status`, если оператор закрыл всё что было.
- **Ручное назначение** — менеджер выбирает лид(ы) в /leads или
  /leads/orphans, назначает оператора (POST `/leads/bulk-reassign/` или
  `/leads/{id}/reassign/`). Assignment.source = `admin_reassign`.

### 5.3 Оператор берёт лид в работу

- Открывает `/my`, видит карточку с бейджем текущего статуса.
- Жмёт «Bog'lanish» → выбирает Call (`tel:` deep-link) или TG
  (`https://t.me/{username}` если знаем, иначе `tg://resolve?phone=+998…`).
- В момент клика **сразу же** создаётся CallAttempt с `outcome`
  соответствующим действию, и статус лида оптимистично меняется:
  - Call/`talked_interested` → `in_progress`
  - TG → `contacted_telegram`
  - «крестик»/`rejected` → `lost`
- Дальше оператор жмёт статус-кнопку («Javob bermadi», «Qarzi bor»,
  «Показалось дорого», «Придёт в магазин»...) — статус обновляется через
  POST `/leads/{id}/status/`.
- **Специальная логика `no_answer`:** если жмут «Javob bermadi» и лид
  уже был в `no_answer`, апгрейд до `no_answer_2` — через
  `/call-attempts/` (не через generic `/status/`).

### 5.4 Callback

- Кнопка «Callback» на карточке → `ScheduleCallbackModal` (datetime-local
  + комментарий). POST `/leads/{id}/callbacks/`, статус лида идёт в
  `callback_scheduled`.
- Хук `useCallbackWatcher` каждую минуту пуллит `/callbacks/mine/due/`.
- Как только `remind_at <= now` — открывается модалка `CallbackDueModal`
  поверх интерфейса. Крупная кнопка «Позвонить сейчас» (mark done +
  открыть tel:) и «+15 мин» (snooze).
- Крон `check_due_callbacks` (в README.md сказано «каждую минуту через
  cron») переводит pending → overdue после `remind_at` и шлёт DM
  в Telegram оператору (если подключен) — только 1 раз (защита
  `dm_sent_at`).
- Overdue callback'и **блокируют** оператора: `blocked=true` в ответе
  `/leads/my/`, hero показывает красный banner «Locked» с ссылкой
  разобрать.

### 5.5 Postpone (отложить на потом)

- Кнопка «Postpone» → `PostponeModal` (reason ≤280 символов).
  POST `/leads/{id}/postpone/`.
- Лид уходит на вкладку «Отложенные», не считается в working_count.
- В любой момент можно вернуть: кнопка «Return» → POST `/unpostpone/`.
- Postpone НЕ является статусом — это отдельный флаг (`Lead.postponed_at`).
  Оператор может отложить в любом статусе.

### 5.6 Carry-over (перенос на следующий день)

Ключевая логика, которую операторы не понимают, поэтому подробно.

- Статусы с `carry_over_next_day=True` (по умолчанию: `no_answer`,
  `no_answer_2`, `phone_on`, `callback_scheduled`, `contacted_telegram`,
  `dokonga_keladi`) — это **«спец-лиды»**, которые нужно добить.
- Правило «активный на сегодня» (memory `project_lead_active_today_rule.md`):
  лид считается активным на сегодня, если оператор его сегодня НЕ трогал
  (`updated_at < today_start` в Asia/Tashkent). Если тронул сегодня —
  скрывается до завтра.
- Ночной auto-close (23:30 → wait → 00:30 Tashkent, `auto-closer` +
  `auto_close_stale_leads.py`, memory `project_auto_close_stale_leads.md`)
  закрывает как LOST все вчерашние **non-carry** активные лиды, которые
  оператор тронул вчера или раньше, но не закрыл. Carry-статусы (спец-лиды)
  НЕ закрываются — они «переносятся» и утром снова всплывают.
- Утром 08:30 идёт `morning_distribute` — доливает новых поверх этого
  carry-хвоста.

### 5.7 Конверсия в продажу

- Кнопка «В продажу» на карточке → `/sales/new?lead=<id>`.
- SaleCreate.tsx подгружает данные лида, оператор/менеджер оформляет
  продажу.
- POST `/leads/{id}/convert-to-sale/` (или из SaleCreate.tsx создаётся Sale
  с `lead=<id>`) — статус лида идёт в `won`, `Sale.lead` заполнен,
  `Sale.sheet_source` денормализуется.

### 5.8 Другие терминалы

- Reject (`lost`), архив (`archived`), «Не тот номер» (`notogri_raqam`),
  «Нет карты» (`kartsi_yoq`), «Купил у другого» (`harid_qildi`),
  «Отправил SMS» (`sms_jonatildi`), «Ждёт зарплату» (`waiting_salary`),
  «Показалось дорого» (`qimmatlik_qildi`).
- Все они `is_terminal=True` — исключаются из /my active по умолчанию,
  не блокируют новые лиды.

### 5.9 Retry (qimmatlik → передача другому оператору)

`LeadAssignmentSource.QIMMATLIK_RETRY`. Если оператор закрыл лид как
«qimmatlik» (дорого), лид может быть перекинут другому оператору с
бейджем на карточке «🔄 Уже пробовал {name}» (см. lead.is_retry +
lead.previous_operator_name в MyLeads.tsx).

---

## 6. Типичный день оператора

1. **Приходит в офис ~8:20.** Открывает свой профиль в мобильном
   браузере → «Chek-in», сканирует QR (лежит рядом с рабочим местом)
   ИЛИ жмёт toggle на `/profile`.
2. **8:30 крон уже раздал ему пачку.** Открывает `/my` — hero говорит
   «У тебя 12 активных лидов». Если есть carry с вчера — они наверху.
3. **Проверяет callback'ы.** Если полоса overdue-callback'ов сверху
   красная — обязан сначала перезвонить (`blocked=true`, новые не
   долиют). Кликает — переходит к активной вкладке, звонит.
4. **Работает по списку.** На каждой карточке: жмёт «Bog'lanish» →
   Call. Если ответили — «В работе» → диалог → или закрывает статусом
   (`Купил` / `Дорого` / `Нет карты` / ...), или ставит Callback на
   позже, или откладывает Postpone до вечера.
5. **Не ответили** — жмёт «Javob bermadi». Первый раз → `no_answer`.
   Второй раз тем же жестом → `no_answer_2`. Третий раз — обычно
   закрывает через быструю кнопку `sms_jonatildi` («отправил SMS»)
   или `lost`.
6. **Клиент попросил перезвонить в 14:00** — жмёт «Callback», ставит
   время. В 14:00 всплывает модалка «Callback time» с крупной кнопкой
   «Позвонить сейчас».
7. **Клиент согласен купить** — жмёт «В продажу», переходит в форму
   создания продажи (в текущем UI менеджер должен подтвердить, потому
   что RoleGate — известная UX-дыра, см. §10).
8. **Пришли новые лиды в течение дня** — сервис `distribute-watcher`
   раз в 5 минут доливает пачку тем, у кого пусто.
9. **Обед / перерыв** — chek-out (toggle на профиле), после chek-in.
10. **Уходит домой ~18:00** — chek-out. Всё, что не тронул сегодня из
    non-carry, ночью закроется в `lost`. Всё carry (спец-статусы) —
    ждёт его утром.
11. **Первое, что видит утром** — `/lessons/today`, короткая LLM-сводка
    вчерашнего дня (сколько продал, конверсия, куда потерял). Затем
    возвращается к шагу 1.

---

## 7. Типичный день менеджера

1. **Утро ~9:00.** Логинится через username/пароль. Попадает на
   `/` — Dashboard. Смотрит KPI: сколько продали вчера/за месяц, кто
   на смене.
2. **Проверяет посещаемость** `/attendance/today` — все ли пришли, кто
   опоздал, кому надо сделать замечание.
3. **Открывает `/leads/orphans`** — сколько сирот в пуле, как раздача
   работает. Если есть перекос (у одного 40, у другого 0) — bulk-reassign
   вручную. Если совсем ничего не раздаётся — идёт в `/settings`,
   проверяет killswitch auto-distribution.
4. **Смотрит `/leads?needs_review=1`** — sheet-sync нашёл алиасы
   операторов, которые не привязаны. Привязывает через
   `/sheet-sources` → OperatorSheetAlias.
5. **В течение дня:** оформляет продажи, которые операторы конвертируют
   (SaleCreate.tsx). Смотрит уведомления о новых крупных продажах.
6. **Разбор callback'ов** — если оператор явно не справляется, кто-то
   не берёт трубку, менеджер видит по бейджу в сайдбаре
   `Leads (badge)`.
7. **Analytics `/analytics`** — раз в неделю смотрит по каналам, моделям,
   источникам лидов. Кто конвертирует лучше — Instagram или Google-Sheets?
   Выгружает Excel для отчёта владельцу.
8. **`/marketing`** — раз в неделю жмёт «сгенерировать инсайт», получает
   LLM-разбор какие источники лидов самые качественные и что упомянуть
   таргетологам.
9. **`/ai-chat`** — быстрые вопросы «сколько мы продали iPhone 15 в
   августе?», «покажи топ-5 операторов». Ассистент делает read-only
   tool-calls, отвечает.
10. **Конец месяца:** `/payroll` → пересчёт → экспорт xlsx → передача
    в бухгалтерию. `/reports` — сборник Excel-выгрузок.
11. **Audit** — если возникло подозрение, кто менял продажу / удалил
    лида — идёт в `/audit`.

---

## 8. Автоматика (крон-подобные сервисы)

Все крутятся как отдельные Docker-сервисы в `docker-compose.prod.yml`.
Никакого celery, просто bash-loops + `sleep`.

- **`sheet-sync`** — каждые **5 минут** `sync_sheets_leads`. Тянет новые
  строки из всех активных SheetSource, создаёт Lead'ы.
- **`morning-splitter`** — раз в сутки **08:30 Asia/Tashkent**
  (03:30 UTC). Сначала `sync_sheets_leads` (одноразово), затем
  `morning_distribute` — раздаёт всех сирот поровну между активными
  операторами.
- **`distribute-watcher`** — каждые **5 минут** `refill_idle_operators`.
  Доливает пачки тем, у кого `working_count=0`. Уважает killswitch
  auto-distribution.
- **`auto-closer`** — раз в сутки **00:30 Asia/Tashkent** (19:30 UTC).
  Закрывает как LOST вчерашние non-carry, не тронутые сегодня, «висящие»
  лиды. См. memory `project_auto_close_stale_leads.md`.
- **`ops-nightly`** — раз в сутки **23:30 Asia/Tashkent** (18:30 UTC).
  `release_stale_leads --days 10` (снимает оператора с лидов старше 10
  дней) + `send_daily_manager_report` (DM в Telegram менеджеру).
- **`scheduler`** — каждые **15 минут** `analyze_tg_dialogs` (LLM-анализ
  качества переписки операторов в их Telegram-чатах).
- **`userclient`** — постоянно, `run_tg_userclient` (Telethon MTProto).
- **`lesson-generator`** — каждые **6 часов** `generate_daily_lessons`
  (готовит уроки для операторов из вчерашних данных).
- Плюс отдельные **systemd-таймеры** (`deploy/systemd/*.timer`):
  - `naff-daily-lessons-generate.timer` — `05:30 Asia/Tashkent`,
    ежедневно.
  - `naff-daily-lessons-deliver.timer` — `07:30 Asia/Tashkent`,
    ежедневно (DM операторам с уроком).
  - `naff-attendance-long-shift-check.timer` — каждые 30 минут.
- **`check_due_callbacks`** — по README.md ставится в системный cron
  каждую минуту:
  `* * * * * docker compose exec -T web python manage.py check_due_callbacks`.
  Переводит pending → overdue, шлёт DM оператору один раз.

**LLM-провайдеры.** `apps.ai_chat` и `apps.marketing` используют
per-app-фабрики `get_ai_chat_provider()` / `get_marketing_provider()`
(memory `project_llm_provider_protocol.md`). OpenAI-compat proxy можно
переопределить через env. Ai-chat строго read-only (memory
`project_ai_chat_readonly.md`), никаких write-tool'ов.

---

## 9. User stories

Формат: как {роль}, я хочу {X}, чтобы {Y}.

### Оператор
1. **Как оператор**, я хочу зайти в систему по своему рабочему телефону
   и паролю, чтобы не запоминать никаких выдуманных username'ов.
2. **Как оператор**, я хочу утром сразу увидеть, сколько активных лидов
   у меня в работе, чтобы не тратить время на поиск.
3. **Как оператор**, я хочу видеть лиды в порядке приоритета (сначала
   вчерашние carry — они уже «горячие»), чтобы не терять клиентов.
4. **Как оператор**, я хочу за 1 клик позвонить/написать в TG, чтобы
   не переключаться между приложениями.
5. **Как оператор**, я хочу за 1 клик отметить исход разговора
   (`Javob bermadi`, `Дорого`, `Придёт в магазин`), чтобы система
   знала когда меня разблокировать / когда напомнить.
6. **Как оператор**, я хочу поставить callback на конкретное время и
   получить громкое напоминание в это время, чтобы не забыть.
7. **Как оператор**, я хочу отложить лид «на после обеда» с коротким
   комментарием и вернуться к нему одной кнопкой, чтобы разгрузить
   активный список.
8. **Как оператор**, я хочу видеть, если этот лид уже пробовал
   другой оператор (retry-бейдж), чтобы понимать контекст разговора.
9. **Как оператор**, я хочу видеть свой прогресс по дневному плану
   (визуальный gauge), чтобы понимать, справляюсь ли.
10. **Как оператор**, я хочу утром получить короткий урок по вчера
    (что было хорошо, что провалил), чтобы расти.
11. **Как оператор**, я хочу отметить приход/уход через QR-код или
    один tap в профиле, чтобы не тратить время на бумажный табель.
12. **Как оператор**, я хочу подключить свою Telegram-сессию через
    wizard, чтобы система знала мой @username и могла шифровать/
    анализировать мои чаты с клиентами.

### Менеджер
13. **Как менеджер**, я хочу утром увидеть дашборд: продажи вчера/
    сегодня/за месяц, кто на смене, лидборд, чтобы понимать состояние
    без вопросов.
14. **Как менеджер**, я хочу увидеть, сколько лидов в пуле «сирот» и
    как крон их распределяет, чтобы вовремя вмешаться при перекосе.
15. **Как менеджер**, я хочу вручную перекинуть пачку лидов от одного
    оператора другому (через bulk-select), чтобы разгрузить
    перегруженного.
16. **Как менеджер**, я хочу привязать алиас из Google-таблицы
    («Sardor» — какой это Operator?) один раз, чтобы новые лиды сразу
    попадали правильно.
17. **Как менеджер**, я хочу настроить свои статусы (добавить «Ждёт
    зарплаты», перекрасить `no_answer_2` в красный), потому что бизнес
    меняется чаще, чем разработчики релизят.
18. **Как менеджер**, я хочу увидеть аналитику по источникам лидов,
    чтобы понять, куда стоит вкладывать бюджет.
19. **Как менеджер**, я хочу задать вопрос на естественном языке
    («сколько продал Sardor в июле?») и получить ответ, чтобы не
    строить запросы вручную.
20. **Как менеджер**, я хочу получить LLM-инсайт по маркетингу за
    период (какие источники самые качественные, топ товаров), чтобы
    принять решение по бюджету рекламы.
21. **Как менеджер**, я хочу выгрузить excel-отчёт по продажам /
    зарплате / посещаемости, чтобы отдать в бухгалтерию или владельцу.
22. **Как менеджер**, я хочу увидеть, кто и что менял в продаже /
    операторе (audit log), чтобы разобраться при жалобе.
23. **Как менеджер**, я хочу выключить авто-раздачу одним тумблером
    (killswitch в /settings), когда провожу собрание или тестирую
    новую логику.
24. **Как менеджер**, я хочу увидеть QR оператора для чек-ина и
    показать пароль оператора без сброса, потому что операторы часто
    забывают.
25. **Как менеджер**, я хочу подключить новый Google-Sheet источник
    с column-map через UI, а не через код.

---

## 10. Известные проблемы UX (почему операторы не понимают)

### 10.1 Слишком много статусов, коды на латинице и русском вперемешку

В builtin-таблице **22+ кода**: `new`, `assigned`, `in_progress`,
`callback_scheduled`, `contacted_telegram`, `no_answer`, `no_answer_2`,
`phone_on`, `has_debt`, `won`, `lost`, `archived`, `needs_review`,
`sms_jonatildi`, `qimmatlik_qildi`, `dokonga_keladi`, `qarzi_bor`,
`kartsi_yoq`, `waiting_salary`, `harid_qildi`, `notogri_raqam`, ...
Некоторые имеют почти идентичные лейблы: `sms_jonatildi` (SMS отправлен)
vs `no_answer_2` («Javob bermadi 2»). Латинские коды путаются с
названиями. Emoji помогают, но недостаточно.

**Дизайнеру:** сгруппировать статусы в понятные бакеты («Не дозвонился»,
«В работе», «Отложен», «Закрыто с продажей», «Закрыто без продажи»)
и внутри каждой давать выбор конкретного подстатуса.

### 10.2 Флаги статусов невидимы

`blocks_new_leads`, `carry_over_next_day`, `is_terminal` — критичные
поля, но оператор о них не знает. Он не понимает, почему после `no_answer`
ему **не дают** новые лиды (потому что `blocks_new_leads=True`) или
почему вчерашний `phone_on` всплыл утром (`carry_over_next_day=True`).

**Дизайнеру:** на карточке лида и в чипе фильтра показывать иконку
«активный» / «отложен» / «спец-лид» / «закрыт» — визуально отличимо.

### 10.3 Разница между «активен сегодня» / «carry» / «postponed» / «terminal»

- **Активен сегодня** = `is_terminal=False`, `postponed_at=NULL`, не
  тронут сегодня (`updated_at < today_start`).
- **Carry** = тот же активный, но со статусом `carry_over_next_day=True`.
  Всплывает наверх утром.
- **Postponed** = флаг `postponed_at` не NULL. Отдельная вкладка.
- **Terminal** = `is_terminal=True`. Не в active по умолчанию.

Оператор видит просто «мои лиды», не понимая, почему список внезапно
уменьшился или увеличился.

**Дизайнеру:** явные разделы «Сегодня новые», «Вчерашние carry»,
«Отложенные», «Callback'и (ждут напоминания)», «Закрытые» с
переключением табами.

### 10.4 Overdue callback banner может не бросаться в глаза

Сейчас есть красный hero-banner и sticky-хедер с иконкой Lock, но при
скролле легко пропустить, что оператор `blocked`. Также термин «locked»
непонятен операторам.

**Дизайнеру:** blocking modal-overlay + звуковой сигнал (пуш через
браузер?) — оператор физически не может продолжать, пока не разберёт.

### 10.5 Нет очевидной кнопки «дай мне следующий лид»

Сейчас оператор видит **список карточек** и должен сам выбирать, кого
звонить первым. По сути ему нужен один экран «текущий лид», кнопки
результата, автопереход к следующему.

**Дизайнеру:** режим «one-lead-at-a-time» (карточка на весь экран,
после действия автопрокрутка к следующей).

### 10.6 Split-button «Bog'lanish» с dropdown требует 2 клика

Клик по «Bog'lanish» → dropdown → выбор Call/TG. Оператор ожидает 1 клик.

**Дизайнеру:** две отдельные крупные кнопки Call и TG, side-by-side.

### 10.7 Статус-кнопки «show_in_button» — множество мелких икон

Сейчас на карточке 6-8 icon-only кнопок статусов подряд + Callback +
Postpone + В продажу + Reject. На мобильном они убивают ширину.

**Дизайнеру:** «primary actions» (Позвонить/TG/В продажу) большие,
«secondary» (статусы) — компактно в bottom-sheet при «Изменить статус».

### 10.8 Sidebar 25+ пунктов у менеджера

7 групп по 3-5 пунктов, с collapsible-заголовками. Всё равно — стена
текста. Русско-узбекская смесь в лейблах статусов.

**Дизайнеру:** максимум 8 пунктов первого уровня + вложенные внутри
страницы (например, «Аналитика» — одна страница с вкладками, а не
5 разных роутов).

### 10.9 Форма создания продажи — большая

IMEI, модель, quantity, split по операторам (динамические строки),
split по партнёрам (динамические строки), клиент имя, клиент телефон,
скидка, комментарий, бонус, override-дубля (checkbox + comment). Плюс
edit-режим, который делает сложные вычисления `gross/net` из существующих
данных. Легко запутаться.

**Дизайнеру:** wizard из 3 шагов (устройство → оплата → комментарий/бонус).

### 10.10 Валидация форматов слабая

Телефоны нормализуются на бэке (иногда `phone_invalid=True`), IMEI —
валидируется Luhn'ом на бэке, но UI не показывает live-подсказку в
формах вне SaleCreate. У Lead'ов часто `phone_alt`, `phone_raw`
разные, оператор видит все три.

### 10.11 Оператор не может создать продажу сам

Кнопка «В продажу» ведёт на `/sales/new`, который защищён
`RoleGate allow={["manager"]}`. Оператор упирается в редирект на `/my`.

**Дизайнеру:** либо разрешить упрощённую форму для оператора, либо
переименовать в «Отправить менеджеру на оформление продажи».

### 10.12 Placeholder-страницы в сайдбаре

`/calls`, `/catalog`, `/stickers` — Placeholder-компонент («в разработке»).
Занимают строки в меню, но толку ноль.

**Дизайнеру:** убрать из sidebar до реализации.

### 10.13 3D-сцены на дашборде и /my

`GaugeScene`, `BarsScene` (three.js) выглядят красиво, но не читаются
как данные. Оператор не понимает, что за градусник и что за столбики.

**Дизайнеру:** плоские простые компоненты (progress bar, sparkline),
данные важнее декора.

---

## 11. Приоритеты для нового дизайна

**Критично (оператор видит каждый день):**
1. `/my` — MyLeads (полностью переосмыслить).
2. `/login` — вход по телефону (проще + один шаг).
3. `/profile` — упростить под задачи оператора (chek-in, стикер, пароль).
4. Модалка Callback + Postpone.
5. `/notifications`.
6. `/lessons/today` — сейчас перегружено секциями.

**Средне (менеджер видит каждый день):**
7. Dashboard `/`.
8. `/leads` + `/leads/orphans`.
9. Sidebar (сжать группировку).
10. Header (title/subtitle текущей страницы).

**Не критично (менеджер видит раз в неделю/месяц):**
11. `/analytics`, `/leads-stats`, `/reports`.
12. `/payroll`, `/audit`.
13. `/settings`, `/users`, `/statuses`.
14. `/sheet-sources`, `/partners`, `/operators`.
15. `/ai-chat`, `/marketing`.
16. `/tg-queue`.
17. `/screen` (полноэкранное табло — можно оставить как есть).

---

## 12. Рекомендации дизайнеру

- **Mobile-first для оператора.** Операторы часто работают с планшетов
  или телефонов (менеджер — с ноута/десктопа). `/my`, `/profile`,
  `/scan`, `/lessons/today`, `/notifications` должны быть touch-friendly.
- **Крупные тач-цели.** Минимум 44×44px, лучше 56.
- **Плоские кнопки статусов без 3D-эффектов.** Emoji + короткий лейбл.
- **Максимум 2 цвета акцента.** Сейчас палитра gradient orange
  (`--accent-grad`) + gray. Не добавлять больше.
- **Тёмная тема ДА.** Есть в i18n `common.theme_dark`, работает через
  `store/theme.ts`. Дизайнер должен спроектировать оба варианта.
- **Onboarding для нового оператора.** Первый вход → чек-лист:
  «(1) подключи Telegram, (2) выбери стикер, (3) отсканируй QR
  посещаемости, (4) вот твоя первая пачка лидов». Сейчас этого нет
  вообще.
- **Однозначные иконки на каждый статус.** Emoji помогают, но добавить
  цветовой code (dot слева на карточке = tone статуса).
- **Живой feedback на действия.** Уже есть nfFlashRing (soft accent ring
  на смену статуса) — сохранить и усилить.
- **Не пытаться уместить всё на один экран.** Оператор работает с
  одним лидом за раз — full-width карточка активного, остальные внизу
  списком.
- **Обучающие подписи к флагам статусов.** Например «Этот статус
  блокирует новые лиды» под чипом.
- **Явное состояние оператора.** «Ты сегодня: 12 звонков, 3 продажи,
  1 callback ждёт в 15:30» — постоянно на виду.

---

## 13. Дополнительно

### Скриншоты

Дизайнеру не приложены — актуальный вид смотреть на https://naff.flek.uz
после логина под demo (менеджерская учётка `dostik` с паролем `tostik`
согласно контексту задачи). Роуты в §3.

### Полная карта API endpoints

<details>
<summary>Разворнуть список endpoints по группам</summary>

- **Auth / me**: `POST /api/auth/login/`, `POST /api/auth/logout/`,
  `GET /api/auth/me/`, `POST /api/me/change-password/`,
  `POST /api/me/telegram/link/`.
- **Preferences / stickers / greetings**: `GET|PATCH /api/me/preferences/`,
  `GET|PUT /api/me/sticker/`, `GET /api/stickers/palette/`,
  `GET /api/me/morning-greeting/`, `POST /api/me/morning-greeting/dismiss/`.
- **Operators**: `GET|POST /api/operators/`, `GET|PATCH|PUT /api/operators/{id}/`,
  `GET /api/operators/{id}/stats/`, `GET|PUT /api/operators/{id}/plan/`,
  `POST /api/operators/{id}/deactivate/`, `POST /api/operators/{id}/reactivate/`,
  `DELETE /api/operators/{id}/delete/`.
- **Operator accounts (менеджер)**: `POST /api/operators/{id}/account/`,
  `GET /api/operators/{id}/account/password/`,
  `POST /api/operators/{id}/account/reset-password/`,
  `POST /api/operators/{id}/account/deactivate/`,
  `POST /api/operators/{id}/account/activate/`,
  `DELETE /api/operators/{id}/account/delete/`,
  `GET|PUT /api/operators/{id}/sticker/`.
- **Users (менеджер)**: `GET|POST /api/users/`,
  `POST /api/users/{id}/reset-password/`, `DELETE /api/users/{id}/delete/`.
- **Sales**: `GET|POST /api/sales/`, `GET|PATCH|PUT|DELETE /api/sales/{id}/`,
  `POST /api/sales/{id}/return/`, `POST /api/sales/{id}/confirm/`,
  `POST /api/sales/import-excel/`, `GET /api/sales/export.xlsx`.
- **Catalog**: `GET|POST /api/channels/` (+ id), `GET /api/imei/{imei}/lookup/`.
- **Payroll**: `GET|POST /api/payroll/rules/` (+ id),
  `GET /api/payroll/monthly/`, `GET /api/payroll/monthly/export.xlsx`.
- **Analytics**: `GET /api/analytics/kpi/`, `/leaderboard/`, `/by-channel/`,
  `/by-model/`, `/by-source/`, `/timeseries/`, `/leads-distribution/`,
  `/operator-funnels/`, `/callback-heatmap/`, `/lead-stats/`, `/export.xlsx`.
- **Audit**: `GET /api/audit/`.
- **Leads**: `GET|POST /api/leads/`, `GET|PATCH|PUT|DELETE /api/leads/{id}/`,
  `GET /api/leads/my/`, `GET /api/leads/orphans/`,
  `POST /api/leads/bulk-reassign/`, `GET /api/leads/distribution-status/`,
  `POST /api/leads/distribute-now/`, `POST /api/leads/{id}/reassign/`,
  `POST /api/leads/{id}/status/`, `POST /api/leads/{id}/postpone/`,
  `POST /api/leads/{id}/unpostpone/`, `POST /api/leads/{id}/convert-to-sale/`,
  `POST /api/leads/{id}/call-attempts/`, `POST /api/leads/{id}/callbacks/`.
- **Callbacks**: `GET /api/callbacks/mine/`, `GET /api/callbacks/mine/due/`,
  `POST /api/callbacks/{id}/done/`, `POST /api/callbacks/{id}/snooze/`.
- **Sheet sources / aliases**:
  `GET|POST /api/sheet-sources/` (+ id),
  `GET|POST /api/operator-sheet-aliases/` (+ id).
- **Lead statuses**: `GET|POST /api/lead-statuses/` (+ id).
- **Telegram lookup**: `GET /api/telegram/lookup/`.
- **TG userclient**: `POST /api/tg-userclient/start/`,
  `POST /api/tg-userclient/verify-code/`,
  `POST /api/tg-userclient/verify-password/`,
  `POST /api/tg-userclient/revoke/`,
  `GET /api/tg-userclient/status/`,
  `GET /api/tg-userclient/chats/`, `/messages/`, `/insights/`,
  `/backfill-jobs/`, `POST /api/tg-userclient/backfill-jobs/retry/`,
  `GET /api/tg-userclient/queue/`, `/coaching/`.
- **AI-chat (read-only)**: `GET|POST /api/ai-chat/sessions/`,
  `GET|POST /api/ai-chat/sessions/{id}/messages/`,
  `GET /api/ai-chat/providers/`.
- **Marketing**: `GET /api/marketing/insights/`,
  `GET /api/marketing/insights/latest/`,
  `POST /api/marketing/insights/generate/`.
- **Lessons**: `GET /api/lessons/today/`, `GET /api/lessons/history/`,
  `GET /api/lessons/{id}/`.
- **Attendance**: `POST /api/attendance/scan/`,
  `GET /api/attendance/me/current/`, `POST /api/attendance/me/toggle/`,
  `GET /api/attendance/me/history/`, `GET /api/me/attendance-qr.png`,
  `GET /api/attendance/today/`, `/report/`,
  `GET /api/attendance/operators/{id}/logs/`, `/qr/`, `/qr.png`,
  `POST /api/attendance/operators/{id}/qr/rotate/`,
  `GET|PATCH /api/attendance/settings/`,
  `POST /api/attendance/logs/{id}/close/`.
- **Notifications**: `GET /api/notifications/`, `/unread-count/`,
  `POST /api/notifications/mark-read/`, `/mark-all-read/`.
- **Settings**: `GET|PATCH /api/settings/distribution/`.

</details>

---

## Обратная связь

При вопросах по конкретному экрану — открыть соответствующий файл
`frontend/src/pages/<Name>.tsx`. Файл содержит все `t("…")`-ключи (RU/UZ
лейблы можно найти по ключу в `frontend/src/lib/i18n.ts`) и все API-
вызовы, поэтому автономно объясняет, что именно происходит на странице.

За бизнес-правила (переходы статусов, refill-логика, carry-over,
auto-close) — читать `backend/apps/leads/services.py` и связанные
data-migrations в `backend/apps/leads/migrations/`. Модели данных —
`backend/apps/*/models.py`.
