# Спецификация: Backfill истории Telegram-чатов при подключении оператора

Документ для builder-агента. Задача — добавить в модуль `apps/tg_userclient/` **автоматическую
подгрузку истории личных и групповых чатов оператора начиная с настраиваемой даты**
(по дефолту `2026-07-01`) сразу после успешной авторизации.

Все ссылки — на **существующий код** в `/Users/user/Desktop/mp/ai/naff/`. Стиль — строгий HackSoft.

---

## 1. Контекст

- Модуль `apps/tg_userclient/` уже реализован — 4 модели, auth flow, runner, AI-провайдер.
- Handler `apps/tg_userclient/handlers.py` уже умеет обрабатывать одно входящее событие через сервис `tg_message_ingest` в `apps/tg_userclient/services.py`.
- Runner `apps/tg_userclient/runner.py` держит `ClientManager` — словарь `operator_id → TelegramClient` и раз в 5 сек синхронизируется с БД.
- Сейчас: **после логина оператора система видит только новые входящие/исходящие сообщения**. Старая переписка **не подтягивается вообще**. Это делает панель менеджера пустой до тех пор пока клиент не напишет заново.

---

## 2. Цель

Как только оператор авторизуется и `TgSession.status` становится `ACTIVE`, система должна:

1. Пройти по всем **личным** и **групповым** диалогам этого аккаунта.
2. Скачать сообщения **начиная с `settings.TG_BACKFILL_SINCE` (дефолт `2026-07-01`)**.
3. Для каждого сообщения вызвать существующий сервис `tg_message_ingest` — чтобы логика (создание `TgChat`, матчинг с `Lead`, дедупликация по `(chat, tg_message_id)`) была одна и та же для backfill и real-time.
4. Записывать прогресс в новую модель `TgBackfillJob`.
5. Не блокировать HTTP-ответ auth-endpoint'а — фоновая задача.
6. Быть **идемпотентным**: если backfill для сессии уже прошёл — не повторять при рестарте runner'а. При повторной авторизации (после `REVOKED`) — считать job'у переигранной.

**Не-цели**:
- Не скачивать медиа (файлы, фото, видео) — только текст и метаданные voice (`voice_duration_sec`).
- Не транскрибировать voice в backfill'е (даже при включённом `TG_TRANSCRIBE_VOICE=1`) — это отдельный batch по расписанию.
- Не подтягивать каналы (кроме мегагрупп, которые в спеке = группа) — как и раньше.
- Не пуш-нотификации оператора о прогрессе.

---

## 3. Модель `TgBackfillJob`

Одна миграция в `apps/tg_userclient/migrations/0002_backfill_job.py`.

```python
class TgBackfillJobStatus(models.TextChoices):
    PENDING  = "pending",  "Ожидает"
    RUNNING  = "running",  "В работе"
    DONE     = "done",     "Готово"
    ERROR    = "error",    "Ошибка"

class TgBackfillJob(TimestampedModel):
    session         = models.ForeignKey(
        TgSession, on_delete=models.CASCADE, related_name="backfill_jobs"
    )
    since           = models.DateTimeField()                 # с какой даты тянем
    status          = models.CharField(max_length=8, choices=TgBackfillJobStatus.choices, default=TgBackfillJobStatus.PENDING)
    started_at      = models.DateTimeField(null=True, blank=True)
    finished_at     = models.DateTimeField(null=True, blank=True)
    chats_scanned   = models.IntegerField(default=0)         # сколько чатов пройдено
    messages_saved  = models.IntegerField(default=0)         # сколько успешно записали
    last_error      = models.TextField(blank=True, default="")

    class Meta:
        indexes = [models.Index(fields=["session", "status"])]
        verbose_name = "TG Backfill Job"
```

**Идемпотентность**: НЕ `unique_together`. Каждая новая авторизация оператора (после `REVOKED`) — новая job'а. При активной `PENDING`/`RUNNING` для сессии — не создавать вторую (см. §5.2).

---

## 4. Настройки

### 4.1 `config/settings/base.py` — добавить рядом с существующим `TG_*`:
```python
from datetime import datetime, timezone

TG_BACKFILL_SINCE = config(
    "TG_BACKFILL_SINCE",
    default="2026-07-01",
)  # ISO date "YYYY-MM-DD" или пустая строка чтобы отключить
TG_BACKFILL_CHAT_DELAY_MS = config(
    "TG_BACKFILL_CHAT_DELAY_MS", default=800, cast=int
)  # sleep между чатами чтобы не словить FloodWait
TG_BACKFILL_BATCH_SIZE = config(
    "TG_BACKFILL_BATCH_SIZE", default=200, cast=int
)  # сколько сообщений в одной пачке telethon iter_messages
```

### 4.2 `.env.example`:
```env
# Telegram backfill (полная история после авторизации оператора)
TG_BACKFILL_SINCE=2026-07-01
TG_BACKFILL_CHAT_DELAY_MS=800
TG_BACKFILL_BATCH_SIZE=200
```

### 4.3 Парсинг даты
В сервисе `_parse_backfill_since()` — читать `settings.TG_BACKFILL_SINCE`, парсить как date в UTC:
```python
def _parse_backfill_since() -> datetime:
    v = (settings.TG_BACKFILL_SINCE or "").strip()
    if not v:
        raise ValueError("TG_BACKFILL_SINCE not configured")
    return datetime.fromisoformat(v).replace(tzinfo=timezone.utc)
```

Пустая строка → **не запускать backfill вообще** (важно для тестов).

---

## 5. Логика запуска

### 5.1 Куда воткнуть триггер
В `apps/tg_userclient/services.py` уже есть сервисы `session_verify_code` и `session_verify_password`. Они возвращают/сохраняют `TgSession` со статусом `ACTIVE`.

**Дописать в конец обоих сервисов** — сразу после `session.status = ACTIVE; session.save(...)`:
```python
_ensure_backfill_job(session)
```

Где `_ensure_backfill_job` — новый приватный хелпер в том же файле:
```python
def _ensure_backfill_job(session: TgSession) -> TgBackfillJob | None:
    """
    Create a fresh PENDING job for this session if there's none PENDING/RUNNING.
    Idempotent: if a job is already in flight, return it without creating a new one.
    """
    try:
        since = _parse_backfill_since()
    except ValueError:
        return None  # backfill disabled
    existing = TgBackfillJob.objects.filter(
        session=session,
        status__in=[TgBackfillJobStatus.PENDING, TgBackfillJobStatus.RUNNING],
    ).first()
    if existing:
        return existing
    return TgBackfillJob.objects.create(session=session, since=since)
```

### 5.2 Кто исполняет job
**Runner** (`apps/tg_userclient/runner.py`). Он и так синхронизируется с БД раз в 5 сек. Добавить в `ClientManager.sync_from_db()` дополнительный шаг:

```python
async def sync_from_db(self) -> None:
    # (существующий код: подхватить новые ACTIVE / удалить REVOKED)
    ...
    # НОВОЕ: подхватить PENDING backfill'ы для клиентов которые сейчас есть у нас
    await self._pick_pending_backfills()

async def _pick_pending_backfills(self) -> None:
    pending = await sync_to_async(list)(
        TgBackfillJob.objects
        .filter(status=TgBackfillJobStatus.PENDING, session__status=TgSessionStatus.ACTIVE)
        .select_related("session")
    )
    for job in pending:
        client = self.clients.get(job.session.operator_id)
        if client is None:
            continue  # клиент ещё не поднят — подхватим на следующем tick'е
        if job.id in self._running_backfills:
            continue  # уже гоним
        self._running_backfills.add(job.id)
        asyncio.create_task(self._run_backfill(client, job))
```

Держать множество `self._running_backfills: set[int]` — чтобы не запустить одну job'у дважды.

### 5.3 Тело `_run_backfill`
Новая приватная корутина в `ClientManager`:

```python
async def _run_backfill(
    self, client: TelegramClient, job: TgBackfillJob
) -> None:
    logger.info("backfill#%s start op=%s since=%s", job.id, job.session.operator_id, job.since.isoformat())
    await sync_to_async(_mark_running)(job)
    try:
        chats_scanned = 0
        messages_saved = 0
        async for dialog in client.iter_dialogs():
            if dialog.is_channel and not dialog.is_group:
                continue  # чистый канал — пропускаем
            saved = await self._backfill_one_chat(client, job.session, dialog, job.since)
            messages_saved += saved
            chats_scanned += 1
            await asyncio.sleep(settings.TG_BACKFILL_CHAT_DELAY_MS / 1000)
        await sync_to_async(_mark_done)(job, chats_scanned, messages_saved)
        logger.info(
            "backfill#%s done chats=%s messages=%s",
            job.id, chats_scanned, messages_saved,
        )
    except FloodWaitError as fw:
        logger.warning("backfill#%s FloodWait %ss — pausing", job.id, fw.seconds)
        await asyncio.sleep(fw.seconds + 5)
        # оставляем status=RUNNING; следующий tick sync_from_db не подхватит, потому что мы уже в task'e
        # либо: помечаем PENDING чтобы подхватить снова после падения — на усмотрение реализатора
    except Exception as exc:
        await sync_to_async(_mark_error)(job, repr(exc))
        logger.exception("backfill#%s failed", job.id)
    finally:
        self._running_backfills.discard(job.id)
```

### 5.4 `_backfill_one_chat`
```python
async def _backfill_one_chat(
    self, client: TelegramClient, session: TgSession, dialog, since: datetime,
) -> int:
    saved = 0
    async for msg in client.iter_messages(
        dialog.entity,
        limit=None,
        offset_date=None,
        reverse=True,  # от старых к новым
    ):
        # Стоп-условие: до even since
        if msg.date < since:
            continue
        # (переиспользовать существующие хелперы determine_chat_kind / partner_name / partner_phone / determine_kind / determine_direction — либо вынести их из handlers.py в services/utils)
        try:
            created = await sync_to_async(tg_message_ingest)(
                session_id=session.id,
                tg_chat_id=<peer_id>,
                chat_kind=<...>,
                chat_title=<...>,
                partner_name=<...>,
                partner_phone=<...>,
                tg_message_id=msg.id,
                direction=<...>,
                message_kind=<...>,
                text=msg.message or "",
                voice_duration_sec=<... or None>,
                sent_at=msg.date,
                is_channel=False,
            )
        except Exception:
            logger.exception("backfill: message ingest failed, skipping")
            continue
        if created:
            saved += 1
    return saved
```

**Важно**: не дублировать логику извлечения `partner_name / partner_phone / direction` из handler'а. **Вынести** её в `apps/tg_userclient/services.py` как хелпер `extract_message_fields(session, message) -> IngestPayloadDTO` и переиспользовать и в handler'е, и здесь.

---

## 6. Хелперы `_mark_*`

Простые sync-функции в services.py, обёрнутые через `sync_to_async`:

```python
def _mark_running(job: TgBackfillJob) -> None:
    job.status = TgBackfillJobStatus.RUNNING
    job.started_at = timezone.now()
    job.save(update_fields=["status", "started_at", "updated_at"])

def _mark_done(job: TgBackfillJob, chats: int, messages: int) -> None:
    job.status = TgBackfillJobStatus.DONE
    job.finished_at = timezone.now()
    job.chats_scanned = chats
    job.messages_saved = messages
    job.save(update_fields=[
        "status", "finished_at", "chats_scanned", "messages_saved", "updated_at",
    ])

def _mark_error(job: TgBackfillJob, err: str) -> None:
    job.status = TgBackfillJobStatus.ERROR
    job.finished_at = timezone.now()
    job.last_error = err[:2000]
    job.save(update_fields=["status", "finished_at", "last_error", "updated_at"])
```

Все три — с audit-логом через `audit_log_create` (см. `apps/audit/services.py`).

---

## 7. Ручной перезапуск

Management-команда `retry_tg_backfill` в `apps/tg_userclient/management/commands/retry_tg_backfill.py`:

```
python manage.py retry_tg_backfill --operator 1
python manage.py retry_tg_backfill --session 42
python manage.py retry_tg_backfill --all-errors
```

Логика: находит нужные `TgSession`/`TgBackfillJob`, если у сессии нет активной job'ы — создаёт новую PENDING, runner подхватит на следующем tick'е.

---

## 8. API endpoint для менеджера

Дописать в `apps/tg_userclient/apis.py`:

```
GET /api/tg-userclient/backfill-jobs/?operator={id}
```

Permissions: `IsManagerOrTeamLead` (уже есть). Возвращает последние 10 job'ов для оператора,
сериализованных с `status, chats_scanned, messages_saved, started_at, finished_at, last_error`.

На фронте — на карточке оператора (`OperatorDetail.tsx`), вкладка «Диалоги» — над списком чатов
показать статусную плашку:
- `RUNNING`: «Загружаем историю… чатов пройдено N, сообщений сохранено M»
- `DONE`: зелёная плашка «История загружена: чатов N, сообщений M» (мелким шрифтом)
- `ERROR`: красная плашка с `last_error` + кнопка «Повторить» (вызывает POST `/api/tg-userclient/backfill-jobs/retry/` — реализовать)

---

## 9. UX для оператора

В `Profile.tsx` — раздел «Telegram для анализа» — добавить визуал:
- После успешной авторизации (шаг 6 wizard'а) вместо «Подключено» показать:
  > «Подключено. Загружаем историю переписок с {since}…»
- Через 30-60 сек polling статуса job'ы → сменить на «Готово. История загружена.»
- При ошибке — «Ошибка загрузки истории: {last_error}. Попробуем позже.»

Опрос: `GET /api/tg-userclient/status/` расширить полем `latest_backfill_job: {status, chats_scanned, messages_saved}`.

---

## 10. Тесты

Файл: `apps/tg_userclient/tests/test_backfill.py`.

### 10.1 `test_verify_code_creates_pending_backfill_job`
- Замокать `_do_sign_in`.
- Проверить: после `session_verify_code(...)` появилась `TgBackfillJob(status=PENDING, since=2026-07-01)`.

### 10.2 `test_ensure_backfill_job_is_idempotent`
- Дважды вызвать `_ensure_backfill_job(session)` подряд → в БД одна job'а.

### 10.3 `test_new_session_after_revoke_gets_new_job`
- Первый цикл: job=DONE.
- Session переведена в REVOKED, потом снова ACTIVE (полный ре-логин).
- Ожидаем: новая PENDING job'а.

### 10.4 `test_backfill_skips_messages_older_than_since`
- Замокать `client.iter_messages` возвращать 3 сообщения с датами `[since-1d, since, since+1d]`.
- Ожидаем: сохранено ровно **2** сообщения (те что не старше `since`).

### 10.5 `test_backfill_skips_pure_channels`
- Замокать `client.iter_dialogs` возвращать [private, group, channel].
- Ожидаем: `chats_scanned == 2`, channel не тронут.

### 10.6 `test_backfill_marks_error_on_exception`
- `client.iter_dialogs` кидает случайное исключение.
- Ожидаем: `job.status == ERROR`, `last_error` содержит текст.

### 10.7 `test_backfill_disabled_when_since_empty`
- `override_settings(TG_BACKFILL_SINCE="")`.
- `_ensure_backfill_job` возвращает `None`, job'а не создаётся.

### 10.8 `test_ingest_helper_extracts_partner_phone_from_private`
- Проверить что вынесенный `extract_message_fields` работает и в handler'е и в backfill'е.

Всё через mock. **Никаких реальных подключений к Telegram** в тестах.

---

## 11. Обработка ошибок

| Ситуация | Обработка |
|---|---|
| `FloodWaitError` во время `iter_dialogs` / `iter_messages` | Если duration <= 300s — sleep(fw.seconds + 5) и продолжить; если > 300s — статус job переводится в PENDING, runner освобождает слот и продолжит работу позже |
| `AuthKeyError` (сессия отвалилась) | `session → EXPIRED`, `job → ERROR`, DM оператору через бота |
| `ChatAdminRequiredError` (нет прав в группе) | Пропустить чат, продолжить со следующим (не считать ошибкой job'ы) |
| Дублирующее `tg_message_id` в БД | `tg_message_ingest` возвращает `None` (уже дедуп), `saved` не инкрементим |
| Runner упал посреди backfill'а | Job остаётся в `RUNNING`. При старте runner'а: если у сессии есть RUNNING job старше 10 мин без обновления — reset в PENDING (в отдельном хелпере `_reset_stale_running_jobs`) |

---

## 12. Стиль

- Строго HackSoft: сервисы — fat, views — thin, никакой бизнес-логики в handler'ах.
- Ни в один audit-diff, лог, ошибку не попадает **текст сообщения** — только счётчики и мета.
- Никаких эмодзи в коде/коммитах.
- Type hints везде.
- Комменты — только для Telegram-квинков (лимиты, edge cases).

---

## 13. План работ (~1 день)

1. **A1**: Модель `TgBackfillJob` + миграция `0002_backfill_job.py`.
2. **A2**: Настройки в `base.py` + `.env.example` + парсер `_parse_backfill_since`.
3. **A3**: Хелпер `_ensure_backfill_job` в `services.py` + вызовы в `session_verify_code` / `session_verify_password`.
4. **A4**: Вынести `extract_message_fields` из handler'а в services.py, переиспользовать.
5. **A5**: В `runner.py` — `_pick_pending_backfills`, `_run_backfill`, `_backfill_one_chat`, множество `_running_backfills`, `_reset_stale_running_jobs`.
6. **A6**: 8 тестов из §10 через mock.
7. **A7**: API endpoint `/api/tg-userclient/backfill-jobs/` + retry endpoint.
8. **A8**: UI обновления в `Profile.tsx` (статусная плашка) и `OperatorDetail.tsx` (вкладка «Диалоги» — прогресс backfill'а над списком).
9. **A9**: Management-команда `retry_tg_backfill`.
10. **A10**: Обновить README раздел «Telegram-интеграция» — добавить `TG_BACKFILL_SINCE=`.

---

## 14. Открытые вопросы (закрыты дефолтами)

1. **Что если оператор много лет в TG и с 1 июля у него >100k сообщений?** — Ограничить hard-limit'ом `TG_BACKFILL_MAX_MESSAGES_PER_CHAT=10000` (добавить как настройку). После лимита — пропускаем остальные, лог warning.
2. **Транскрибировать voice в backfill'е?** — **Нет**. Только текст. Voice остаётся `transcript_status="skipped"`, отдельный batch их подхватит если `TG_TRANSCRIBE_VOICE=1`.
3. **Матчить с лидом в backfill'е?** — **Да**, тем же кодом что в handler'е — переиспользовать `extract_message_fields`.
4. **Полный ре-логин запускает новый backfill с той же даты (`2026-07-01`) или с `last_ingested`?** — Дефолт: **с той же даты**. Идемпотентность обеспечивает `unique_together (chat, tg_message_id)` — старые сообщения не задублируются.
5. **UI показывает прогресс каждую секунду?** — Нет, polling `/api/tg-userclient/status/` раз в 10 сек, достаточно.

---

## 15. Финальный отчёт (для человека)

- Ссылки file_path:line на: `TgBackfillJob`, `_ensure_backfill_job`, `_run_backfill`, `extract_message_fields`.
- Вывод `pytest apps/tg_userclient` — должно быть 18 (существующие) + 8 (новые) = 26 passed.
- Общий регресс не сломан.
- Инструкция как проверить руками:
  ```bash
  # 1. Оператор проходит wizard в /profile
  # 2. Проверяем job:
  POSTGRES_HOST=localhost POSTGRES_PORT=5544 DJANGO_SETTINGS_MODULE=config.settings.dev \
    .venv/bin/python -c "
  import django; django.setup()
  from apps.tg_userclient.models import TgBackfillJob
  print(TgBackfillJob.objects.latest('id').__dict__)
  "
  ```
- Список открытых вопросов если появились новые.
