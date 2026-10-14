# Маршрут → артборды нового дизайна

Артборды: docs/design-atlas/artboards/<Name>.dc.html, скриншоты: docs/design-atlas/shots/<Name>.png (локально, не в git).


## Вход и общие экраны

| Маршрут | Кому | Экран | Артборды | Заметка |
|---|---|---|---|---|
| `/login` | все | Вход | OpLogin | Оператор по номеру, менеджер по логину. «Забыли пароль?» ведёт к подсказке, а не в никуда |
| `/` | все | Главная по роли | OpMy · MgDashboard · SmDashboard | Оператор → фокус-режим, менеджер → пульт зала, супер → пульт ветки; состояния — MgPultStates, утро — MgMorning |
| `/scan` | публичный | QR-отметка с телефона | OpScan | Узкая веб-страница: селфи → «Отметка принята» |
| `/kiosk` | публичный | Киоск отметок | MgKiosk | Отдельный экран киоска вместо копии /scan |
| `/screen` | все | ТВ-табло | MgScreen | Тёмное табло, данные за сегодня; «Выйти» действительно выходит |

## Оператор

| Маршрут | Кому | Экран | Артборды | Заметка |
|---|---|---|---|---|
| `/my` | оператор | Мои лиды | OpMy · OpMyList · OpMyBlocked · OpMyEmpty | Фокус / Список, блокировка, всё закрыто; окна — OpSheetOutcome, OpSheetCallback |
| `/my/sale-new` | оператор | Новая продажа | OpSale | Принимает ?lead=; ошибки — OpSheetSale |
| `/my/sales` | оператор | Мои продажи | OpSales | Статус продажи виден: ждёт / подтверждена / отклонена |
| `/my/activity` | оператор | Активность | OpSales | Вкладка «Активность» в «Мои продажи» — раньше на неё не было ссылки |
| `/my/payroll` | оператор | Моя зарплата | OpPayroll | Два порога, день в часовом поясе Ташкента |
| `/my/day-off` | оператор | Выходной | OpDayOff | Заявку можно отменить |
| `/sales/:id` | оператор | Моя продажа | OpSaleDetail | Тот же роут, вид оператора: причина отклонения и «Исправить и отправить» |
| `/profile` | все | Профиль | OpProfile · MgProfile · SmProfile | У каждой роли свой; окна оператора — OpSheetProfile |
| `/notifications` | все | Уведомления | OpNotif · MgNotif · SmNotif | Подписки сохраняются на сервере; у менеджеров «Одобрить» прямо в ленте |
| `/lessons/today` | все | Урок дня | OpLessons | Окна — OpSheetLearn |
| `/lessons/history` | все | История разборов | OpLessonsHistory | own |
| `/training` | все | Курсы | OpTraining | own |
| `/training/:id` | все | Урок курса | OpTrainingLesson | Тест, результат с правильными ответами, «Пройти заново» |
| `/leaderboard` | оператор, менеджер | Табло | OpBoard · MgBoard | Свой вид у оператора и у менеджера |
| `/calculator` | оператор, менеджер | Калькулятор рассрочки | OpCalc · MgCalc | Проверка «взнос больше суммы»; у менеджера цена заявки и комиссия |
| `/catalog` | оператор, менеджер | Каталог телефонов | OpCatalog · MgCatalog | Оператор копирует тексты, менеджер редактирует |

## Продажи

| Маршрут | Кому | Экран | Артборды | Заметка |
|---|---|---|---|---|
| `/sales` | менеджер | Продажи | MgSales | Бейдж «отклонена» вместо «оплачено» |
| `/sales/:id` | менеджер | Продажа | MgSaleDetail | Панели действий по статусу; окна — MgSheetSale |
| `/sales/new` | менеджер | Новая продажа | MgSaleFormNew | Поиск лида по телефону, распознавание IMEI; ошибки — MgSheetSaleForm |
| `/sales/:id/edit` | менеджер | Исправить продажу | MgSaleForm | «Исправить и одобрить» сохраняет и одобряет |
| `/sales/pending` | менеджер | Подтверждение продаж | MgPending | «Одобрить все» с подтверждением |
| `/sales-today` | менеджер | Продажи сегодня | MgSalesToday | Без фальшивого «AI-анализа дня» |

## Лиды

| Маршрут | Кому | Экран | Артборды | Заметка |
|---|---|---|---|---|
| `/leads` | менеджер | Все лиды | MgLeadsAll | Клик по строке открывает лид, выбор — чекбоксом |
| `/leads/orphans` | менеджер | Без оператора | MgLeads | «Раздать поровну» с подтверждением; окна — MgSheetLeads |
| `/leads/system-lost` | superadmin | Системно потерянные | MgSystemLost | Восстановление через окно, не window.confirm |
| `/leads-stats` | менеджер | Статистика лидов | MgLeadsStats | own |
| `/statuses` | менеджер | Статусы лидов | MgSettings | Окна — MgSheetStatuses |
| `/sheet-sources` | менеджер | Google-таблицы | MgSheets · MgSheetsForm | Форма листа и псевдонимы; мастер и диагностика — MgSheetSources |

## Команда

| Маршрут | Кому | Экран | Артборды | Заметка |
|---|---|---|---|---|
| `/operators` | менеджер | Операторы | MgOperators | Окна — MgSheetOp1, MgSheetOp2, MgOperatorsDiag |
| `/operators/:id` | менеджер | Карточка оператора | MgOperatorDetail · MgOperatorDetail2 | Кнопка «Telegram» работает; опасные действия с подтверждением |
| `/operators/day-off` | менеджер | Заявки на выходной | MgDayOff | Кнопки решения видны даже при ошибке контекста |
| `/users` | менеджер | Пользователи | MgUsers | Окна — MgSheetUsers |
| `/calls` | менеджер | Звонки | MgCalls | own |
| `/audit` | менеджер | Журнал изменений | MgJournal | Действия и поля по-русски, не JSON |

## Смена и деньги (PIN)

| Маршрут | Кому | Экран | Артборды | Заметка |
|---|---|---|---|---|
| `/attendance/today` | менеджер | Смена сегодня | MgAttendance | PIN — MgSheetPin |
| `/attendance/report` | менеджер | Отчёт посещаемости | MgAttReport | own |
| `/attendance/photos` | менеджер | Фото сотрудников | MgAttPhotos | own |
| `/attendance/kiosk` | менеджер | Киоск отметок | MgKiosk | Тот же экран, что /kiosk |
| `/attendance/payroll` | менеджер | Зарплата | MgPayroll | Разбор по оператору — MgSheetPayroll |
| `/settings/attendance` | менеджер | Настройки смены и зарплаты | MgAttSettings | Бонус посещаемости сохраняется |
| `/payroll` | менеджер | Старая зарплата | → /attendance/payroll | Две страницы «Зарплата» сливаются в одну |

## Аналитика и эфир

| Маршрут | Кому | Экран | Артборды | Заметка |
|---|---|---|---|---|
| `/analytics` | менеджер | Аналитика | MgAnalytics | own |
| `/marketing` | менеджер | Маркетинг | MgMarketing · MgMarketing2 · MgMarketingSource | 6 вкладок: обзор, источники, паттерны, динамика, AI-советы, затраты |
| `/marketing/sources` | менеджер | Аналитика источников | MgSources | Спрос и покупки по источникам |
| `/reports` | менеджер | Отчёты | MgReports | «Свой период» с выбором дат |
| `/ai-chat` | менеджер | AI-ассистент | MgAIChat | own |
| `/live/wall` | менеджер | Эфир | MgLive | Выключение для всех с подтверждением — MgSheetTrainingLive |
| `/live/archive` | менеджер | Архив эфиров | MgLiveArchive | own |

## Настройки и каталог

| Маршрут | Кому | Экран | Артборды | Заметка |
|---|---|---|---|---|
| `/settings` | менеджер | Настройки | MgSettingsGeneral | Автораздача, блокировка, PIN |
| `/partners` | менеджер | Партнёры (способы оплаты) | MgPartners | own |
| `/catalog/tiers` | менеджер | Тарифы рассрочки | MgCatalogMore | Блок «Тарифы» |
| `/catalog/banks` | менеджер | Банки | MgCatalogMore | Блок «Банки»; в старом меню ссылки не было — теперь есть |
| `/catalog/marketing-settings` | менеджер | Тексты для маркетинга | MgCatalogMore | Блок «Тексты» |
| `/bot` | менеджер | Бот и рассылки | MgBot · MgBot2 | Отчёты, чаты, аудит команд; редактор — MgSheetCatalogBot |
| `/bot-subscribers` | менеджер | Подписчики бота | MgBotSubs | own |
| `/tg-queue` | менеджер | Очередь Telegram | MgTgQueue | own |
| `/stickers` | менеджер | Стикеры | — | Сейчас заглушка. Решение: убрать из меню, пока раздела нет |

## Обучение (менеджер)

| Маршрут | Кому | Экран | Артборды | Заметка |
|---|---|---|---|---|
| `/training/manage` | менеджер | Уроки | MgTraining | own |
| `/training/manage/new` | менеджер | Новый урок | MgTrainingForm | Ошибки конструктора теста — MgSheetTrainingLive |
| `/training/manage/:id` | менеджер | Урок и статистика | MgTrainingForm | Предупреждение, если у урока уже есть попытки |

## Супер-менеджер

| Маршрут | Кому | Экран | Артборды | Заметка |
|---|---|---|---|---|
| `/team/managers` | супер | Доска ветки | SmBoard · SmBoardDrag · SmSheet | Перенос операторов перетаскиванием |
| `/team/operators` | супер | Операторы ветки | SmOperators | own |
| `/team/sales` | супер | Продажи команды | SmTeamSales | own |
| `/team/deleted-operators` | супер | Удалённые операторы | SmDeleted | Журнал без восстановления — его нет в коде |
