# Спецификация: Telegram-интеграция для naffAI (Этап B, TG-часть)

Документ для builder-агента. Задача — подключить к системе анализ Telegram-переписки операторов
без требования Telegram Premium от их аккаунтов.

Ссылки в спеке — на **уже существующий код naff** в `/Users/user/Desktop/mp/ai/naff/`.
Стиль — строгий HackSoft: `models / selectors / services / apis`. Не отклоняться.

---

## 1. Цель и не-цели

### Цель
Дать менеджеру возможность **читать и AI-анализировать переписку операторов** с клиентами
в Telegram (все 1-на-1 чаты + релевантные группы). Анализ — качество продающих аргументов,
тон, обещания клиенту, красные флаги.

### Не-цели (не делать в этой фазе)
- Отвечать за оператора автоматически — только чтение.
- Голосовые звонки Telegram — их API не даёт **никак**, не пытаться.
- Массовые рассылки, добавление в группы, любые write-действия — **запрещены**.
- Хранить сессии клиентов (только сессии операторов).

---

## 2. Выбор технологии — Telethon, не Business API

| Опция | Требования | Решение |
|---|---|---|
| Bot API | Ничего | ❌ Не даёт доступ к чужим чатам оператора |
| Business API | Telegram Premium у каждого оператора | ❌ Отвергнут заказчиком |
| **User Client (Telethon)** | Оператор один раз проходит phone+code+2FA | ✅ **Используем** |

**Библиотека — `telethon` (MTProto).** Причины:
- Pure-python, работает в asyncio, совместим с aiogram который уже стоит.
- StringSession — можно сохранять в БД, восстанавливать без файлов.
- Активная поддержка, зрелая.

**Альтернатива `pyrogram`** — тоже норм, но у нас aiogram + telethon чаще идут в паре,
меньше конфликтов в event loop.

---

## 3. Риски и как их снимаем

| Риск | Смягчение |
|---|---|
| Telegram банит за автоматизацию | **Только чтение**, никаких write-действий, никакой рассылки. Sleep между запросами. |
| Утечка session-string = полный доступ к аккаунту оператора | **Fernet-шифрование** (ключ `OPERATOR_PASSWORD_ENCRYPTION_KEY` уже есть, см. `apps/users/crypto.py`). Отдельный ключ для sessions: `TG_SESSION_ENCRYPTION_KEY`. |
| Оператор поменял пароль → сессия умерла | Ловим `AuthKeyError` → status=`expired`, показываем «Переавторизуйся». |
| Rate limit / FloodWait | Ловим `FloodWaitError`, ждём указанные секунды, потом продолжаем. Логируем в `TgSession.last_error`. |
| Юр. риск: клиент не знает что его читают | Оператор при подключении подписывает согласие (checkbox с текстом). Мы **не** храним сырые сообщения дольше 90 дней (см. §7.5). |

---

## 4. Архитектура

```
┌─────────────────────────────────────────┐
│  Django backend (apps/tg_userclient/)   │
│  ─ HTTP endpoints (login flow)          │
│  ─ Session storage (encrypted)          │
│  ─ AI insights read model               │
└─────────────────────────────────────────┘
              │
              │ shares DB, settings
              ▼
┌─────────────────────────────────────────┐
│  tg_userclient/runner.py (asyncio proc) │
│  ─ ClientManager: словарь operator_id → │
│    TelegramClient (Telethon)            │
│  ─ Слушает events.NewMessage            │
│  ─ Ловит FloodWait / AuthKeyError       │
│  ─ Сохраняет TgMessage в БД             │
│  ─ Планировщик Whisper / LLM            │
└─────────────────────────────────────────┘

Ежесекундная модель НЕ нужна. Telethon получает push из MTProto.
Процесс запускается отдельно от `runserver` / `gunicorn`
(management-команда `run_tg_userclient` в проде — под systemd/supervisor).
```

**Ключевое**: HTTP-часть (Django) **не** держит Telethon-клиенты. Она только записывает
"добавь такого оператора" в БД. Runner-процесс раз в 5 сек проверяет БД и подхватывает
новые/удалённые сессии.

Такой split нужен потому что:
- Django gunicorn — pre-fork синхронный, event loop не выживет.
- Клиент Telethon — long-lived asyncio task, не помещается в HTTP-запрос.

---

## 5. Модели

Новый app: `apps/tg_userclient/`. **Не** трогать существующий `apps/tg_bot/` (это aiogram-бот
для FSM продаж и callback-DM, см. `apps/tg_bot/runner.py`).

### 5.1 `TgSession`
```python
class TgSessionStatus(models.TextChoices):
    PENDING_CODE = "pending_code"      # ждём ввода кода
    PENDING_2FA  = "pending_2fa"       # ждём пароль облака
    ACTIVE       = "active"
    EXPIRED      = "expired"           # AuthKeyError / отвалилась
    REVOKED      = "revoked"           # оператор отозвал
    ERROR        = "error"             # непонятная ошибка

class TgSession(models.Model):
    operator          = models.OneToOneField(Operator, on_delete=CASCADE, related_name="tg_session")
    phone             = models.CharField(max_length=20)                      # нормализованный
    phone_code_hash   = models.CharField(max_length=64, blank=True)          # temp, для sign_in
    encrypted_session = models.BinaryField(blank=True, default=b"")          # Fernet(StringSession)
    tg_user_id        = models.BigIntegerField(null=True, blank=True)
    tg_username       = models.CharField(max_length=64, blank=True)
    status            = models.CharField(max_length=16, choices=TgSessionStatus.choices)
    consent_at        = models.DateTimeField(null=True, blank=True)          # оператор подписал согласие
    last_connected_at = models.DateTimeField(null=True, blank=True)
    last_error        = models.TextField(blank=True)
    created_at        = models.DateTimeField(auto_now_add=True)
    updated_at        = models.DateTimeField(auto_now=True)
```

**Важно**: `phone_code_hash` — временный, живёт только между отправкой кода и его вводом
(≤10 минут по TG API). После sign_in — очищаем.

### 5.2 `TgChat`
Справочник чатов оператора. Заполняется при первом сообщении.
```python
class TgChatKind(models.TextChoices):
    PRIVATE = "private"
    GROUP   = "group"
    CHANNEL = "channel"

class TgChat(models.Model):
    session      = models.ForeignKey(TgSession, on_delete=CASCADE, related_name="chats")
    tg_chat_id   = models.BigIntegerField()                      # peer id из MTProto
    kind         = models.CharField(max_length=8, choices=TgChatKind.choices)
    title        = models.CharField(max_length=200, blank=True)  # для групп/каналов
    partner_name = models.CharField(max_length=200, blank=True)  # для private: имя собеседника
    partner_phone= models.CharField(max_length=20, blank=True)   # если знаем (client_phone из Lead)
    lead         = models.ForeignKey("leads.Lead", null=True, blank=True, on_delete=SET_NULL)
    first_seen   = models.DateTimeField(auto_now_add=True)
    last_message_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        unique_together = [("session", "tg_chat_id")]
```

**Матчинг с лидом**: если `partner_phone` совпадает с `Lead.phone` (нормализованный) →
проставляем `TgChat.lead` FK. Это ключевая связка "переписка ↔ лид".

### 5.3 `TgMessage`
```python
class TgMessageDirection(models.TextChoices):
    IN  = "in"    # клиент → оператор
    OUT = "out"   # оператор → клиент

class TgMessageKind(models.TextChoices):
    TEXT      = "text"
    VOICE     = "voice"
    PHOTO     = "photo"
    VIDEO     = "video"
    STICKER   = "sticker"
    OTHER     = "other"

class TgMessage(models.Model):
    chat            = models.ForeignKey(TgChat, on_delete=CASCADE, related_name="messages")
    tg_message_id   = models.BigIntegerField()
    direction       = models.CharField(max_length=3, choices=TgMessageDirection.choices)
    kind            = models.CharField(max_length=8, choices=TgMessageKind.choices)
    text            = models.TextField(blank=True)                # для text; для voice — transcript
    transcript_status = models.CharField(max_length=16, blank=True) # pending / done / error / skipped
    voice_duration_sec = models.IntegerField(null=True, blank=True)
    sent_at         = models.DateTimeField(db_index=True)
    ingested_at     = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [("chat", "tg_message_id")]
        indexes = [
            models.Index(fields=["chat", "sent_at"]),
        ]
```

**Не хранить**: сами файлы (фото/видео/аудио). Только метаданные + transcript для voice.
Экономит место, снимает часть юр. риска.

### 5.4 `TgAiInsight`
```python
class TgAiInsight(models.Model):
    session      = models.ForeignKey(TgSession, on_delete=CASCADE, related_name="insights")
    chat         = models.ForeignKey(TgChat, null=True, blank=True, on_delete=CASCADE)
    since        = models.DateTimeField()
    until        = models.DateTimeField()
    model_version= models.CharField(max_length=64)  # e.g. "gpt-4o-2024-11", "claude-sonnet-4-6"
    prompt_version = models.CharField(max_length=32) # "v1", "v2"
    summary      = models.TextField()               # короткое резюме
    quality_score= models.IntegerField(null=True, blank=True)   # 0-100
    red_flags    = models.JSONField(default=list)   # ["обещал скидку 50%", ...]
    highlights   = models.JSONField(default=list)   # положительные моменты
    created_at   = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=["session", "until"]),
            models.Index(fields=["chat", "until"]),
        ]
```

**Разделение**: `chat is null` → инсайт по всему оператору. `chat is not null` → инсайт по
конкретному диалогу.

### 5.5 Миграция
Одна миграция: 4 модели + FK на `operators.Operator`, `leads.Lead`. Никаких изменений
существующих таблиц.

---

## 6. Поток авторизации оператора

Строгая последовательность. Каждый шаг — отдельный HTTP endpoint.

### 6.1 Endpoint'ы (в `apps/tg_userclient/apis.py`)

Все — permission `IsAuthenticated + operator принадлежит текущему пользователю`.
Оператор может подключить **только свою** сессию. Manager может смотреть статус чужих.

```
POST /api/tg-userclient/start/
  body: { phone: str, consent: bool }
  → создаёт/обновляет TgSession(status=PENDING_CODE, consent_at=now if consent)
  → отправляет запрос "прислать код" в TG
  response: { session_id, status: "pending_code" }

POST /api/tg-userclient/verify-code/
  body: { session_id, code: str }
  → sign_in(phone, code, phone_code_hash)
  → если 2FA включён — SessionPasswordNeeded → status=PENDING_2FA
  → иначе — сохраняем encrypted_session, status=ACTIVE
  response: { status: "active" | "pending_2fa" }

POST /api/tg-userclient/verify-password/
  body: { session_id, password: str }
  → sign_in(password=password)
  → сохраняем encrypted_session, status=ACTIVE
  response: { status: "active" }

POST /api/tg-userclient/revoke/
  body: { session_id }
  → status=REVOKED, encrypted_session=b"", уведомляем runner (см. §7.3)
  response: { status: "revoked" }

GET /api/tg-userclient/status/
  → { operator_id, status, tg_username, last_connected_at, last_error }
```

### 6.2 Как HTTP-endpoint общается с Telegram
Через **временный** Telethon-клиент, живёт только на протяжении запроса:

```python
async def send_code(phone: str) -> tuple[str, str]:
    client = TelegramClient(StringSession(), api_id, api_hash)
    await client.connect()
    r = await client.send_code_request(phone)
    ss = client.session.save()  # хранит auth_key
    await client.disconnect()
    return r.phone_code_hash, ss  # ss хранит незавершённую auth
```

**Тонкость**: между `send_code` и `sign_in` **надо переиспользовать тот же session-string**
(auth_key живёт в нём). Значит после `send_code` записываем `encrypted_session` со статусом
`PENDING_CODE`. При `verify-code` восстанавливаем StringSession из БД и делаем `sign_in`
на нём же.

### 6.3 Согласие
На фронте `/profile → Telegram` показать чекбокс:
> Я разрешаю системе naffAI подключиться к моему Telegram-аккаунту в режиме чтения
> для анализа переписки с клиентами компании. Я обязуюсь предупреждать клиентов о том,
> что переписка обрабатывается в CRM-системе.

Без чекбокса — endpoint возвращает 400 `{"detail": "consent_required"}`.

### 6.4 Секреты
Django settings:
```python
TG_API_ID     = config("TG_API_ID", cast=int)
TG_API_HASH   = config("TG_API_HASH")
TG_SESSION_ENCRYPTION_KEY = config("TG_SESSION_ENCRYPTION_KEY")  # Fernet key
```

`TG_API_ID` и `TG_API_HASH` — получить на my.telegram.org/apps один раз. Это API-ключи
**приложения**, не оператора. Один комплект на всех.

`TG_SESSION_ENCRYPTION_KEY` — **отдельный** от `OPERATOR_PASSWORD_ENCRYPTION_KEY`.
Утечка ключа паролей ≠ утечка ключа сессий. Генерация:
```
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Утилиты — переиспользовать паттерн из `apps/users/crypto.py`, но с новым ключом.

---

## 7. Runner: приём сообщений

### 7.1 Процесс
Management-команда `run_tg_userclient` (в `apps/tg_userclient/management/commands/`).
Запускается один экземпляр на весь прод. Внутри asyncio event loop.

```python
class ClientManager:
    def __init__(self):
        self.clients: dict[int, TelegramClient] = {}   # operator_id → client

    async def sync_from_db(self):
        # каждые 5 сек: подтянуть активные сессии, добавить новые, убрать revoked
        ...

    async def spawn_client(self, session: TgSession):
        client = TelegramClient(
            StringSession(decrypt_session(session.encrypted_session)),
            settings.TG_API_ID, settings.TG_API_HASH,
        )
        client.add_event_handler(
            partial(on_new_message, session_id=session.id),
            events.NewMessage(incoming=True, outgoing=True),
        )
        await client.start()
        self.clients[session.operator_id] = client
```

### 7.2 Обработка сообщения
`on_new_message(event, session_id)` (в `apps/tg_userclient/handlers.py`):

1. Достать `TgSession` по id.
2. Разобрать peer → `tg_chat_id`, `kind` (private/group/channel).
3. Игнорировать `channel` (нам не нужны каналы — только диалоги с клиентами).
4. `get_or_create` `TgChat`.
5. Определить `direction`:
   - `event.out is True` → OUT (оператор написал)
   - иначе → IN (клиент написал)
6. Определить `kind` (text / voice / photo / ...) — см. §7.4.
7. Для text — `text=event.message.message`.
8. Для voice — сохранить `voice_duration_sec`, `transcript_status="pending"`, положить
   задачу в очередь Whisper (см. §7.4).
9. Обновить `TgChat.last_message_at`, `TgChat.partner_name`, `TgChat.partner_phone` если пусто.
10. **Матчинг с лидом**: если `TgChat.lead is None` и есть `partner_phone`:
    ```python
    lead = Lead.objects.filter(phone=normalize_uz_phone(partner_phone)[0]).first()
    if lead:
        chat.lead = lead
    ```

Всё через сервис `tg_message_ingest(...)` — не в handler'е напрямую.

### 7.3 Управление жизненным циклом
Runner раз в 5 секунд:
- Тянет `TgSession.objects.filter(status=ACTIVE)`.
- Для тех кого нет в `self.clients` — `spawn_client`.
- Для тех кто в `self.clients` но статус изменился (REVOKED/EXPIRED) — `disconnect` + удалить.

При падении клиента (`AuthKeyError`, `PhoneNumberBannedError`) — mark session как EXPIRED,
записать `last_error`, менеджеру показать в UI.

### 7.4 Голосовые сообщения
- Если решим **не** обрабатывать — `transcript_status="skipped"`, ничего не качаем. **Дефолт: SKIPPED**.
- Если владелец включит через feature-flag `TG_TRANSCRIBE_VOICE=1`:
  - Скачать `event.message.download_media()` во временный файл.
  - Отправить в Whisper (OpenAI API `whisper-1` или локальный `whisper.cpp`).
  - `transcript_status="done"`, `text=<transcript>`.
  - Удалить файл.
  - При ошибке — `transcript_status="error"`, `last_error`.

Провайдер Whisper — через `apps/tg_userclient/transcribe.py` с интерфейсом
`transcribe(path) -> str`. Реализация выбирается по settings.

### 7.5 Ретенция
Management-команда `purge_old_tg_messages`, cron раз в день:
```python
cutoff = timezone.now() - timedelta(days=settings.TG_MESSAGE_RETENTION_DAYS)  # default 90
TgMessage.objects.filter(sent_at__lt=cutoff).delete()
```

Инсайты (`TgAiInsight`) хранятся дольше — они уже агрегированы, персональных данных меньше.

---

## 8. AI-анализ

### 8.1 Провайдер
`apps/tg_userclient/ai/provider.py` — интерфейс:
```python
class LLMProvider(Protocol):
    def analyze_dialogs(self, messages: list[MessageDTO], prompt_version: str) -> InsightDTO: ...
```

Реализации:
- `OpenAIProvider` (GPT-4o).
- `AnthropicProvider` (Claude Sonnet 4.6 или новее).

Выбор через `settings.LLM_PROVIDER` (`openai` / `anthropic` / `none` для тестов).

### 8.2 Промпт
Один шаблон, versioned:
```
Ты — эксперт по продажам телефонов. Ниже переписка оператора {op_name} с клиентом.
Оцени:
1. Тон (профессиональный/грубый/дружелюбный) — score 0-100.
2. Продающие аргументы — какие использовал.
3. Красные флаги: обещал невозможное, слил цену, был груб, игнорировал вопросы.
4. Что мог бы улучшить.

Верни JSON: {"quality_score": int, "summary": str, "red_flags": [str], "highlights": [str]}.
```

Шаблон в `apps/tg_userclient/ai/prompts/dialog_v1.txt`. Версия — literal `"v1"`.

### 8.3 Batch
Management-команда `analyze_tg_dialogs`, cron раз в час:
1. Найти чаты с новыми сообщениями с последнего инсайта.
2. Для каждого — собрать последние 50 сообщений.
3. Вызвать `provider.analyze_dialogs(...)`.
4. Записать `TgAiInsight`.

Идемпотентность: если для чата уже есть инсайт с `until >= last_message_at` — пропустить.

### 8.4 Стоимость
- OpenAI GPT-4o: ~$0.005 / 1K токенов input, ~$0.015 / 1K output. Один диалог ≈ 2-3K токенов.
  Цена анализа диалога — ≈$0.01-0.02.
- Claude Sonnet 4.6 — сопоставимо.
- Whisper (если включим): $0.006 / минута аудио.

Оценка при 500 диалогов/день × $0.02 = $10/день = ~$300/мес. Разумно.

---

## 9. UI

### 9.1 Оператор — `/profile`
Новый раздел «Telegram для анализа»:
- Если `TgSession is None` или `status in (REVOKED, EXPIRED)`:
  - Кнопка «Подключить»
  - Модалка Wizard:
    1. Показать текст согласия + чекбокс.
    2. Поле «Номер телефона» (по умолчанию — `Operator.phone`).
    3. Кнопка «Прислать код». POST `/tg-userclient/start/`.
    4. Экран «Введи код из Telegram». POST `/tg-userclient/verify-code/`.
    5. Если `pending_2fa` — экран «Введи облачный пароль». POST `/tg-userclient/verify-password/`.
    6. Успех — зелёная плашка «Подключено. Аккаунт @{username}».
- Если `status=ACTIVE`:
  - Плашка «Подключено. Аккаунт @{username}. Последняя активность: {last_connected_at}».
  - Кнопка «Отключить». POST `/tg-userclient/revoke/`.
- Если `status=ERROR` — красная плашка с `last_error` + кнопка «Переподключить».

Компонент: `frontend/src/pages/Profile.tsx` — добавить блок в конец страницы.

### 9.2 Менеджер — карточка оператора
На `/operators/{id}` (страница `OperatorDetail.tsx`) — новая вкладка «Диалоги»:
- Список чатов (`TgChat`): partner_name/phone, last_message_at, лид-ссылка если есть.
- Клик на чат → правая панель: последние 50 сообщений + AI-инсайт этого чата.
- Сверху общий инсайт по оператору (последняя запись `TgAiInsight` с `chat=null`).

Компонент `TgDialogsPanel.tsx`. Использует запросы:
```
GET /api/tg-userclient/chats/?operator={id}
GET /api/tg-userclient/messages/?chat={id}&limit=50
GET /api/tg-userclient/insights/?operator={id}
GET /api/tg-userclient/insights/?chat={id}
```

Permissions: **manager only**. Оператор свои чаты в UI **не** видит (они и так у него в TG).

### 9.3 Индикатор в шапке
Если у оператора `TgSession.status != ACTIVE` — красная точка на аватарке в шапке
`Layout.tsx`, tooltip «TG-сессия отвалилась, обнови в профиле».

---

## 10. Ошибки и edge cases

| Ситуация | Обработка |
|---|---|
| `PhoneNumberInvalidError` при `send_code` | 400 `{"phone": "Неверный формат"}` |
| `PhoneCodeInvalidError` при `verify-code` | 400 `{"code": "Неверный код"}` |
| `PhoneCodeExpiredError` | 400 `{"code": "Код истёк, начни заново"}`, session → PENDING_CODE reset |
| `SessionPasswordNeededError` | Не ошибка — переводим status в PENDING_2FA |
| `PasswordHashInvalidError` | 400 `{"password": "Неверный облачный пароль"}` |
| `AuthKeyError` в runner | session → EXPIRED, `last_error=...`, DM оператору через бота: "TG-сессия отвалилась" |
| `FloodWaitError` | Если duration <= 300s — sleep(seconds) & retry; если > 300s — status переводится в PENDING_CODE/PENDING, фиксируется last_error, runner освобождает слот и подхватит позже |
| `PhoneNumberBannedError` | session → ERROR, DM менеджеру: "Telegram забанил номер X" |
| Runner упал | systemd/supervisor рестартит; при старте — все ACTIVE сессии переподключаются |

---

## 11. План реализации по фазам

### Фаза B1 — Скелет и модели (0.5 дня)
- Создать `apps/tg_userclient/` с `models.py, selectors.py, services.py, apis.py, urls.py, admin.py`.
- Миграция для 4 моделей.
- Секреты в settings + `.env.example`.
- Утилиты крипто в `apps/tg_userclient/crypto.py` (по образцу `apps/users/crypto.py`).
- Регистрация роутов в `backend/config/api_urls.py`.

### Фаза B2 — Auth flow (1 день)
- Сервисы `session_start`, `session_verify_code`, `session_verify_password`, `session_revoke`.
- API endpoints (§6.1).
- Permission-класс `IsSessionOwnerOrManager`.
- Тесты на each error case из §10.
- **Не подключать runner ещё.**

### Фаза B3 — Runner + ingest (1.5 дня)
- `management/commands/run_tg_userclient.py`.
- `ClientManager` + `on_new_message` handler.
- Сервис `tg_message_ingest(session, event)` (в services.py).
- Матчинг чата с лидом по phone.
- Тест ingest'а: замокать `event`, проверить создание `TgChat` + `TgMessage`.
- Локально: запустить runner в одном терминале, стартануть тестовую сессию — увидеть
  сохранение сообщений в БД.

### Фаза B4 — UI оператор (0.5 дня)
- Расширение `Profile.tsx` — wizard подключения.
- API-клиент в `frontend/src/api/tgUserclient.ts`.

### Фаза B5 — UI менеджер (1 день)
- `OperatorDetail.tsx` — вкладка «Диалоги».
- `TgDialogsPanel.tsx` компонент.
- Endpoints для списка чатов/сообщений/инсайтов.
- Пагинация сообщений.

### Фаза B6 — AI-анализ (1 день)
- `apps/tg_userclient/ai/provider.py` + OpenAI/Anthropic реализации.
- Промпт-файлы в `ai/prompts/`.
- Management-команда `analyze_tg_dialogs`.
- Тесты с фейковым провайдером.

### Фаза B7 — Voice (опционально, за фича-флагом, 0.5 дня)
- `transcribe.py` с интерфейсом Whisper.
- Обработка в handler'е при `TG_TRANSCRIBE_VOICE=1`.

### Фаза B8 — Ретенция + операционка (0.5 дня)
- `purge_old_tg_messages`.
- Cron:
  ```
  * * * * *  ...manage.py analyze_tg_dialogs  # hourly? nope: every min, но с internal throttle
  0 4 * * *  ...manage.py purge_old_tg_messages
  ```
  `analyze_tg_dialogs` идемпотентен — можно каждую минуту, он сам не будет дублировать.
- systemd unit для `run_tg_userclient`:
  ```
  [Service]
  Restart=always
  ExecStart=/opt/naffAI/backend/.venv/bin/python manage.py run_tg_userclient
  ```

### Фаза B9 — Документация (0.5 дня)
- `docs/tg-integration-runbook.md`: как получить `TG_API_ID`/`TG_API_HASH`, как оператору
  подключиться, как менеджеру откатить.

**Итого**: ~7 рабочих дней.

---

## 12. Тесты (обязательный минимум)

### Backend
- `test_session_start_creates_pending_code`
- `test_session_start_requires_consent`
- `test_verify_code_ok_moves_to_active`
- `test_verify_code_needs_2fa_moves_to_pending_2fa`
- `test_verify_password_ok`
- `test_revoke_clears_session_string`
- `test_message_ingest_creates_chat_and_message`
- `test_message_ingest_matches_lead_by_phone`
- `test_message_ingest_ignores_channels`
- `test_message_ingest_idempotent_on_duplicate_tg_message_id`
- `test_only_owner_or_manager_can_view_status`
- `test_operator_cannot_start_session_for_another_operator`

### AI (с fake-провайдером)
- `test_analyze_creates_insight_for_operator`
- `test_analyze_skips_if_up_to_date`
- `test_analyze_handles_provider_error`

Для Telethon-специфики — **не тестировать** реальным подключением к TG. Мокать
`TelegramClient` целиком.

---

## 13. Стиль

- Строго HackSoft: fat services + thin views + selectors для read.
- Каждый мутирующий сервис пишет `AuditLog` через `audit_log_create` (см. `apps/audit/services.py`).
- **plaintext** session-string и код 2FA — **никогда** в лог, никогда в audit-diff.
- Никаких эмодзи в коде/коммитах.
- Type hints везде.
- Комменты — только для крипто-нюансов и Telegram API-квинков.

---

## 14. Открытые вопросы к владельцу (если возникнут)

Не блокироваться — задать одним списком в конце реализации фазы B2.
Кандидаты:
1. Хранить voice-транскрипты или ограничиться только текстами? (дефолт: только тексты)
2. LLM: OpenAI GPT-4o или Anthropic Claude Sonnet 4.6? (дефолт: Anthropic — лучше держит узбекский)
3. Ретенция сообщений: 90 дней норм? (дефолт: 90)
4. Показывать красную точку менеджеру в шапке при `EXPIRED`? (дефолт: да)
5. Разрешать оператору видеть его инсайты? (дефолт: нет — только manager)

---

## 15. Финальный отчёт после реализации

- Список файлов с путями и строками ключевых сервисов.
- Пример команд:
  - как получить `TG_API_ID`/`TG_API_HASH`
  - как запустить runner локально
  - как проверить подключение оператора end-to-end
- Скриншот или описание UI wizard'а.
- Список открытых вопросов (см. §14).
