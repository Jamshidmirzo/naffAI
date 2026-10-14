I've covered every file in scope. Russian strings below are resolved from `lib/i18n.ts` or copied from hardcoded JSX. Shared conventions first, then one section per file.

## Global conventions
- **Toasts** (sonner, `components/ui/Toast.tsx`): one style for every toast, a dark pill at the bottom centre that stays 2.4 s. Success and error toasts look the same apart from the icon.
- **Modals**:
  - New modal (`components/ui/Modal`): closes on Esc; backdrop click closes unless `closeOnBackdrop=false`.
  - Legacy modal (`components/Modal.tsx`, used by StickerPicker): has a header "×" button (aria "Закрыть").
- **Paginator** (hardcoded Russian): "Показано X–Y из N", "Назад", "Вперёд". Hidden when there is only one page.
- **API client** (`lib/api.ts`):
  - On a 401 it silently calls `/auth/me/` once and retries the request. If that also fails it clears localStorage and does a hard redirect to `/login`, with no "session expired" message. `/scan` is exempt.
  - A 401 with code `pin_required` is passed to PinGate instead.
  - A 403 shows the toast "Доступ запрещён", except on `/my/` and `/mine/` URLs.
  - A keepalive call to `/auth/me` runs every 30 min.
- **App.tsx**: there is no catch-all route, so an unknown URL renders a completely blank page (not even AppShell). `RoleGate` redirects an operator to `/my` on any manager route. `/screen` only requires a login, so operators can open it.
- **Overlays mounted in AppShell for operators** (z-index, highest first):
  - SnapshotRequestPrompt (1200)
  - CheckoutBackfillGate (310)
  - CheckinGate (300)
  - Scan success overlays (200)
  - QR modal (180)
  - LiveStreamPublisher pill (80)
  - MorningGreeting (50) and HelperButton (50)
  - CheckoutReminderBanner and the sticky birthday banner sit inline under the header.

## components/layout/Header.tsx (same for every role)
- Back arrow only when the page sets `back`. The only operator-reachable page that does is SaleDetail, whose back goes to `/sales`, which bounces an operator to `/my`.
- Title and subtitle from `usePageHeader`.
- Sound toggle for all roles. Hardcoded Russian tooltips: "Звук продаж выключен — включить" / "Звук продаж включён — выключить".
- RU | UZ tabs.
- Theme button labelled with the target theme: "Светлая" or "Тёмная".
- No user menu. Logout ("Выйти") is at the bottom of the Sidebar: no confirmation, and it only clears client storage (never calls `/auth/logout/`).
- **Sidebar badges:** polled every 30–60 s. Operator badges: myBlockers, notifs, and a dot for a new lesson.

## pages/MyLeads.tsx
**Loading / error / polling**
- Page loading: "Загружаем лиды…". Load error: red box "Не удалось загрузить лиды".
- Polling: list every 60 s, `/leads/my/status/` every 30 s, chip query every 60 s, calls-today every 60 s, due callbacks every 30 s (plays a chime on a new one).

**Top widgets**
- AttendanceStatusWidget (see below).
- CallsTodayBadge: "Сегодня: нет звонков" (grey) or "Сегодня: {n} звонков, ⌀ {m:ss}" (green).

**BlockingGateCard** (only when `gate_active`)
- Lock icon, "Закрой эти {n} лида(-ов), чтобы получать новые".
- Explanation: "Пока эти клиенты не закрыты (продажа, отказ или отложить) — свежие лиды тебе не даются. Нажми «Открыть» и разберись с каждым."
- Progress "{done} из {total} закрыто".
- Up to 8 rows: number, name or "Без имени", phone or "нет телефона", a badge, the overdue time, and an "Открыть" button.
  - Badge: "Пропущенный колбэк" (red) or the status (amber).
  - Overdue time: "просрочен {n} мин" / "{h}ч {m}м" / "{n} дн.".
  - "Открыть" scrolls to the card and flashes it for 2.2 s.
- More than 8 rows: "…и ещё {n} — прокрути ниже, увидишь весь список".

**Hero**
- Eyebrow "Доброе утро" at any time of day.
- H1 "У вас {n} активный лид / активных лидов", or "Активные лиды разобраны".
- Line: "{name} · план на сегодня — 20 звонков." plus "{n} лидов отложены."
- CTA renders as "+ + Новая продажа".
- Gauge "План на день · {n}%" / "{done} из 20 лидов в работе" (hidden on mobile).

**Tabs**
- "Активные": count turns red when there are overdue callbacks or yesterday's backlog.
- "Блокирующие": only shown when working ≥ limit; red.
- "Отложенные", "Закрытые", "Все".
- Right side: "{n} лидов · {n} просрочено".

**Status chips** (Active tab only): "Все · N" plus the statuses from the catalog; a chip at 0 is dimmed.

**Status banner** (Active tab; the second line is the backend's `reason_ru`, Russian even in UZ)
- Red with a pulsing count: "Сначала закрой это".
- Orange: "Проверь дневные звонки".
- Green: ✓ plus the reason.

**Quota mode**
- Banner "Эти {n} лидов блокируют выдачу новых".
- Body: "Лимит — {limit} в работе. Закройте минимум {need} из списка ниже … Старейшие сверху: начните с них."
- Link "Показать все лиды".

**DayStrip:** "Все дни" / "Сегодня" / "Вчера" / "DD.MM" / "Давно (>7 дней)", each with a count.

**Empty states**
- Chip with no results: "Пока нет лидов с этим статусом".
- Nothing left: "✅ Все лиды закрыты" / "Новые придут автоматически — обычно в течение нескольких минут."
- Closed tab: "Пока нет закрытых лидов".
- Generic: "Здесь пока пусто".
- Today: "На сегодня пока ничего нового" / "Закройте вчерашние — автораздача сразу подкинет свежие лиды."
- Another day: "В этот день нет лидов".

**LeadCard badges**
- Status badge (overdue variant).
- "🔥 ТЕЗ mm:ss" countdown ticking every second, pulsing in the last 60 s, then "💀 Остыл".
- "отложен".
- Retry box: "🔄 Уже звонил {name}" / "Клиент сказал дорого — предложи рассрочку или скидку."
- "📅 Звонили вчера".
- Hint plate "💡 {Сегодня|Вчера|Позавчера HH:MM | DD.MM в HH:MM} — {не взял трубку|второй раз не ответил|телефон включён|обещал перезвонить|писали в Telegram|обещал прийти в магазин}".
- Callback: "⚠️ просрочен · {time}" or just the time.
- Alternate phone: "также: …". Product hint line.

**LeadCard actions**
- Green 📞 ("Позвонить и учесть").
- Split button "Bog'lanish ▾" (disabled without a phone), opening "📞 Qo'ng'iroq qildim" / "💬 Telegramda yozdim".
- Status buttons from the catalog.
- "Callback", "Отложить" or "Вернуть", "+ В продажу", ✕ ("Отказ").
- Every action plays a flash ring. After a call is marked, all buttons are replaced by "✓ звонок отмечен".

**Toasts**
- "✓ Позвонил — статус: в работе"
- "✓ Отказ — лид закрыт"
- "✓ Отмечено: TG'га боғланди"
- "✓ {emoji} {status}"
- "Звонок отмечен"
- Error: "Произошла ошибка"

**ClosedLeadCard:** grey avatar, name, status badge, phone, "Закрыт {сегодня HH:MM | вчера HH:MM | DD.MM, HH:MM}". No actions.

**ScheduleCallbackModal**
- Title "Callback · {name}".
- "Быстрое время" chips: "Через час" / "Через 3 часа" / "Вечером 19:00" / "Завтра утром 09:30".
- "Когда перезвонить" (datetime-local) and "Комментарий" (placeholder "Что обсудили?").
- Inline error "Укажите время" or the API text.
- Buttons "Отмена" / "Назначить" ("Сохранение…"). Toast "Callback назначен".

**PostponeModal**
- Title "Отложить на потом", subtitle "{name} · {phone|без телефона}".
- "Причина (необязательно)", placeholder "Например: «после обеда», «ждёт зарплату»", counter n/280.
- Inline API error. Buttons "Отмена" / "Отложить". Toast "Лид отложен".

**CallbackDueModal** (backdrop does not close it; Esc does)
- Pulsing alarm icon, eyebrow "Время колбэка", name, "{phone} · обещал перезвон в {time}", comment box.
- Buttons "Позвонить сейчас" / "+15 мин". Toasts "Отмечено сделанным" / "Отложено на 15 мин".
- Errors are silent. A dismissed reminder comes back on the next 30 s poll.

**CallOutcomeModal** (`components/CallOutcomeModal.tsx`)
- Opens when the operator returns to the tab at least 15 s after pressing 📞.
- "Как прошёл звонок?", name, phone.
- 2×3 tiles: "Поговорили, интерес" / "Просят перезвонить" / "Не берёт" / "Не тот номер" / "Отказ" / "Только Telegram".
- Comment "Комментарий (необязательно)" and "Пропустить".
- Backdrop click closes it without saving.

**Bugs**
- "+ В продажу" goes to `/sales/new?lead=`, which is manager-only, so operators are bounced back to `/my`. `/my/sale-new` also ignores `?lead=`.
- The CTA shows a double plus: "+ + Новая продажа".
- The gate card progress is hardcoded to "0 из N" with a 3% bar.
- The optimistic rollback uses a query key without `quotaMode`, so a failed status change leaves the wrong status on screen.
- Success toasts fire before the server responds, and the call option shows two toasts at once.
- After a call is marked, the card hides all actions until the page reloads.
- Mixed languages: "Bog'lanish", "Qo'ng'iroq qildim", "Telegramda yozdim" and "TG'га боғланди" sit in the RU dictionary; "Callback", "Сначала закрой это" and "Проверь дневные звонки" are hardcoded.
- The plan of 20 is hardcoded, and the percentage is (active + postponed) / 20, so more pending leads makes it look like more of the plan is done.
- "Позвонить сейчас" doesn't dial; it only marks the callback done.
- The CallOutcomeModal comment isn't cleared between calls. "Просят перезвонить" doesn't open the Callback modal. Closing via backdrop leaves the call pending, so the modal reopens on the next tab switch.
- The Callback modal accepts past times. "Вернуть" has no toast and no error handling. Reject has no confirmation.
- Dead code: OutcomeReasonModal and OutcomeTile are never used; `components/leads/LeadCard.tsx` and `SectionHeader` are not rendered.

## pages/OperatorSaleCreate.tsx
- **Header:** "Новая продажа" / "Заполните и отправьте менеджеру на подтверждение".
- **When errors show:** inline red text after a field is blurred or a submit was attempted. Any keystroke clears all server errors and the banner.
- **IMEI (15 цифр) \***
  - Digits only, capped at 15, letter keys blocked.
  - Hint: "{n}/15" (muted), "IMEI может содержать опечатку — проверьте" (amber; a failed Luhn check is only a warning and does not block), "IMEI валиден" (green).
  - Errors: "IMEI обязателен", "IMEI: только цифры", "IMEI должен состоять ровно из 15 цифр".
  - At 15 digits the TAC lookup silently overwrites the Model field.
  - Duplicate IMEI is checked only by the backend; its error appears under IMEI.
- **Модель \***
  - Placeholder "Начни вводить — выпадет список. Нет в списке? Впиши свой", but no list exists.
  - Errors: "Укажите модель телефона", "Модель — минимум 2 символа", "Слишком длинное название модели".
- **Сумма \*** (max 10 digits)
  - Errors: "Укажите сумму", "Сумма должна быть больше нуля", "Минимальная сумма — 1 000 сум", "Слишком большая сумма — проверьте цифры", "Сумма должна быть целым числом".
- **Канал \***
  - Combobox, placeholder "Выберите канал". "+ Добавить канал" (max 2) switches the label to "Оплата по каналам 2/2" and adds a per-row "Сумма", a ✕, and "↓ Заполнить остаток ({n})".
  - Live line: "Суммы сходятся с общей" (green) / "Осталось распределить: {n} сум" / "Превышение на {n} сум" (red).
  - Errors: "Выберите канал", "Можно указать не более 2 каналов оплаты", "Один и тот же канал выбран дважды", "Укажите положительную сумму по каждому каналу", "Сумма по каналу должна быть целым числом", "Сумма по каналам не равна общей сумме продажи".
- **Имя клиента \***
  - Placeholder "Иванов Иван". Errors: "Укажите имя клиента", "Слишком длинное имя".
- **Телефон клиента \***
  - "+998 " prefix is locked; 9 digits max.
  - After 4 digits (300 ms debounce) a lead dropdown appears: name, phone, "📄 source", status pill.
  - Picking a lead turns the field into a locked chip with ✕ (unlink) and skips phone validation.
  - Errors: "Укажите телефон клиента", "Формат: +998 XX XXX XX XX (12 цифр)".
- **Комментарий:** counter n/500; error "Комментарий — максимум 500 символов".
- **Фото договора \***
  - Hint "От 1 до 5 фото. Cmd/Ctrl+V из буфера, drag-drop или выберите файл." Buttons "Камера" / "Выбрать файл" / "Добавить", counter n/5. Anything over 5 is dropped silently.
  - Errors: "Прикрепите фото договора", "Фото больше 10 МБ — уменьшите размер", "Только изображение (JPG, PNG, WebP)", "Можно приложить не более 5 фото".
- **Summary tile:** "К отправке: {N} сум" when the amount is above 0.
- **Buttons:** "Отмена" (history back, no unsaved-changes guard) and "Отправить менеджеру" (shows "Загрузка…"; disabled until everything is valid).
- **Submit outcomes**
  - Success: toast "Отправлено на подтверждение", then navigates to `/sales/:id`.
  - Field errors from the server: inline under the field plus banner "Ошибка при отправке — проверьте выделенные поля"; scrolls and focuses the first one. DRF English messages become "Некорректное значение" / "Обязательное поле".
  - Other errors: banner with `detail` or "Не удалось отправить. Проверьте поля."
- **Bugs**
  - Because the button stays disabled, the summary banner "Заполните / проверьте: …" can never appear. Untouched invalid fields give no hint at all; the button is just grey.
  - Lead-status pills mix languages ("Javob bermadi 1", "Telfoni ochiq", "TG'га боғланди", hardcoded in `lib/leads.ts`).
  - "сум" is hardcoded.

## components/CheckinGate.tsx
- Full-screen, cannot be closed. Shown when check-in is required, there is no open shift, no backfill is pending, and the route is not `/scan`, `/kiosk` or `/login`. Polls every 5 s and disappears by itself.
- Content:
  - Eyebrow "Отметьтесь чтобы работать", title "Начните смену — отсканируйте QR".
  - Body: "Без отметки прихода рабочие экраны CRM недоступны. Возьмите телефон и наведите камеру на QR-код ниже."
  - Green button "Я на смене — начать работу" ("Отмечаемся…"); inline error below.
  - "или отсканируйте QR с телефона".
  - QR box: "Готовим QR-код…" or a red API error.
  - "Что делать" steps: 1 "Наведите камеру телефона на QR", 2 "На телефоне откроется страница отметки", 3 "Сделайте селфи — статус здесь обновится сам".
  - Footer "Ожидаем скан…".
- If the backend answers `photo_required`, the button is hidden and only the QR remains.

## components/CheckoutBackfillGate.tsx
- Full-screen, no skip.
- Content:
  - Eyebrow "Вчерашняя смена не закрыта", title "Во сколько вы вчера ушли?".
  - Body: "Вы забыли отметить уход. Смена была авто-закрыта в 23:00 — введите фактическое время… Приход был {date} в {time}."
  - Time picker "Фактическое время ухода", default check-in + 8 h.
  - Live line "Смена получится: {h} ч {m} мин", or in red "Уход не может быть раньше чем через 30 минут после прихода" / "Смена не может длиться больше 14 часов".
  - API error box. Button "Подтвердить время ухода" ("Сохранение…"). Hint "Пропустить нельзя — введите время когда реально ушли".
- **Bugs:** a checkout after midnight can't be entered (the date is fixed to the check-in day). The date is always formatted in Russian. "вчера" is shown even when the open log is up to 3 days old.

## components/CheckoutReminderBanner.tsx
- Orange strip under the header. Polls every 60 s. Hidden on `/scan`, `/kiosk`, `/login` and `/my/sale-new`.
- "Не забудьте отметиться об уходе" / "Прошло 8 часов работы. Если сейчас не отметитесь, смена закроется автоматически в 23:00."
- Buttons "Завершить смену" and × ("Закрыть"). Dismissal is remembered per shift in localStorage.
- **Bug:** "Завершить смену" also dismisses the banner, then only scrolls to the widget or hard-reloads `/my`. It never opens the checkout flow.

## components/AttendanceStatusWidget.tsx (on /my)
- **Off shift:** "Смена не начата" / "Начните смену", green "Начать смену".
- **On shift:** "На смене" / "Пришли в {t}", "Уже работаете: {dur}" (updates every 30 s), "⚠ Опоздание", 52 px selfie thumbnail, orange "Завершить смену". Busy: "Отправляем…".
- No loading state: it shows "off shift" while data loads.
- **QR modal**
  - Eyebrow "Отметка прихода" / "Отметка ухода", "Отсканируйте QR телефоном".
  - "На компьютере нет камеры — сделайте фото с телефона…"
  - QR loading or error, steps "Как это работает" (1–3 as in CheckinGate).
  - Link "Использовать камеру этого ПК", footer "Ожидаем скан…".
  - Polls every 5 s and closes itself when the shift state changes.
- **Success overlay** (closes after 4.2 s or on tap): "СМЕНА НАЧАТА" / "СМЕНА ЗАВЕРШЕНА", "Приход в {t}" / "Уход в {t}", "Отработано: {h} ч {m} мин".
- **Error toast:** the API message with an action button "Проверить статус".
- Checkout has no confirmation step.

## pages/Scan.tsx and pages/ScanPhotoFlow.tsx
- **`/scan` without `?qr=` and `/kiosk` (KioskMode, all hardcoded Russian):**
  - "Войти по паролю", "Распечатайте свой QR и наклейте на бейдж".
  - "Персональный QR оператора — на странице «Оператор → QR». Ниже — общий заглушка-код…"
  - "Ссылка: …", "Скачать PNG", "Перерисовать".
  - Bug: the generic QR encodes `/scan` itself, so scanning it lands on the same page.
- **ScanPhotoFlow loading / error:** "Загрузка…". Error: ✕ "Не удалось прочитать QR" + message + "Войти по паролю". The "QR-код не указан…" message can't be reached.
- **Main screen:**
  - Eyebrow "ПРИХОД НА СМЕНУ" / "ЗАВЕРШЕНИЕ СМЕНЫ", operator name, orange "Подтверждение ухода" in checkout mode, "На смене с {t}".
  - "Сделайте селфи для отметки прихода/ухода" / "На фото должно быть чётко видно лицо. Одну и ту же фотку использовать нельзя."
  - "Открыть камеру" (same label for in and out), "Отправляем фото…", red inline error, link "Войти по паролю".
- **Success overlay** (4.2 s): status, name, time, duration, "⚠ Опоздание", photo, "Готово". There is no link to the CRM afterwards.

## components/CameraCapture.tsx (full-screen black)
- Header: × ("Закрыть"), title "Селфи для смены" (also used for sale-contract photos) or "Проверьте фото", flip button ("Другая камера").
- States: "Открываем камеру…" → live view with shutter (disabled until ready) → preview with "Пересделать" / "Отправить" ("Отправляем…").
- Fallback: "Камера недоступна" / "Разрешите доступ к камере в настройках браузера — или загрузите фото из галереи." + "Выбрать фото".
- Toasts: "Камера ещё не готова, подождите секунду", "Не удалось сделать снимок".

## components/PinGate.tsx (manager attendance pages)
- Loading: "Загрузка…".
- PIN not set: "PIN не установлен" + "Обратитесь к супер-админу, чтобы он задал общий PIN…" (the same text appears twice).
- Enter form:
  - "Введите PIN" / "Доступ к разделу «Посещаемость» защищён общим 4-значным PIN."
  - 4-digit field (placeholder "PIN").
  - Errors: "Ровно 4 цифры" or the API text; the field is cleared.
  - Button "Войти" (shows "…", disabled until 4 digits).
  - Hint "Забыли PIN? Попросите супер-админа сбросить его в «Настройках»."
- Error toast 60 s before the session expires: "PIN-сессия истекает через минуту — потребуется ввести PIN снова". Polls every 60 s and on focus.
- **Bug:** if the status request fails, the page shows "Загрузка…" forever.

## Overlays
- **MorningGreeting**
  - Modal "Доброе утро!" (UZ "Xayrli tong!"), AI quote, author, button "Приступить" (UZ "Boshlash").
  - Backdrop click closes it and calls dismiss.
  - Language comes from the profile's `preferred_language` (default `uz`), not the UI toggle. Old styling (`btn-primary`, amber).
  - Can show underneath CheckinGate at the same time.
- **BirthdayCelebration**
  - Once a day: confetti and toast "🎂 С днём рождения, {name}!".
  - Sticky gradient banner "Сегодня ваш день рождения — {name}. Хорошего дня!" with ×, dismissed per day.
- **SaleCelebration**
  - Triggered by SSE, or by polling every 30 s for notifications under 2 min old.
  - Gradient card: "Новая продажа!", "{name} продал(а) {device}! 🎉" or "{name} закрыл(а) продажу! 🎉" ("Коллега" if no name), avatar, × ("Закрыть"). Confetti and applause.
  - Closes after 4 s. A second sale arriving meanwhile is dropped (marked read, never shown). The same sale can show twice (SSE and poll).
- **SnapshotRequestPrompt** (SSE only, all hardcoded Russian)
  - "Запрос снимка", "{Менеджер} просит сделать снимок с камеры. Он станет вашим аватаром."
  - Buttons "Отменить" / "Да, сделать". Closes itself after 60 s.
  - Then "Делаем снимок…" (1.5 s video preview) → "Загрузка…" → "✓ Снимок отправлен" (closes after 1.5 s).
  - Errors: "Доступ к камере запрещён в браузере." / "Не удалось сделать снимок. Попробуйте ещё раз." with only a "Закрыть" button (no retry).
- **LiveStreamPublisher** (bottom-left pill; checks a global switch every 10 s)
  - "Вы в эфире" (pulsing dot; × "Закрыть эфир на эту сессию")
  - "Включение камеры…"
  - "Камера заблокирована браузером"
  - "Ошибка эфира" (tooltip shows the raw error)

## components/helper/*
- **HelperButton:** bottom-right, 24 px from the edges. Badge shows the total; it is red if anything is urgent.
- **HelperPanel:** title "Помощник", × "Закрыть", Esc and backdrop close it.
- **Tabs:** "Подсказки (n)" / "Частые вопросы (n)".
- **States:**
  - Loading: "Загрузка подсказок…"
  - Error: "Не удалось загрузить подсказки. Попробуйте позже."
  - Empty: "Всё в порядке — рекомендаций сейчас нет."
  - FAQ empty: "Пока нет вопросов."
  - Footer: "Обновляется каждую минуту." (polls every 60 s)
- **SuggestionCard:** severity badge "Срочно" / "Внимание" / "К сведению", title, body, action button (backend label or "Открыть") that navigates and closes the panel. FaqAccordion opens one item at a time.

## pages/Login.tsx
- Language tabs RU/UZ, "Вход в систему" / "Учёт продаж и управление операторами".
- **Mode toggle:** phone, labelled "Оператор — номер в формате" (an unfinished sentence), or "Логин".
- **Fields:**
  - Phone (PhoneInput): red border only, no message.
  - Password with show/hide (aria "Hide"/"Show" in English).
- **Errors:** red box with the backend message (DRF may return English).
- **Button:** "Войти" ("Вход…"), disabled until valid.
- **Footer:** hint "+998 90 000 00 00", or "manager · qa · admin" in text mode, which exposes demo usernames.
- **Bugs:** "Забыли пароль?" has no handler. Logged-in users aren't redirected away from `/login`. There is no message after a forced logout.

## pages/Profile.tsx
- **Hero:** avatar or initials, name, role or "—", sticker plus "rare" badge, button "QR check-in". Bug: it goes to the `/scan` kiosk poster.
- **Attendance card** (operator; hardcoded Russian)
  - Labels "СМЕНА ИДЁТ" / "СМЕНА ЗАКРЫТА", "Пришёл в HH:MM · X ч Y мин", "⚠ ОПОЗДАНИЕ", "Нажми чтобы начать смену".
  - Button "Начать смену" (green) / "Завершить смену" (red) → "…" → "⏱ {n} сек" (30 s cooldown).
  - Toasts: "🟢 Приход отмечен" / "· опоздание" / "🔴 Уход отмечен · смена N ч"; errors show the API message or "Ошибка check-in/out".
  - Bugs: no photo or QR (bypasses the CheckinGate flow), no confirmation, and it uses a separate cache key so the other widgets lag behind.
- **"Мои данные" — Дата рождения**
  - Hint "Год виден только менеджеру…".
  - Value or "Не указана"; buttons "Выбрать" / "Редактировать" / "Убрать"; edit mode with a date input and "Сохранить" / "Отмена".
  - Toasts "Настройка сохранена" / the error or "Не удалось сохранить настройку".
- **Аватар / Фото профиля** (hardcoded Russian)
  - "Виден коллегам в overlay-овациях…", placeholder "нет фото".
  - Buttons "Загрузить файл" / "📷 Сделать с камеры"; webcam view with "Отмена" / "Снять"; "Загрузка…".
  - Toast "Аватар обновлён". Errors: "Не удалось загрузить. Попробуйте ещё раз." plus toast "Не удалось загрузить аватар"; "Доступ к камере запрещён в браузере." / "Камера недоступна."
  - No preview or confirmation after taking the shot.
- **Настройки rows**
  - Theme "Светлая / Тёмная".
  - Language "Русский / O'zbekcha" → toast "Язык переключён".
  - "Ежедневный разбор" toggle (optimistic) → "Настройка сохранена" / "Не удалось сохранить настройку".
  - "Мой стикер": "Выбрать" or "{emoji} Редактировать".
  - "Пароль": the button says "Сбросить" but opens a change dialog.
- **PasswordModal**
  - "Смена пароля", subtitle "Минимум 8 символов".
  - Fields "Текущий пароль" / "Новый пароль" / "Повторите новый пароль" (eye toggles "Показать/Скрыть пароль").
  - Errors: "Новый пароль должен быть не короче 8 символов", "Пароли не совпадают", the API field error, or "Не удалось изменить пароль".
  - Buttons "Отмена" / "Сменить" ("Сохранение…", disabled until all filled). Toast "Пароль изменён".
- **Telegram-bot section**
  - "Уведомления в Telegram" + hint, button "Получить код для привязки".
  - Code state: large code, "Копировать" / "Скопировано" (1.5 s), "Откройте бота @naffai_bot", "Отправьте команду: /link {code}", "Код действует 10 минут. Не делитесь им ни с кем."
  - Linked state: "✓ Привязано", "chat_id: …", "Отвязать" → toast "Telegram отвязан".
  - Bugs: no countdown, no polling for the link to complete (the page doesn't update until refresh), errors on generating the code are silent, and unlinking has no confirmation.
- **Telegram userbot section**
  - "Проверяем статус…"
  - Connected: "подключено @user · date", backfill line ("⏳ Загружаем историю: …", "⏳ В очереди на загрузку истории", "✓ История загружена (…)", "⚠ {error}"), "Отключить" (no confirmation) → toast "Telegram отключён".
  - Error: red box with the error or "Неизвестная ошибка" + "Переподключить".
  - Not connected: "Подключить Telegram".

## components/TgConnectWizard.tsx
1. "Шаг 1 из 3" — "Подключить Telegram": "Номер телефона Telegram" plus a consent checkbox ("Разрешаю подключить мой Telegram-аккаунт в режиме чтения…"). Button "Отправить код" ("Отправка…"), disabled until the phone is valid and consent is ticked, so the "Необходимо согласие" error can't appear.
2. "Код из Telegram": "Мы отправили код в приложение Telegram на {phone}…", field "Код", buttons "Назад" / "Проверить" ("Проверяем…").
3. "Облачный пароль": "У аккаунта включена двухфакторная защита…", field "Облачный пароль (2FA)", buttons "Назад" / "Завершить".

- Success: toast "Telegram подключён". Errors appear inline from the API.
- **Bugs:** it says "из 3" even when 2FA isn't needed. A backdrop click loses the session mid-flow. There is no resend or timer. In step 3 a non-"active" status does nothing.

## Other components
- **components/StickerPicker.tsx** (legacy modal, hardcoded Russian): "Мой стикер", emoji grid with tooltips "Занят: {owner}" (disabled) / "Ваш текущий" / "Выбрать", "Убрать стикер", inline error.
- **components/TgDialogsPanel.tsx:** used only on manager pages (Operators / OperatorDetail), not by operators.

## pages/MyDayOff.tsx
- **Form "Новая заявка":** "Менеджер рассмотрит и одобрит либо отклонит"; "Дата" (today to +60 days); "Причина" (placeholder "Например: семейные дела, поход к врачу…", max 2000).
- **Button:** "Отправить заявку", disabled without a date.
- **Toasts:** "Заявка отправлена — ждём решение менеджера" / the error or "Не удалось отправить заявку".
- **History list:** "История заявок", status pills "На рассмотрении" / "Одобрен" / "Отклонён", "Решение: {note}"; empty "Пока нет заявок".
- **Bugs:** a request can't be cancelled; "today" is computed in UTC, so it is wrong before 05:00 Tashkent time.

## pages/MyPayroll.tsx
- **Controls:** "Месяц" picker; "Excel" / "PDF" buttons ("Загрузка…", disabled without data).
- **Content:**
  - Gate cards "Attendance" (English label) and "Продажи", each with "Гейт пройден" / "Гейт провален".
  - "К выплате … из {max}".
  - Warning: "Оба гейта должны быть пройдены. Даже если один блок закрыт — оплата 0 UZS…"
  - Shortfall lines: "Нужно посетить ещё {n} дн., чтобы пройти гейт", "До гейта осталось продать на {amount}".
  - Per-day statuses: "Вовремя / Опоздание / Пропуск / Выходной / Прощённый пропуск".
- **States:** loading "Загрузка…"; empty or error "Нет данных за выбранный диапазон" (the two are merged).
- **Bug:** download errors are silent (no catch).

## pages/MySales.tsx
- KPIs "Всего продаж" / "Моя доля". Columns "Дата", "Модель / Клиент", "Канал", "Сумма" ("всего:" for shared sales).
- Loading "Загрузка…"; empty "Пока нет продаж. Как только оформишь первую — появится здесь." Rows link to the sale page.
- **Bug:** sale status isn't shown, so pending and rejected sales look the same.

## pages/MyActivity.tsx
- Presets "Сегодня / Вчера / 7 дней / 30 дней / Этот месяц / Свой диапазон" (two date inputs).
- Loading "Загрузка отчёта…"; empty "Нет активности за выбранный период".
- "По статусам" (empty "Ни один лид ещё не в статусе").
- Sales block: "Мои продажи / Всего: / моя доля: / показано {shown} из {n}", empty text.
- **Bugs:** no navigation link anywhere points here; no from/to validation; errors aren't handled.

## pages/Notifications.tsx
- Header line "{unread} новых · всего {total}" or "Всего {n}". Button "Прочитать всё" (only when there are unread) → toast "Все уведомления прочитаны". Polls every 30 s.
- Clicking an item marks it read and navigates to its link. Empty "Уведомлений пока нет".
- "Подписки" toggles: "Новые лиды", "Колбэки со звуком", "Уроки и разборы", "Ежедневный отчёт по KPI".
- **Bugs:** the toggles are local state only, yet show "Настройка сохранена". No pagination or error state.

## Lessons and training
- **pages/DailyLesson.tsx**
  - Loading "Загрузка разбора…". Any error, including server errors, shows "Утренний разбор ещё не готов" / "Если вчера не было продаж или диалогов…" + "История моих разборов →".
  - Feedback "Помог ли разбор?" with "Помог" (saves immediately) or "Не помог".
  - "Не помог" opens a modal: "Что было не так?", optional comment, "Отмена" / "Сохранить".
  - Toasts "Спасибо, оценка сохранена" / "Ошибка".
  - Bug: cancelling the modal leaves "Не помог" highlighted but unsaved.
- **pages/LessonsHistory.tsx:** "{n} разборов", button "Сегодняшний разбор", accordion by date that loads detail on open, "не прочитан" badge, empty "История пока пуста".
- **pages/TrainingList.tsx:** cards with "Видео" / "Файл" / "Вопросов: {n}" and "Пройдено" / "Не пройдено"; empty "Пусто" / "Менеджер пока не добавил обучающих материалов."
- **pages/TrainingLessonView.tsx**
  - Video: YouTube iframe, `<video>`, or link "Открыть видео в новой вкладке". File: "Файл прикреплён" / "Скачать".
  - Test: radio questions; "Отправить ответы" ("Отправка…") enabled only when all are answered → toast "Ответы отправлены" / "Не удалось отправить".
  - After submitting: "Результат {n}%", the chosen answer marked green or red, "Вы уже прошли этот тест — результаты выше."
  - Comments: empty "Пока комментариев нет — будьте первым.", placeholder "Ваш комментарий", error toast "Не удалось отправить".
  - Bugs: a 404 or other error leaves "Загрузка…" forever; no retake; the correct answer isn't revealed; result colours are light-theme only.

## Calculator and catalog
- **pages/Calculator.tsx**
  - Fields: product combobox ("Товар (поиск по бренду/модели)"), "Ariza miqdori", "Oldindan to'lov". These two labels and "Ariza narxi" are Uzbek inside the RU dictionary.
  - Tier cards "мес / в месяц / Комиссия / Итого к выплате" (click to select).
  - "Копировать расчёт" → toast "Расчёт скопирован", or the raw browser error.
  - Bugs: a request error shows "Нет активных тарифов — добавьте их в разделе «Тарифы рассрочки»", which also points operators at a manager-only page; no check that the down payment is below the amount.
- **components/InstallmentPanel.tsx:** "Рассрочка", "Банк", "Переплата", "/ мес"; loading; "Не удалось загрузить рассрочку"; "Банки рассрочки ещё не настроены".
- **pages/Catalog.tsx (operator view)**
  - Search "Поиск по бренду или модели"; stock filter "Все / В наличии / Под заказ / Нет".
  - Copy buttons "Текст" / "Фото" (disabled with no cover) / "Marketing". Toasts: "Скопирован текст", "Фото скопировано", "Marketing-текст скопирован в буфер", "Нет фото", "Не удалось скопировать: {msg}".
  - Bug: the empty state "Каталог пуст / Добавьте первый телефон…" is shown to operators and on searches with no results.

## Leaderboard and screen
- **pages/Leaderboard.tsx**
  - Periods "Сегодня / Неделя / Месяц / Всё время". "Топ-5" podium and "Остальные" list with a "Вы" badge and highlighted row; "стажёр"; totals; empty "Пока нет продаж" / "За выбранный период нет ни одной подтверждённой продажи".
  - Bugs: no loading state, an error shows as the empty state, no polling.
- **pages/Screen.tsx** (hardcoded Russian, refreshes every 30 s)
  - "Табло продаж · сегодня", "обновление каждые 30 сек", "Выйти", empty "Пока нет данных за месяц".
  - Bugs: the title says today but the data is the month; "Выйти" just goes to `/` and doesn't log out.