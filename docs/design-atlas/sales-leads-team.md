I've covered every file in scope. Below is everything a designer needs to draw, grouped by file, with the real Russian text resolved from `lib/i18n.ts`. Some screens have no Russian text at all because their strings are hard-coded in Uzbek; I flag those as **[UZ hard-coded]**.

**Corrections to the brief**
- **DeletedOperators.tsx has no restore flow.** It is a read-only audit log with one detail modal.
- **OrphanLeads.tsx has no "distribute all" confirmation.** The button acts on the first click.
- **SaleCreate.tsx has no "max 2 partners" rule.** That limit exists only in the operator's form (`OperatorSaleCreate.tsx`).
- **OperatorDetail.tsx has no "delete operator" modal.** Its delete modal deletes the login account only.
- **Unused code:** `AccountControls.tsx` and `components/sales/SalesFormModal.tsx` are not imported anywhere, so users never see them.
- **Photo uploaders are out of this scope:** `PhotoUploader` / `PhotosUploader` are used only by the Catalog and the operator's sale form.

---

## Global behaviour (applies to every page)

- **Toasts:** bottom-center dark pill, 2.4 s. Some toasts have an action button ("Открыть").
- **Session expired (401):** retried silently once. If it fails again, the user is sent to /login with no message.
- **No permission (403):** global toast "Доступ запрещён". Calls to the /my/ endpoints are excluded.
- **Fallback error text:** "Ошибка" when the server sends nothing usable.
- **Modals:** close on ESC and on backdrop click. There is no built-in close (X) button; only some modals draw their own.
- **Missing translation keys show as raw key strings.** The `t(...) || "fallback"` pattern never reaches the fallback, because `t()` returns the key instead of an empty value.

## components/RoleGate.tsx + App.tsx routing

**Roles**
- **manager:** backend roles manager, team_lead and superadmin all count as manager here.
- **super_manager:** gets every manager page plus /team/*.
- **superadmin:** bypasses all role checks and can open everything.

**Routes**
- **Manager + super_manager:** /sales, /sales/new, /sales/:id/edit, /sales/pending, /sales-today, /leads, /leads/orphans, /leads-stats, /statuses, /sheet-sources, /operators, /operators/:id, /operators/day-off, /users, and all other manager pages.
- **super_manager only (plus superadmin):** /team/sales, /team/operators (same Operators page), /team/managers, /team/deleted-operators. A plain manager is redirected to "/".
- **superadmin only:** /leads/system-lost. Everyone else is redirected to "/".
- **Not gated:** /sales/:id is open to operators too. They see no action buttons, and the back link goes to /sales, which bounces them to /my.
- **PIN required:** /attendance/* is additionally wrapped in a PIN check.

**Home page ("/") by role:** operator → /my, super_manager → /team/sales, everyone else → Dashboard.

**Access denied:** silent redirect with no message or screen. Operator → /my, others → "/", unknown role → /login. There is no 403 page to design unless you want to add one.

**Sidebar**
- super_manager and superadmin get the "my branch" group (Моя команда — продажи, Ожидают подтверждения, Операторы, Мои менеджеры, Удалённые операторы, Аналитика, Лидерборд, …) **plus** the full manager menu.
- This duplicates items: pending sales, analytics, leaderboard and lessons each appear twice.
- superadmin also gets "Фото сотрудников" and "Системно потерянные".

---

## pages/Sales.tsx

- **Search placeholder:** "Поиск по IMEI, модели, оператору…"
- **Status chips:** "Все / Продажи / Возвраты / Подарки"
- **"Фильтры" panel**
  - Counter badge showing the number of active filters.
  - Presets: "Сегодня / Вчера / 7 дней / Этот месяц / Прошлый месяц"
  - "Дата от", "Дата до", "Партнёры" (multi-select), "Операторы" (multi-select), "Источник" ("Все источники")
  - "Сбросить" appears only when a filter is active.
- **Conditional "Сводка за период" card** (only when a date is set): "{n} продаж · сумма", columns "Кто сколько продал" and "Что продавали". Empty: "Нет данных".
- **States**
  - Loading: "Загрузка…"
  - Empty: "Ничего не найдено — измените запрос или фильтры"
  - Excel button shows "…" and is disabled while downloading.
  - Pagination: "На странице:", "1–50 из N", "Назад/Вперёд" disabled at the ends.
- **Row badges:** "возврат" (danger), "ожидает" (hot), "оплачено".
- **Bugs**
  - Rejected sales show the "оплачено" badge; there is no "отклонена" badge.
  - Excel export has no error handling: a failure is silent.

## pages/SaleDetail.tsx

- **States**
  - Loading: "Загрузка…"
  - Error / not found: red box "Продажа не найдена" + "Назад к списку".
  - Badges: "возврат" / "удалена" / "ожидает" / "оплачено".
- **Conditional blocks**
  - "Оплата по каналам" split list (2+ partners).
  - "Сплит:" for operator percentages.
  - "Комментарий"
  - Orange bonus box "Бонус / особые условия"
  - "Источник лида"
  - "Договор" photo grid; opens a fullscreen gallery with ‹ › arrows and "n / N".
  - Red box "Продажа отклонена. Причина:" + reason text.
- **IMEI copy:** toast "Скопировано" / "Не удалось скопировать".
- **Action bars (manager / super_manager only)**
  - Pending sale: "Одобрить" (shows "Загрузка…" while working), "Исправить и одобрить" (goes to the edit form), "Отклонить".
  - Not pending and not deleted: "Редактировать", "Оформить возврат" (hidden if already returned), "Удалить".
- **Reject modal:** "Отклонить продажу"
  - Hint: "Оператор увидит эту причину в уведомлении и на карточке продажи."
  - Field "Причина", placeholder "Например: IMEI не совпадает с фото договора". Required: button disabled while empty.
  - Toasts: "Продажа отклонена" / "Не удалось отклонить".
- **Return modal:** "Оформить возврат"
  - Subtitle "Продажа #{id} · {model}".
  - Field "Причина возврата", placeholder "Например: брак экрана, клиент передумал". Required.
  - Button shows "Оформление…" while working.
  - Toasts: "Возврат оформлен" / "Не удалось оформить возврат".
- **Delete modal:** "Удалить продажу?" (red title)
  - Body: "Продажа #{id} — {model} · {sum}. Будет помечена как удалённая, восстановление — через админку."
  - Button shows "Удаление…"; on success navigates to /sales.
  - Toasts: "Продажа удалена" / "Не удалось удалить продажу".
- **Approve toasts:** "Продажа подтверждена" / "Не удалось подтвердить".
- **History card:** "История изменений". Fallback entries: "Продажа создана · {sum}", "Обновлена запись"; actor "система".
- **AI panel ("AI-анализ")**
  - **It is fake:** the insights are hard-coded, not real analysis.
  - "Заново" → "сравниваю с 1284 продажами за месяц…" → toast "Анализ обновлён".
  - Footer: "Анализ для продажи #{id} · mock".
- **Bugs**
  - A rejected sale shows the "оплачено" badge and still offers edit/return/delete.
  - "Исправить и одобрить" opens the edit form, but saving there only updates the sale. It never calls approve.

## pages/SaleCreate.tsx (new and edit)

- **Header:** eyebrow "NEW"/"EDIT"; title "Новая продажа" / "Редактировать продажу".
- **Edit loading:** "Загрузка…"
- **Fields**
  - **"IMEI (15 цифр)":** digits only, 6–15 allowed. Live hints:
    - "{n} цифр (минимум 6)"
    - "→ {model}" (model recognised)
    - "модель не определена, заполни вручную"
  - **"Модель":** autocomplete. Placeholder "Начни вводить — выпадет список. Нет в списке? Впиши свой".
  - **"Кол-во, шт":** hint "Сумма ниже — за всю продажу, не за штуку."
  - **"Имя клиента":** placeholder "Иванов Иван".
  - **"Телефон клиента"**
    - Lead lookup dropdown from 4 digits: name (or "Без имени"), phone, source, product, operator, status chip.
    - Once a lead is picked, it shows as a chip: "Привязан к лиду · {status}" with an X to unlink.
    - Red warning (9+ digits, no match): "⚠️ Клиент не найден в списке лидов. Продажа сохранится без источника — мы не сможем понять с какого шита пришёл клиент. Проверь номер или оформи как «прямую» продажу."
- **"Операторы" and "Партнёры" line editors**
  - "+ добавить" adds a line; trash icon removes one (hidden when only one line).
  - Each line: combobox "Выбрать или ввести имя…" + "Сумма".
  - Inline error under the amount: "мин 1 000".
  - Note: "Новые имена добавятся автоматически при сохранении."
- **Totals tile** (amber outline when the sums don't match or the discount is too big)
  - "Сумма по операторам:", "Сумма по партнёрам:"
  - Mismatch: "Суммы не совпадают на {n} сум. Проверьте строки."
  - "Итого продажи:"
  - With a discount: "Скидка:" "− {n} сум", "Итог (с учётом скидки):" (green), "Кредит операторов будет уменьшен пропорционально на сумму скидки."
- **"Скидка (необязательно)":** red border when too big. Hint "Скидка пропорционально уменьшает кредит каждого оператора. Партнёры (способы оплаты) сохраняют свои суммы."
- **"Комментарий"**
- **Bonus checkbox:** "🎁 Был бонус или особые условия" → textarea, placeholder "Например: подарочный чехол, скидка 20 000, обмен старого телефона…", hint "Менеджер получит уведомление с текстом бонуса — не забудьте описать суть."
- **Duplicate IMEI** (appears only after the server reports a duplicate)
  - Amber block: "IMEI уже встречался. Подтвердите дубликат с комментарием:"
  - Input placeholder "Причина (замена, обмен, ошибка ранее…)". The reason is not required; the user re-submits.
- **Submit validation messages** (single red banner above the buttons, checked in this order)
  1. "IMEI: только цифры, от 6 до 15"
  2. "Добавьте минимум одного оператора с суммой > 0"
  3. "Добавьте минимум одного партнёра с суммой > 0"
  4. "У всех операторов должна быть положительная сумма"
  5. "У всех партнёров должна быть положительная сумма"
  6. "Минимальная сумма по строке — 1 000 сум"
  7. "Сумма по операторам ({op}) ≠ сумма по партнёрам ({partner})"
  8. "Скидка не может быть отрицательной"
  9. "Скидка не может быть равна или превышать сумму продажи"
  10. "Опишите бонус хотя бы 3 символами"
  11. Server error text, or "Ошибка сохранения"
- **Buttons:** "Отмена" (browser back), "Сохранить" / "Сохранить изменения".
- **Bugs**
  - No saving or disabled state on submit, so a double submit is possible.
  - No success toast.
  - The "IMEI (15 цифр)" label contradicts the 6–15 rule.
  - Unlimited partner lines, while the operator's form caps them at 2.
  - If the sale fails to load in edit mode, the form is simply empty.

## components/sales/SalesFormModal.tsx — unused

- **Title:** "Новая продажа" / "Редактировать продажу"; subtitle "IMEI + модель + сумма + сплит по операторам".
- **IMEI hints:** "Введите 15 цифр — модель подставится автоматически", "Осталось N цифр", "Неверный IMEI — не проходит проверку Луна" (red), "IMEI валиден · TAC найден", "IMEI валиден · TAC неизвестен, укажите модель".
- **Duplicate banner:** "Этот IMEI уже встречался…"
- **Split counter:** "{x}% из 100%". Save is disabled until IMEI valid + model + amount + split = 100%.
- **Loading lists:** "Каналы загружаются…", "Операторы загружаются…".
- **Toast / error:** "Продажа сохранена" / "Не удалось сохранить продажу". Saving label: "Сохраняем…".

## pages/SalesPending.tsx

- **States**
  - Loading: "Загрузка…"
  - Empty card: "Нет продаж на подтверждении" + "Все продажи операторов уже обработаны."
  - Refreshes every 30 s.
- **Cards:** select checkbox, photo or camera placeholder, "+N" photo count, IMEI copy, split chips.
- **Select-all link:** "Выбрать все" ↔ "Сбросить".
- **Floating bulk bar:** "{n} выбрано", green "Одобрить все" (no confirmation), red "Отклонить все", "Сбросить". All disabled while running.
- **Reject-all dialog** (custom overlay: no ESC or backdrop close)
  - Title "Отклонить {n} продаж", label "Причина отклонения", placeholder "Кратко почему отклоняем — оператор увидит".
  - Required: button disabled while empty.
- **Toasts:** "Обработано {ok} · пропущено {skipped} · ошибок {errors}"; error shows server text or "Ошибка".

## pages/SalesToday.tsx

- **Empty states:** "Сегодня ещё не было продаж" (table), "Пока пусто" (channel breakdown). Loading: "Загрузка…".
- **Mini tiles:** "Средний чек", "Операторов", "К плану дня", "Штук".
- **Labels:** "С 09:00", "{n} продаж · клик открывает карточку".
- **AI-анализ дня:** also fake/hard-coded. "Заново" → "сравниваю с продажами за месяц…" → toast "Анализ обновлён".
- **Bug:** only the first 30 rows are shown, with no "show more".

## pages/MyTeamSales.tsx (super_manager)

- **Periods:** "Сегодня / Неделя / Месяц". **Tabs:** "Всё итого / Прямые / По менеджерам".
- **KPIs:** "Продажи за период", "Активных операторов · N стажёров", "Мои менеджеры · N операторов всего".
- **Empty states**
  - Direct tab: "Нет прямых операторов. Назначьте оператора на себя через карточку оператора."
  - By-manager tab: "Пока нет менеджеров под вами."
- **Bugs**
  - No loading state: zeros show while data loads.
  - "By manager" counts only managers who report to this super_manager, while MyManagers lists all managers in the system, so the two pages disagree.

---

## pages/Leads.tsx

- **Sheet sync bar** (see SheetSyncBar below), then source chips ("Все источники").
- **Search:** "Поиск: имя, телефон, товар…". **Quick chips:** "Все лиды / Нужна проверка / Без оператора".
- **Counters:** "Выбрано: {n}" or "Всего: N · {n} просрочено".
- **Buttons:** "Назначить оператора" (disabled with no selection), "Снять выбор".
- **States:** loading "Загрузка…"; empty "Лидов пока нет". Row: "нет телефона" (red), "не назначен".
- **Assign modal:** "Назначить оператора · {n}"
  - Subtitle "Один лид будет переназначен" / "{n} лидов будут переназначены".
  - "Оператор" select: the first operator is preselected.
  - "Причина (необязательно)", placeholder "Например: alias «Sevara» → Sevara Karimova".
  - Red inline error with server text; buttons "Назначить" / "Сохранение…".
  - Toast: "Оператор назначен".
- **Bugs**
  - Clicking a row toggles selection instead of opening the lead.
  - "просрочено" counts only the current page.
  - Leads are reassigned one by one, so a partial failure leaves some reassigned with no progress shown.
  - The preselected operator invites accidental assignments.

## pages/OrphanLeads.tsx

- **Distribution panel:** "Статус распределения"
  - Loading: "Загружаем статус распределения…"
  - Meta line: "RR_BATCH_SIZE = {batch} · авто-раздача ВКЛ/ВЫКЛ · получают лиды сейчас: x/y" (ВКЛ green, ВЫКЛ red).
  - Button "Раздать все {n} сейчас поровну" / "Раздаём…". It is disabled when auto-distribution is off or the pool is empty. Tooltips:
    - Off: "Сначала включите авто-распределение в /settings"
    - Empty pool: "Пул сирот пуст"
    - Otherwise: "Раздать всех сирот поровну активным операторам"
  - Red banner when off: "Авто-раздача выключена в /settings. Пока не включите — новые лиды не будут уходить операторам автоматически."
  - No operators: "Нет активных операторов. Пока не активируете хотя бы одного — RR некуда раздавать."
  - Operator table: "Оператор / Работает / Отложено / Статус / Почему". Status badges: "ок", "квота", "gate", "выключен", "—".
- **Metrics:** "Всего сирот", "По источникам". Source chips.
- **Toolbar:** "Выбрано: {x} из {y}" / "Всего:", "Раздать поровну" (no confirmation), "Назначить оператору…", "Снять выбор".
- **Table states:** loading "Загрузка…"; empty "Свободных лидов нет."
- **Assign modal:** "Назначить оператору · {n}"
  - Hint "Все выделенные лиды уйдут выбранному оператору. История назначений сохраняется в аудит-логе."
  - Buttons "Назначить" / "Сохраняем…".
- **Toasts:** "Раздано: {n}", "Раздано лидов: {n}", neutral "Раздавать нечего — пул пуст"; errors as server text.
- **Bugs**
  - Mass actions have no confirmation.
  - The status column shows raw status codes, not labels.

## pages/SystemLostLeads.tsx (superadmin)

- **Summary:** "Всего", "По причинам", "Топ операторов (до увольнения)".
- **Reason chips:** "Все причины", "Оператор уволен", "Битый телефон из таблицы". Days input: "За последние N дней" (1–365).
- **States:** loading "Загрузка…"; empty "Системно потерянных лидов нет."
- **Restore:** browser confirm "Вернуть лид в orphan-пул? Метаданные закрытия будут удалены." → toast "Лид восстановлен".
- **Bug:** while one restore runs, every row's button reads "Восстанавливаем…" and all are disabled.

## pages/LeadsStats.tsx

- **Presets:** "Сегодня / Вчера / 7 дней / 30 дней / Этот месяц / Свой диапазон" (date range appears for custom).
- **"Retry статусы" toggle panel:** "Статусы для retry-export'a"
  - Subtitle explains that an empty selection falls back to the default set.
  - "Выбрано: {n}", "Сохранить выбор" / "Сохраняем…"; toast "Настройка сохранена".
- **"Сформировать retry-лист" / "Формируется…"**
  - Success: toast "Экспортировано {n} лидов" with an "Открыть" action, shown for 8 s.
  - Already running (409): info toast "Экспорт уже формируется, подождите ~30 секунд."
- **Empty states:** "Нет данных за период" (by status, by operator); expanded operator row: "Нет разбивки по статусам за этот период". The total shows "…" while loading.
- **Bug:** the export tooltip names fixed statuses, which contradicts the configurable list.

## pages/LeadStatuses.tsx

- **Header:** "Всего: {n}" + "Добавить статус".
- **States:** loading "Загрузка…"; empty "Пусто". Inactive rows at 55% opacity.
- **Row badges:** "builtin", "🔒 блокер". The trash icon is hidden for built-in statuses.
- **Delete:** browser confirm "Удалить этот статус? Действие необратимо." → toast "Статус удалён".
- **Status modal:** "Новый статус" / "Редактировать статус"; built-in hint "Встроенный статус — code изменить нельзя, удалить тоже."
  - Fields: "Название (RU)"; "Название (UZ)" (placeholder "если пусто — покажем RU-вариант"); "Code (slug)" (auto-filled from the RU name, locked in edit with "Code нельзя менять после создания."); "Emoji" (max 4); "Цвет badge" (нейтральный/синий/оранжевый/зелёный/красный); "Порядок" (0–999).
  - Toggles: "Показывать в чипах", "Кнопка «Отметить»", "Активен".
  - Red-highlighted toggle "🔒 Блокирует получение новых лидов" + hint.
  - Save is disabled without a name or code. Server error shows inline. Success toast: "Сохранено".

## pages/SheetSources.tsx

- **Layout:** SheetSyncBar, then tabs "Листы / Alias'ы операторов".
- **Sheets tab**
  - "Всего листов: {n}" + hint "Вставьте ссылку на Google-шит — CRM сама разберёт колонки и подключит."
  - Buttons "Добавить из ссылки" (wizard) and ghost "Добавить лист" (manual form).
  - Health cards section "Активные источники".
  - Table empty: "Пока не настроены". Row chips: "off", mode, "Пул: {n}", "🔥 ТЕЗ · {n} мин".
- **Manual form modal:** "Новый лист" / "Редактировать лист"
  - Fields: Название, Дефолтный статус (new/archived/needs_review), Spreadsheet ID, gid, "Название листа (опц.)", "Column map (JSON)", "Default оператор" ("— нет —"), "Distribution mode" (+ a hint for each mode), "Активен (участвует в sync)".
  - "Пул операторов" with the checkbox "Все активные операторы (без ограничения)".
  - "🔥 Горячий шит (ТЕЗ)" + "SLA, минут" (silently clamped to 1–120).
  - "🔁 Обратная запись" + 4 column letters (Статус/Оператор/Время/Коммент) + service-account hint.
  - Errors inline: "column_map — некорректный JSON" or server text. Success toast: "Сохранено".
- **Aliases tab**
  - "Непривязанных: {n}" (accent) or "Всего alias'ов: {n}"; "+ Alias".
  - Empty: "Alias'ов ещё нет — создаются автоматически при sync". Badge "не привязан".
  - Inline operator select ("— не привязан —") → toast "Привязано".
  - New alias modal: "Новый alias", field "Как оператор написан в листе"; toast "Alias создан".
- **Bugs**
  - The sheet list has no loading state: it shows "Пока не настроены" while loading.
  - The manual form has no client-side validation; Save is always enabled.
  - Sheet sources cannot be deleted.
  - Alias binding has no error handling.

## components/sheet-sources/SheetSourceWizard.tsx

- **Title:** "Подключить Google-Sheet", "Шаг N из 3", 3-dot stepper (completed steps show ✓).
- **Step 1**
  - "Ссылка на Google-таблицу" + hint "Скопируйте URL из адресной строки — с /d/… и gid=…".
  - "Проверить" button with spinner.
  - Errors in a red box + toast.
  - Preview: sheet title, "Строк в листе: {n}", 10-row table.
  - Already connected (shown red): "Такой источник уже подключён как «{name}». Данные ниже — только для просмотра." The user can still continue.
- **Step 2:** "Сопоставьте колонки листа с полями лида. Phone и Name — обязательные."
  - Selects: "Телефон*", "Имя*", "Что хочет купить", "Есть ли карта", "Дополнительный телефон" ("— не использовать —").
  - "Далее" is disabled until both required columns are set.
- **Step 3:** Название, Дефолтный статус, Distribution mode (default "Alias → round-robin"), Default оператор, Пул операторов, ТЕЗ + SLA, "Писать статусы обратно в лист" + 4 column dropdowns (A–ZZ), inline create error.
- **Footer:** "Отмена"/"← Назад", "Далее →" / "Подключить" (spinner).
- **Success toasts:** "Источник подключён", then the auto-sync result "Sync ok — новых лидов: {n}" or "Первый sync не удался — можно попробовать позже вручную".
- **Bugs**
  - In step 3, unticking "Все активные операторы" does nothing, so the user can never choose specific operators. This bug is already fixed in the manual form.
  - "Только для просмотра" is untrue: the user can proceed and overwrite the existing source.

## components/sheet-sources/SheetSyncBar.tsx [UZ hard-coded]

- **Hidden** when there are no active sources or data hasn't loaded.
- **Healthy (green dot):** "Google Sheets: {n} ta jadval aloqada · So'nggi tekshiruv: … · Yozish (Writeback): {n} navbatda".
- **Error (red bar):** "{n} ta jadvalda xatolik aniqlandi!"
- **Buttons:** "Hozir tekshirish" / "O'qilmoqda…" (spinning icon), "Jadvallar" (opens the diagnostics modal), "Operatorlar" (opens OperatorDiagnosticsModal).
- **Toasts:** a sync summary, or "Sinxronlashda xatolik yuz berdi".

## components/sheet-sources/SheetSyncDiagnosticsModal.tsx [UZ hard-coded]

- **Header:** green/red icon, "Google Sheets va Yozish (Writeback) diagnostikasi", "Hozir hammasini tekshirish".
- **3 KPI tiles**
  - Sheets: "N ta faol (N sog'lom)", last check.
  - Writeback: "N ta navbatda (N xato)", "So'nggi 1 soatda", link "Hozir yozish".
  - Overall: "Barchasi alo darajada" or "Xatolik aniqlandi", "Har 5 daqiqada avtomatik tekshiriladi".
- **Source list:** loading "Jadvallar ma'lumotlari yuklanmoqda…"; empty "Faol jadvallar topilmadi."
- **Per row:** "Tekshirish", "Qayta o'qish", metadata, red error box with an advice line.
- **Close:** "Yopish". Toasts are Uzbek success/error strings.
- **Bugs**
  - "Qayta o'qish" (full re-read from row 1) has no confirmation; the same action asks for one on the health card.
  - Each row's buttons disable all rows while one runs.

## components/sheet-sources/SheetSourceHealthCard.tsx

- **Status dot + label:** "работает" (green), "давно не синкался" (amber; also shown while loading), "ошибка sync" (red).
- **Numbers:** big "лидов за 24 ч", "sync: dd.mm hh:mm", "всего: {n}". Gear icon "Настроить".
- **Sync buttons**
  - "Синхронизировать" / "Синхронизирую…"
  - "Перескан" with browser confirm "Выполнить полный перескан таблицы с 1-й строки?"
- **Red state:** link "Показать ошибку" / "Скрыть ошибку" expands the error text.
- **Toasts:** "Синхронизировано: {read} строк в таблице. Новых лидов: {created}, обновлено: {merged}." / "Sync не удался".

---

## pages/Operators.tsx (also /team/operators)

- **Toolbar**
  - Search "Поиск: имя или телефон…"; chips "Все / Активные / Уволенные".
  - super_manager only: select "Менеджер" (Все менеджеры / Без менеджера / list).
  - "Taqsimot diagnostikasi" (UZ text in the RU UI) and "Добавить оператора".
- **List states**
  - Loading "Загрузка…"; empty "Операторов пока нет"; no search results "Ничего не найдено".
  - Badges: birthday (tooltip "Сегодня у оператора день рождения"), "Забыл: {n}", "⏸ На паузе", "🕐 личное расписание".
- **Side panel**
  - Nothing selected: "Выберите оператора" + "{n} операторов в команде".
  - Tiles: "План", "Сделал".
  - Buttons: "Открыть карточку", "Стикер", "Редактировать", "План", "Taqsimot holati" (UZ), "📷 Попросить снимок", "🖼 Загрузить фото", "⏸ На паузу"/"▶ Снять с паузы" (hidden for inactive operators), "Активировать"/"Деактивировать" (no confirmation), "Удалить".
- **Edit modal:** "Редактировать оператора"
  - Fields: Имя оператора (required), Телефон, Дата приёма, "Дата рождения · год виден только менеджеру", Статус (Активный/Стажёр/Неактивный), Заметка.
  - Two toggle cards: "Блокировка по спец-лидам" and "Требовать отметку прихода для работы", each with a long hint.
  - Section "Зарплата и график" ("Все поля опциональные…"): "Бонус за attendance, UZS", "Бонус за продажи, UZS", "Гейт продаж, %" (clamped 0–100).
  - Subsection "Личное расписание": Начало/Конец смены, "Grace (мин)", "Штраф за опоздание, UZS", "Выходной" ("По умолчанию" + weekdays), "Прощённых пропусков в неделю".
  - Toasts: "Оператор обновлён" / server text or "Не удалось сохранить".
- **Plan modal:** "План на месяц" + name; field "Цель (сум)", placeholder "например 100 000 000"; toast "План обновлён".
- **Delete modal:** "Удалить оператора"
  - Body: long warning about sales being deleted or shrunk; ends "Действие необратимо — рассмотрите деактивацию, если оператор может вернуться."
  - Field "Причина удаления (для аудита)", min 10 chars, live counter "Нужно ещё {n} символ(ов)" (red) or "{n} символов".
  - Inline server error; "Удаление…"; toast "Оператор удалён".
- **Create modal:** "Новый оператор"
  - Fields: ФИО (required), Телефон, Статус; super_manager also sees "Назначить менеджеру" ("Без менеджера").
  - Toasts: "Оператор добавлен" / "Не удалось добавить оператора".
- **Deactivation PIN dialog** (only appears if the server demands a PIN)
  - "🔒 Подтвердите деактивацию" + rescue-cascade text; 4-digit masked PIN.
  - Errors: "PIN — 4 цифры", "Неверный PIN". Buttons "Отмена" / "Подтвердить".
- **Sticker picker** (legacy styling, see note below)
  - Title "Стикер оператора"; radio "Обычный" / "Rare (уникальный на всю систему)".
  - Grid of emoji; taken ones are dimmed with tooltip "Занят: {name}".
  - Rare mode: "Rare-эмодзи (можно любой)", warning "Сейчас rare: X у Y. Будет снят.", button "Выдать rare". Also "Убрать стикер".
- **Toasts:** "Статус обновлён"; "Деактивирован · {n} лидов автоматом раскинуты по остальным"; "Активирован · {n} лидов подтянуто…"; "Оператор на паузе — новые лиды не приходят" / "Оператор снят с паузы"; "Запрос снимка отправлен оператору"; "Аватар обновлён" / "Не удалось загрузить аватар".
- **Bugs**
  - Plan save has no error handling: a failure is silent.
  - The sticker picker uses old styles that don't match the current design system.
  - Uzbek and Russian are mixed on the same toolbar.

## components/operators/OperatorDiagnosticsModal.tsx [UZ hard-coded]

- **Header:** "Operatorlar taqsimoti diagnostikasi", "Yangilash" (spinning while refreshing).
- **Summary chips:** eligible / "Bloklangan" / "Pauzada" / quota full / "Bo'sh lidlar puli N ta".
- **Left list:** search "Operator nomi yoki raqami..."; filters "Barchasi (n)", "Bloklangan (n)", "Pauza (n)", eligible. Loading "Yuklanmoqda..."; empty "Operatorlar topilmadi".
- **Right panel**
  - Nothing selected: "Tafsilotlarni ko'rish uchun chap tomondan operatorni tanlang".
  - Toggles "Pauzaga qo'yish"/"Pauzadan chiqarish" and "Geyt: ON/OFF".
  - Big banner "LIDLAR TAQSIMOTI OCHIQ (Раздача открыта)" or "…BLOKLANGAN (Раздача заблокирована)".
  - Stats: "Joriy kvota", "Kechagi qoldiq", "Bugun olgan", "Bugungi qo'ng'iroq".
- **Tabs:** "⏳ Kechagi qoldiq lidlar", "📦 Joriy kvotadagi lidlar", "📜 Bugun berilganlar". Empty texts:
  - "Kechadan qolgan yopilmagan lidlar yo'q. Hammasi toza!"
  - "Hozirda kvotani to'ldirib turgan faol lidlar yo'q."
  - "Bugun avtotizim orqali lid berilmagan."
- **"Barchaga teng taqsimlash":** browser confirm "{n} ta kechagi lid barcha faol operatorlarga teng taqsimlansinmi?"
- **Bug:** error toasts show the generic network error message instead of the server's explanation.

## pages/OperatorDetail.tsx

- **Hero**
  - Name + pencil (opens edit) + status badge.
  - "рабочий:"/"личный:" phones, or accent button "+ добавить рабочий телефон"; "редактировать" link.
  - Achievements.
  - Buttons: "Назначить стикер" (or "😀 Редактировать"), "QR для входа", "Telegram".
- **Stat tiles:** "Сумма · {period}", "Средний чек" ("Сумма ÷ кол-во"), "План · {month}".
  - Plan tile inline edit: "Цель в сумах" + save/cancel. Otherwise "{actual} из {target}" + "✏️ изменить", or "Не установлен" + "➕ задать".
  - Toasts: "План обновлён" / "Не удалось сохранить план".
- **Payroll tile:** "Зарплата · этот месяц", badge "порог достигнут".
- **Account section:** "Учётная запись оператора"
  - **No account:** "У оператора пока нет логина. Создайте — сгенерируется пароль."
    - Without a phone: orange warning "Сначала укажите рабочий телефон — он нужен для логина и подключения Telegram." and the button becomes "Указать телефон" (opens the phones modal).
    - With a phone: "Создать учётку" / "Создаём…" + "Пароль будет сгенерирован автоматически, покажем один раз."
  - **Has account:** status "активна"/"деактивирована"/"удалена".
    - Buttons: "Показать пароль", "Сгенерировать новый пароль" (both disabled if deleted; no confirmation), "Деактивировать"/"Активировать" (no confirmation), "Удалить учётку".
    - "Язык интерфейса и AI" chips UZ/RU + hint.
- **Credentials modal:** "Учётка создана" / "Новый пароль" / "Данные для входа"
  - Orange warning (except in view mode): "Сохраните пароль сейчас — больше мы его в открытом виде показывать не будем."
  - Login / password tiles with copy buttons (toasts "Логин скопирован", "Пароль скопирован"); "Готово".
- **Phones modal:** "Телефоны оператора"
  - "Рабочий · для входа и Telegram" (red when invalid) + "Формат: 9 цифр после +998"; "Личный · опционально".
  - Save disabled unless the work phone is valid. Toast "Телефоны обновлены".
- **Edit modal:** "Редактировать оператора"
  - Fields: name (required), hire date, status, note, "Блокировка по спец-лидам".
  - "Live-эфир" toggle (hard-coded RU hint about the camera stream).
  - "Владелец (менеджер)" select ("Не назначен (общий пул)", entries shown as "username (role)") + hint.
  - Errors: server text, first field error, or "Не удалось сохранить".
- **QR modal:** "QR-код для check-in"
  - "{name} · сканируйте камерой телефона"; "Генерируем…" placeholder.
  - Hint "Личный QR оператора. При «Сгенерировать новый» старый перестаёт работать."
  - "Скачать PNG" (disabled until loaded); "Сгенерировать новый" (no confirmation).
  - Toast "QR обновлён — старый больше не работает".
- **Delete-account modal:** "Удалить учётку?"
  - Body: "Оператор потеряет доступ к веб-панели. Продажи, лиды и история — остаются. Позже можно создать заново."
  - Same 10-character reason rule as operator delete. "Удаляем…"; toast "Учётка удалена".
- **Close-shift modal:** "Закрыть смену" + "{name} — время ухода будет зафиксировано сейчас"
  - "Комментарий (необязательно)" (max 280 characters); red "Закрыть смену" button.
  - Toasts: "Смена закрыта" / "Не удалось закрыть смену".
- **Lesson detail modal:** AI review with "Фокус", stats, "Итоги дня", "Сильные стороны", "Рекомендации".
- **Empty states:** "Нет продаж за период", "Нет данных", "Нет записей о сменах", "Разборов пока нет". Shift badges: "авто 23:00", "на смене".
- **Bugs**
  - The "Telegram" button has no click handler: it does nothing.
  - Password regeneration, account deactivation and QR rotation are destructive with no confirmation.
  - The back link always points to /operators, even when arriving from /team/operators.

## components/AccountControls.tsx — unused

- **States:** "Активен" / "Заблокирован" / "Удалён".
- **Modals:** create login, view password ("просмотр аудируется"), reset password, block confirmation, delete with the 10-character reason.
- **Bug:** it calls a different delete method from OperatorDetail. Don't design from it.

## components/PhotoUploader.tsx / PhotosUploader.tsx (Catalog and operator sale form only)

- **Dropzone:** "Перетащите или вставьте фото" + "Cmd/Ctrl+V из буфера, или drag-drop, или выберите файл. JPG/PNG до 20 МБ."
- **Buttons:** "Выбрать файл", "Камера"; multi-photo version adds "Добавить" and an "n/max" counter (default max 5). Remove: "Убрать". Drag-over highlight.
- **Bugs**
  - Non-image files are silently ignored.
  - Files beyond the maximum are silently dropped.
  - The 20 MB limit stated in the hint is never checked.

---

## pages/Users.tsx

- **Toolbar:** search, count "x / y", "Добавить менеджера".
- **Placeholder bug:** the search box shows the raw key "users.search_ph".
- **Table:** loading "Загрузка…"; empty "Пусто".
- **Rows:** "это вы", Telegram icon, "superuser" note, UZ/RU language chips (toast "Язык сохранён").
- **Row actions:** edit (tooltip is the raw key "users.edit_role"), "Пароль", delete (hidden on your own row).
- **Create modal:** "Новый менеджер" + "Пароль будет сгенерирован автоматически, покажем один раз."
  - "Логин" (placeholder "например: azizbek"); role chips "Менеджер / Тим-лид / Супер-менеджер".
  - For Менеджер, "Подчинён" select ("Нет") + "Для менеджеров — super_manager, которому они подчинены."
  - Inline error; "Создать" / "Создание…"; toast "Аккаунт создан".
- **Edit role modal** (title = username): chips also include "Оператор"; "Подчинён" shown for Менеджер.
  - Success toast shows the raw key "users.saved".
- **One-time password modal:** "Готово · сохраните пароль" + orange "Больше пароль в открытом виде показывать не будем. Сохраните сейчас." + copy rows.
- **Reset confirmation:** "Сгенерировать новый пароль?" / "Старый пароль {name} перестанет работать сразу же." / "Сгенерировать"; toast "Пароль сброшен".
- **Deactivate confirmation:** "Деактивировать?" / "Пользователь {name} потеряет доступ…" → toast "Пользователь деактивирован".
- **Role differences:** none in the UI. super_manager sees the same page and options.
- **Bugs**
  - Three missing translation keys show as raw strings (listed above).
  - You can edit your own role and reset your own password.
  - The superadmin role is labelled "Менеджер".
  - One-time password modals close on backdrop click or ESC, so the password can be lost with no way to see it again. This applies on every page with such a modal.

## pages/MyManagers.tsx (super_manager)

- **Header:** "Менеджеры, подчинённые вам напрямую…" + "Добавить менеджера".
- **Table states:** loading; empty "Пока ни одного менеджера под вами. Нажмите «Добавить менеджера»."
- **Rows:** team button showing the operator count, key icon, trash icon.
- **Add modal [UZ hard-coded parts]:** tabs "Mavjud xodimdan" / "Yangi raqam bilan"
  - Existing user: "Xodimni tanlang" ("— Xodimni tanlang (N ta) —") + note → "Menejer qilish"/"Tayinlanmoqda…"; toast "Menejer qilib tayinlandi".
  - New number: "Telefon raqami (Login)" (red when invalid), "F.I.SH / Ismi" ("masalan: Sardor") + note → "Создать"; toast "Менеджер создан и привязан к вам", then the one-time password modal.
- **Reset password:** same as Users.
- **Delete confirmation:** "Удалить менеджера?" / "Аккаунт {name} будет деактивирован. Его операторы ({n}) станут свободными — назначь их другому менеджеру."
  - The button is primary-coloured, not danger. Toast "Пользователь деактивирован".
- **Team modal:** "Команда {username}" / "{n} Операторов"
  - Empty: "Пока никого. Добавь оператора из списка ниже."
  - Each operator has a red X ("Убрать из команды"): instant, no confirmation, no toast.
  - "Добавить оператора" select ("— выбери оператора —", suffix "сейчас у {name}" or "свободен") + "Добавить" + "Если оператор уже у другого менеджера — он автоматически перейдёт сюда."
  - Adding shows no success toast.
- **Bugs**
  - The subtitle says "directly subordinate", but the list shows all managers in the system.
  - The "existing user" tab can promote operators to manager without a confirmation.

## pages/DeletedOperators.tsx (super_manager) — read-only

- **Subtitle** explains the audit log.
- **KPIs:** "Всего удалений", "Их продаж (90 дн)", "Сумма продаж", "Без причины" + "Удалений без комментария — проверь мотив".
- **Search:** "Поиск: имя, телефон, кто удалил, причина…".
- **States:** loading; empty "Удалённых операторов пока нет." Missing reason shows red "⚠ Причина не указана". Restored count shown as a badge.
- **Detail modal:** name, "Удалил {by} · {at}", tiles (Телефон, Устроен, Продажи, Сумма), "Причина" (or "Причина не указана. Удаление произошло до внедрения обязательного комментария (2026-10-07).")
  - Green box "Восстановлено {n} продаж(и)…"
  - "Что затронул delete": "Продаж soft-deleted" (red if not restored), "Продаж shrunk", "Лидов отвязано", "Звонков отвязано".
- **Bugs**
  - Trainee and fired statuses show the raw keys "op_detail.status_trainee_lower" and "op_detail.status_inactive_lower".
  - The modal has no buttons and no restore action.

## pages/DayOffRequests.tsx

- **Header card:** "Ожидают решения: N" + hint "Разверните карточку — увидите…".
- **States:** loading "…"; empty "Нет ожидающих заявок".
- **Collapsible card:** operator name, date · reason.
- **Expanded**
  - Loading "…".
  - Stats: "Последний выходной" ("никогда"), "Других в этот день" (red if 3 or more), "Продажи · 7 дней", "Лиды · звонки (7д)".
  - "Комментарий менеджера" (placeholder "Например: сделай ещё 5 продаж — тогда одобрю").
  - Buttons "Отклонить" / "Одобрить", no confirmation.
  - Toasts: "Заявка одобрена" / "Заявка отклонена" / "Не удалось сохранить решение".
- **Bug:** if the details fail to load, it shows English "Error loading context" and **no approve/reject buttons**, so the manager cannot decide that request.