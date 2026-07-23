# naffAI

Внутренняя система учёта продаж и управления операторами колл-центра
телефонного магазина. Заменяет ручной подсчёт «IMEI + модель + кто продал»
из группового чата.

> **Live:** фронт — https://naffcrm.vercel.app · API — за Cloudflare Tunnel на DigitalOcean droplet.
> Логин по умолчанию: `dostik / tostik`.

## Что нового

- **Pre-sale контур (Этап A)** — лиды из Google Sheets, авто-распределение по операторам round-robin, callback-реминдеры с TG-DM, операторская станция `/my` с блокировкой при просроченных callback'ах. Подробнее в разделе «Pre-sale (Этап A)» ниже.
- **Мульти-аллокация продаж** — на одну продажу теперь можно повесить N операторов и N партнёров (Alif / Birzum / Hamroh / Cash / …), у каждого своя доля суммы. Премия и аналитика считают по строкам, а не по «основному» FK.
- **Excel-импорт и -экспорт в формате `savdo` магазина** — листы `savdo` + `nomerla`, сплит-платежи `"Birzum+Hamroh"` / `"5300000+6900000"`, авто-распознавание `MM.DD.YY` vs `DD.MM.YY` локали дат, идемпотентный round-trip.
- **IMEI 6–15 цифр** (был ровно 15) — поддержка короткого внутреннего серийника + полного 15-значного.
- **Тёмная тема** с переключателем, состояние в localStorage, авто-старт по `prefers-color-scheme`.
- **Комбобоксы с автодобавлением** — поля «Модель», «Оператор», «Партнёр» дают подсказки из истории и автосоздают новую запись, если ввести что-то, чего ещё нет в списке.
- **Валидация сумм** на форме продажи: per-line guard ≥ 1 000, live-итог «по операторам» vs «по партнёрам» с amber-предупреждением при несовпадении.

## Стек

- **Backend:** Django 5.x + DRF, PostgreSQL, openpyxl, drf-spectacular. Структура по [HackSoft styleguide](https://github.com/HackSoftware/Django-Styleguide):
  `models.py` → `selectors.py` (чтение) → `services.py` (запись) → `apis.py` (тонкие view) → `urls.py`.
- **Frontend:** React 18 + Vite + TypeScript + Tailwind + Recharts. Минимализм, без украшательств.
- **Telegram-бот:** aiogram, парсит сообщения и создаёт черновики продаж со статусом `pending`.
- **Деплой:** Docker Compose (`db`, `web`, `frontend`, опционально `bot`).
- **Управление зависимостями:** `uv` + `pyproject.toml`.

## Структура

```
naffAI/
├── backend/
│   ├── config/          # settings (base/dev/prod/test), urls, wsgi
│   ├── apps/
│   │   ├── common/      # TimestampedModel, validators (Luhn), money, excel
│   │   ├── audit/       # AuditLog + service-level diff
│   │   ├── catalog/     # Channel + TacLookup + IMEI lookup
│   │   ├── operators/   # Operator + soft-delete lifecycle
│   │   ├── sales/       # Sale + GiftItem + duplicate gate + Excel-export
│   │   ├── payroll/     # PayrollRule + compute_payout/monthly
│   │   ├── analytics/   # KPI / leaderboard / by-channel / by-model / TS
│   │   ├── users/       # роли (team_lead / manager / operator) + login
│   │   └── tg_bot/      # regex-парсер + aiogram-runner
│   ├── pyproject.toml
│   ├── manage.py
│   └── scripts/entrypoint.sh
├── frontend/
│   ├── src/
│   │   ├── pages/       # Dashboard / Sales / SaleCreate / Operators / Analytics / Payroll / Audit / Login
│   │   ├── components/  # Layout / KpiCard / ProgressBar
│   │   ├── lib/         # api.ts, format.ts
│   │   └── store/       # zustand auth store
│   └── package.json
├── docker-compose.yml
├── Makefile
└── .env.example
```

## Быстрый старт

```bash
# 1. Конфиг
cp .env.example .env
# (отредактируй DJANGO_SECRET_KEY и пароль БД при необходимости)

# 2. Запуск (db + Django + React)
docker compose up --build -d

# 3. Открываем
#   - Дашборд:  http://localhost:5180
#   - API:      http://localhost:8010/api/
#   - Swagger:  http://localhost:8010/api/docs/
#   - Admin:    http://localhost:8010/admin/
#
# Дефолтный логин: dostik / tostik (создаётся на старте, смени в .env)
```

`entrypoint.sh` сам прогоняет миграции и сидит каналы
(Alif / Uzum / WhatsApp / Walk-in / Phone-call) и TAC-словарь.
Демо-данные не сидаются — загружай реальную таблицу через
кнопку «Импорт Excel» на странице Продаж или
`python manage.py import_excel --file file.xlsx [--wipe]`.

## Production-деплой

* **Backend** на VPS — `bash deploy/deploy.sh` (см. `deploy/deploy.sh`).
  Поднимает Postgres + Django (gunicorn) на 80 порту с авто-сгенерёнными
  паролем БД и `DJANGO_SECRET_KEY`. Жёлтый прод-стэк описан в
  `docker-compose.prod.yml`.
* **Frontend** на Vercel — `cd frontend && vercel --prod`. Конфиг
  `frontend/vercel.json` проксирует `/api/*` на backend по HTTP, чтобы
  браузер видел только HTTPS-вызовы к `*.vercel.app`. Базовый URL берётся
  из `frontend/.env.production` (`VITE_API_BASE_URL=/api`).

## Локальная разработка без Docker

```bash
# Backend
cd backend
uv venv --python 3.12
uv pip install -r pyproject.toml
.venv/bin/python manage.py migrate
.venv/bin/python manage.py seed_channels
.venv/bin/python manage.py seed_tac --builtin
.venv/bin/python manage.py seed_demo
.venv/bin/python manage.py runserver

# Frontend
cd ../frontend
npm install
npm run dev
```

## Команды Make

| Команда           | Что делает                                |
|-------------------|-------------------------------------------|
| `make up`         | поднять все контейнеры                    |
| `make down`       | остановить                                |
| `make migrate`    | миграции в `web`                          |
| `make seed`       | каналы + демо-продажи                     |
| `make seed-tac`   | обновить TAC-таблицу из встроенного датасета |
| `make test`       | pytest в backend                          |
| `make lint`       | ruff check + format                       |
| `make fresh`      | полный ресет БД и редеплой                |

## Обновление TAC-базы

Локальная таблица `TacLookup` — основной источник правды для `IMEI → бренд + модель`.
Подгрузка из файла:

```bash
docker compose exec web python manage.py seed_tac --file /path/to/tacdb.csv
# CSV-колонки: tac, brand, model, [device_type]
# либо JSON: [{"tac":"35676211","brand":"Apple","model":"iPhone 13"}, …]
```

Источники датасетов:
- [Osmocom TAC DB](https://tacdb.osmocom.org/)
- [MoazEb/tac-database (GitHub)](https://github.com/MoazEb/tac-database)

Встроенный seed (`--builtin`) содержит популярные iPhone/Samsung/Xiaomi/Pixel.

Опциональный онлайн-фолбэк (`IMEI_ONLINE_LOOKUP_ENABLED=1`) дёргает
ImeiCheck при промахе локальной таблицы и тихо откатывается к ручному
вводу при любых ошибках сети.

## Управление аккаунтами операторов (Этап B)

Менеджер (роль `manager`) выдаёт логины операторам прямо из UI:
`/operators` → колонка «Аккаунт» → «Создать логин».

- **Логин** = нормализованный номер телефона оператора (`+998XXXXXXXXX`).
  Login-endpoint принимает номер в любом формате — `+998…`, `998…` или
  `901234567` — и приводит к каноническому виду.
- **Пароль** можно ввести вручную (мин. 8 символов) или сгенерировать
  кнопкой Generate (`Naff-XXXXXX`, `secrets` RNG).
- **Двойное хранение.** Django-hash в `User.password` (источник правды
  для входа) + Fernet-зашифрованный plaintext в `OperatorSecret`
  (позволяет менеджеру посмотреть текущий пароль без сброса). Обе версии
  обновляются атомарно из `apps.users.services.user_password_set`.
- **Просмотр пароля.** Кнопка с ключом → API дёргает
  `GET /api/operators/{id}/account/password/` → пишется `AuditLog` с
  `changes.kind = "password_viewed"`, `user = actor`. Тимлид/владелец
  видят кто и когда смотрел пароли в разделе «Журнал».
- **Соло-смена пароля.** Оператор идёт в «Профиль» (шапка сайдбара),
  вводит текущий и новый — обе версии пароля обновляются,
  менеджер сразу видит новый в «Показать пароль».
- **Блокировка / удаление.** Блокировка = `is_active=False`. Удаление
  soft: аккаунт заблокирован, `Profile.deleted_at=now`, ciphertext стёрт
  (Django-hash сохраняется, чтобы аудит-запись имела корректный FK).

### Настройка Fernet-ключа

Ключ обязателен в prod (`ImproperlyConfigured` без него). В `DEBUG=1`
пустой ключ приводит к генерации эфемерного при старте — сохранённые под
таким ключом пароли протухают после каждого рестарта, это ок только для
локальной разработки.

Сгенерировать боевой ключ:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Положить в `.env`:

```env
OPERATOR_PASSWORD_ENCRYPTION_KEY=<строка выше>
```

> **Безопасность.** Пароли хранятся обратимо-зашифрованно. При одновременной
> компрометации БД и `.env` все пароли становятся читаемыми — держи Fernet-
> ключ вне пути бэкапа БД (отдельный секретный менеджер, отдельный volume,
> etc.). Плейн-пароль возвращается только из create / reset / view / self-
> change endpoint'ов и никогда не пишется в `AuditLog.changes`.

### API-сводка

| Метод   | Путь                                              | Кто        |
|---------|---------------------------------------------------|------------|
| POST    | `/api/operators/{id}/account/`                    | manager    |
| GET     | `/api/operators/{id}/account/password/`           | manager    |
| POST    | `/api/operators/{id}/account/reset-password/`     | manager    |
| POST    | `/api/operators/{id}/account/deactivate/`         | manager    |
| POST    | `/api/operators/{id}/account/activate/`           | manager    |
| DELETE  | `/api/operators/{id}/account/delete/`             | manager    |
| POST    | `/api/me/change-password/`                        | любой auth |
| POST    | `/api/auth/login/`                                | все        |

## Pre-sale (Этап A)

Контур «до продажи»: лид приходит из Google-формы (три листа с разным
форматом), система нормализует телефон, распределяет по оператору
(round-robin среди активных, пропуская тех, у кого есть просроченный
callback), и живёт в новом разделе «Мои лиды» (`/my`). Продажа делается
через кнопку «Продажа» на карточке лида — это оборачивает существующий
`sale_create` и линкует его к лиду через `Sale.lead FK`.

### Модель данных

- `apps.leads.models.Lead` — лид + идемпотентный ключ `(sheet_source, sheet_row_index)`.
- `apps.leads.models.LeadAssignment` — история назначений (round-robin / alias / ручное).
- `apps.leads.models.SheetSource` — конфиг per-worksheet: `spreadsheet_id`, `gid`, `column_map` jsonb, `default_status`.
- `apps.leads.models.OperatorSheetAlias` — `alias_name → operator FK`. Неизвестные alias'ы автоматически создаются с `operator=None`, тимлид биндит их в UI.
- `apps.leads.models.TelegramLink` — phone → username кэш (кнопка «Написать в TG»).
- `apps.calls.models.CallAttempt` — попытка звонка + исход.
- `apps.calls.models.CallbackReminder` — реминдер с supersede-семантикой (один активный на лид).

### Google Sheets integration setup

1. Создать service-account в GCP, скачать JSON-ключ, положить на VPS
   (например, в `/opt/naffAI/secrets/gsheets.json`).
2. В Google Sheets прошарить таблицу
   `140JC8hXXhI1VqBcsZK8yWvBZ05a4NOV7OiNKCz007W0` с ролью «Viewer» на
   e-mail service-account'а.
3. В `.env` прописать `GOOGLE_SHEETS_CREDENTIALS_JSON=/opt/naffAI/secrets/gsheets.json`.
4. Прогнать миграции и sim-сид:
   ```bash
   docker compose exec web python manage.py migrate
   docker compose exec web python manage.py bootstrap_lead_domain
   ```
   Это создаст три `SheetSource` (гид 2041870110, 523288785, 1712070933) и
   placeholder-alias'ы `Nihola / Sevara / Yasmina / Abdulaziz` — админ
   привязывает их к реальным операторам на странице `/sheet-sources`.
5. Одноразовый импорт архива Bitrix (лист 3):
   ```bash
   docker compose exec web python manage.py import_sheet3_archive
   ```
6. Регулярный sync — через cron раз в минуту (см. ниже).

### Cron (prod)

Добавь в `crontab -e` на VPS:

```
* * * * * cd /opt/naffAI && docker compose exec -T web python manage.py sync_sheets_leads >> /var/log/naff/sync.log 2>&1
* * * * * cd /opt/naffAI && docker compose exec -T web python manage.py check_due_callbacks >> /var/log/naff/callbacks.log 2>&1
```

Обе команды идемпотентны — safe re-run. `check_due_callbacks` помечает
просроченные (`remind_at + CALLBACK_OVERDUE_GRACE_MINUTES < now()`) и
рассылает DM операторам, у которых привязан TG-профиль (`/link_operator`
в боте).

### Пороги / политика

- `CALLBACK_OVERDUE_GRACE_MINUTES=30` (env, дефолт 30) — через сколько
  после `remind_at` реминдер становится `overdue`.
- Оператор с ≥1 `overdue` не получает новых лидов (`operator_is_blocked_by_overdue_callbacks`).
- Round-robin: активные операторы, отсортированы по количеству активных лидов ASC → выбирается наименее нагруженный. Ties — по `id` (стабильно).
- Нормализация телефона: все не-цифры выкидываются, берутся последние 9 цифр, префикс `+998`. Если после этого длина ≠ 13 — `phone_invalid=true`, лид отправляется в «Требуют проверки».
- Sale ↔ Lead: `Sale.lead` nullable FK. `lead_convert_to_sale` вызывает `sale_create` и переводит лид в `won`.

## Telegram-бот (фаза 5)

```bash
# 1. В .env заполнить TELEGRAM_BOT_TOKEN и TELEGRAM_GROUP_ID
# 2. Поднять профиль `bot`:
docker compose --profile bot up -d bot
```

Бот слушает группу/пересылки, парсит регулярками IMEI/модель/продавца,
создаёт `Sale` со статусом `pending`. В UI на странице «Продажи»
тимлид одним кликом подтверждает (`POST /api/sales/<id>/confirm/`)
или редактирует/удаляет.

**Оператор-режим (Этап A):**
Оператор пишет боту `/link_operator`, вводит свой номер (тот же, что в
карточке `Operator.phone`), бот сохраняет `Profile.telegram_user_id`.
После этого cron `check_due_callbacks` шлёт ему DM за минуту до
запланированного callback'а с inline-кнопками «✅ Сделано» и
«⏰ +15 мин» — обе роутятся в те же сервисы, что и веб-UI
(`callback_reminder_complete / _snooze`), audit trail единый.

## Telegram User Client & AI-Анализ (Этап B)

- **User Client (Telethon MTProto)**: модуль `apps.tg_userclient`. Приём сообщений 1-на-1 и групповых чатов операторов. Запуск: `python manage.py run_tg_userclient`.
- **Backfill истории чатов**: Автоматическая фоновая подгрузка истории личных и групповых чатов при авторизации оператора. Настройки в `.env`: `TG_BACKFILL_SINCE=2026-07-01`, `TG_BACKFILL_CHAT_DELAY_MS=800`, `TG_BACKFILL_MAX_MESSAGES_PER_CHAT=10000`. Ручной перезапуск: `python manage.py retry_tg_backfill --all-errors`.
- **AI Provider (Google Gemini)**: AI-анализ диалогов (`apps.tg_userclient.ai.provider.GeminiProvider`). Настройки в `.env`: `LLM_PROVIDER=gemini`, `GEMINI_API_KEY=...`, `GEMINI_MODEL=gemini-3.6-flash`, `GEMINI_FALLBACK_MODEL=gemini-2.5-flash-lite`. Автоматический fallback на `gemini-2.5-flash-lite` при исчерпании квоты (429). Запуск анализа: `python manage.py analyze_tg_dialogs`.

### Telegram User-Client в prod

Фоновый процессор `run_tg_userclient` работает как systemd-сервис на VPS:

```bash
# Статус сервиса
systemctl status naff-tg-userclient

# Перезапуск сервиса
systemctl restart naff-tg-userclient

# Просмотр логов
journalctl -u naff-tg-userclient -f
# или
tail -f /var/log/naffAI/tg-userclient.log
```

### Ошибки в проде — Sentry (SaaS free tier)

Для отслеживания необработанных исключений в продакшене поддерживается интеграция с [Sentry](https://sentry.io/signup/):

1. Зарегистрируйтесь на [sentry.io](https://sentry.io/signup/) и создайте проект Django.
2. Скопируйте DSN и добавьте в `.env`:
   ```
   SENTRY_DSN=https://your-dsn-key@o0.ingest.sentry.io/0
   ```
3. При запуске под `config.settings.prod` ошибки будут автоматически отправляться в Sentry без передачи персональных данных (PII).

## ПРИНЯТЫЕ ДОПУЩЕНИЯ

> Эти решения приняты автономно, потому что они не были чётко зафиксированы в ТЗ.
> Все настраиваются — это дефолты, а не хардкод.

1. **Формула премии:** глобальное правило `percent` со ставкой **3% от суммы продаж выше порога 50 000 000 сум/месяц**. Альтернативы (`fixed` фиксированный бонус, `tiers` прогрессивная шкала) поддержаны движком и редактируются через `/api/payroll/rules/` и в `PayrollRule` Django-admin.
2. **Стажёры считаются в общем котле**, но в UI/Excel помечены бейджем «стажёр», а в payroll параметр `include_trainees=0` позволяет исключить их одним кликом.
3. **Возвраты** не учитываются ни в премиях, ни в дашбордах/лидерборде. Сама продажа остаётся в БД, видна в журнале и в экспорте отдельной колонкой. Это согласуется с тем, что тимлид не должен платить за откатанные сделки.
4. **Подарки внутри продажи** не уменьшают сумму, на которую начисляется премия (тимлид договорился с операторами, что бонус считается по «грязной» сумме оплаты клиента). `cost` подарка используется только для будущего отчёта по марже.
5. **Дубликат IMEI** — по умолчанию блокируется. Override требует поля `allow_duplicate_imei=true` + непустого `duplicate_override_comment`. Комментарий уходит в `AuditLog`.
6. **Soft-delete** для операторов и продаж: данные остаются в БД, для аналитики фильтруются.
7. **Аудит пишется явно из services**, не через signals (HackSoft: явность важнее магии).
8. **Деньги:** `Decimal(14, 2)`. Никогда не float.
9. **TAC-источник:** локальная таблица + встроенный seed (`apps/catalog/management/commands/seed_tac.py`). Полный публичный датасет грузится из CSV/JSON.
10. **Авторизация:** Django session + DRF TokenAuth. Регистрации нет, аккаунты заводит тимлид через `/admin/`. Пароли по `DJANGO_PASSWORD_VALIDATORS` (мин. 8 символов).
11. **i18n:** UI на русском, ключи готовы для добавления узбекского (но узбекский ещё не подключён — отложено в Phase 2).

## Что отложено

- Узбекская локализация UI (i18n-структура есть, нужны только переводы).
- Тёмная тема (Tailwind `darkMode: 'class'` уже настроен).
- Интеграция с 1С/бухгалтерией (по ТЗ out-of-scope — Excel-экспорта достаточно).
- Более продвинутые отчёты по марже (нужна себестоимость каждой модели).
- Notifier бота: дневные/месячные digest'ы тимлиду, alert'ы при пересечении порога (легко добавить, не было приоритетом).
- **Этап B (pre-sale):** AI-скоринг лидов, funnel-аналитика (конверсия по этапам), WebSocket-нотификации вместо polling'а, эскалация неотвеченных лидов после N попыток.

## Качество

```bash
make test    # pytest: validators / payout / sale create / bot parser
make lint    # ruff
```

15 тестов, все зелёные:
- `apps/common/tests/test_validators.py` — IMEI Luhn (4 теста)
- `apps/payroll/tests/test_payout.py` — fixed/percent/tiers/under-threshold (4 теста)
- `apps/sales/tests/test_sale_create.py` — happy path / invalid IMEI / duplicate gate / override (4 теста)
- `apps/tg_bot/tests/test_parser.py` — regex-парсер (3 теста)

## Лицензия

Internal use only.
