# Волна 4 — HackSoft compliance и надёжность интеграций

Спека для builder-агента. 9 MEDIUM-приоритетных фиксов для чистоты слоёв и робастности интеграций.

**Контекст**: Волны 1, 2, 3 уже приняты. **Не трогать их** — только 4. Проект `/Users/user/Desktop/mp/ai/naff/`. HackSoft-раскладка: models / selectors / services / apis.

## Задачи

### 4.1 Прямой ORM в APIViews (HackSoft violation)

- **Проблема**: `Operator.objects.filter(pk=...)` вызывается 8+ раз прямо во view'ях:
  - `apps/leads/apis.py:238, 270, 396, 400, 426`
  - `apps/calls/apis.py:106, 132, 184, 204`
- **Фикс**:
  - Новый селектор `apps/operators/selectors.py`:
    ```python
    def operator_get_by_id_or_404(operator_id: int) -> Operator:
        try:
            return Operator.objects.get(pk=operator_id)
        except Operator.DoesNotExist:
            raise Http404("Operator not found")
    ```
  - Все views переехать: `operator = operator_get_by_id_or_404(operator_id)`.
  - Импорты и unused-cleanup.

### 4.2 Google Sheets — валидация обязательных заголовков

- **Проблема**: `apps/leads/services.py:_pick_column` возвращает пустую строку молча если header переименовали.
- **Фикс**:
  - В `apps/leads/integrations/google_sheets/sync.py:sync_one` — до цикла по строкам:
    ```python
    required = ["full_name", "phone_number"]
    missing = [k for k in required if not sheet_source.column_map.get(k)]
    if missing:
        raise ApplicationError(f"Sheet source #{sheet_source.id}: missing column mapping for {missing}")
    # + проверить что маппинги реально резолвятся к headers первой строки
    first_row_headers = raw_rows[0] if raw_rows else []
    for key in required:
        mapped = sheet_source.column_map[key]
        if mapped not in first_row_headers:
            raise ApplicationError(f"Sheet source #{sheet_source.id}: mapped column '{mapped}' not found in sheet headers")
    ```
  - Ошибка → `SheetSource.last_sync_error = str(exc)` (новое поле, миграция).
  - Health-endpoint (Волна 2.2) уже показывает если `last_synced_at` >5мин старое.
- Тесты: `test_sync_fails_when_required_column_renamed`, `test_sync_fails_when_column_map_incomplete`.

### 4.3 Матчинг TgChat ↔ Lead — fallback по имени

- **Проблема**: Если phone у клиента в TG и в Lead разные — не залинкует.
- **Фикс** в `apps/tg_userclient/services.py:tg_message_ingest`, где сейчас:
  ```python
  if chat.lead_id is None and chat.partner_phone:
      normalized, valid = normalize_uz_phone(chat.partner_phone)
      if valid:
          lead = Lead.objects.filter(phone=normalized).first()
          if lead: chat.lead = lead
  ```
  добавить fallback после `if valid` блока:
  ```python
  if chat.lead_id is None and chat.partner_name:
      # Простой match по имени (case-insensitive substring)
      lead = Lead.objects.filter(
          full_name__iexact=chat.partner_name.strip()
      ).exclude(status=LeadStatus.ARCHIVED).first()
      if lead: chat.lead = lead
  ```
- Не делать Levenshtein — избыточно; iexact + strip достаточно.

### 4.4 SELECT FOR UPDATE на SheetSource во время sync

- **Проблема**: Два параллельных `sync_sheets_leads` (cron overlap) наступят друг другу.
- **Фикс** в `apps/leads/integrations/google_sheets/sync.py:sync_one`:
  ```python
  with transaction.atomic():
      sheet_source = SheetSource.objects.select_for_update(of=("self",)).get(pk=sheet_source.id)
      # ... вся логика
      sheet_source.last_synced_at = timezone.now()
      sheet_source.save(update_fields=["last_synced_at"])
  ```
- Тест: `test_two_parallel_syncs_do_not_double_import` (через threading).

### 4.5 `_bot_complete_callback` retry + inline retry-кнопка

- **Проблема**: `apps/tg_bot/runner.py:895-903` — если `callback_reminder_complete` упал, оператор видит "Не удалось", но статус не обновлён и нет retry.
- **Фикс**:
  ```python
  async def _bot_complete_callback(callback_query, reminder_id):
      try:
          await sync_to_async(callback_reminder_complete)(reminder=..., user=None)
          await callback_query.message.edit_text("✅ Отмечено выполненным")
      except Exception as exc:
          logger.exception("cb-done failed for reminder=%s", reminder_id)
          # добавить inline кнопку "Повторить"
          kb = InlineKeyboardMarkup(inline_keyboard=[[
              InlineKeyboardButton(text="🔄 Повторить", callback_data=f"cb-done:{reminder_id}")
          ]])
          await callback_query.message.edit_text(
              "Не удалось отметить, попробуй ещё раз.",
              reply_markup=kb,
          )
  ```
- Аналогично для `cb-snooze`.

### 4.6 Ежедневный отчёт — идемпотентность по дате

- **Проблема**: `apps/tg_bot/runner.py:daily_report_scheduler` может переслать отчёт дважды при перезапуске (например в 21:00:59).
- **Фикс**:
  - Миграция: `BotSubscription.last_daily_report_date = models.DateField(null=True, blank=True)`.
  - В сервисе отправки — до send:
    ```python
    today = timezone.localdate()
    if subscription.last_daily_report_date == today:
        return  # уже отправлено
    ```
    после успешной отправки:
    ```python
    subscription.last_daily_report_date = today
    subscription.save(update_fields=["last_daily_report_date"])
    ```
- Тест: `test_daily_report_not_sent_twice_same_day`.

### 4.7 `analyze_tg_dialogs` — retry при LLM-ошибке

- **Проблема**: Если Gemini упал на 10-м чате из 50, следующий запуск пропустит эти чаты (`until` не установлен, но и не переигрывает).
- **Фикс**:
  - Новая модель `TgAiInsightAttempt(chat, session, attempted_at, status, error_message, next_retry_at)` — миграция.
  - Статусы: `success, error_retriable, error_permanent`.
  - Backoff: 3 попытки с delays [1min, 5min, 30min]. После 3-го permanent.
  - В `apps/tg_userclient/management/commands/analyze_tg_dialogs.py`:
    ```python
    def _should_process(chat):
        # skip if success insight already covers latest message
        latest_insight = TgAiInsight.objects.filter(chat=chat).order_by("-until").first()
        if latest_insight and latest_insight.until >= chat.last_message_at:
            return False
        # skip if last attempt is retriable but next_retry_at in future
        last_attempt = TgAiInsightAttempt.objects.filter(chat=chat).order_by("-attempted_at").first()
        if last_attempt:
            if last_attempt.status == "error_permanent":
                return False
            if last_attempt.status == "error_retriable" and last_attempt.next_retry_at > timezone.now():
                return False
        return True
    ```
  - При успехе — `Attempt(status=success)` + Insight.
  - При ошибке провайдера — `Attempt(status=error_retriable, next_retry_at=now+delay)`, `delay=[60, 300, 1800]` секунд.

### 4.8 Партнёрский phone — нормализация при ingest

- **Проблема**: `partner_phone` сохраняется как есть в БД, матчинг с Lead через `Lead.phone` (уже нормализованный) — миссы.
- **Фикс** в `tg_message_ingest` — перед сохранением `chat.partner_phone`:
  ```python
  if partner_phone:
      normalized, _ = normalize_uz_phone(partner_phone)
      if normalized:
          partner_phone = normalized
  ```

### 4.9 Единый `FernetVault` — вынести в `apps/common/crypto.py` (уже сделано в Волне 1)

- Волна 1.3 уже реализовала `FernetVault` в `apps/common/crypto.py`. Задача 4.9 — **удостовериться**, что оба модуля (`users/crypto.py`, `tg_userclient/crypto.py`) — тонкие обёртки над ним. Если ещё копипаста — упростить.

## Порядок работ

4.1 → 4.8 → 4.3 → 4.2 → 4.4 → 4.5 → 4.6 → 4.9 → 4.7 (сначала лёгкие).

## Стиль

- HackSoft строго. Селекторы для read, сервисы для write.
- Каждый мутирующий сервис — `audit_log_create` (`_scrub` из Волны 1 применяется автоматически).
- Никаких эмодзи в коде и коммитах.
- Type hints везде.
- Комменты только для нюансов интеграций.
- По коммиту на подзадачу.

## Тесты (минимум 12)

- `test_sheet_column_validation.py` — 2
- `test_tg_chat_lead_match_by_name.py` — 2
- `test_sync_parallel_locking.py` — 1
- `test_bot_complete_retry_kb.py` — 2
- `test_daily_report_idempotent.py` — 2
- `test_analyze_retry_backoff.py` — 3

Итого 12 новых. Регресс: **160 pre-existing зелёных (Волна 2 + 1) должны остаться зелёными**. Итого ≥172 passed.

## Финальный отчёт

- 9 подзадач: file:line ключевых изменений.
- Итог pytest.
- Инструкция как проверить каждый фикс руками.
- Список открытых вопросов если появятся.
