# naffAI — Design Handoff v3 (Full)

**Дата:** 2026-08-11
**Prod:** https://naff.flek.uz
**Референс (legacy 21.07 UI):** https://naffcrm.vercel.app (сейчас на свежем bundle)
**Цель:** редизайн UI под реальные пользовательские сценарии. Операторы не понимают текущий UX — нужна оптимизация плотности, иерархии, флоу.

> Читать вместе с `docs/ui-spec-for-designer.md` (функциональная спека) и `docs/FEATURES_FOR_DESIGNER.md` (что реально работает в V2). Этот файл — их дополнение с акцентом на **UX-проблемы + рекомендации + полный контекст**.

---

## 1. Что за проект

Внутренняя CRM для call-центра **магазина телефонов в Ташкенте** (Узбекистан).

**Как работает бизнес:**
1. Клиенты оставляют заявки в Google-таблицах, Instagram, Telegram, у таргетологов. Всё это стекается в БД как **лиды** (Lead).
2. Утром в 10:00 система раздаёт лиды между активными **операторами** (морнинг-сплит, round-robin).
3. Оператор обзванивает лидов, отмечает исход (не ответил, callback, написали в TG, купит, не купит).
4. Когда лид сконвертирован — оператор создаёт **продажу** (Sale) с IMEI, моделью, комиссиями.
5. Менеджер видит KPI, аналитику, посещаемость операторов, считает **payroll** по порогам + %.

**Ключевые пользователи:**
- **Оператор** (call-center сотрудник) — работает в поле, часто с мобильного, быстро. Ему важна **скорость** и **очевидные действия**.
- **Менеджер / team_lead** (владелец, руководитель) — сидит за десктопом, много данных, аналитика. Ему важна **плотность инфы** + удобные фильтры + экспорты.

**Языки:** русский + узбекский (пользователь переключает в header). Узбекский обычно короче на 15-20%. Тема: dark/light.

---

## 2. Роли и что каждая видит

### Оператор (`operator`)
Landing: `/my` (Мои лиды). Sidebar-меню (5-6 пунктов):
- **Мои лиды** (`/my`) — главный экран.
- **Сканер** (`/scan`) — QR для чекина на смену.
- **Урок дня** (`/lessons/today`) + **История уроков** (`/lessons/history`).
- **Уведомления** (`/notifications`).
- **Профиль** (`/profile`).

### Менеджер (`manager` / `team_lead`)
Landing: `/` (Dashboard). Sidebar — 6 групп, ~25 пунктов:

| Группа | Экраны |
|---|---|
| **Обзор** | Dashboard `/`, Продажи `/sales`, Продажи сегодня `/sales-today` |
| **Лиды** | Реестр `/leads`, Orphans `/leads/orphans`, Статистика `/leads-stats`, Статусы `/statuses` |
| **Analytics** | `/analytics`, Отчёты `/reports` |
| **Команда** | Операторы `/operators` → `/operators/:id`, Пользователи `/users`, Партнёры `/partners`, Зарплата `/payroll` |
| **Посещаемость** | Сегодня `/attendance/today`, Отчёт `/attendance/report` |
| **Каталоги + AI** | Google Sheets `/sheet-sources`, AI-Chat `/ai-chat`, Маркетинг `/marketing`, TG-очередь `/tg-queue`, Аудит `/audit`, Настройки `/settings` |

Есть третья роль `team_lead` — в коде почти = `manager`. В UI навигации сейчас пропущена (по memory: `team_lead` должна быть скрыта, только `manager` + `operator`).

**Публичные экраны (без sidebar):**
- `/login` — вход. Menedzher по логину/паролю, оператор — по телефону +998 или тому же логину/паролю.
- `/screen` — большое табло операторов, для монитора в офисе (leaderboard + лента продаж + прогресс к плану).

---

## 3. Ключевые user journeys (что делают за день)

### 3.1 Оператор — «отработать лид»
1. Приходит утром → **/scan** → сканирует свой QR → чекин зафиксирован (`attendance/scan/`).
2. Открывает **/my** → видит список активных лидов (сегодняшних + carry-over из вчера + recall-after-lunch).
3. Кликает лид → карточка с телефоном, именем, продуктом, историей звонков.
4. Звонит клиенту. По результату — выбирает **outcome** (крупная плитка, не мелкая кнопка):
   - «Callback» → назначает время → лид уходит в `callback_scheduled`, создаётся `CallbackReminder`.
   - «Написали в TG» → `contacted_telegram` (carry-over на завтра).
   - «Не ответил» → `no_answer` (recall-after-lunch: неактивен до 13:00, потом всплывает).
   - «Дорого» / «Есть долг» / «Нет карты» → соответствующие custom-статусы.
   - «Купит» → `dokonga_keladi` (придёт в магазин).
   - «Не тот номер» → `notogri_raqam`.
   - «Отказ / потерян» → `lost`.
   - **«Продано»** → редирект на **/sales/new?lead=<id>** — форма создания продажи с автозаполненными name+phone.
5. На /sales/new заполняет IMEI, модель (autofill по TAC), комиссии операторов/партнёров, сохраняет → лид флипается в `won`.

### 3.2 Менеджер — «утро»
1. Логин → **/** (Dashboard) → KPI за день/месяц, топ-операторы, лента продаж, 3D-график.
2. **/attendance/today** → кто на смене, кто опоздал, кто отсутствует.
3. **/leads?tab=needs_review** → чинит лиды которых система не смогла назначить (алиас неизвестен).
4. **/leads/orphans** → распределяет вручную сиротские лиды между операторами.

### 3.3 Менеджер — «конец месяца»
1. **/payroll?month=X** → пересматривает начисления, инициирует выплаты.
2. **/analytics** → топ-модели, воронка, конверсия по каналам, heatmap звонков.
3. **/reports** → экспорт Excel (продажи / посещаемость / зарплата / лиды).

---

## 4. Домен и статусы — критично для UX

### 4.1 Lead — жизненный цикл

Один лид = одна заявка на телефон. Живёт в одной из 3 «плоскостей»:
- **Активен** («Faol» вкладка) — оператор ещё должен работать. Показывается на /my.
- **Отложен** («Kechiktirilgan») — оператор нажал «postpone» с причиной, до какой-то даты.
- **Закрыт** («Yopilgan») — терминальный статус (won/lost/archived/needs_review), только для истории.

**Статусы (chip-фильтры в /my):**

| Uzbek chip | Русский | Code | Флаги | UX-семантика |
|---|---|---|---|---|
| Yangi | Новый | `new` | untouched | Только что раздан оператору, ещё не звонил |
| Tayinlangan | Назначен | `assigned` | untouched | Оператор подобран, ещё не работал |
| Callback | Callback | `callback_scheduled` | **carry-over** | Оператор назначил перезвон, лид всплывёт завтра |
| TGga bog'landi | Написал в Telegram | `contacted_telegram` | **carry-over** | Клиент ответил в TG, оператор ведёт диалог там |
| Javob bermadi 1 | Не ответил (1-й раз) | `no_answer` | **recall-after-lunch** | Утром неактивен, после 13:00 всплывает наверх |
| Javob bermadi 2 | Не ответил (2-й раз) | `no_answer_2` | **carry-over** | Второй раз не ответил, продолжаем звонить |
| Telfoni ochiq | Телефон открыт | `phone_on` | **recall-after-lunch** | Гудки шли — попробуем позже |
| Qarzi bor | Есть долг | `has_debt` | active | Клиент просит подождать зарплаты |
| Qimmatlik qildi | Дорого | `qimmatlik_qildi` | active | Отказ по цене, можно предложить другой аппарат |
| X Kartsi Yo'q | Нет карты (рассрочка) | `kartsi_yoq` | active | Не проходит для рассрочки |
| Limit chiqmadi | Лимит не дали | (custom) | active | Банк отказал в рассрочке |
| Do'konga keladi | Придёт в магазин | `dokonga_keladi` | **carry-over** | Договорились — придёт сам |
| Harid Qildi | Купил | `harid_qildi` | active | Пометка что купил, но продажа ещё не оформлена |
| Shunchaki Qiziqdi | Просто интересовался | `shunchaki_qiziqdi` | active | Не готов покупать |
| Notogri raqam | Неверный номер | `notogri_raqam` | active | Не тот человек / нерабочий номер |
| Yo'qotildi | Потерян | `lost` | **terminal** | Финальный отказ |
| SMS jonatildi | SMS отправлено | `sms_jonatildi` | active | Отправили доп-инфо в SMS |
| Tekshirish kerak | Требует проверки | `needs_review` | **terminal** | Менеджер должен разобраться (неизвестный alias) |
| Won | Продажа | `won` | **terminal** | Конвертировался в Sale |

**Флаги** (`LeadStatusLabel`):
- `is_terminal` → лид «закрыт», не считается в квоте оператора, попадает в вкладку «Yopilgan».
- `carry_over_next_day` → завтра снова активен, приоритет выше fresh-лидов.
- `recall_after_lunch` → неактивен утром, после 13:00 (лунч Ташкента) всплывает наверх /my.
- `blocks_new_leads` → пока не закрыл лид с этим флагом — оператор не получает новые.

### 4.2 Sale — модель продажи

Одна Sale = один IMEI (телефон), проданный клиенту. Ключевые особенности:
- **Multi-operator commission split** — один Sale может быть на N операторов, каждый со своей абсолютной суммой (SaleOperator M2M).
- **Multi-partner allocation** — тот же Sale может быть распределён на N партнёров (SalePartner M2M) — каналов оплаты (наличка/карта Uzcard/рассрочка Alif/Payme/Zoodpay).
- **Скидка (discount)** — уменьшает **операторскую** часть пропорционально, партнёрскую НЕ меняет.
- **Возврат (`is_returned=True`)** — вычитается из payroll оператора.
- **Дубликат IMEI** — один IMEI дважды нельзя без `allow_duplicate_imei=True` + `duplicate_override_comment`.
- **Bonus note** — свободный текст «за что бонус» (для мотивации).
- **Sale.lead FK (nullable)** — если оператор нашёл лид по phone-search → связан. Backend автоматом флипает лид в WON (если не был terminal).

### 4.3 Operator, Attendance, Payroll — коротко

- **Operator**: `active` / `trainee` / `inactive`. Trainee не участвует в round-robin. Inactive не показывается на leaderboard.
- **Attendance**: чекин через QR (`/scan` on-mobile), проверка late (порог 15 мин от shift_start). AttendanceLog хранит `checked_in_at` + `checked_out_at`.
- **Payroll**: считается месячно. `PayrollRule` = threshold + payout_type (`fixed`/`percent`/`tiers`). Возвраты вычитаются.

### 4.4 CallbackReminder — gating

- Оператор назначил callback → `CallbackReminder{status=pending, remind_at=…}`.
- В `remind_at` система DM'ит в @naffai_bot оператору.
- Если оператор не выполнил → status = `overdue` → **блокирует раздачу новых лидов** этому оператору до разрешения.
- UX: красный banner на /my «У вас просрочен callback: {name}, {time}».

---

## 5. UX-проблемы прямо сейчас (список из жалоб + анализа кода)

### 5.1 Общие
1. **Плотность/иерархия страдает** — часть форм (SaleCreate до недавнего рефакторинга) использовала легаси-CSS `.card/.label/.input` которого нет в новой Phase 1 системе → лейблы налипали на инпуты. Может встречаться на других страницах (`Users.tsx`, `Partners.tsx`, `LeadStatuses.tsx` — проверить).
2. **Двойная система дизайн-токенов** — старые (`--bg`, `--surface`, `--text`, `--accent`) сосуществуют с Phase 1 (`--bg-page`, `--text-primary`, `--accent-pale-bg` и т.д.). Компоненты юзают разные наборы → визуальная несогласованность.
3. **Chip-фильтры в /my** — сейчас все 19 статусов вываливаются в одну длинную строку с horizontal scroll. **Не помещается на телефон**, оператор путается.
4. **role=team_lead** видна в некоторых местах UI (nav, RoleGate) — по бизнес-требованиям её не должно быть. Memory: только `manager` + `operator`.
5. **Placeholder-страницы** (`/calls`, `/catalog`, `/stickers`) — заглушки в меню, кликаешь — пустая страница. Убрать или спрятать за флагом.
6. **AI-chat** (`/ai-chat`) — заглушка, backend не подключён. То же самое.

### 5.2 Оператор (`/my`) — самый критичный экран
1. **Слишком много статус-чипов** — 19 штук в горизонтальном скролле. Оператор в потоке не помнит какой куда. Нужно **сгруппировать**: «Свежие» (new/assigned), «В работе» (callback/TG/phone_on/no_answer), «Спорные» (has_debt/qimmatlik/kartsi_yoq/limit), «Позитив» (dokonga_keladi/harid_qildi), «Закрытые» (won/lost).
2. **Три вкладки Faol/Kechiktirilgan/Yopilgan** — хороший паттерн, но:
   - «Барчаси» (Все) в чипах = не всегда очевидно что это ВСЕ, а не «все активные».
   - Счётчики чипов и счётчики вкладок могут расходиться (chip=225, tab=65) — оператор в шоке.
3. **Outcome-tiles** (крупные плитки с решениями) — уже неплохо на десктопе, но на мобильном 2×2 сетка. Можно попробовать carousel или long-press-menu.
4. **Carry-over лиды визуально не отличаются** от fresh — оператор не понимает почему у него завтра снова тот же лид. Нужен badge «Вчера: Callback 15:00» на карточке.
5. **Callback просрочен** — сейчас красный banner сверху, но не блокирует UI. Оператор может проигнорить и не понять почему новые лиды не приходят. Нужен modal-блокер или очень явный сигнал.

### 5.3 Форма создания продажи (`/sales/new`)
1. **Только что рефакторили** — теперь на nf-* токенах, шапка с eyebrow, tabular-nums, badge для найденного лида. Но:
2. **Секции operators/partners** — линейный список, каждая строка = combobox + сумма-input + trash. При 3+ операторах становится длинно, теряется контекст «зачем эта сумма».
3. **Скидка** — идёт после итогов, оператор её не видит пока не проскроллит. Логично либо поднять выше, либо inline с итогом.
4. **IMEI + модель autofill** — TAC lookup работает, но пока идёт запрос — поле «Модель» пустое → визуально «глюк». Нужен spinner или skeleton.
5. **Bonus note** — checkbox + textarea. Занимает много места, редко используется. Свернуть в expandable «+ Bonus».
6. **Duplicate IMEI** — только warning inline. Может быть modal с чётким «Точно продать второй раз?».
7. **Client phone → lead search dropdown** — недавно добавили, работает. Но UX не всегда очевиден: dropdown появляется от 4 цифр, если оператор ввёл номер вслепую (не через dropdown) и лид ЕСТЬ — он не привязывается. Может быть toast «Найден лид {name} — привязать?».

### 5.4 Sales список / Dashboard
1. **Sales таблица** — ширкая, много колонок (IMEI, модель, оператор, партнёр, сумма, скидка, дата, статус, действия). На мобильном горизонтальный скролл — плохо. Нужна mobile-версия карточками.
2. **Filters panel** — collapsable, но чипсы для активных фильтров под кнопкой не видно если панель свёрнута. Нужен summary «3 фильтра активны».
3. **Dashboard 3D-график (BarsScene)** — красиво, но на слабых устройствах тормозит. Нужен fallback на flat-chart.
4. **KPI-карточки** — count-up анимация с задержкой ~1 сек. Оператор ждёт цифру. Возможно ускорить или показать сразу.

### 5.5 Analytics / Payroll / Reports
1. **Analytics** — много таблиц, все в одном скролле. Нет sticky-header, при скролле теряется контекст (какая колонка что значит).
2. **Payroll** — таблица с 8 колонками. Тоже теряется контекст. Нужны sticky-header + возможно горизонтальный scroll с pinned первой колонкой (имя).
3. **Reports** — сейчас 4-5 карточек с описаниями и кнопкой «Скачать». Скучно и не информативно. Можно показать превью данных / график.

### 5.6 Мобильный опыт
- Оператор часто с мобильного (Android). Layout не адаптирован под 375px width местами.
- Sidebar сворачивается в burger? Проверить — сейчас может занимать весь экран.
- QR-scan на `/scan` использует камеру — работает, но UI кнопок мелкий.

---

## 6. Приоритеты редизайна (что важнее)

**P0 — критические (без этого операторы уходят):**
1. Redesign `/my` — упростить чип-фильтры (группировка), сделать понятные вкладки Faol/Kechiktirilgan/Yopilgan, добавить badge для carry-over.
2. Mobile-first версия `/my` и `/scan` (оператор на телефоне 80% времени).
3. Убрать плейсхолдеры и role=team_lead из nav (косметика на 2 часа).

**P1 — высокие (менеджер злится):**
1. Sales list mobile version (карточки вместо таблицы <768px).
2. Analytics — sticky header + улучшенная плотность таблиц.
3. Payroll — pinned столбец «Оператор», подсветка бонусов/штрафов.

**P2 — nice-to-have:**
1. Dashboard — refine 3D-график (или заменить на 2D flat), добавить skeleton при загрузке.
2. Reports — превью данных перед экспортом.
3. Форма Sale — вертикальная компоновка секций operators/partners в accordion.

**P3 — тех-долг для дизайнера:**
1. Полностью выпилить старые CSS-классы (`.card`, `.label`, `.input`, `.btn-*`) — оставить только `nf-*`.
2. Свести две системы токенов (legacy + Phase 1) в одну.
3. Определить финальную типографику + шкалу spacing (сейчас смешанно `text-[13.5px]`, `text-[15px]` и Tailwind-default).

---

## 7. Технический стек и ограничения дизайнера

**Frontend:**
- React 18 + Vite + TypeScript.
- **Tailwind CSS** — utility-first, но использовать **сначала `nf-*` классы** (`nf-card`, `nf-btn`, `nf-input`, `nf-col`, `nf-tile`, `nf-chip`, `nf-tabs`, `nf-badge`, `nf-toggle`, `nf-check`), потом Tailwind для точечных отступов.
- **Кастомные UI-примитивы** в `frontend/src/components/ui/`: `Button`, `Chip`, `TabPill`, `StatusBadge`, `Modal`, `Card`, `Eyebrow`, `Input`, `NumericInput`, `PhoneInput`, `Toggle`, `Checkbox`, `Toast`.
- **Иконки:** `lucide-react` (только оттуда, не Font Awesome / SVG-inline).
- **3D:** three.js + @react-three/fiber (BarsScene, GaugeScene) — используется на Dashboard/Login. Дорогое.
- **Charts:** `recharts` (line/bar/pie).
- **State:** zustand + react-query.
- **Routing:** react-router v6.
- **Шрифт:** Golos Text (загружается self-hosted).

**Design tokens (актуальные, Phase 1):**

Light mode:
- Backgrounds: `--bg-page: #EFEEEB`, `--bg-surface: #FBFAF8`, `--bg-card: #FFFFFF`, `--bg-nested: #F6F4F0`.
- Text: `--text-primary: #17150F`, `--text-secondary: #4A453D`, `--text-muted: #6E685E`, `--text-label: #8C867C`.
- Border: `--border-main: #E7E3DC`, `--border-btn: #D9D4CB`, `--border-row: #F1EFEA`.
- Accent (оранжевый): `--accent: #E4571B`, `--accent-hover: #C0430F`, `--accent-shadow: rgba(228,87,27,0.28)`.
- Pale accent: `--accent-pale-bg: #FFF4EC`, `--accent-pale-border: #FBDCC6`, `--accent-pale-text: #7A4519`.
- Success/Danger/Info — с собственными bg/text/border.

Dark mode: те же переменные, но инвертированные (fon темнеет, текст светлеет). Переключение через `data-nf="dark"` на `<html>`.

**Radii:**
- Card: 22px
- Tile: 16px
- Button/chip: 99px (pill)
- Input: 14px
- Badge: 20px

**Shadow:** `--shadow: 0 8px 24px -12px rgba(...)` (subtle).

**Motion:** cubic-bezier(0.2, 0.7, 0.2, 1) — «nf-ease» — 200-320ms.

**Существующие CSS-паттерны, которые дизайнер может переиспользовать:**
- `.nf-outcome` — большая плитка с иконкой + label + hint для outcome-выбора на /my (уже неплоха).
- `.nf-fade-up` — анимация появления карточек.
- `.nf-pulse-ring` — pulse для активных элементов.
- `.nf-scroll-thin` — тонкий scrollbar 6px.

---

## 8. Терминология (важно не путать!)

**Uzbek ↔ Русский ↔ English (кодовое):**

| UZ (что видит оператор) | RU (что видит manager) | Code |
|---|---|---|
| Yangi sotuv | Новая продажа | `sale_create` |
| Yangi lid | Новый лид | `lead_new` |
| Mijoz | Клиент | `client` |
| Sotuv | Продажа | `sale` |
| Lid | Лид | `lead` |
| Operator | Оператор | `operator` |
| Menejer | Менеджер | `manager` |
| Hamkor | Партнёр (канал оплаты) | `partner` / `channel` |
| Chegirma | Скидка | `discount` |
| Bonus | Бонус | `bonus` |
| Faol | Активный | `active` |
| Kechiktirilgan | Отложенный | `postponed` |
| Yopilgan | Закрытый | `closed` / `terminal` |
| Barchasi | Все | `all` |
| Qo'ng'iroq | Звонок | `call` |
| Callback / Qayta qo'ng'iroq | Перезвон | `callback` |
| Ish smenasi | Смена | `shift` / `attendance` |
| Kelib qoldi | Опоздал | `late` |
| Maosh | Зарплата | `payroll` / `salary` |

**Специфика узбекского:**
- Апострофы важны: `To'lov` (оплата), `Bog'landi` (связался). Не `To'lov` через backtick.
- Оператор часто пишет с ошибками (typo в client_name/phone) — форма должна прощать.

---

## 9. Что дизайнер должен получить на выходе

**Минимум:**
1. **Redesigned `/my`** (Figma flow) — desktop + mobile, все 3 вкладки, чипы сгруппированы, LeadCard с carry-over badge.
2. **Redesigned `/sales/new`** — компактная, mobile-friendly, с dropdown найденного лида.
3. **Redesigned `/sales` list** — desktop table + mobile cards.
4. **Redesigned `/`** (Dashboard) — KPI, график, лента продаж, топ-операторы.

**Nice:**
5. Analytics + Payroll refresh.
6. Компонент-library в Figma (Button variants, Chip states, Card layouts, TabPill, Modal).
7. Иллюстрации для empty-states («Нет лидов сегодня», «Все callback выполнены»).

**Формат:** Figma-файл с прототипом (interactive flow), готовые токены (цвет / шрифт / spacing) как Figma variables — чтобы фронтенд легко перенёс в CSS-переменные.

---

## 10. Ссылки на код для reference

**Router:** `frontend/src/App.tsx`
**Design tokens:** `frontend/src/index.css` (строки 1-96 legacy, 350-570 component layer `.nf-*`)
**Все страницы:** `frontend/src/pages/*.tsx` (33 файла)
**UI-примитивы:** `frontend/src/components/ui/*.tsx`
**Layout:** `frontend/src/components/layout/{AppShell, Sidebar, Header}.tsx`
**Dashboard-виджеты:** `frontend/src/components/dashboard/*.tsx`
**3D:** `frontend/src/components/three/{BarsScene, GaugeScene}.tsx`
**i18n:** `frontend/src/lib/i18n.ts` (~2500 строк ru+uz)
**Lead helpers + status labels + badge colors:** `frontend/src/lib/leads.ts`

**Backend (для понимания домена):**
- Lead + status labels: `backend/apps/leads/models.py` (line 24-138 для enum, line 271+ для модели)
- Sale + multi-allocation: `backend/apps/sales/models.py`
- Operator: `backend/apps/operators/models.py`
- CallbackReminder: `backend/apps/calls/models.py`
- Attendance: `backend/apps/attendance/models.py`
- Payroll: `backend/apps/payroll/models.py`

**Существующие спеки (не переписывать, дополнять):**
- `docs/ui-spec-for-designer.md` — исчерпывающий функциональный обзор (445 строк).
- `docs/FEATURES_FOR_DESIGNER.md` — что реально работает в V2 prod.
- `docs/wave3-frontend-ux-spec.md` — предыдущий UX-редизайн (Wave 3).

---

## 11. Вопросы к пользователю (для клиента)

Прежде чем дизайнер начнёт, желательно уточнить:

1. **Приоритет мобильного** — % операторов работающих с телефона vs десктопа? (влияет на mobile-first vs desktop-first).
2. **Тёмная тема** — оператор пользуется? Если да, дизайн должен работать в обеих.
3. **Брендинг** — оранжевый accent (`#E4571B`) — окончательный или можно менять?
4. **Emoji vs иконки** — сейчас на статусах много emoji (🎁 bonus, ✓ linked). Оставить или заменить на lucide-иконки?
5. **Количество лидов у оператора в день** — 20, 50, 100? (влияет на плотность LeadCard).
6. **Callback критичность** — блокировать UI при overdue или только warning?

---

## Changelog handoff-документа

- **v3 (2026-08-11)** — этот файл. Добавлены UX-проблемы, приоритеты, terminology, актуальные Phase 1 tokens.
- **v2** — `docs/FEATURES_FOR_DESIGNER.md` (что работает в prod).
- **v1** — `docs/ui-spec-for-designer.md` (функциональный обзор всех экранов).
