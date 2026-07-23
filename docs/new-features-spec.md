# Новые фичи naffAI — Стикеры, AI-цитаты, AI-дашборд

Спека для builder-агента. **3 фичи в порядке нарастающей сложности**. Каждая — самостоятельная, но идут в этом порядке (F1 → F2 → F3).

**Контекст**: Проект `/Users/user/Desktop/mp/ai/naff/`. Django 5 + DRF + React + Vite + TypeScript. AI-провайдер уже настроен (`apps/tg_userclient/ai/provider.py:GeminiProvider` — можно переиспользовать). Регресс: 172 passed / 0 failed. HackSoft-раскладка. Никаких эмодзи в **коде** (в UI можно — фича сама про эмодзи).

Финализированные решения пользователя:
- Логин остаётся: phone + пароль (не меняем на TG SMS)
- Стикеры: обычные эмодзи + 1 «редкий» назначаемый админом
- AI-чат: читает БД, отвечает + графы, без write-действий

---

## Фича F1 — Стикеры операторов (~1 день)

### F1.1 Модели

Новый app `apps/stickers/` (или расширение `apps/operators/`). Один файл `models.py`:

```python
class OperatorSticker(TimestampedModel):
    operator = models.OneToOneField(
        "operators.Operator", on_delete=CASCADE, related_name="sticker"
    )
    emoji = models.CharField(max_length=8)        # utf-8 emoji
    is_rare = models.BooleanField(default=False)  # only 1 rare across whole system
    assigned_by = models.ForeignKey(
        "auth.User", null=True, blank=True, on_delete=SET_NULL,
        help_text="Кто назначил (только для rare)"
    )

    class Meta:
        constraints = [
            # Обычные эмодзи уникальны в системе среди всех operator'ов
            models.UniqueConstraint(
                fields=["emoji"],
                condition=Q(is_rare=False),
                name="unique_common_sticker",
            ),
            # Rare может быть только один во всей системе
            models.UniqueConstraint(
                fields=["is_rare"],
                condition=Q(is_rare=True),
                name="single_rare_sticker",
            ),
        ]
```

Миграция.

### F1.2 Селекторы / сервисы

`apps/stickers/selectors.py`:
- `taken_emojis() -> set[str]` — множество занятых обычных эмодзи
- `rare_holder() -> Operator | None`

`apps/stickers/services.py`:
- `sticker_set(operator, emoji, *, actor)` — оператор выбирает свой; проверка `emoji not in taken_emojis()`. Если уже был — обновляем.
- `sticker_grant_rare(operator, emoji, *, actor)` — admin назначает rare. Отбирает у предыдущего носителя (если был), устанавливает новому. Audit.
- `sticker_revoke(operator, *, actor)` — сброс.

Все — атомарные транзакции + `audit_log_create`.

### F1.3 API

- `GET /api/stickers/taken/` — `{"emojis": ["🔥", "⚡", ...]}` (для UI подсветки серым)
- `PUT /api/me/sticker/` — оператор ставит себе (body: `{"emoji": "🎯"}`)
- `PUT /api/operators/{id}/sticker/` — admin ставит любому (body: `{"emoji": "...", "is_rare": true|false}`)
- `DELETE /api/operators/{id}/sticker/` — admin убирает
- `GET /api/operators/{id}/` расширить `sticker` полем в serializer

Permissions: `IsAuthenticated` для GET; `IsSelfOrManager` для мутаций.

### F1.4 UI

- `Profile.tsx` — блок «Мой стикер»: текущий крупно + кнопка «Изменить». Модалка с сеткой ≈100 эмодзи (`🔥⚡🎯💎🌟💫🚀⭐🎨🎪...`), занятые серые с tooltip «Занят: [имя оператора]».
- `Operators.tsx` — новая колонка «Стикер». Для manager кнопка «⭐ Rare» открывает мини-модалку выбора эмодзи + галка is_rare.
- `MyLeads.tsx` header — рядом с именем оператора показать стикер (крупно).
- `Screen.tsx` (TV) — стикеры в лидерборде рядом с именем.
- `Layout.tsx` sidebar footer — стикер оператора возле его имени.

### F1.5 Тесты

- `test_common_sticker_uniqueness` — 2-й оператор с тем же emoji → ValidationError
- `test_rare_sticker_singleton` — 2-й rare → отбирает у 1-го (или ошибка — уточнить)
- `test_only_admin_can_grant_rare`
- `test_taken_endpoint_returns_current_emojis`

---

## Фича F2 — Утренние AI-цитаты при первом логине дня (~0.5 дня)

### F2.1 Модели

Кэш чтобы не дёргать Gemini каждый раз:

```python
class DailyQuote(TimestampedModel):
    quote_date = models.DateField(db_index=True)
    language = models.CharField(max_length=8)  # "ru" / "uz"
    text = models.TextField()
    author = models.CharField(max_length=100, blank=True, default="")
    generated_by_model = models.CharField(max_length=64)  # e.g. "gemini-3.6-flash"

    class Meta:
        unique_together = [("quote_date", "language")]
```

**Дизайн**: одна цитата на день на язык, показывается всем операторам этого языка. Индивидуализация — не нужна.

Модель `DailyGreetingShown(operator, date)` (unique_together) — чтобы фиксировать «уже видел сегодня».

### F2.2 Сервис

`apps/greetings/services.py`:

```python
def get_or_create_daily_quote(*, language: str) -> DailyQuote:
    today = timezone.localdate()
    qs = DailyQuote.objects.filter(quote_date=today, language=language)
    if quote := qs.first():
        return quote
    # generate via Gemini
    provider = get_llm_provider()  # from apps.tg_userclient.ai.provider
    prompt = _load_prompt(language)  # "Дай короткую (1-2 предложения) мотивационную цитату..."
    text, author = provider.generate_quote(prompt)  # новый метод в провайдере
    return DailyQuote.objects.create(
        quote_date=today, language=language,
        text=text, author=author, generated_by_model=settings.GEMINI_MODEL,
    )

def mark_greeting_shown(operator: Operator) -> None:
    DailyGreetingShown.objects.get_or_create(operator=operator, date=timezone.localdate())

def should_show_greeting(operator: Operator) -> bool:
    return not DailyGreetingShown.objects.filter(
        operator=operator, date=timezone.localdate()
    ).exists()
```

Промпты в `apps/greetings/prompts/{ru,uz}.txt`:

```
ru.txt:
Дай короткую (1-2 предложения) мотивационную цитату для оператора call-центра
магазина телефонов. На русском. Если цитата известного автора — укажи его через "—".
Формат: TEXT — AUTHOR

uz.txt:
Telefon do'koni call-markazi operatori uchun qisqa (1-2 gap) motivatsion iqtibos ber.
O'zbek tilida. Agar mashhur muallif bo'lsa — "—" orqali ko'rsat.
Format: TEXT — AUTHOR
```

### F2.3 API

- `GET /api/me/morning-greeting/` — возвращает `{quote, author, should_show}`. Если `should_show=false` — квота на сегодня уже показана. Оператор сам решает показывать/нет.
- `POST /api/me/morning-greeting/dismiss/` — помечает как показанное.

### F2.4 UI

- В `App.tsx` или `MyLeads.tsx` при загрузке — вызвать `GET /api/me/morning-greeting/` → если `should_show=true` → показать модалку.
- Модалка: карточка с цитатой + автором + кнопка «Приступить». При закрытии → `POST /dismiss/`.
- Дизайн — минималистичный, с градиентом или иконкой ☀.
- Язык модалки — из `Profile.language` или `navigator.language`.

### F2.5 Тесты

- `test_quote_generated_once_per_day_per_language`
- `test_second_call_returns_cached_quote`
- `test_should_show_flips_after_dismiss`
- `test_next_day_shows_again`

---

## Фича F3 — AI-дашборд админа: чат + маркетинг-агент + расширенные графики (~3-4 дня)

Большая фича. Разбита на 3 подмодуля.

### F3.A — AI-чат админа с чтением БД

#### F3.A.1 Backend

Новый app `apps/ai_chat/`:

```python
class ChatSession(TimestampedModel):
    user = models.ForeignKey("auth.User", on_delete=CASCADE, related_name="chat_sessions")
    title = models.CharField(max_length=200, blank=True)

class ChatMessage(TimestampedModel):
    session = models.ForeignKey(ChatSession, on_delete=CASCADE, related_name="messages")
    role = models.CharField(max_length=16)  # "user" / "assistant" / "tool"
    content = models.TextField()
    tool_calls = models.JSONField(default=list)  # если ассистент вызвал tools
```

**Tools** (функции которые LLM может вызвать) в `apps/ai_chat/tools.py`:

```python
TOOLS = {
    "get_leads_count": {"description": "...", "handler": ...},
    "get_sales_summary": {"description": "..."},
    "get_operator_stats": {"description": "..."},
    "get_funnel_data": {"description": "..."},
    "get_callback_backlog": {"description": "..."},
    "get_lead_source_quality": {"description": "..."},
}
```

Каждый handler:
- Принимает JSON-параметры (например `{"period": "week", "operator_id": 1}`)
- Возвращает **только read-only данные**: агрегаты, топ-N, счётчики
- Использует существующие селекторы из `apps/analytics/selectors.py`, `apps/payroll/selectors.py`

**Никаких write-tools** — AI НЕ может назначить/удалить/изменить.

#### F3.A.2 API

- `POST /api/ai-chat/sessions/` — создать
- `GET /api/ai-chat/sessions/` — список моих
- `POST /api/ai-chat/sessions/{id}/messages/` — послать сообщение, получить streaming ответ (SSE или обычный JSON после завершения — на выбор реализатора, но обычный JSON проще)
- `GET /api/ai-chat/sessions/{id}/messages/` — история

Permission: **manager only** (не team_lead).

#### F3.A.3 Реализация Gemini function-calling

Gemini 3.6+ поддерживает function calling. `GeminiProvider.chat_with_tools(messages, tools) -> str | ToolCall` — loop до финального ответа:

```python
def handle_message(session, user_text):
    session.messages.create(role="user", content=user_text)
    history = list(session.messages.order_by("created_at").values("role", "content"))
    while True:
        response = provider.chat_with_tools(history, TOOLS)
        if response.type == "tool_call":
            result = TOOLS[response.name]["handler"](**response.arguments)
            session.messages.create(role="tool", content=json.dumps(result))
            history.append({"role": "tool", "content": json.dumps(result)})
        else:  # final text
            session.messages.create(role="assistant", content=response.text)
            return response.text
```

Лимит цикла: макс. 5 tool-calls на сообщение (защита от бесконечного цикла).

#### F3.A.4 UI

Новая страница `AIChat.tsx` — двухпанельный layout:
- Левая колонка: список сессий (title + last_message_at)
- Правая: сообщения + input внизу

Дизайн — как ChatGPT/Claude. Streaming не обязательно, обычный «→ ответ через 3-10 сек» ок.

Если tool возвращает `{"type": "chart", "data": [...]}` — рендерить `<Recharts>` inline.

### F3.B — AI-агент маркетинг-аналитик

#### F3.B.1 Модель

```python
class MarketingInsight(TimestampedModel):
    period_start = models.DateField()
    period_end = models.DateField()
    lead_quality_by_source = models.JSONField(default=dict)
    # e.g. {"sheet_1": {"leads": 500, "converted": 45, "rate": 9.0}, ...}
    targeting_recommendations = models.JSONField(default=list)
    # e.g. ["Sheet 2 конвертит 12%, Sheet 3 — 1%. Сфокусируйтесь на 2.", ...]
    top_products = models.JSONField(default=list)
    summary = models.TextField()
    model_version = models.CharField(max_length=64)

    class Meta:
        unique_together = [("period_start", "period_end")]
        indexes = [models.Index(fields=["-period_start"])]
```

#### F3.B.2 Management-команда

`python manage.py run_marketing_analyst --period week` — раз в неделю по cron.

Логика:
1. Собрать данные за период: лиды по источникам, конверсия, средний чек, топ товаров.
2. Скормить Gemini с промптом «Ты — маркетинг-аналитик. Вот данные. Дай рекомендации по таргетингу и качеству источников. JSON.»
3. Сохранить `MarketingInsight`.

#### F3.B.3 UI

Новая страница `/marketing` (manager only):
- Виджет «Конверсия по источникам» (bar chart)
- Секция «Рекомендации» (список от LLM)
- Секция «Топ товаров»
- История инсайтов (пагинация)

### F3.C — Расширенные графики распределения лидов

Уже есть `/analytics`. Добавить туда 3 новых чарта или сделать отдельную вкладку:

1. **Распределение лидов по операторам** (bar): X — операторы, Y — кол-во активных лидов (по статусам). Стек: `new / assigned / in_progress / won / lost`.
2. **Воронка по каждому оператору** (small multiples): для топ-10 операторов — миниатюрная воронка `Лид → Взят → Callback → Продажа`.
3. **Тепловая карта callback-активности** (heatmap): X — часы дня, Y — операторы, цвет — кол-во callback'ов.

Данные — через `apps/analytics/selectors.py` (расширить).

---

## Порядок работ (обязательный)

1. **F1** (стикеры) — самая простая, разогрев.
2. **F2** (утренние цитаты) — используется тот же LLM-провайдер что и в TG-анализе. Расширяем `GeminiProvider` методом `generate_quote`.
3. **F3.C** (расширенные графики) — чистый frontend + селекторы, LLM не нужен.
4. **F3.A** (AI-чат) — крупная, требует function-calling. Использует наработки F3.C для чартов в ответах.
5. **F3.B** (маркетинг-агент) — batch-команда + UI. Не блокирует остальное.

Внутри каждой фичи — по коммиту на подзадачу.

## Стиль (для всех фич)

- HackSoft строго. Мутирующие сервисы — `audit_log_create` (auto-scrub из Волны 1 работает).
- **AI-чат tools — только read**, никаких write-действий (пользователь чётко попросил).
- TypeScript strict, никакого `any`.
- Никаких эмодзи в коде и коммитах (стикеры — это UI-контент, разрешено).
- Type hints везде.
- LLM провайдер — переиспользовать существующий `apps.tg_userclient.ai.provider.get_llm_provider()`. Если нужны новые методы (`generate_quote`, `chat_with_tools`) — добавить в тот же интерфейс `LLMProvider` (Protocol).

## Тесты

Минимум:
- F1: 4 теста
- F2: 4 теста
- F3.A: 6 тестов (tool handlers + chat loop + limit)
- F3.B: 3 теста (batch + insight save + UI serializer)
- F3.C: не требует — визуальная проверка

Регресс: **172 pre-existing зелёных не должны сломаться**. Итого ≥190 passed.

## Открытые вопросы (закрыты дефолтами)

1. **Rare сtiкер: при назначении нового — отбирается у старого или ошибка?** Дефолт: **отбирается** (admin явно перепереназначает). Audit'ом фиксируем.
2. **AI-чат — streaming или blocking?** Дефолт: **blocking** (проще, 3-10 сек ответ — приемлемо).
3. **Marketing-analyst — период дефолт?** Дефолт: **week** (7 дней назад до сегодня).
4. **Утренние цитаты — язык?** Дефолт: `Profile.language` если есть, иначе `ru`.

## Финальный отчёт

- Каждой фичи (F1, F2, F3.A, F3.B, F3.C): file:line ключевых изменений.
- Итог pytest: N passed / 0 failed.
- Скриншот/описание UI каждой фичи.
- Стоимость LLM: сколько запросов Gemini на день ожидается (для утренних цитат — 2/день, для чата — по нужде, для marketing — 1/неделя).
