# Спецификация: Gemini как LLM-провайдер для AI-анализа TG-диалогов

Документ для builder-агента. Задача — добавить **Google Gemini** как основной провайдер AI-анализа
в модуль `apps/tg_userclient/` и подготовить возможность fallback при исчерпании квоты.

Все ссылки — на **существующий код** в `/Users/user/Desktop/mp/ai/naff/`. Стиль — строгий HackSoft.

---

## 1. Контекст

- Проект: naffAI (`/Users/user/Desktop/mp/ai/naff/`), Django 5 + DRF + React/Vite.
- Модуль `apps/tg_userclient/` уже реализован (см. `docs/tg-integration-spec.md`).
- В `apps/tg_userclient/ai/provider.py` уже есть:
  - `Protocol LLMProvider` — интерфейс.
  - `MessageDTO`, `InsightResult` — dataclass'ы.
  - Заглушки `OpenAIProvider`, `AnthropicProvider`, `NoneProvider`.
- Промпт `apps/tg_userclient/ai/prompts/dialog_v1.txt` уже существует.
- Management-команда `analyze_tg_dialogs` уже запускается по cron'у и дергает провайдера.

**Провайдер выбирается через `settings.LLM_PROVIDER` (см. `config/settings/base.py`).** Сейчас
там `"none"`. После этой работы должно поддерживаться `"gemini"` (основной) и
`"anthropic" / "openai"` (уже написаны как заглушки).

---

## 2. Цель

Реализовать **`GeminiProvider`** в существующем `apps/tg_userclient/ai/provider.py` так, чтобы:

1. Использовался Google Gemini API через официальный SDK `google-genai`.
2. Модель по умолчанию — **`gemini-3.6-flash`** (актуальная flash на 2026-07). Настраивается через `settings.GEMINI_MODEL`.
3. При падении с квотой (HTTP 429 / `ResourceExhausted`) — **fallback** на `gemini-2.5-flash-lite`. Логировать факт fallback'а.
4. Работал в существующем интерфейсе `LLMProvider` — без изменений в `analyze_tg_dialogs`, `NoneProvider`, `services.py`.
5. Не ломал существующие 13 тестов `tg_userclient`.

**Не-цели**:
- Не менять `Protocol LLMProvider` без крайней нужды.
- Не переписывать `OpenAIProvider` / `AnthropicProvider`.
- Не добавлять Vertex AI. Только **Google AI Studio (Gemini API)** через `google-genai`.
- Не хранить plaintext API-ключ в audit-логах.

---

## 3. Обоснование выбора и стоимости

**Почему Gemini**:
- Free tier Google AI Studio: **1500 запросов/день Flash + 1M токенов/день**, 15 QPM.
- Расчёт для 25 операторов × ~30 диалогов/день × 1 анализ/день + 25 недельных сводок = **~775 запросов/день** → влезает в free tier с 2× запасом.
- Узбекский/русский держит нормально (лучше Llama, слабее Claude — но бесплатно перевешивает).
- 1M токенов input — можем засовывать длинные диалоги без chunking'а.

**Модель по умолчанию — `gemini-3.6-flash`**:
- Актуальная flash на 2026-07 (см. вывод `/models` — уже есть в API).
- 1M input, 65k output.
- Для sales-дилог-анализа с JSON-выводом — хватает с запасом.

**Fallback — `gemini-2.5-flash-lite`**:
- Отдельная квота, счётчик не пересекается с Flash.
- Немного дешевле по квоте, качество чуть ниже — приемлемо для батча.

**Стоимость** (при free tier ключе): **0₽/мес**. Если ключ paid — Flash ≈ $0.075/1M input, $0.30/1M output; наш батч ≈ $2-4/мес.

---

## 4. Секреты и настройки

### 4.1 `.env.example` — добавить (пустыми):
```env
# Google Gemini (AI Studio)
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.6-flash
GEMINI_FALLBACK_MODEL=gemini-2.5-flash-lite
```

### 4.2 `config/settings/base.py` — добавить блок (рядом с `TG_*`):
```python
LLM_PROVIDER = config("LLM_PROVIDER", default="none")   # ← уже есть, не дублируй
GEMINI_API_KEY = config("GEMINI_API_KEY", default="")
GEMINI_MODEL = config("GEMINI_MODEL", default="gemini-3.6-flash")
GEMINI_FALLBACK_MODEL = config("GEMINI_FALLBACK_MODEL", default="gemini-2.5-flash-lite")
```

### 4.3 `pyproject.toml` — добавить зависимость:
```toml
"google-genai>=1.0",   # текущий официальный SDK Google (не старый google-generativeai)
```

Установить: `uv pip install google-genai --python .venv/bin/python`

---

## 5. Реализация `GeminiProvider`

Класс в **том же файле** `apps/tg_userclient/ai/provider.py`, добавить рядом с `OpenAIProvider`.
Стиль — как остальные провайдеры в этом файле.

### 5.1 Скелет

```python
class GeminiProvider:
    """
    Google Gemini via google-genai SDK (AI Studio, not Vertex).
    Primary: settings.GEMINI_MODEL. Fallback on 429/ResourceExhausted:
    settings.GEMINI_FALLBACK_MODEL.
    """

    def __init__(self, *, api_key: str, model: str, fallback_model: str) -> None:
        from google import genai
        if not api_key:
            raise ValueError("GEMINI_API_KEY is empty")
        self._client = genai.Client(api_key=api_key)
        self._model = model
        self._fallback_model = fallback_model

    def analyze_dialogs(
        self,
        *,
        operator_name: str,
        messages: list[MessageDTO],
        prompt_version: str,
    ) -> InsightResult:
        prompt = self._build_prompt(operator_name, messages, prompt_version)
        try:
            result = self._call(self._model, prompt)
            model_used = self._model
        except ResourceExhausted:
            logger.warning("gemini quota hit on %s — falling back to %s",
                           self._model, self._fallback_model)
            result = self._call(self._fallback_model, prompt)
            model_used = self._fallback_model
        return self._parse(result, model_used, prompt_version)
```

### 5.2 `_build_prompt`
- Читать шаблон из `apps/tg_userclient/ai/prompts/dialog_{prompt_version}.txt` (уже существует `dialog_v1.txt`).
- Форматировать через `str.format` подстановкой `{op_name}` и `{dialog}`.
- `{dialog}` — конкатенация `messages` в формате:
  ```
  [OP → CLIENT | 12:30]: ...
  [CLIENT → OP | 12:31]: ...
  ```

### 5.3 `_call`
```python
def _call(self, model: str, prompt: str) -> str:
    resp = self._client.models.generate_content(
        model=model,
        contents=prompt,
        config={
            "response_mime_type": "application/json",
            "max_output_tokens": 800,
            "temperature": 0.3,
        },
    )
    return resp.text
```

### 5.4 `_parse`
- Парсит JSON-ответ.
- Ожидаемый формат (совпадает с полями `TgAiInsight`):
  ```json
  {
    "quality_score": 78,
    "summary": "…",
    "red_flags": ["обещал скидку 50%", "…"],
    "highlights": ["…"]
  }
  ```
- Возвращает `InsightResult(model_version=model_used, prompt_version=prompt_version, ...)`.
- Если JSON битый — `raise LLMProviderError("gemini returned invalid json: …")`.

### 5.5 Импорт `ResourceExhausted`
```python
try:
    from google.genai.errors import ClientError as _GeminiClientError
except ImportError:
    _GeminiClientError = Exception   # тесты без SDK

# ResourceExhausted распознаём по коду:
def _is_quota_error(exc: Exception) -> bool:
    return isinstance(exc, _GeminiClientError) and getattr(exc, "code", None) == 429
```

Использовать `_is_quota_error(exc)` вместо `except ResourceExhausted`.

### 5.6 Фабрика провайдера

В том же файле — обновить существующую (или создать) `def get_llm_provider() -> LLMProvider`:

```python
def get_llm_provider() -> LLMProvider:
    kind = settings.LLM_PROVIDER.lower()
    if kind == "gemini":
        return GeminiProvider(
            api_key=settings.GEMINI_API_KEY,
            model=settings.GEMINI_MODEL,
            fallback_model=settings.GEMINI_FALLBACK_MODEL,
        )
    if kind == "openai":
        return OpenAIProvider(...)   # оставить как есть
    if kind == "anthropic":
        return AnthropicProvider(...) # оставить как есть
    return NoneProvider()
```

Если фабрика уже есть — только **добавить ветку `gemini`**, не переделывать существующее.

---

## 6. Обновление промпта

Промпт `apps/tg_userclient/ai/prompts/dialog_v1.txt` **не менять**. Он уже написан под возврат JSON.

Если формата плейсхолдеров нет — добавить в начало промпта строгую инструкцию:

```
Ты — эксперт по продажам телефонов в Ташкенте.
Оператор: {op_name}. Ниже переписка с клиентом.

{dialog}

Верни строго JSON без пояснений:
{
  "quality_score": <int 0-100>,
  "summary": "<1-2 предложения>",
  "red_flags": ["<строка>", ...],
  "highlights": ["<строка>", ...]
}

Работай на русском и узбекском одинаково.
```

Не создавать `dialog_v2.txt` — v1 нам ещё пригодится для diffа между версиями.

---

## 7. Тесты

Файл: `apps/tg_userclient/tests/test_gemini_provider.py`.

Обязательный минимум:

### 7.1 `test_gemini_provider_parses_valid_json`
- Замокать `genai.Client.models.generate_content` через `unittest.mock.patch`.
- Вернуть mock с `.text = '{"quality_score":80,"summary":"ok","red_flags":[],"highlights":[]}'`.
- Проверить что `InsightResult` содержит правильные поля + `model_version == settings.GEMINI_MODEL`.

### 7.2 `test_gemini_fallback_on_429`
- Первый `generate_content` кидает `ClientError(code=429)`.
- Второй возвращает валидный JSON.
- Проверить: результат вернулся, `model_version == GEMINI_FALLBACK_MODEL`.
- Проверить что логирование сработало (использовать `caplog`).

### 7.3 `test_gemini_invalid_json_raises`
- Mock возвращает `.text = "not json"`.
- Ожидаем `LLMProviderError`.

### 7.4 `test_get_llm_provider_returns_gemini_when_configured`
- `override_settings(LLM_PROVIDER="gemini", GEMINI_API_KEY="test")`.
- Проверить: `isinstance(get_llm_provider(), GeminiProvider)`.

### 7.5 `test_get_llm_provider_falls_back_to_none_without_key`
- `override_settings(LLM_PROVIDER="gemini", GEMINI_API_KEY="")`.
- Ожидаем `NoneProvider` (или четкая ошибка с советом добавить ключ).

**Реальный HTTP-вызов Gemini НЕ делать в тестах.** Всё через mock.

---

## 8. Интеграция с существующим `analyze_tg_dialogs`

Скорее всего команда `apps/tg_userclient/management/commands/analyze_tg_dialogs.py` уже
использует фабрику `get_llm_provider()`. Если да — ничего не менять.

Если нет — обновить импорт:
```python
from apps.tg_userclient.ai.provider import get_llm_provider

def handle(self, *args, **options):
    provider = get_llm_provider()
    ...
```

**Проверить** после реализации что `python manage.py analyze_tg_dialogs --dry-run` (если флаг есть) отработает без ошибок при `LLM_PROVIDER=none`.

---

## 9. Как проверить в реальности после кода

Проверять **самим агентом не надо** — ключ пользователь введёт сам после ротации. Достаточно
инструкции в отчёте:

```bash
# 1. Ротируй ключ (старый скомпрометирован в чате): https://aistudio.google.com/apikey
# 2. Вставь в .env:
#    LLM_PROVIDER=gemini
#    GEMINI_API_KEY=<новый ключ>
# 3. Один тестовый запуск:
POSTGRES_HOST=localhost POSTGRES_PORT=5544 DJANGO_SETTINGS_MODULE=config.settings.dev \
  .venv/bin/python manage.py analyze_tg_dialogs --limit 1
# 4. Проверить в БД:
#    TgAiInsight.objects.latest("id").summary
```

---

## 10. Стиль и правила

- Строго HackSoft: сервис не пишет напрямую в БД мимо существующих `apps/tg_userclient/services.py`. `GeminiProvider` — pure-функция «в prompt → JSON», без Django-моделей внутри.
- **plaintext API-ключ** — только в `settings`, никогда в logging, никогда в audit-diff, никогда в тестах в коде (только через `override_settings`).
- Никаких эмодзи в коде и коммитах.
- Type hints везде.
- Комменты — только для нюансов Gemini API (например, почему `response_mime_type="application/json"`).

---

## 11. План работ (~1-2 часа)

1. **B1**: Зависимость `google-genai>=1.0` в `pyproject.toml` + `uv pip install`.
2. **B2**: Добавить env-переменные в `settings/base.py` и `.env.example`.
3. **B3**: Написать `GeminiProvider` в `apps/tg_userclient/ai/provider.py` (~80 строк).
4. **B4**: Обновить/дописать `get_llm_provider()` — добавить ветку `gemini`.
5. **B5**: 5 тестов из §7.
6. **B6**: Убедиться что все 13 существующих тестов `tg_userclient` остались зелёными.
7. **B7**: Обновить README (короткий блок «AI provider: Gemini»).

---

## 12. Открытые вопросы (закрыты дефолтами)

1. **Основная модель?** — `gemini-3.6-flash` (актуальная flash на 2026-07). Если по факту исчезнет — упасть в `gemini-flash-latest`.
2. **Fallback?** — `gemini-2.5-flash-lite` (отдельная квота).
3. **Что делать при отсутствии ключа при `LLM_PROVIDER=gemini`?** — `raise ImproperlyConfigured` в `prod.py`; в `dev.py` и `test.py` — вернуть `NoneProvider` с warning.
4. **Логировать полный prompt и ответ Gemini?** — **нет**. Только `model_version, tokens_used, latency_ms`. Prompt содержит реальные переписки клиентов.
5. **Кэшировать одинаковые prompt'ы?** — не в этой фазе, слишком редкое совпадение.

---

## 13. Финальный отчёт

После завершения (для человека):
- Ссылки file_path:line на `GeminiProvider`, `get_llm_provider`, новые тесты.
- Вывод `pytest apps/tg_userclient` (все зелёные).
- Инструкция как включить (см. §9).
- Список открытых вопросов (если появились новые сверх §12).
