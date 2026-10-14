# naffAI frontend content inventory

Pages are in `/Users/user/Desktop/mp/ai/naff/frontend/src/pages/`, routes in `/Users/user/Desktop/mp/ai/naff/frontend/src/App.tsx`. Labels were resolved from `lib/i18n.ts` and page literals; block order inside long pages (Profile, OperatorDetail) is approximate.

Role legend:
- **M** = `RoleGate allow=["manager"]`: manager, team_lead, superadmin (bypasses every gate) and super_manager (auto-added).
- **O** = operator.
- **Any** = any logged-in user.
- **+PIN** = wrapped in `PinGate` ("Введите PIN", 4 digits, "Войти").

## 1. Sales

**/sales — Sales.tsx (M)**. All sales and returns ("Продажи" / "Все продажи и возвраты").
- Filters: search "Поиск по IMEI, модели, оператору…"; chips Все / Продажи / Возвраты / Подарки.
- "Фильтры" panel: presets Сегодня / Вчера / 7 дней / Этот месяц / Прошлый месяц; Дата от; Дата до; Партнёры; Операторы; Источник ("Все источники"); Сбросить.
- Block "Сводка за период": "N продаж · …", "Кто сколько продал" and "Что продавали" (each row "N шт · сумма").
- Columns: Время | Оператор (+N) | Источник | Канал | Модель | IMEI | Сумма | Статус (возврат / ожидает / оплачено).
- Actions: Excel, "Новая продажа", row click opens detail; footer "На странице:", "1–20 из N", Назад / Вперёд.

**/sales/:id — SaleDetail.tsx (Any; action buttons manager-level only)**. Header "Продажа #id".
- Hero: "ПРОДАЖА #ID", model, IMEI + "Копировать", badge возврат / удалена / ожидает / оплачено.
- Tiles: Сумма | Канал (or "Оплата по каналам" when split) | Оператор | Клиент | Дата | Подарки.
- Sections: Оплата по каналам, "Сплит:", Комментарий, Бонус / особые условия, Источник лида, Договор (photos), red banner "Продажа отклонена. Причина:".
- Cards: "AI-анализ" (mock; tags Чек / Скорость / Оператор / Рекомендация; "Заново") and "История изменений".
- Buttons, pending: Одобрить / Исправить и одобрить / Отклонить. Otherwise: Редактировать / Оформить возврат / Удалить.
- Modals: "Отклонить продажу" (Причина), "Оформить возврат" (Причина возврата), "Удалить продажу?".

**/sales/new, /sales/:id/edit — SaleCreate.tsx (M)**. "Новая продажа" / "Редактировать продажу". Fields in order:
- IMEI (15 цифр), with hint "→ модель".
- Модель (autocomplete).
- Кол-во, шт.
- Имя клиента.
- Телефон клиента (chip "Привязан к лиду · статус", "Убрать"; warning if the client is not among leads).
- Операторы: rows of name + Сумма, "добавить", "мин 1 000".
- Партнёры: same row layout.
- Totals: Сумма по операторам / Сумма по партнёрам / Итого продажи / Скидка / Итог (с учётом скидки).
- Скидка (необязательно).
- Комментарий.
- Checkbox "Был бонус или особые условия" + text.
- Duplicate-IMEI confirm: "Причина (замена, обмен, ошибка ранее…)".
- Buttons: Отмена / Сохранить (Сохранить изменения).

**/sales/pending — SalesPending.tsx (M)**. "Ожидают подтверждения" / "Продажи, отправленные операторами".
- Two-column card grid: checkbox, contract photo (+N), Модель, Сумма, IMEI + copy, "Оператор · Канал", client name and phone.
- Actions: "Выбрать все" / "Сбросить"; sticky bar "{n} выбрано", Одобрить все, Отклонить все, Сбросить.
- Modal "Отклонить N продаж" with "Причина отклонения". Empty: "Нет продаж на подтверждении".

**/sales-today — SalesToday.tsx (M; not in sidebar)**. "Продажи сегодня".
- Hero: "С 09:00", sum, "{n} продаж", "средний чек", "{n} возврат".
- KPI: Штук | Средний чек | Операторов | К плану дня.
- Table "Что продали сегодня": Время | Модель / оператор | Канал | Сумма.
- "Разрез по каналам" (Доля в выручке за сегодня); "AI-анализ дня" (mock: Итог / Драйвер / Внимание; "Заново").

## 2. Leads (manager)

**/leads — Leads.tsx (M)**. "Лиды" / "Управление воронкой и назначением".
- Filters: source chips ("Все источники" + one per sheet); search "Поиск: имя, телефон, товар…"; chips Все лиды / Нужна проверка / Без оператора.
- Counters: "Выбрано: n", "Всего: N", "{n} просрочено".
- Columns: ☐ | Лид | Источник | Оператор | Статус | Звонки | Колбэк.
- Actions: Выделить все, Назначить оператора, Снять выбор. Modal: Оператор, Причина (необязательно), Назначить.

**/leads/orphans — OrphanLeads.tsx (M)**. "Свободные лиды" / "Пул без оператора — раздайте вручную".
- Blocks: "Всего сирот"; "По источникам" chips.
- Panel "Статус распределения": ВКЛ/ВЫКЛ, RR_BATCH_SIZE, button "Раздать все N сейчас поровну"; table Оператор | Работает | Отложено | Статус | Почему (badges ок / квота / gate / выключен).
- Columns: ☐ | Лид | Источник | Статус | Товар | Создан.
- Actions: Выбрать все, Раздать поровну, Назначить оператору…, Снять выбор.

**/leads/system-lost — SystemLostLeads.tsx (superadmin only, `SuperadminGate`)**. "Системно потерянные".
- Blocks: Всего; По причинам; Топ операторов (до увольнения).
- Filters: "Все причины", "За последние N дней".
- Columns: Лид | Оператор до | Статус до | Причина | Закрыт | Комментарий | "Восстановить".

**/leads-stats — LeadsStats.tsx (M)**. "Статистика лидов".
- Period: Сегодня / Вчера / 7 дней / 30 дней / Этот месяц / Свой диапазон.
- Buttons: "Retry статусы" (panel "Статусы для retry-export'a", status chips, "Сохранить выбор"), "Сформировать retry-лист".
- Blocks: "Всего лидов за период"; "По статусам" (bars); "Динамика по дням" (Пришло / Продано / Потеряно).
- Table "По операторам": Оператор | Всего | Звонков | Обзвонил лидов | Продажи (через лид) | Продажи (всего) | В работе | Потеряно | Конверсия.

**/statuses — LeadStatuses.tsx (M)**. "Статусы лидов".
- Columns: Emoji | Название (RU) | UZ | Цвет | Чип | Кнопка | Активен | Действия; badge "блокер".
- Form: Название (RU), Название (UZ), Code, Emoji, Цвет badge (нейтральный / синий / оранжевый / зелёный / красный), Порядок, "Показывать в чипах", "Кнопка «Отметить»", Активен, "Блокирует получение новых лидов".
- Actions: "Добавить статус", edit, Удалить.

**/sheet-sources — SheetSources.tsx (M)**. "Google-Sheets". Tabs: Листы | Alias'ы операторов.
- Листы: "Всего листов: n", "Добавить из ссылки" (wizard), "Добавить лист", "Активные источники" (health cards).
- Columns: Название | Spreadsheet | gid | Default op | Mode | Последняя строка | Действия; badges "off", "Пул: n", "🔥 ТЕЗ · n мин".
- Form: Название, Дефолтный статус, Spreadsheet ID, gid, Название листа (опц.), Column map (JSON), Default оператор, Distribution mode, "Активен (участвует в sync)", Пул операторов, "🔥 Горячий шит (ТЕЗ)" + "SLA, минут", "Обратная запись" (Статус / Оператор / Время / Коммент).
- Alias tab: Привязано / Непривязанных / Всего alias'ов; columns Alias (как в листе) | Оператор; "Новый alias".

## 3. Operator secondary

**/my/activity — MyActivity.tsx (O; not in sidebar)**. "Моя активность".
- Period presets as on /leads-stats.
- KPI: Лидов | Звонков.
- "Мои продажи" ("Всего: n · моя доля: X сум") list; "По статусам".

**/my/sales — MySales.tsx (O)**. "Мои продажи" / "Все лиды, ставшие продажами".
- KPI: Всего продаж | Моя доля (сум).
- "Список": Дата | Модель / Клиент | Канал | Сумма (own share; "всего: X" when split). Row opens /sales/:id.

**/my/payroll** — see "Payroll gate" below.

**/my/day-off — MyDayOff.tsx (O)**. "Мои заявки на выходной".
- "Новая заявка": Дата, Причина, "Отправить заявку".
- "История заявок": date, reason, "Решение: …", badge На рассмотрении / Одобрен / Отклонён.

**/profile — Profile.tsx (Any)**. "Профиль" / "Настройки аккаунта". Blocks:
- Header: avatar, name, role (Оператор / Менеджер / Супер-менеджер), sticker.
- Shift card "QR check-in": СМЕНА ИДЁТ / СМЕНА ЗАКРЫТА, "Пришёл в", "⚠ ОПОЗДАНИЕ", "Начать смену" / "Завершить смену".
- "Аватар": Загрузить файл, Сделать с камеры.
- "Мои данные": Дата рождения.
- "Настройки": Тема (Светлая / Тёмная), Язык (Русский / O‘zbekcha), Ежедневный разбор (toggle), Мой стикер, Пароль ("Сбросить" → Текущий пароль, Новый пароль, Повторите новый пароль).
- "Подключить Telegram": подключено, history progress, Отключить / Переподключить.
- "Уведомления в Telegram": "Получить код для привязки", Привязано, Отвязать.

**/notifications — Notifications.tsx (Any)**. "Уведомления".
- Counter "{unread} новых · всего {total}", "Прочитать всё", notification list.
- "Подписки" toggles: Новые лиды / Колбэки со звуком / Уроки и разборы / Ежедневный отчёт по KPI.

**/scan and /kiosk — Scan.tsx (public, same component)**.
- Poster: "Распечатайте свой QR и наклейте на бейдж", QR, "Ссылка:", Скачать PNG, Перерисовать, "Войти по паролю".
- Selfie flow (ScanPhotoFlow.tsx, apparently when `?qr=` is present): "ПРИХОД НА СМЕНУ" / "ЗАВЕРШЕНИЕ СМЕНЫ", "Сделайте селфи для отметки прихода/ухода", "Открыть камеру".
- Result: "СМЕНА НАЧАТА" / "СМЕНА ЗАВЕРШЕНА", "Приход в" / "Уход в", "Отработано:", "⚠ Опоздание", Готово.

**/calculator — Calculator.tsx (M + O)**. "Калькулятор рассрочки".
- Fields: Товар (поиск по бренду/модели), Ariza miqdori, Oldindan to'lov, Ariza narxi. These three labels are Uzbek even in the RU dictionary.
- Per-tier cards: "N мес", "в месяц", Ariza narxi, Комиссия, Итого к выплате. Button "Копировать расчёт".

**/leaderboard — Leaderboard.tsx (M + O)**. "Табло" / "Рейтинг операторов по продажам".
- Period: Сегодня / Неделя / Месяц / Всё время.
- KPI: Операторов | Продаж | Общая сумма.
- "Топ-5" cards (name, "Вы", "стажёр", "N продаж", sum); "Остальные": Оператор | Сумма.

## 4. Attendance and payroll

**/attendance/today — AttendanceToday.tsx (M +PIN)**. "Посещаемость" / "Кто на смене сейчас".
- Banner "QR-код для отметки на входе" (Открыть киоск, Открыть экран /scan).
- KPI: На смене сейчас | Опоздали (Более чем на 15 мин) | Не пришли (Не отметились).
- Controls: Дата, Обновить, "Обновлено в".
- "Сейчас на смене": photo, name, "Пришёл", "Длит.", badge "на смене", "Закрыть".
- "Уже ушли": in/out photos and times, "Длит.", "23:00 авто", "⚠ Опоздание".
- "Не пришли". Modal "Закрыть смену" (Комментарий).

**/attendance/report — AttendanceReport.tsx (M +PIN)**. "Посещаемость — отчёт".
- Filters: date range, Операторы. Action: "Экспорт в Excel".
- Columns: Оператор | Явился / Ожид. | Опоздал | Авто-закрыто | Ручное закр. | Ср. смена | Итого часов.

**/attendance/photos — AttendancePhotos.tsx (route M +PIN; nav item superadmin only)**. "Фото сотрудников".
- Filters: Сегодня / Вчера, С даты, По дату, Оператор ("Все операторы"), Сбросить.
- Photo cards: Приход, Уход, Длительность, Опоздание.

**/attendance/payroll — PayrollReport.tsx (M +PIN)**. "Зарплата".
- Filters: Месяц, Операторы.
- Columns: Оператор | План | Продано | Att. (flag + %) | Sales (flag + %) | К выплате.
- Row drilldown: "График: from–to · grace N мин", Excel, PDF, "К выплате … из max", Attendance block, Продажи block, "По дням".
- "Личный порог продаж" (личный / глобальный; "Изменить" → Порог, Тип выплаты: Процент от суммы сверх порога / Фиксированный бонус / Прогрессивные тиры; "Сбросить к глобальному").

**/attendance/kiosk — AttendanceKiosk.tsx (M +PIN)**. "Киоск отметок".
- Flow: "Выберите оператора" → "Отметка прихода" / "Отметка ухода" → "Через камеру ноутбука" (Открыть камеру) or "Через QR-код" (Показать QR-код).
- Result: "Приход зафиксирован" / "Уход зафиксирован", "Готов принять следующего". Buttons: Сменить оператора, Сбросить.

**/payroll — Payroll.tsx (M; legacy sales-bonus page, removed from nav)**. "Зарплата" / "Начисления операторам по месяцам".
- Month select.
- Columns: Оператор (badges стажёр / порог достигнут) | Продажи ("N шт · сумма") | Прогресс к порогу ("из X") | Премия.

**/operators/day-off — DayOffRequests.tsx (M)**. "Заявки на выходной".
- "Ожидают решения" cards; expanded: Последний выходной ("никогда"), Других в этот день, Продажи · 7 дней, Лиды · звонки (7д).
- Комментарий менеджера; Отклонить / Одобрить.

**/settings/attendance — AttendanceSettings.tsx (M +PIN)**. "Настройки посещаемости".
- "График работы": Начало смены, Конец смены, Выходной день недели (Пн–Вс), Авто-закрытие смены.
- "Штрафы и гейт": Grace-период (минут), Штраф за опоздание (UZS), Прощённых пропусков в неделю, Гейт посещаемости (%).
- "Бонус attendance по умолчанию": Бонус attendance (UZS).
- "Продажи и планы": Бонус за продажи (UZS), Гейт продаж (%), План продаж по умолчанию (UZS/мес).
- "Обязательная отметка": Обязательная отметка при входе, Порог «пора закрыть смену» (часов). Button: Сохранить.

## 5. Admin and journal

**/users — Users.tsx (M)**. "Пользователи".
- Search; "Добавить менеджера".
- Columns: Логин (avatar, name, phone/login, "это вы") | Роль (Менеджер / Тим-лид / Супер-менеджер / Оператор) | Язык | Создан | Последний вход | Действия (edit role, "Пароль", Деактивировать).
- Modal "Новый менеджер": Логин, Роль, Подчинён. One-time modal "Готово · сохраните пароль": Логин / Пароль + Копировать.

**/audit — Audit.tsx (M)**. "Аудит" / "Журнал изменений".
- Search "Поиск: кто / что / когда…"; chips "Все объекты" + entity names.
- Columns: Когда | Кто | Действие | Объект | Изменения.

**/calls — Calls.tsx (M)**. "Звонки" / "Все попытки звонков операторов".
- Filters: Сегодня / Вчера / 7 дней / 30 дней / Этот месяц; Операторы; chips Все / Разговор / Нет ответа / Отказ / Прочее / Без результата.
- KPI: Всего звонков | Средняя длительность | С записью | Ответили.
- Columns: Дата и время | Оператор | Лид | Длительность | Результат | Запись.
- Result badges: Разговор, интерес / Перезвонить / Не берёт / Не тот номер / Отказ / Без результата.
- "Загрузить ещё". Modal "Детали звонка": Оператор, Лид, Начало, Окончание, Длительность, Результат, Комментарий, Запись ("Скоро").

**/partners — Partners.tsx (M)**. "Партнёры" / "Каналы продаж".
- "Всего: n", "Добавить".
- Columns: Название | Статус (активен / выключен) | Действие (Выключить / Включить).
- Modal "Новый партнёр": Название.

**/tg-queue — TgQueue.tsx (M)**. "Очередь Telegram".
- KPI: Активны | Подключаются | Загружаем | Не подключены | Ошибок | Всего сообщений.
- Columns: Оператор | TG-сессия | Backfill | Чаты | Сообщ. | AI | Действия (Retry, Подключить).
- TG-сессия values: активна / ждёт код / ждёт 2FA / истёкла / отозвана / ошибка / не подключён.
- Backfill values: в очереди / загружаем / готово / ошибка.

**/bot — BotConfig.tsx (M)**. "Telegram-бот". Tabs: Отчёты | Чаты | Аудит.
- Отчёты: "Новый отчёт", "Из шаблона"; cards with schedule, "получателей", "Последняя отправка", Отправить сейчас, Редактировать, Удалить.
- Editor: Название, Расписание, Язык, Период данных, Куда отправить, Блоки данных, Включен, "Живой предпросмотр", "Отправить тестово".
- Чаты: Тип | Название | Пользователь | Язык | Статус.
- Аудит: Время | Chat | Пользователь | Команда | Итог.

**/bot-subscribers — BotSubscribers.tsx (M)**. "Подписчики бота".
- Columns: Чат | Телефон | Кто это (Оператор / Менеджер) | Язык | Слушает бот (toggle) | Последняя активность; badges Заблокирован / Отписан.

**/team/deleted-operators — DeletedOperators.tsx (super_manager and superadmin only)**. "Удалённые операторы".
- KPI: Всего удалений | Их продаж (90 дн) | Сумма продаж | Без причины.
- Search "Поиск: имя, телефон, кто удалил, причина…".
- Columns: Оператор | Телефон | Когда удалён | Кем удалён | Причина | Продажи | Сумма | Восстановлено.
- Expanded: "Удалил {by} · {at}", Устроен, "Что затронул delete": Продаж soft-deleted / Продаж shrunk (доля вычтена) / Лидов отвязано / Звонков отвязано.

**/operators/:id — OperatorDetail.tsx (M)**.
- Header: name, status (Активен / Стажёр / Неактивен), "В системе с", phones (рабочий / личный); buttons Редактировать, Назначить стикер, QR для входа, Telegram.
- Tabs: День / Неделя / Месяц.
- KPI: "Сумма · период" (N продаж) | Средний чек | "План · месяц" (actual из target; изменить / задать) | "Зарплата · этот месяц".
- "Учётная запись оператора": Логин, Показать пароль, Сгенерировать новый пароль, Деактивировать / Активировать, Удалить учётку / Создать учётку.
- "Язык интерфейса и AI"; "Продажи по дням" (chart); "Посещаемость · 30 дней"; "TG-диалоги с клиентами".
- "По моделям": Модель | Кол-во | Сумма. "По партнёрам": Партнёр | Кол-во | Сумма.
- "История смен": Дата | Пришёл | Ушёл | Длит. | Опозд. | Канал | Статус | Действия.
- "Обучение · последние 7 разборов": Дата | Фокус дня | Резюме | Прочит.
- Edit modal: Имя оператора, Дата приёма, Статус, Заметка, Блокировка по спец-лидам, Live-эфир, Владелец (менеджер).

## 6. Catalog and settings

**/catalog — Catalog.tsx (M + O)**. "Каталог телефонов".
- Search "Поиск по бренду или модели"; "Новый телефон".
- Cards: cover, model, price "сум", "Рассрочка" ("N мес", "сум/мес"); copy buttons Текст / Фото / Marketing; Редактировать, Скрыть от операторов / Показать операторам, delete.
- Editor "Карточка телефона" (`components/PhoneEditor.tsx`): Бренд, Модель, Память GB, RAM GB, Наличие, Цена (сум), Обложка, Цвета, Описание, Показывать операторам.

**/catalog/banks — CatalogBanks.tsx (M; not in sidebar)**. "Банки рассрочки".
- "Добавить банк" (name, emoji); per-bank plans: Срок (мес) | Множитель | Переплата; Удалить.

**/catalog/marketing-settings — MarketingSettingsPage.tsx (M)**. "Настройки маркетинга".
- Fields: Слоган по умолчанию, Телефон основной, Телефон второй (необязательно), Telegram, Адрес, Преимущества (one per line). Button: Сохранить.

**/catalog/tiers — InstallmentTiersPage.tsx (M)**. "Тарифы рассрочки".
- Columns: Месяцы | Комиссия, % | Активен | В marketing-тексте | Порядок | delete.
- "Добавить тариф": Месяцы, Комиссия %.

**/settings — Settings.tsx (M)**. "Настройки" / "Глобальные тумблеры и правила системы".
- Toggle cards: "Авто-распределение лидов", "Блокировка при спец-лидах".
- "PIN для «Посещаемости»": Установить PIN / Сменить PIN / Сбросить PIN (code comments indicate superadmin only).

**/stickers** — `Placeholder`: "Скоро появится / Экран «Стикеры» в разработке — вернитесь позже." (M)

**/marketing — Marketing.tsx (M)**. "Маркетинг". Buttons: "Обновить AI-анализ", Excel. Tabs: Обзор | Источники | Паттерны | Динамика | AI-советы | Затраты.
- Обзор KPI: Лиды | Конверсии | Конверсия | Выручка | Средний чек | Расход рекламы | CAC.
- Source table: Источник | Лиды | Продажи | Конв. | Выручка | Ср. чек | Δ pp.
- Паттерны: "Часовой паттерн" heatmap.
- Динамика: "Лиды по источникам", "Конверсия по источникам" (Текущий vs Пред. период); "Когорты по неделям": Неделя | Лиды | Прод. 7д | % 7д | Прод. 30д | % 30д.
- AI-советы: Резюме периода, Рекомендации (Уверенность, Обоснование, "Отметить как выполненное"), Вопросы к владельцу.
- Затраты: "Добавить расход" (Период, source, Сумма, Заметка), "История расходов".

**/marketing/sources — MarketingSources.tsx (M)**. "Аналитика источников".
- Month picker. KPI: Источников | Лидов | Продаж | Оборот.
- Table: Источник (Sheet / Bot / Ручной / Другое) | Лиды | Продажи | Конв. | Оборот | Ср. чек | Купили | Спрашивали (badge "дефицит").
- "Разбор источника" ("Смотреть продажи").
- "Что искали vs что купили": Модель | Спрос | Продано | Конв. | Статус (не хватает / избыток / в норме).

## 7. Learning

**/lessons/today — DailyLesson.tsx (Any)**. "Урок на сегодня" / "AI-разбор вчерашнего дня".
- Blocks: Фокус дня; "AI-РАЗБОР · ВЧЕРА" (Диалогов | Продаж | Конверсия); Ключевой инсайт; Что сработало; Что мешало; Сегодня по шагам / План на сегодня.
- Feedback "Помог ли разбор?" (Помог / Не помог → "Что было не так?"); link "История разборов →".

**/lessons/history — LessonsHistory.tsx (Any)**. "История разборов".
- "{n} разборов", "Сегодняшний разбор"; list with badge "не прочитан".
- Detail: Фокус дня, Продаж | Диалогов | Качество, Ключевой инсайт, Что сработало, Что мешало, Сегодня по шагам, Что подтянуть.

**/training — TrainingList.tsx (Any)**. "Обучение". Cards: title, Пройдено / Не пройдено, Видео, Файл, "Вопросов: n".

**/training/:id — TrainingLessonView.tsx (Any)**. Video ("Открыть видео в новой вкладке"), "Файл прикреплён" (Скачать), "Тест" ("Отправить ответы", "Результат n%"), "Комментарии".

**/training/manage — TrainingManage.tsx (M)**. "Всего уроков: n", "Новый урок".
- Columns: Название | Медиа | Вопросов | Попыток | Статус (Активен / Скрыт) | Действия (Статистика, Редактировать, Скрыть / Показать, Удалить).

**/training/manage/new and /:id — TrainingLessonForm.tsx (M)**. Tabs: Урок | Статистика.
- "Основное": Название, Описание, Ссылка на видео, Файл (PDF/PPTX/DOCX до 15 МБ), Показывать операторам.
- "Добавить тест": Текст вопроса, Вариант ответа (one correct), Добавить вариант, Добавить вопрос.
- Статистика: Попыток | Средний балл | По вопросам ("{n}% ошибок").

## 8. Other

**/analytics — Analytics.tsx (M)**. Month picker. Blocks:
- "Аналитика по команде".
- "Воронка команды" (Лиды → Дозвоны → … → Продажи).
- "Каналы продаж" (Доля в выручке).
- "По источникам лидов (таргетологи)": Источник | Лидов | Продаж | Конверсия | Выручка.
- "Топ операторов" (По выручке).
- "Топ моделей": Модель | Кол-во | Сумма.
- "Тепловая карта callback-активности" (hours × operators, 30 дней).

**/reports — Reports.tsx (M)**. "Отчёты" / "Готовые выгрузки по разделам".
- Period: Сегодня / Неделя / Месяц / Свой период.
- Six cards (Excel / Открыть): Продажи, Посещаемость, Зарплата, Лиды, Активность операторов, Аналитика по каналам.
- "Последние выгрузки": Файл | Размер | Когда; "Очистить".

**/ai-chat — AIChat.tsx (M)**. "AI-ассистент".
- Session list ("Сессия #id", "Новая сессия"), "Модель" select ("Авто (chain)").
- Empty state "О чём хотите узнать?" with chips Продажи за неделю / Топ-3 оператора / Разрез по каналам / Просроченные колбэки; input "Спросить у ассистента…".

**/live/wall — LiveWall.tsx (M)**. "Live-эфир операторов".
- Status "Подключено к LiveKit · В эфире: N"; global toggle "Live-эфир ВКЛЮЧЁН / ВЫКЛЮЧЕН"; video tile grid; enlarged tile (Звук, Закрыть).
- Empty: "Сейчас никто не в эфире."

**/live/archive — LiveArchive.tsx (M)**. "Архив live-эфира".
- Filters: Оператор ("Все"), С даты, По дату, "Сбросить фильтр".
- Columns: Оператор | Начало | Длительность | Размер | Действия ("Смотреть"). Player "Запись #id".

**/login — Login.tsx (public)**. "naffAI", "Вход в систему", "Учёт продаж и управление операторами". Fields: Логин (operator hint "Оператор — номер в формате …"), Пароль; "Войти"; "Забыли пароль?".

**/screen — Screen.tsx (Any; outside AppShell)**. "Табло продаж · сегодня", "обновление каждые N сек", "Выйти". Shows top-5 operators from the month leaderboard: name, "N шт", sum in "млн". Empty: "Пока нет данных за месяц".

## Sidebar navigation

Built in `/Users/user/Desktop/mp/ai/naff/frontend/src/components/layout/AppShell.tsx`.

**Operator** (one untitled group):
1. Мои лиды — /my
2. Уведомления — /notifications
3. Табло — /leaderboard
4. Каталог — /catalog
5. Калькулятор — /calculator
6. Уроки — сегодня — /lessons/today
7. Уроки — история — /lessons/history
8. Обучение — /training
9. Моя зарплата — /my/payroll
10. Мои продажи — /my/sales
11. Запросить выходной — /my/day-off
12. Профиль — /profile

**Manager / team_lead**:
- (untitled): Дашборд /; Продажи /sales; Ожидают подтверждения /sales/pending; Звонки /calls; Лиды /leads; Свободные лиды /leads/orphans.
- **Аналитика**: Аналитика /analytics; Табло /leaderboard; Статистика лидов /leads-stats; Отчёты /reports; TV-экран /screen (external).
- **Посещаемость**: Сегодня /attendance/today; Киоск check-in /attendance/kiosk; Отчёт /attendance/report; Live-эфир /live/wall; Архив live /live/archive.
- **Команда**: Операторы /operators; Заявки на выходной /operators/day-off; Зарплата /attendance/payroll; Настройки посещаемости /settings/attendance; Уроки /lessons/today; Обучение /training; Управление обучением /training/manage; Пользователи /users; Стикеры /stickers.
- **Справочники**: Каталог /catalog; Калькулятор /calculator; Тарифы рассрочки /catalog/tiers; Marketing-настройки /catalog/marketing-settings; Партнёры /partners; Google-шиты (источники лидов) /sheet-sources; Статусы лидов /statuses.
- **AI & Telegram**: AI-чат /ai-chat; Очередь Telegram /tg-queue; Бот и рассылки /bot; Подписчики бота /bot-subscribers; Маркетинг /marketing; Аналитика источников /marketing/sources.
- (untitled): Аудит /audit; Настройки /settings.

**Super_manager** gets these groups first, followed by the full manager nav above:
- (untitled): Моя команда — продажи /team/sales; Ожидают подтверждения /sales/pending; Мои операторы /team/operators; Мои менеджеры /team/managers; Удалённые операторы /team/deleted-operators.
- **Аналитика**: Аналитика /analytics; Табло /leaderboard.
- (untitled): Уроки — сегодня /lessons/today; Профиль /profile.

The comment in `useSuperManagerGroups` says "pure branch nav", but the code concatenates `[...superManagerGroups, ...managerGroups]` for both super_manager and superadmin. So "Аналитика" appears twice as a group title, and /sales/pending, /analytics, /leaderboard and /lessons/today are duplicated.

**Superadmin**: same as super_manager, plus "Фото сотрудников" /attendance/photos (after Отчёт in Посещаемость) and "Системно потерянные" /leads/system-lost (between Аудит and Настройки).

## Lead statuses, sale statuses, payment channels

**Seeded lead statuses** (`/Users/user/Desktop/mp/ai/naff/backend/apps/leads/migrations/0007_seed_builtin_statuses.py`, plus 0010 and 0015), in sort order:

| Code | Emoji | Tone | RU | UZ |
|---|---|---|---|---|
| new | 📋 | info | Новый | Yangi |
| assigned | 👤 | info | Назначен | Tayinlangan |
| in_progress | 💬 | hot | В работе | Ishda |
| callback_scheduled | ⏰ | info | Callback | Callback |
| contacted_telegram | 💬 | info | TG'га боғланди | TGga bog'landi |
| qimmatlik_qildi | 💸 | hot | Показалось дорого | Qimmatlik qildi |
| no_answer | 📵 | neutral | Javob bermadi 1 | Javob bermadi 1 |
| no_answer_2 | ⚠️ | hot | Javob bermadi 2 | Javob bermadi 2 |
| phone_on | 📞 | info | Telfoni ochiq | Telfoni ochiq |
| has_debt | 💸 | danger | Qarzi bor | Qarzi bor |
| won | 💰 | success | Продажа | Sotildi |
| lost | ✖️ | danger | Потерян | Yo'qotildi |
| sms_jonatildi | 💬 | neutral | SMS отправлен | SMS jonatildi |
| archived | 📦 | neutral | Архив | Arxiv |
| needs_review | 🚩 | hot | Требует проверки | Tekshirish kerak |

**Manager-created codes** are not seeded, so they have no emoji or tone in the repo. RU/UZ labels exist only in `/Users/user/Desktop/mp/ai/naff/backend/apps/tg_bot/management/commands/send_3h_leaderboard.py`:
- kartsi_yoq: Нет карты / Kartasi yo'q
- shunchaki_qiziqdi: Просто интересовался / Shunchaki qiziqdi
- notogri_raqam: Неверный номер / Noto'g'ri raqam
- boshqa_madel_soradi: Спросил другую модель / Boshqa model so'radi
- boshqa_joydan_xarid_qilgan: Купил в другом месте / Boshqa joydan xarid qilgan
- ishonchdan_olgan: Взял в Ishonch / Ishonchdan olgan
- waiting_salary: Ждёт зарплаты / Oyliguni kutyapti
- dokonga_keladi: Придёт в магазин / Do'konga keladi
- soaragan_telefoniga_limit_yetmadi: Лимит не хватил / So'ragan telefoniga limit yetmadi
- harid_qildi: Купил / Xarid qildi

**Status behaviour** (later migrations):
- Terminal: won, lost, archived, needs_review, plus the dead-ends boshqa_joydan_xarid_qilgan, notogri_raqam, ishonchdan_olgan, shunchaki_qiziqdi.
- Blocks new leads ("блокер"): no_answer, no_answer_2, phone_on, dokonga_keladi, callback_scheduled.

**Sale statuses** (`backend/apps/sales/models.py`): pending "На подтверждении", confirmed "Подтверждена", rejected "Отклонена". UI badges are: ожидает (hot), оплачено (neutral), возврат (danger, from `is_returned`), удалена (from `is_deleted`).

**Payment channels**: "Партнёры" on /partners are `catalog.Channel` rows, edited at runtime.
- Seed command `seed_channels.py`: Alif, Uzum, WhatsApp, Walk-in, Phone-call (Telegram and Instagram deactivated).
- Excel importer canon adds Birzum, Hamroh, TBC, Cash.
- Anor appears in code comments only; the UI placeholder is "Alif / Uzum / Hamroh / TBC / Cash…".

## Payroll gate on /my/payroll

MyPayroll.tsx (O). "Моя зарплата" / "Расчёт по посещаемости — оклад минус вычеты за пропуски и опоздания."

1. **Toolbar**: "Месяц" (month input, capped at the current month); Excel; PDF.
2. **Hero "К выплате"**: month name, `total_earned` in large type, "из {max_possible}". If `both_gates_passed === false`, a warning shows: "⚠ Оба гейта должны быть пройдены. Даже если один блок закрыт — оплата 0 UZS, пока не пройдёшь второй."
3. **Two gate cards**, green border when passed and red when failed, each with a badge "Гейт пройден" / "Гейт провален":
   - **"Attendance"**: earned amount; "Бонус за attendance: {attendance_bonus_uzs}"; "{rate}% / {gate}%"; "{attended} из {planned} дней"; progress bar with a threshold tick at the gate %. If passed with lates: "Опозданий: {n} (−{amount})". If failed: "Нужно посетить ещё {n} дн., чтобы пройти гейт".
   - **"Продажи"**: earned amount; "Бонус за продажи: {sales_bonus_uzs}"; "{rate}% / {gate}%"; "{actual} из {plan}"; same bar. If failed: "До гейта осталось продать на {amount}".
4. **Collapsible "По дням"**: per day an icon and status, date with weekday, optional note, "HH:MM → HH:MM", and deduction "−сумма". Statuses: ✓ Вовремя, ⏰ Опоздание, ✕ Пропуск, ○ Выходной, ◐ Прощённый пропуск.

Logic is an AND-gate: total = attendance block + sales block, but 0 unless both gates pass. Gate percentages, bonuses and plan come from the API and are configured on /settings/attendance, where the hints give a default of 1 500 000 for each bonus. No gate percentage default is shown in the UI; 85% appears only in a code comment.