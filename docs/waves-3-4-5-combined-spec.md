# Волны 3, 4, 5 — единый план для одного builder-агента

Спека для агента, который выполнит **все три оставшиеся волны подряд**. Каждая волна — самостоятельная спека:

- **Волна 3** — `/Users/user/Desktop/mp/ai/naff/docs/wave3-frontend-ux-spec.md` (Frontend UX, 8 задач)
- **Волна 4** — `/Users/user/Desktop/mp/ai/naff/docs/wave4-hacksoft-integration-spec.md` (HackSoft + integrations, 9 задач)
- **Волна 5** — `/Users/user/Desktop/mp/ai/naff/docs/wave5-polish-tech-debt-spec.md` (Полировка, 10 задач)

Читай каждую при начале соответствующей волны. Не отклоняйся от файла.

## Контекст всего проекта

- Путь: `/Users/user/Desktop/mp/ai/naff/`
- Стек: Django 5 + DRF + PostgreSQL (HackSoft-раскладка) + React 18 + Vite + TypeScript + Tailwind
- Волны 1 и 2 уже приняты: **160 тестов passed / 0 failed**
- Роли: `manager / team_lead / operator`
- Локально: `docker start naff-db-1` (порт 5544), `DJANGO_SETTINGS_MODULE=config.settings.dev`
- Тесты: `POSTGRES_HOST=localhost POSTGRES_PORT=5544 DJANGO_SETTINGS_MODULE=config.settings.test .venv/bin/python -m pytest -q`

## Порядок и правила

### Строгий порядок волн: 3 → 4 → 5

**Не начинать следующую пока предыдущая не сдана**:
- Волна 3 полностью зелёная (`npx tsc --noEmit` без ошибок + все ручные проверки из спеки) — **потом** Волна 4.
- Волна 4 зелёная (регресс ≥172 passed) — **потом** Волна 5.
- Волна 5 зелёная (docs синхронизированы, `tsc --noEmit` чистый, регресс ≥172).

Причина: Волна 4 использует health-endpoint из Волны 2 (`SheetSource.last_sync_error` виден в healthz). Волна 5 обновляет докспеки под фактическую реализацию Волн 2-4.

### Коммиты
По одному коммиту на подзадачу внутри каждой волны. Сообщения:
- `feat(frontend): unified TG queryKey (Wave 3.2)`
- `refactor(views): move Operator ORM to selector (Wave 4.1)`
- `docs(readme): retry_tg_backfill usage (Wave 5.9)`

Все локально. **Не пуш'ить в prod**.

### Между волнами
После каждой волны:
1. Прогнать полный регресс: `.venv/bin/python -m pytest -q --tb=line 2>&1 | tail -5`.
2. `npx tsc --noEmit` в `frontend/` (для Волн 3 и 5).
3. Записать в отдельный секцию финального рапорта: «Волна N — принято, X passed / 0 failed».
4. **Не переходить к следующей** если есть красные тесты или Type errors.

Если между волнами обнаружен сюрприз (например, Волна 3 сломала что-то в Волне 4) — остановиться, задать пользователю вопрос в финальном рапорте, не изобретать обходной путь.

## Что конкретно делать (сводка из спек)

### Волна 3 — Frontend UX (~1-2 дня)
1. Пагинация (`Paginator.tsx`) в `/leads` и `/my`
2. Единый `TG_STATUS_KEY` в `lib/tgUserclient.ts`
3. 403-handler в axios + `sonner` toast
4. `invalidate ["leads-my"]` в `ScheduleCallbackModal` и `CallbackDueModal`
5. Ролевой гейт `<RoleGate>` вокруг manager-only маршрутов
6. Универсальный `<Modal>` с Escape + focus trap (заменяет 8+ разрозненных)
7. Фильтры `/leads` в URL search params
8. Пункт «Требуют проверки» в `Layout.tsx` для manager/team_lead

### Волна 4 — HackSoft + integrations (~2 дня)
1. Убрать прямой `Operator.objects.filter(pk=...)` из views → селектор `operator_get_by_id_or_404`
2. Валидация обязательных заголовков Google Sheets перед sync
3. Fallback-матчинг TgChat↔Lead по `partner_name` iexact
4. `SELECT FOR UPDATE` на `SheetSource` во время sync
5. Retry-кнопка при падении `_bot_complete_callback`
6. `BotSubscription.last_daily_report_date` для идемпотентности
7. LLM retry с backoff (`TgAiInsightAttempt` модель, 3 попытки 1m/5m/30m)
8. Нормализация `partner_phone` в `tg_message_ingest`
9. Проверить что `FernetVault` из Волны 1 переиспользуется в обоих crypto.py (не копипаста)

### Волна 5 — Полировка (~1 день)
1. `any` → `unknown` + `apiErrorMessage(err)` helper в `lib/api-types.ts`
2. Убрать `import React` из `TgConnectWizard`, `TgDialogsPanel` (React 18)
3. `aria-label` ко всем icon-only кнопкам (`AccountControls`, `MyLeads`)
4. Дефолт API URL: `localhost:8001/api` (было 8000)
5. Синхронизировать `docs/tg-integration-spec.md` и `docs/tg-backfill-spec.md` с реальным FloodWait handling (после Волны 2.4)
6. Payroll doc в README
7. Удалить мёртвый `useEffect(() => {}, [])`
8. `formatDate` вместо inline `.toLocaleString()`
9. README раздел про `retry_tg_backfill`
10. Плашка «Не привязан» на `/sheet-sources` для unbound alias

## Общие правила стиля (для всех трёх волн)

- HackSoft строго. Все мутирующие сервисы — `audit_log_create` (`_scrub` из Волны 1 применяется автоматически).
- **Никаких эмодзи в коде и коммитах**.
- TypeScript strict — никакого `any`. React Query — с generic'ами.
- Type hints везде в Python.
- Комменты только для нюансов (rate limit scope, TG API квинки, race conditions).
- Не создавать новые markdown-файлы кроме обновления существующих в Волне 5.
- Пропущенные / отложенные пункты — явно перечислить в финальном отчёте, а не молча пропустить.

## Финальный отчёт (один в конце всех трёх волн)

Формат:
```
## Волна 3
- Сделано подзадач: 8 из 8
- Файлы: ...
- Регресс: N passed, 0 failed
- Ручные проверки: [список пройденных сценариев]

## Волна 4
- Сделано подзадач: 9 из 9
- Файлы: ...
- Регресс: N passed, 0 failed

## Волна 5
- Сделано подзадач: 10 из 10
- Файлы: ...
- Регресс: N passed, 0 failed
- Обновлённые docs: [список]

## Открытые вопросы
[если появились]

## Что не сделано и почему
[если что-то отложено — явно]
```

## Экстренная остановка

Если при выполнении обнаружишь:
- Регресс упал (>0 failed) и не связан с текущей подзадачей
- Django `check --deploy` показывает новые warnings
- `npx tsc --noEmit` показывает >5 новых ошибок

→ Остановиться на текущей подзадаче, задать пользователю вопрос в отчёте, не продолжать вслепую.
