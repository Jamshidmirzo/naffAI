# naffAI

Внутренняя система учёта продаж и управления операторами колл-центра
телефонного магазина. Заменяет ручной подсчёт «IMEI + модель + кто продал»
из группового чата.

> **Live:** фронт — https://naffcrm.vercel.app · API — за Cloudflare Tunnel на DigitalOcean droplet.
> Логин по умолчанию: `dostik / tostik`.

## Что нового

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
