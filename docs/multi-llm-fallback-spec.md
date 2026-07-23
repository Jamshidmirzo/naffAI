# Multi-provider LLM chain с автоматическим fallback

Спека для builder-агента. Задача — реализовать **цепочку провайдеров** которая автоматически переключается при 429/rate-limit ошибках, как в Cursor/Claude/GPT-fallback паттернах. Плюс UI-индикация «этот ответ от X модели, потому что Y заблокирован».

**Контекст**: Проект `/Users/user/Desktop/mp/ai/naff/`. Django 5 + DRF + React. Регресс сейчас 203 passed / 0 failed. LLM-провайдер уже готов через `Protocol LLMProvider` в `apps/tg_userclient/ai/provider.py`. Есть `GeminiProvider`, `OpenAIProvider` (заглушка), `AnthropicProvider` (заглушка), `NoneProvider`. Используется в: `apps/tg_userclient/management/commands/analyze_tg_dialogs.py`, `apps/greetings/services.py`, `apps/marketing/services.py`, `apps/ai_chat/services.py`.

## Что уже проверено

- **Gemini**: ключ `AQ.Ab8R…` в `.env`, работает `gemini-flash-latest`, `gemini-2.0-flash`. Free tier: **5 QPM на preview-моделях** (3.6-flash), 15 QPM на стабильных.
- **GitHub Models**: работает через **токен `gh auth token`** (обычный OAuth, без Copilot Pro). 
  - Endpoint: `https://models.github.ai/inference/chat/completions` — **OpenAI-совместимый**
  - 37 моделей: OpenAI (GPT-4.1/mini/nano, 4o/mini), DeepSeek (v3/R1), Llama 3.3, Mistral, Phi-4
  - Дневной лимит: **150 запросов/день на модель** для не-Copilot аккаунтов
  - Free для Student Pack

## Цель

Один вход `get_llm_provider()` → **прозрачно** переключается между провайдерами при 429/rate-limit/сеть-fail, возвращает результат + метаданные `provider_used` для UI.

## Не-цели

- Не менять существующие `GeminiProvider`, `NoneProvider` — только обернуть.
- Не менять существующий Protocol `LLMProvider` без обратной совместимости.
- Не хранить persistent counter квот в БД (полагаемся на 429 от API).

---

## 1. Провайдеры для добавления

### 1.1 `GitHubModelsProvider`

Новый класс в `apps/tg_userclient/ai/provider.py`. OpenAI-совместимый endpoint.

```python
class GitHubModelsProvider:
    """
    GitHub Models via https://models.github.ai/inference/
    OpenAI-compatible. Auth: bearer token (gh CLI OAuth works, no Copilot Pro required).
    """
    
    BASE_URL = "https://models.github.ai/inference"
    
    def __init__(self, *, token: str, model: str) -> None:
        if not token:
            raise ValueError("GITHUB_MODELS_TOKEN is empty")
        self._token = token
        self._model = model  # e.g. "openai/gpt-4o-mini", "deepseek/deepseek-v3-0324"
    
    def generate_content(self, *, prompt: str, response_json: bool = False) -> LLMResponse:
        payload = {
            "model": self._model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 4000,
            "temperature": 0.3,
        }
        if response_json:
            payload["response_format"] = {"type": "json_object"}
        r = httpx.post(
            f"{self.BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {self._token}"},
            json=payload,
            timeout=60,
        )
        if r.status_code == 429:
            raise LLMRateLimitError(f"GitHub Models 429: {r.text[:200]}")
        r.raise_for_status()
        data = r.json()
        text = data["choices"][0]["message"]["content"]
        return LLMResponse(text=text, model_used=self._model, provider="github_models")
    
    def generate_quote(self, *, prompt: str) -> QuoteResult: ...
    def chat_with_tools(self, ...) -> ChatResponse: ...
    def analyze_dialogs(self, ...) -> InsightResult: ...
```

**Все методы Protocol'а** — реализовать. Для `chat_with_tools` — использовать OpenAI-style `tools` параметр (функционально аналогично Gemini function-calling).

### 1.2 `LLMRateLimitError` — общий exception

Новый класс, наследует `LLMProviderError`. Гемини бросает `ClientError(code=429)` — обернуть в chain'е в `LLMRateLimitError`. GitHub Models — детектится по `status_code == 429`.

Провайдеры бросают `LLMRateLimitError` → chain ловит → пробует следующего.

Другие exceptions (5xx, timeouts, парсинг) — тоже ловить как рекуверабельные с флагом.

---

## 2. `LLMProviderChain` — сама цепочка

Новый класс в том же файле:

```python
@dataclass(frozen=True)
class LLMResponse:
    text: str
    model_used: str  # e.g. "gemini-3.6-flash", "openai/gpt-4o-mini"
    provider: str  # e.g. "gemini", "github_models"

class LLMProviderChain:
    """
    Ordered list of providers. Each call walks the list in order,
    catching LLMRateLimitError and network errors, moving to the next.
    Records which provider ultimately answered on the response.
    """
    
    def __init__(self, providers: list[LLMProvider], *, name_map: dict[LLMProvider, str] | None = None) -> None:
        if not providers:
            raise ValueError("chain must have at least 1 provider")
        self._providers = providers
        self._name_map = name_map or {}
    
    def _call_with_fallback(self, method_name: str, **kwargs):
        last_error = None
        for provider in self._providers:
            try:
                result = getattr(provider, method_name)(**kwargs)
                logger.info(
                    "llm.chain: %s succeeded with %s",
                    method_name,
                    self._name_map.get(provider, type(provider).__name__),
                )
                return result
            except LLMRateLimitError as e:
                logger.warning(
                    "llm.chain: %s hit rate-limit on %s, falling back",
                    method_name,
                    self._name_map.get(provider, type(provider).__name__),
                )
                last_error = e
                continue
            except Exception as e:
                # Network / parse / unknown — also fall through but log louder
                logger.error(
                    "llm.chain: %s failed on %s: %s",
                    method_name,
                    self._name_map.get(provider, type(provider).__name__),
                    e,
                )
                last_error = e
                continue
        raise LLMChainExhaustedError(f"all providers exhausted: {last_error}")
    
    # Прокси-методы
    def generate_content(self, **kwargs): return self._call_with_fallback("generate_content", **kwargs)
    def generate_quote(self, **kwargs): return self._call_with_fallback("generate_quote", **kwargs)
    def chat_with_tools(self, **kwargs): return self._call_with_fallback("chat_with_tools", **kwargs)
    def analyze_dialogs(self, **kwargs): return self._call_with_fallback("analyze_dialogs", **kwargs)
```

**`LLMChainExhaustedError`** — новый exception. Все провайдеры отказали. Пусть caller решает что делать (обычно — fallback на статический текст).

---

## 3. Конфиг цепочки

### 3.1 Env vars

Добавить в `config/settings/base.py`:

```python
# Multi-provider chain
LLM_CHAIN = config("LLM_CHAIN", default="gemini,github_models_gpt4omini,github_models_deepseek,github_models_llama")
GITHUB_MODELS_TOKEN = config("GITHUB_MODELS_TOKEN", default="")

# Per-model configs (по одной env-переменной на слот в цепочке)
LLM_CHAIN_MODELS = {
    "gemini": config("LLM_CHAIN_GEMINI_MODEL", default="gemini-flash-latest"),
    "github_models_gpt4omini": config("LLM_CHAIN_GH_GPT4OMINI", default="openai/gpt-4o-mini"),
    "github_models_deepseek": config("LLM_CHAIN_GH_DEEPSEEK", default="deepseek/deepseek-v3-0324"),
    "github_models_llama": config("LLM_CHAIN_GH_LLAMA", default="meta/llama-3.3-70b-instruct"),
    "github_models_gpt41mini": config("LLM_CHAIN_GH_GPT41MINI", default="openai/gpt-4.1-mini"),
}
```

### 3.2 `.env.example`

```env
# LLM chain — providers tried in order, 429 → next
LLM_CHAIN=gemini,github_models_gpt4omini,github_models_deepseek,github_models_llama
GITHUB_MODELS_TOKEN=
# Optional: override models
LLM_CHAIN_GEMINI_MODEL=gemini-flash-latest
LLM_CHAIN_GH_GPT4OMINI=openai/gpt-4o-mini
LLM_CHAIN_GH_DEEPSEEK=deepseek/deepseek-v3-0324
LLM_CHAIN_GH_LLAMA=meta/llama-3.3-70b-instruct
```

Инструкция в README: `GITHUB_MODELS_TOKEN` = вывод `gh auth token`.

### 3.3 Обновлённая `get_llm_provider()`

```python
def get_llm_provider() -> LLMProvider:
    kind = settings.LLM_PROVIDER.lower()
    if kind == "chain":
        return _build_chain_from_settings()
    if kind == "gemini":
        return GeminiProvider(...)
    if kind == "github_models":
        return GitHubModelsProvider(
            token=settings.GITHUB_MODELS_TOKEN,
            model=settings.LLM_CHAIN_MODELS["github_models_gpt4omini"],
        )
    return NoneProvider()

def _build_chain_from_settings() -> LLMProviderChain:
    slots = [s.strip() for s in settings.LLM_CHAIN.split(",") if s.strip()]
    providers = []
    name_map = {}
    for slot in slots:
        model = settings.LLM_CHAIN_MODELS.get(slot)
        if not model:
            logger.warning("unknown LLM_CHAIN slot: %s", slot); continue
        try:
            if slot.startswith("gemini"):
                p = GeminiProvider(api_key=settings.GEMINI_API_KEY, model=model, fallback_model=settings.GEMINI_FALLBACK_MODEL)
            elif slot.startswith("github_models"):
                p = GitHubModelsProvider(token=settings.GITHUB_MODELS_TOKEN, model=model)
            elif slot == "none":
                p = NoneProvider()
            else:
                continue
            providers.append(p)
            name_map[p] = f"{slot}({model})"
        except ValueError as e:
            logger.info("skipping %s: %s", slot, e)  # e.g. missing token
    if not providers:
        return NoneProvider()  # ultimate fallback
    return LLMProviderChain(providers, name_map=name_map)
```

### 3.4 Дефолт

Изменить в `.env`:
```
LLM_PROVIDER=chain
```

Тогда все вызовы `get_llm_provider()` автоматически получают цепочку.

---

## 4. UI индикация «этот ответ от X»

### 4.1 Backend response

Все методы Protocol'а должны возвращать `provider` и `model_used` в `LLMResponse`. Уже в 1.1 сделано.

Для `ChatMessage` (AI-чат) — добавить поле:
```python
model_used = models.CharField(max_length=100, blank=True, default="")
provider_used = models.CharField(max_length=32, blank=True, default="")  # gemini / github_models / none
```
Миграция.

В `handle_user_message` (`apps/ai_chat/services.py`) — сохранять оба поля когда `response.provider` доступен.

Аналогично `TgAiInsight.model_version` уже есть → добавить `provider_used`.
Аналогично `MarketingInsight` и `DailyQuote`.

### 4.2 Frontend

- **AI-чат**: под каждым ответом ассистента маленький бейдж:
  ```tsx
  <span className="text-xs text-gray-400">через {message.provider_used}/{message.model_used}</span>
  ```
- **Marketing**: заголовок инсайта — «Сгенерировано моделью X (провайдер Y)»
- **MorningGreeting**: не показывать пользователю (техническая деталь)
- **Header-баннер (опционально)**: если сегодня хоть раз произошёл fallback (query кэш `["llm-status"]`) — тонкая жёлтая полоска сверху для manager'а «Основной AI-провайдер недоступен, работаем на резерве»

---

## 5. Тесты (обязательный минимум)

`apps/tg_userclient/tests/test_provider_chain.py`:

- `test_first_provider_success_short_circuits` — второй провайдер не вызывается
- `test_second_provider_used_when_first_raises_rate_limit` — mock 1-го → LLMRateLimitError, 2-й отвечает, response.provider == второй
- `test_all_providers_fail_raises_chain_exhausted` — mock всех на 429 → `LLMChainExhaustedError`
- `test_generic_exception_also_falls_through` — 1-й кидает `TimeoutError`, 2-й отвечает
- `test_response_records_which_provider_answered` — проверить `LLMResponse.provider`
- `test_github_models_detects_429_status` — mock httpx с status 429 → `LLMRateLimitError`
- `test_chain_skips_provider_with_missing_token` — GitHub Models без токена → провайдер не добавляется в chain (при build)

Итого 7 новых. Регресс: **203 passed → ≥210 passed / 0 failed**.

---

## 6. План работ

Порядок:

1. **A1** — `LLMResponse` dataclass с полями `text/model_used/provider` + `LLMRateLimitError` + `LLMChainExhaustedError`. Обновить существующие возвраты `GeminiProvider` чтобы всегда возвращали `LLMResponse` (было `str` — обёртка).
2. **A2** — `GitHubModelsProvider` полная реализация всех методов Protocol.
3. **A3** — `LLMProviderChain` + `_build_chain_from_settings()` в фабрике.
4. **A4** — Settings: `LLM_CHAIN`, `GITHUB_MODELS_TOKEN`, `LLM_CHAIN_MODELS`. `.env.example`.
5. **A5** — Миграции `ChatMessage.model_used/provider_used`, `MarketingInsight.provider_used`, `DailyQuote.provider_used`, `TgAiInsight.provider_used`.
6. **A6** — Обновить сервисы (`services.py` в ai_chat, marketing, greetings) чтобы сохранять новые поля.
7. **A7** — Frontend бейджи в `AIChat.tsx` и `Marketing.tsx`.
8. **A8** — 7 тестов.
9. **A9** — README раздел «LLM chain и Student Pack». Инструкция как получить token через `gh auth token`.

**Дефолт после реализации**: `LLM_PROVIDER=chain` в `.env`.

---

## 7. Стиль

- Строго HackSoft (сервисы толстые, views тонкие). Chain — часть сервисного слоя.
- `LLMRateLimitError` — не в audit (не sensitive) → normal logging.
- Никаких эмодзи в коде.
- Type hints везде.
- Комменты только для API-квинков (напр. OpenAI-совместимый format у GitHub Models с префиксом провайдера в model name).

---

## 8. Открытые вопросы (закрыты дефолтами)

1. **Первый провайдер в chain по умолчанию** — Gemini (у нас платно бесплатный ключ) или GitHub Models (лучше квоты)? **Дефолт: Gemini** (в chain как первый), при 429 → github_models_gpt4omini.
2. **Показывать пользователю бейдж провайдера?** **Дефолт: да** для manager (полезно понимать fallback), нет — для оператора (тех. деталь).
3. **Если все упали — статический fallback или ошибка юзеру?** **Дефолт**: сохранить сообщение с текстом «AI-провайдеры сейчас недоступны, попробуйте позже», без 500-ки.
4. **JSON mode на GitHub Models** — есть у OpenAI (`response_format: json_object`), нет у Llama/DeepSeek. Дефолт: если ответ ожидается JSON, но провайдер не поддерживает — парсим текст.

---

## 9. Финальный отчёт

- `provider.py`: file:line ключевых новых классов
- Итог pytest: N passed / 0 failed
- `.env` — как проверить (в конце builder дампит `LLM_CHAIN` и первые слоты)
- Пример логов при 429-fallback (что видно в консоли)
- Инструкция как включить: `gh auth token >> .env как GITHUB_MODELS_TOKEN=…`
- Экономика: сколько дневных запросов даёт финальная цепочка
