I've gone through every file on your list and resolved the i18n keys. Strings are the Russian text from the RU block of `lib/i18n.ts`, or the hardcoded strings in the code. Three things a designer should know first:
- **No PIN lockout exists.** A wrong PIN only shows the error text "Неверный PIN". There is no attempt counter, cooldown or rate limit on the frontend or backend (`backend/apps/attendance/pin_services.py`), so a lockout screen would need to be designed and built from scratch.
- **Two different confirmation patterns.** Many deletes use the browser's own `window.confirm()` dialog, not the app modal. A redesign needs one standard confirm dialog to replace them all.
- **Shared UI behaviour:**
  - The app Modal (`components/ui/Modal.tsx`) has a blurred backdrop and radius 28. Esc and a backdrop click both close it.
  - Toasts (sonner, `components/ui/Toast.tsx`) are bottom-centre pills in inverted colours that last 2.4 s.

---

## components/PinGate.tsx (wraps all /attendance/* routes and /settings/attendance)
- **Loading:** "Загрузка…" centred.
- **States in order:**
  1. Superadmin, or any role where PIN isn't required: content shows directly.
  2. Manager with a valid session (30 min): content shows.
  3. PIN not set: card "PIN не установлен", subtitle plus a red info box "Обратитесь к супер-админу, чтобы он задал общий PIN…". The same text appears twice.
  4. PIN set but session expired: card "Введите PIN", subtitle "Доступ к разделу «Посещаемость» защищён общим 4-значным PIN.", one large monospaced input (placeholder "PIN", digits only, max 4), button "Войти", footer "Забыли PIN? Попросите супер-админа сбросить его в «Настройках»."
- **Validation and errors:**
  - Not exactly 4 digits: "Ровно 4 цифры". The button is disabled until there are 4 digits anyway.
  - Server error is shown in a red box: "Неверный PIN" or "PIN ещё не задан суперадмином". The input then clears and refocuses.
  - While submitting the button shows "…".
- **Toast:** about 1 minute before expiry, an error toast "PIN-сессия истекает через минуту — потребуется ввести PIN снова".
- **Re-checks:** PIN status is re-checked on every route change, every 60 s and on window focus.
- **Roles:** superadmin bypasses the gate. Manager, team_lead and super_manager are gated.

## pages/AttendanceToday.tsx
- **Close-shift modal** (440 px):
  - Title "Закрыть смену", subtitle "{name} — время ухода будет зафиксировано сейчас".
  - Textarea "Комментарий (необязательно)", placeholder "Например: клиент задержал", max 280 characters.
  - Buttons "Отмена" and "Закрыть смену" (danger).
  - Toasts: "Смена закрыта" / "Не удалось закрыть смену".
  - No pending state, so double-submit is possible.
- **Photo lightbox:** click a 36 px thumbnail to get a full-screen black overlay with an X.
- **Loading:** column count badges show "…" and column bodies show "…". The KPI row is hidden until data arrives.
- **Empty columns:**
  - "Ни один оператор сегодня ещё не пришёл"
  - "Пока никто не завершил смену"
  - "Все пришли — красавцы 👏"
- **Other states:**
  - Refresh button "Обновить" (icon spins while fetching) and "Обновлено в {t}". Auto-refreshes every 30 s and on focus.
  - Badges: "23:00 авто" (auto-closed), "⚠ Опоздание", and the raw source code `qr|tg|manual` in uppercase.
- **Bugs:**
  - The late badge on rows still on shift reads "да" (it uses `common.yes`), not "Опоздание".
  - The hero shows a fake 3×3 "QR" glyph, not a real QR.
  - The "kpi_late_hint" text says "Более чем на 15 мин", but the grace period is configurable.

## pages/AttendanceReport.tsx
- **Filters:** date from–to, operators multi-select. **Export:** "Экспорт в Excel".
- **States:** "Загрузка отчёта…" / "Нет данных за выбранный диапазон".
- **Row expand:** clicking a row opens an inline AttendanceStatsCard (heatmap), not a modal.
- **Bugs:**
  - The default dates use `toISOString()` (UTC). This is the same off-by-one-day bug that was fixed in AttendanceToday.
  - Export opens `window.open` with no Token header, so it relies on the session cookie. There is no loading or error feedback.
  - The columns "Ср. смена" and "Итого часов" are sortable but show no active-sort indicator.

## pages/AttendancePhotos.tsx
- **Filters:** "С даты", "По дату", "Оператор" (searchable when there are more than 8; default option "Все операторы"), "Сбросить", and a refresh icon.
- **Date groups:** "Сегодня" / "Вчера" / a long date. Each card has "Приход" and "Уход" thumbnails. A missing photo is a dashed "—" tile. Also "Длительность: X ч Y мин" and the badge "Опоздание".
- **States:** "Загружаем…" / "Пока нет фото". Pagination "← n–m / total →" (24 per page); arrows are disabled at the ends or while fetching. Auto-refreshes every 60 s when the filter is today only.
- **Lightbox:** Esc and backdrop click close it.
- **Bugs:**
  - "Всего" and the "Refresh" tooltip are hardcoded.
  - The key `attendance.photos.load_more` "Показать ещё" is defined but unused.

## pages/AttendanceKiosk.tsx (multi-step)
1. **Pick operator** ("KIOSK · STEP 1"):
   - Title "Выберите оператора", hint "Кто сейчас отметится", search field with the same placeholder.
   - Loading "…". Empty "Активных операторов нет".
   - Cards show name plus the raw status ("active" / "trainee").
2. **Mode:**
   - Back link "Сменить оператора".
   - Greeting card shows "Отметка прихода" (green) or "Отметка ухода" (orange) plus the name.
   - Two cards:
     - "Через камеру ноутбука" / "Оператор смотрит в веб-камеру этого компьютера, менеджер жмёт «Сделать снимок»" / button "Открыть камеру"
     - "Через QR-код" / "Оператор сканирует QR камерой телефона…" / button "Показать QR-код"
3. **Camera** (full-screen black, CameraCapture):
   - Title "Селфи для смены", flip button "Другая камера", "Открываем камеру…", shutter "Сделать фото" (disabled until ready).
   - Preview step: "Проверьте фото", "Пересделать" / "Отправить" (→ "Отправляем…").
   - No camera available: "Камера недоступна" / "Разрешите доступ к камере в настройках браузера — или загрузите фото из галереи." / "Выбрать фото".
   - Toasts: "Камера ещё не готова, подождите секунду" and "Не удалось сделать снимок".
   - Upload overlay: "Отправляем фото…". A server error shows as a toast and returns to the Mode step.
4. **QR:**
   - Back link "Сбросить".
   - Label "Отметка прихода/ухода", title "Наведите камеру телефона", "Готовим QR-код…", a 360 px QR, hint "После сканирования на телефоне откроется страница отметки — вход не требуется.", and the URL in monospace.
5. **Success overlay:** green or orange check, "Готово", name, "Приход зафиксирован" / "Уход зафиксирован", "Готов принять следующего", button "Сбросить". It auto-returns to step 1 after 4.2 s.
- **Bugs:**
  - If the QR token is still loading or failed, the Camera step renders a blank page.
  - The QR step shows no error state if the token request fails.
  - The Mode step shows "Отметка прихода" before the preview loads, then may flip to "ухода".
  - The key `attendance.kiosk.error_no_face` ("На фото не видно лица…") exists but is never used.

## pages/AttendanceSettings.tsx
- **Sections:**
  - "График работы": "Начало смены", "Конец смены", "Выходной день недели" (Пн…Вс), "Авто-закрытие смены".
  - "Штрафы и гейт": "Grace-период (минут)" 0–240, "Штраф за опоздание (UZS)", "Прощённых пропусков в неделю" 0–7, "Гейт посещаемости (%)" 0–100.
  - "Бонус attendance по умолчанию": "Бонус attendance (UZS)".
  - "Продажи и планы": "Бонус за продажи (UZS)", "Гейт продаж (%)", "План продаж по умолчанию (UZS/мес)".
  - "Обязательная отметка": checkbox "Обязательная отметка при входе" with a long hint, and "Порог «пора закрыть смену» (часов)" 0–24.
  - Each field has a muted hint line under it.
- **Validation:** only the HTML min/max attributes. There are no messages; the server error goes to a toast.
- **Save:** "Сохранить" → "Сохраняем…". Toast "Настройки сохранены", or the server error.
- **Loading:** "Загрузка…" (hardcoded). If the request errors, the page stays on this forever.
- **Bugs:**
  - The attendance bonus input calls `upd()` twice with a stale form. The second call overwrites the first, so `default_attendance_bonus_uzs` never changes: the user types and the value snaps back.
  - The hint "Пн=0, Вс=6" is shown next to a select that already shows day names.
  - Toasts here come straight from sonner rather than through the ui wrapper (cosmetic only).

## pages/PayrollReport.tsx (/attendance/payroll)
- **Table states:** "Загрузка…" / "Нет данных за выбранный диапазон". Filters are a month picker (no future months) and an operators multi-select.
- **Drill-down modal** (780 px, no title bar or close button; Esc or backdrop closes):
  - Header: name and "График: {from}–{to} · grace {grace} мин". Buttons "Excel" and "PDF"; the clicked one shows "Загрузка…" and both are disabled.
  - Total block: "К выплате", the amount, "из {max}".
  - Two gate cards, "Attendance" and "Продажи": earned amount, "из {bonus}", "{rate}% / {gate}%", a progress bar with a gate marker, and a red shortfall box when the gate failed. The Attendance card adds "X / Y дн., опозданий: N (−penalty)".
  - "По дням" list. Statuses: "Вовремя" ✓, "Опоздание" ⏰, "Пропуск" ✕, "Выходной" ○, "Прощённый пропуск" ◐. Each row shows times and a red deduction.
- **Personal threshold section** (inside the modal), "Личный порог продаж":
  - Badge "личный" (blue) or "глобальный".
  - View mode: "Порог" and "Формула выплаты", one of "{v}% от суммы сверх порога" / "фикс. бонус {v}" / "прогрессивные тиры". Button "Изменить".
  - Edit mode:
    - Fields: "Порог" (number), "Тип выплаты" (select), and a value field.
    - Type options and their value field:
      - "Процент от суммы сверх порога" → value field "Процент (%)", step 0.1.
      - "Фиксированный бонус" → value field "Бонус, UZS".
      - "Прогрессивные тиры" → value field "—" (disabled), plus hint "Тиры настраиваются через админку — форма пока принимает только порог…".
    - Buttons: "Сбросить к глобальному" (only when a personal rule exists), "Отмена", "Сохранить". All are disabled while busy and the busy one shows "Загрузка…".
  - Validation toasts: "Порог должен быть неотрицательным числом", "Значение выплаты должно быть неотрицательным".
  - Toasts: "Правило сохранено", "Личное правило сброшено", "Не удалось сохранить".
- **Bugs:**
  - "Сбросить к глобальному" has no confirmation.
  - A failed Excel/PDF download gives no toast.
  - The day times use the browser timezone, not Tashkent.
  - "дн., опозданий:" and "из" are hardcoded.
  - The `payroll.subtitle` text "оклад минус вычеты…" is outdated compared with the two-gate model.

## pages/Payroll.tsx (/payroll, legacy)
- **Strings are all hardcoded:** "Начисления операторам по месяцам", "Оператор / Продажи / Прогресс к порогу / Премия", "Загрузка…", "Нет данных за выбранный месяц", badges "стажёр" and "порог достигнут", "из {threshold}".
- **Behaviour:** a row click goes to /operators/:id. The "Excel" button is a plain `<a href>` (no Token header, no feedback).
- **Bugs:**
  - Same "Зарплата" title as PayrollReport, so there are two pages with one name.
  - The year field accepts any number.

## pages/Settings.tsx
- **Card "Авто-распределение лидов":**
  - Hint text, meta line "Изменено {date} — {name}", and a toggle (disabled while loading or saving).
  - When off, a red banner: "Раздача полностью выключена. Все новые лиды копятся в пуле свободных…".
  - Toasts: "Авто-распределение включено/выключено".
- **Card "Блокировка при спец-лидах":** long hint and a toggle. When off, a red banner "Оператор получает новые лиды даже с необработанными callback'ами…". Toasts "Блокировка при спец-лидах включена/выключена".
- **Card "PIN для «Посещаемости»" (superadmin only):**
  - Status "PIN установлен" (green) or "PIN не установлен — менеджеры не могут войти в «Посещаемость»" (red, plus the same text repeated as a banner).
  - Meta line "Обновлён {date} · {name}".
  - Buttons "Установить PIN" / "Сменить PIN", and "Сбросить PIN" (danger, only when a PIN is set).
- **Modal 1, set or change PIN** (440 px):
  - Title "Задайте общий PIN" / "Сменить общий PIN".
  - Subtitle "4 цифры. Все менеджеры будут вводить один и тот же PIN." / "…Все активные сессии менеджеров будут инвалидированы…".
  - Fields: "Новый PIN" and "Повторите PIN" (Enter moves to the second field).
  - Errors: "Ровно 4 цифры", "PIN'ы не совпадают", or the server error.
  - Buttons "Отмена" and "Сохранить" (disabled until both fields have 4 digits; "…" while saving). Toast "Общий PIN сохранён".
- **Modal 2, reset confirmation:** "Сбросить общий PIN?" / "После сброса все менеджеры получат «PIN не установлен»…", buttons "Отмена" and "Сбросить PIN" (danger). Toast "PIN сброшен".
- **Bug:** there is no loading or error state for the settings request; toggles just sit in the off state.

## pages/Partners.tsx (actually sales channels)
- **Modal "Новый партнёр":** field "Название" (required, placeholder "Alif / Uzum / Hamroh / TBC / Cash…"), buttons "Отмена" and "Сохранить" (→ "Сохранение…", disabled while the name is empty). Toast "Партнёр добавлен".
- **List:** "Всего: {n}", badges "активен" / "выключен", row buttons "Выключить" / "Включить".
- **Bugs:**
  - There is no loading state, so the empty text "Партнёров пока нет" flashes while loading.
  - Create and toggle failures are silent, and a toggle success has no feedback.
  - The page is called "Партнёры" but its subtitle is "Каналы продаж".

## pages/Catalog.tsx + components/PhoneEditor.tsx
- **Card actions (all roles):** "Текст", "Фото" (disabled without a cover), "Marketing". The active button shows a spinner and all are disabled during a copy. Clicking an image copies it ("Кликните — скопируется в буфер").
- **Copy toasts:**
  - "Скопирован текст", "Фото скопировано", "Marketing-текст скопирован в буфер".
  - Errors: "Не удалось скопировать: {msg}", and "Нет фото" when copying a photo that doesn't exist.
- **States:** "Загрузка…". Empty: "Каталог пуст" / "Добавьте первый телефон — модель, цвета, цена, обложка.". Stock filter chips: "Все / В наличии / Под заказ / Нет". Cards that aren't in stock show an amber stock label.
- **Manager-only:** "Новый телефон", edit, hide/show ("Скрыть от операторов" / "Показать операторам"), delete via native `confirm` "Удалить {name}?" with toast "Удалено". Operators see only the copy buttons.
- **Editor modal "Карточка телефона"** (640 px, scrollable):
  - Fields:
    - Basics: "Бренд", "Модель", "Слоган / подпись".
    - Specs and stock: "Память, GB", "RAM, GB", "Наличие", "Камера, MP", "Батарея, mAh".
    - Price: "Цена (сум)".
    - Photos:
      - "Обложка" + hint.
      - "Галерея (до 10 фото)" + hint. Existing photos appear as "#n ×" chips, tooltip "Удалить это фото после сохранения".
    - Free-form specs: "Характеристики (свободные поля)" with "+ Поле" and empty text "Пусто — добавьте процессор, экран и т.п.".
    - "Цвета": "+ Добавить цвет", name plus colour picker, empty "Цветов пока нет".
    - "Описание (необязательно)", checkbox "Показывать операторам".
  - Validation: "Сохранить" is disabled unless brand, model and price > 0 are filled. There are no inline messages.
  - Buttons: "Отмена", "Сохранить" (→ "Загрузка…"). Toasts "Сохранено" / "Не удалось сохранить".
- **Bugs:**
  - Clearing a spec key deletes the whole row while you are typing.
  - The editor title is the same for create and edit.
  - Delete and hide failures are silent.
  - Gallery uploads run one by one; a mid-way failure leaves a partial save but shows the generic error.

## pages/CatalogBanks.tsx
- **Add bank:** "Добавить банк", inputs (placeholders "Alif / Zoodpay / Payme…" and "🏦"), button "Сохранить". Toast "Банк добавлен".
- **Bank card:** table "Срок / Множитель / Переплата" with the rows "12 мес / ×1.18 / +18%". Add-plan inputs (12, 1.18) and button "План", disabled until both are filled.
- **Delete bank:** native confirm "Удалить банк {name} и все его планы?". Deleting a plan has no confirmation.
- **States:** "Загрузка…", no empty state, and every error is silent.
- **Bug:** the page is not linked from the sidebar (orphan route).

## pages/InstallmentTiersPage.tsx
- **Table:** "Месяцы / Комиссия, % / Активен / В marketing-тексте / Порядок". The number cells save on blur and the checkboxes save immediately. Toast "Тариф сохранён", error "Не удалось сохранить".
- **Add:** "Добавить тариф" with "Месяцы" / "Комиссия, %" and "Сохранить" (disabled until both are filled).
- **Delete:** native confirm "Удалить тариф {months} мес?". Toast "Тариф удалён".
- **Empty:** "Пусто".
- **Bug:** adding a month count that already exists silently overwrites that row, with no warning.

## pages/MarketingSettingsPage.tsx
- **Fields:** "Слоган по умолчанию", "Телефон основной", "Телефон второй (необязательно)", "Telegram", "Адрес", "Преимущества" (7 rows; hint "По одному на строку. Начинайте с эмодзи…").
- **Save:** "Сохранить" (→ "Загрузка…"). Toasts "Настройки сохранены" / "Не удалось сохранить".
- **Bugs:** no field validation, and a failed load leaves "Загрузка…" forever.

## pages/Analytics.tsx
- **Controls:** MonthPicker and "Excel" (`<a href>` without a Token header).
- **Hardcoded strings:** "Аналитика по команде", "Воронка команды", "Лиды → контакт → callback → продажа", "Лиды/Дозвоны/Callback/Продажи", "Топ моделей", "Модель/Кол-во/Сумма", "Тепловая карта callback-активности" and its legend line.
- **Empty states:** "Нет данных" in channels, leaderboard, models and heatmap; "Нет данных" (`common.no_data`) in by-source. With no data the funnel shows four empty bars at 0.
- **Bugs:**
  - There are no loading states; "Нет данных" flashes while loading.
  - The team funnel (top 20) and the heatmap (30 days) ignore the selected month.

## pages/Marketing.tsx + components/marketing/*
- **Header:**
  - Range chips "7 дн / 14 дн / 30 дн / 90 дн" and two date inputs.
  - "Обновить AI-анализ" → "Считаем…" (disabled while running). Toasts "Инсайт сгенерирован" / the server detail or "Не удалось сгенерировать анализ".
  - "Excel" link.
- **Tabs:** "Обзор / Источники (n) / Паттерны / Динамика / AI-советы / Затраты".
- **Page states:** loading "Загрузка…" (pulsing card). An error shows the raw axios message in red, i.e. English text.
- **Overview tab:**
  - KPI cards. The spend card hint is "Введите бюджет во вкладке «Затраты»" when no spend exists.
  - Source table limited to 6 rows, then the link "Показать все источники →". Empty "Нет данных по источникам за выбранный период".
  - Rows expand into MarketingSourceDetail; each sub-block shows "Нет данных" when empty.
- **Patterns tab:** heatmap "Часовой паттерн" with a leads/sales toggle and legend "Легенда: 0 → max". Empty "Нет данных".
- **Dynamics tab:** time-series charts and the cohort table; each shows "Нет данных" when empty.
- **AI tab (MarketingRecommendations):**
  - Empty: Sparkles icon, "AI-анализ ещё не построен" / "Нажмите «Обновить AI-анализ» вверху страницы".
  - "Резюме периода" plus a model/date meta line.
  - Highlight cards WIN 🏆 / WARN ⚠ / INSIGHT 💡.
  - "Рекомендации (n)". Each card has a priority pill HIGH/MED/LOW, "→ source", "Уверенность: n%", the action, "Обоснование:", and an impact chip 📈.
  - Round check button with tooltip "Отметить как выполненное" / "Отменить отметку". Done cards are struck through at 55% opacity. All check buttons are disabled while one request is pending.
  - Empty list: "Пока нет рекомендаций для этого периода". Optional "Вопросы к владельцу".
- **Spend tab (AdSpendEditor):**
  - "Добавить расход": from/to dates, source select "— выбрать sheet-источник —", or free text "или введите название (Bot, Manual, …)" (disabled when a source is selected), "Сумма", "Сохранить", and "Заметка (необязательно)".
  - Validation toasts: "Введите положительную сумму", "Выберите источник или введите название". Toasts "Расход добавлен" / "Не удалось сохранить".
  - "История расходов", "Всего: X". The amount saves on blur, silently. Delete uses native confirm "Удалить эту запись?" and toast "Расход удалён". Empty "Расходы ещё не введены".
- **Bugs:** mark-done errors are silent, and editing an amount gives no success or failure feedback.

## pages/MarketingSources.tsx
- **Header and summary:** month combobox (placeholder "Выбрать конкретный месяц") and four summary chips.
- **States:** loading "Загрузка…"; an error shows the raw message in red; empty "Нет источников за выбранный период".
- **Ranking table:** a "дефицит" badge with tooltip.
- **Row click** opens an inline panel (not a modal):
  - "Разбор источника", name, "Смотреть продажи →" (only for sheet sources), and a "×" close.
  - "Что искали vs что купили" with gap states "Загрузка…" / "Нет данных о спросе за период".
- **Bug:** the page title is shown twice (page header plus an in-page h1).

## pages/Reports.tsx
- **Period chips:** "Сегодня / Неделя / Месяц / Свой период".
- **Six cards:** each has a title, description and meta line, plus a button "Excel" (spinner "…" while busy; all cards are disabled during a download) or "Открыть →" for the activity card.
- **Toasts:**
  - Success "✓ {title} · {size}".
  - Errors: "Нет прав на этот отчёт" (403), "Отчёт не найден на сервере" (404), "Не удалось скачать".
  - Also "PDF пока не поддерживается — используйте Excel"; this code path is unreachable.
- **"Последние выгрузки":** columns "Файл / Размер / Когда", link "Очистить", empty "Пока нет скачанных отчётов. Нажмите Excel на любой карточке выше."
- **Bugs:**
  - "Свой период" has no date picker; it behaves exactly like "Месяц".
  - Payroll always uses the current month.
  - Card meta lines are fake hardcoded numbers ("~34 строки за сегодня", "12/15 явок сегодня", "1240 лидов в системе").
  - The "сегодня" timestamp renders as "сегодня, 14:12 HH:MM" because the i18n string has a fake time baked in.
  - `common.just_now` is missing, so the raw key is shown.
  - Times under an hour show "N min" in English.
  - Rows in the recent list can't be re-downloaded.

## pages/Dashboard.tsx + components/dashboard/*
- **Header:**
  - Badge "📞 Звонков сегодня: {n}" (goes to /calls).
  - Period pills "День / Неделя / Месяц".
  - Month combobox "Выбрать конкретный месяц" with a "×" to reset (tooltip "Сбросить месяц").
- **"Здоровье воронки" section:**
  - **SheetHealthStrip:**
    - Empty: "Активных источников из Google Sheets нет." plus a "Настроить" button.
    - Otherwise up to 4 cards with status dot "работает" / "давно не синкался" / "ошибка sync", "лидов за 24 ч", "sync: …", "всего: {n}".
    - Buttons "Синхронизировать" (→ "Синхронизирую…") and "Перескан" (native confirm "Выполнить полный перескан таблицы с 1-й строки?"), plus a "Показать/Скрыть ошибку" disclosure.
    - Toasts "Синхронизировано: {read} строк… Новых лидов: {created}, обновлено: {merged}." / detail or "Sync не удался".
  - **HealthLeaks "Утечки":**
    - "System-lost за 24ч" turns red and bold when above 1.3× the 7-day average; hint "среднее за 7 дней: {n}/день".
    - "«Не ответил» без движения >48ч".
    - "Операторы с высоким % потерь" shows "—" or a count plus names; it isn't clickable when empty.
    - "Ошибки синка таблиц" shows a red hint when there are errors.
  - **FunnelBottleneck "Где застревает воронка":** rows show a status label (hardcoded RU map), "средний срок: {n} дней" and a count. Empty: "За 7 дней всё движется — узких мест нет."
- **KPI cards (clickable):** "ПРОВЕДЕНО СЕГОДНЯ" + "{n} ждут проверки"; "ОБОРОТ, СУМ" + "план X млн"; "КОНВЕРСИЯ ЛИДОВ" + "±x п.п." (green/red/grey) + "vs прошлый период"; "НА СМЕНЕ" "x / y" + "{n} опоздали".
- **Bar chart:** "Продажи · 14 дней, шт. в день", "план {n} шт./день". It has no empty state and renders empty axes.
- **RequiresAttentionCard "Требует решения":** rows "Требуют проверки", "Сироты не назначены", "Продажи на проверке", "Опоздали сегодня". Urgent rows with values above zero get an orange highlight. When everything is zero it shows "всё чисто".
- **BirthdaysTodayCard:** hidden when empty; otherwise "🎂 Сегодня день рождения", "Name · {n} лет", and a tel: link.
- **TopOperators:** "Топ операторов", empty "Пока пусто".
- **Footer:**
  - "Загрузка…".
  - Error: the raw message plus a "Повторить" link.
  - "автообновление каждую минуту · X сум".
- **SalesFeed.tsx** ("Лента продаж", "реалтайм", empty "Пока нет продаж — они появятся здесь в реальном времени") is not used anywhere.
- **Bugs:**
  - The chart title is fixed at "14 дней" even when "День" or a specific month is selected.
  - "Требуют проверки" and "Продажи на проверке" both link to /sales/pending.
  - The page title is duplicated (header plus h1).
  - KPI cards show 0 while loading.

## pages/BotConfig.tsx + Bot* components
- **Tabs:** "Отчёты / Чаты / Аудит".
- **Reports tab:**
  - Buttons "Новый отчёт" and "Из шаблона". Both open the same gallery.
  - Empty: bot icon, "Отчётов пока нет" / "Создайте первый отчёт — укажите время, чат и блоки данных.".
  - Report card: name, "выключен" pill, red "ошибка отправки" pill (tooltip shows the error), "⏰ HH:MM · каждый день / Пн, Ср · N получателей", block labels, "Последняя отправка: …".
  - Actions:
    - Send now ▶ (no confirmation). Toasts "Отправлено: {n} · ошибок: {n}" / detail or "Не удалось отправить".
    - Edit.
    - Delete via native confirm "Удалить отчёт «{name}»?", toast "Удалено".
- **Chats tab:**
  - Info tile "Как добавить группу" / "Добавьте @naffai_bot в вашу группу Telegram…".
  - Table "Тип / Название / Связан / Язык / Статус" with a green or red dot.
  - Loading "Загрузка…", no empty state.
- **Audit tab:** a 7-day table whose outcome pills are coloured raw codes (ok / denied / other). No loading or empty state.
- **Template gallery modal** (720 px):
  - "Выберите пресет" / "Готовые шаблоны отчётов. После выбора всё можно поправить.", "Загрузка…".
  - Template cards: category icon, name, description, the first 4 raw block slugs, "+N".
  - Footer button "Начать с чистого листа". No empty state.
- **Editor modal** (1080 px, two columns):
  - **Left column:**
    - Title "Новый отчёт" / "Редактирование отчёта".
    - "Название" (placeholder "Например: Ежедневная сводка для группы"); Save is disabled while it is empty.
    - "Расписание" (BotSchedulePicker):
      - Presets "Каждое утро 9:00 / Каждый вечер 20:00 / Пн–Пт 9:00 / По понедельникам 9:00"; the active one is filled.
      - Disclosure "Точная настройка": "Время", "Asia/Tashkent (UTC+5)", "Дни недели" chips Пн…Вс, hint "Пусто = каждый день" / "Отчёт придёт только по отмеченным дням."
    - "Язык" (O'zbekcha / Русский), "Период данных".
    - "Куда отправить": checkbox list (kind, title, "@ profile"). Empty: "Пока нет чатов. Начните переписку с ботом или добавьте его в группу."
    - "Блоки данных" (BotBlockLibrary):
      - Category tabs "Продажи…" with a count badge.
      - Checkbox rows; sensitive blocks get an amber "🔒 только в личке" tag.
      - Empty category: "В этой категории нет блоков."
      - Footer "Выбрано блоков: {n}".
    - "Включен" checkbox.
    - Buttons "Отмена" and "Сохранить".
  - **Right column (live preview):**
    - "Живой предпросмотр", rebuilt 300 ms after each change.
    - "Показать как увидит:" select, default "Личный чат (все блоки)".
    - Preview area in monospace. Error text "Не удалось построить превью". "Кнопки в сообщении:" list.
    - Test send "Отправить тестово" → "Отправляем…". Toasts "Тестовое сообщение отправлено" / detail or "Не удалось отправить тестовое".
    - Before the first save: "Сохраните отчёт, чтобы включить тестовую отправку."
  - Save toasts: "Сохранено" / "Не удалось сохранить". The modal stays open after saving and a new report switches to edit mode.
- **Bugs:**
  - The editor modal is blank if the blocks list hasn't loaded or failed.
  - The test-send button is hidden until a non-default "preview as" chat is chosen, and nothing hints at that.
  - When "every day" is set, all day chips look selected, and clicking one switches to only that day.
  - `include_header` can't be edited.
  - The gallery shows raw slugs.
  - Delete errors are silent.

## pages/BotSubscribers.tsx
- **Table:** "Чат / Телефон / Связан / Язык / Рассылка / Был в сети".
- **Badges:** "Заблокирован" (red) and "Отписан". The linked column shows a name plus "Оператор" / "Менеджер".
- **Toggle:** optimistic update; all toggles are disabled while one saves. Toasts "Сохранено" / "Не удалось сохранить: {detail}".
- **States:** "Загрузка…". Empty: "Пока никто не подписан" / "Дайте менеджерам и операторам ссылку на @naffai_bot и попросите нажать /start…".
- **Bug:** the interface language is detected by comparing the output of `t("common.loading")` against a Russian string. Relative times are hardcoded ("мин назад", "ч назад", "дн назад").

## pages/TgQueue.tsx
- **Tiles:** "Активны / Подключаются / Загружаем / Не подключены / Ошибок" (red when above zero) / "Всего сообщений". Line "Автообновление каждые 5 сек · {n} операторов".
- **Session badges:** "активна / ждёт код / ждёт 2FA / истёкла / отозвана / ошибка / не подключён", with the red error text cut to 60 characters.
- **Job states:** "в очереди" ⏸, "загружаем" (spinner + "N чатов · M сообщ."), "готово" ✓ + relative time, "ошибка" ⚠ + error text.
- **Actions:**
  - "Retry" appears only for an active session whose job errored (tooltip "Retry backfill"). Toasts "Задача перезапущена" / "Не удалось перезапустить". No pending state.
  - "Подключить" appears only when the status is none. It only navigates to /operators/:id; the real connect flow lives in OperatorDetail.
- **States:** "Загрузка…" / "Пусто". Chips "Всего: … чатов, … сообщений, … AI-инсайтов".
- **Bugs:**
  - Sessions in "revoked" or pending states have no action.
  - "revoked" isn't counted in any tile.
  - "Retry" is English.

## pages/TrainingManage.tsx
- **List:** "Всего уроков: {n}", "Новый урок". The status pill toggles between "Активен" and "Скрыт" (tooltip "Скрыть от оператора" / "Показать оператору"). Actions: Статистика, Edit, Trash.
- **Delete:** native confirm "Скрыть этот урок? История прохождений сохранится." Toast "Урок скрыт". The error toast says "Повторить".
- **States:** "Загрузка…". Empty "Ещё нет уроков. Нажмите «Новый урок», чтобы добавить первый."
- **Bugs:** the trash icon and "Удалить" tooltip actually hide the lesson, which duplicates the status toggle. Toggle failures are silent.

## pages/TrainingLessonForm.tsx
- **Header:** "Новый урок" / "Редактирование урока" with a back link. Edit mode has tabs "Урок / Статистика".
- **"Основное" section:**
  - "Название" (placeholder "Например: Как отработать возражение «дорого»").
  - "Описание" ("Короткое пояснение для оператора").
  - "Ссылка на видео" (hint "YouTube-ссылка … или прямой mp4-URL").
  - "Файл": shows the existing file name with "Удалить прикреплённый файл", a "Выбрать файл" button that changes to the file name, "Убрать", and hint "PDF/PPTX/DOCX до 15 МБ".
  - "Показывать операторам".
- **Test builder:**
  - Checkbox "Добавить тест".
  - Question cards "1." with text and trash ("Удалить вопрос").
  - Answer rows: radio for the correct answer, text, trash (disabled when only 2 answers remain). "+ Добавить вариант" is disabled at 6.
  - "+ Добавить вопрос".
- **Validation:** shown as error toasts in this order:
  - "Укажите название урока."
  - "Добавьте ссылку на видео или файл."
  - "Вопрос №{n}: заполните текст."
  - "Вопрос №{n}: минимум 2 варианта ответа."
  - "Вопрос №{n}: ровно один вариант должен быть правильным."
  - "Вопрос №{qn}, вариант №{an}: заполните текст."
  - Then any server field error.
- **Save:** "Отмена" / "Сохранить" (→ "Загрузка…"). Toast "Урок создан" / "Сохранено", then navigates back to the list.
- **Statistics tab:**
  - "Попыток" and "Средний балл" (or "—").
  - "По вопросам": "correct / wrong", "{n}% ошибок", a red bar, "Ошиблись: names".
  - Empty "Никто ещё не прошёл тест." Loading "Загрузка…".
- **Bugs:**
  - Edit mode shows an empty form while loading.
  - Having the test enabled with zero questions saves silently.
  - Editing questions on a lesson that already has attempts gives no warning.
  - There is no guard against leaving with unsaved changes.

## pages/AIChat.tsx
- **Model chips:** "Модель", "Авто (chain)" (tooltip "Автоматически: chain c fallback по 429"), one chip per provider, and the model id on the right. Hidden when there are no providers.
- **Sessions:** "+ Новый" and up to 6 chips ("Сессия #{id}" fallback). No delete, rename or "show more".
- **Empty state:** "Ассистент готов", "О чём хотите узнать?", "Задайте вопрос про продажи, операторов или лидов — или выберите ниже." Quick prompts: "Продажи за неделю / Топ-3 оператора / Разрез по каналам / Просроченные колбэки".
- **Messages:**
  - User bubble (orange gradient).
  - Assistant bubble plus a "provider · model" caption.
  - Tool call: "🔧 вызывает: name".
  - Tool result: a collapsible `<details>` block.
- **Pending:** three dots and "печатает…". The input is disabled. This is not real streaming: it is one POST and the whole reply arrives at once.
- **Error:** red box with the server message (or "Нет активной сессии"). It stays until the next submit.
- **Placeholders:** "Спросить у ассистента…" / "Начните разговор — Enter". The send button is dimmed when the input is empty or a request is pending.
- **Bug:** typing a message with no session creates the session but drops the text, so the user has to type it again.

## pages/LiveWall.tsx
- **Header (all hardcoded RU, slate colours, no page header):** "Live-эфир операторов", "Подключение…" → "Подключено к LiveKit." plus "· В эфире: N."
- **Errors (red box):**
  - 503/404: "Live-эфир не настроен на этом окружении (нет LIVEKIT_* в .env)."
  - Others: "token: …", "connect: …", "SDK: …".
- **Killswitch:** a full-width button. Green "🟢 Live-эфир ВКЛЮЧЁН — нажми чтобы ВЫКЛЮЧИТЬ всех", red "🔴 Live-эфир ВЫКЛЮЧЕН — нажми чтобы ВКЛЮЧИТЬ", "…" while pending. Caption "При выключении все 40 webcam-стримов остановятся…".
- **Grid:** tiles with a "LIVE" pill. Empty "Сейчас никто не в эфире."
- **Focused view:** name, checkbox "Звук", "Закрыть".
- **Bugs:**
  - After a 503 the subtitle still says "Подключение…".
  - The killswitch has no confirmation and no error feedback.
  - "40" is hardcoded.
  - The page doesn't follow the dark theme.

## pages/LiveArchive.tsx
- **Header:** "Архив live-эфира", "Записи храняться 30 дней…" (typo: "храняться").
- **Filters:** "Оператор" (with "Все"), "С даты", "По дату", "Сбросить фильтр".
- **Table:** "Оператор / Начало / Длительность / Размер / Действия". Button "Смотреть" → "...".
- **States:** "Загрузка…" / "Записей не найдено." A link error shows a red box with the detail or "Не удалось получить ссылку".
- **Player:** inline panel "Запись #id" with "Закрыть".
- **Bugs:**
  - The operators request expects a plain array; other pages handle a paginated `{results}` response, so this one may crash.
  - Same slate styling as LiveWall and no page header.

## pages/Audit.tsx
- **Hardcoded strings:** subtitle "Журнал изменений", search placeholder "Поиск: кто / что / когда…", chips "Все объекты" plus one per entity, columns "Когда/Кто/Действие/Объект/Изменения".
- **States:** "Загрузка…" / "Пока пусто — измените запрос или фильтр".
- **Bugs:**
  - Only the first API page is loaded, with no pagination, and the entity chips come only from that page.
  - Action and entity codes are raw English, and changes are a raw JSON dump.

## pages/Calls.tsx
- **KPIs:** "Всего звонков", average duration, "С записью" % + "N шт", "Дозвонились" % + "N шт".
- **Filters:**
  - Date presets "Сегодня / Вчера / 7 дней / 30 дней / Этот месяц" (default 7 days) plus dates and an operators multi-select.
  - Outcome chips "Все / Разговор / Нет ответа / Отказ / Прочее / Без результата".
- **Outcome badges (hardcoded):** "Разговор, интерес", "Перезвонить", "Не берёт", "Не тот номер", "Отказ", "TG", "Без результата".
- **States:** "Загрузка…" / "Звонков не найдено". Footer "n / total" and "Загрузить ещё" (→ "…").
- **Call detail modal** (custom overlay, not the shared Modal, so Esc doesn't close it):
  - "Детали звонка": Оператор, Лид (link), Начало, Окончание, Длительность, Результат, Комментарий ("—"), Запись (audio player or "Скоро").
  - Button "Закрыть".
- **Bugs:**
  - The KPI cards ignore the outcome filter.
  - A missing recording shows "—" in the table but "Скоро" in the modal.

## pages/Placeholder.tsx (/stickers)
- Card "Скоро появится" / "Экран «{title}» в разработке — вернитесь позже."

## pages/Screen.tsx (/screen, full-screen TV)
- Dark board "Табло продаж · сегодня", "обновление каждые 30 сек", button "Выйти". Rows show rank, name, "N шт" and "X млн". Empty: "Пока нет данных за месяц".
- **Bugs:**
  - The title says "сегодня" but the query uses month data.
  - There is no loading or error state; the empty text shows while loading.

## Role summary
- **superadmin:** passes every RoleGate and PinGate, and is the only role that sees the Settings PIN card.
- **manager / team_lead / super_manager:** reach every page above, with attendance pages behind the PIN gate.
- **operator:** reaches only Catalog among these pages, and sees the copy buttons without edit, hide or delete or "Новый телефон".
- **Within-page differences:** besides the Settings PIN card, Catalog editing and PinGate, nothing else on these pages changes by role.