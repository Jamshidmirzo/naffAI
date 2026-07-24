# Ежедневная обучалка — «Мой вчерашний день»

Спека для builder-агента. Одна фича, одна волна. Даёт оператору каждое утро персональный AI-разбор вчерашнего дня + конкретные советы «что подтянуть в продажах» на сегодня.

**Контекст**: Проект `/Users/user/Desktop/mp/ai/naff/`. Django 5 + DRF + React + Vite + TS. AI-провайдер с fallback уже есть (`apps/tg_userclient/ai/provider.py`, multi-LLM chain из `docs/multi-llm-fallback-spec.md`). HackSoft-раскладка. Никаких эмодзи в коде (в UI можно).

Никакой аналитики «по всему офису» — только строго персональный урок под конкретного оператора.

---

## Что переиспользуем (не изобретаем заново)

| Инфра | Файл | Зачем |
|---|---|---|
| Утренний slot | `apps/greetings/` (MorningGreeting) | Уже шлёт утренние приветствия/цитаты — встраиваемся в тот же runner |
| Диалоги + инсайты | `apps/tg_userclient/models.py` (`TgChat`, `TgMessage`, `TgAiInsight`) | Источник качества коммуникации за день |
| Продажи | `apps/sales/models.py` (`Sale`, `SaleItem`) | Источник фактов: чек, бренд-микс, объём |
| Лиды/коллы | `apps/leads/`, `apps/calls/` (`Lead`, `CallbackReminder`) | Промахи по callback'ам, конверсия лидов |
| Пейролл-порог | `apps/payroll/services.py` | Прогресс до 50M — в контекст урока |
| LLM-цепочка | `apps/tg_userclient/ai/provider.py` + `ai/chain.py` | Генерация с fallback, ничего нового |
| TG-DM | `apps/tg_bot/runner.py` + `notify.py` | Доставка утреннего уведомления с кнопкой |
| Permissions | `apps/common/permissions.py` (IsOwnerOrManager) | Оператор видит только свой урок, TL/Manager видят всех |

---

## Фича — `apps/lessons/` (новый app, ~2 дня)

### 1. Модели

Новый app `apps/lessons/`. Один файл `models.py`:

```python
class DailyLesson(TimestampedModel):
    operator = models.ForeignKey(
        "operators.Operator", on_delete=CASCADE, related_name="lessons"
    )
    lesson_date = models.DateField(help_text="Дата, ЗА которую урок (вчера на момент генерации)")

    # AI-контент
    summary = models.TextField(help_text="Абзац: как прошёл день")
    highlights = models.JSONField(default=list, help_text="[{title, evidence}] — 2-3 сильные стороны")
    tips = models.JSONField(default=list, help_text="[{title, why, example, action}] — 3 совета")
    micro_lesson = models.CharField(
        max_length=280,
        help_text="Один узкий навык на сегодня: 'уточняй бюджет до презентации модели'"
    )

    # Числовой снапшот вчерашнего дня (для UI без пересчёта)
    stats_snapshot = models.JSONField(
        default=dict,
        help_text="{sales_count, revenue_uzs, avg_check, dialogs_count, avg_quality, "
                  "callbacks_missed, leads_won, leads_lost, month_progress_pct}"
    )

    # AI-мета (из TgAiInsight — тот же паттерн)
    model_version = models.CharField(max_length=64)
    prompt_version = models.CharField(max_length=16)

    # Доставка
    delivered_at = models.DateTimeField(null=True, blank=True, help_text="Когда упало в TG-DM")
    opened_at = models.DateTimeField(null=True, blank=True, help_text="Когда оператор открыл в UI")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["operator", "lesson_date"],
                name="unique_lesson_per_operator_per_day",
            ),
        ]
        indexes = [
            models.Index(fields=["operator", "-lesson_date"]),
        ]
```

Плюс аудит-модель по образцу `TgAiInsightAttempt`:

```python
class DailyLessonAttempt(TimestampedModel):
    operator = models.ForeignKey("operators.Operator", on_delete=CASCADE)
    lesson_date = models.DateField()
    status = models.CharField(choices=[("ok","ok"),("skip","skip"),("error","error")])
    reason = models.CharField(max_length=280, blank=True)
    model_version = models.CharField(max_length=64, blank=True)
    duration_ms = models.PositiveIntegerField(default=0)
```

`skip` = у оператора вчера 0 продаж И 0 диалогов (пустой день — урок бессмысленный, пропускаем).

Миграция.

### 2. Селектор для сбора фактов

`apps/lessons/selectors.py`:

```python
def collect_yesterday_facts(operator: Operator, date: date) -> dict:
    """Всё, что нужно скормить LLM. Ничего лишнего."""
    return {
        "sales": {...},          # count, revenue, avg_check, brand_mix, дельта к personal avg 30d
        "dialogs": {...},        # count, avg quality_score, top 3 red_flags, top 3 highlights
        "callbacks": {...},      # missed, on_time, avg_delay_min
        "leads": {...},          # won, lost, stalled (>24h без активности)
        "context": {...},        # month_progress_pct, days_to_threshold, personal_baseline_30d
        "chat_examples": [       # 3-5 коротких выдержек из вчерашних диалогов
            {"chat": "Нурик", "excerpt": "...", "issue": "не уточнил модель"}
        ],
    }
```

Важно: `chat_examples` — это фактический материал для советов. Без них LLM будет генерить абстрактный шум типа «улучшайте коммуникацию».

### 3. AI-генератор

`apps/lessons/ai/prompts/daily_lesson_v1.md` + `apps/lessons/ai/generator.py`. Промпт на русском, структурированный JSON-выход, температура низкая (0.4). Пример структуры промпта:

```
Ты — наставник продавца в узбекском phone-shop.
Оператор: {name}, стаж {tenure_days} дней.
Вчерашние факты (JSON): {facts}
Примеры из его же диалогов: {chat_examples}

Верни строгий JSON:
{
  "summary": "<абзац 2-3 предложения, конкретный, с цифрами>",
  "highlights": [{"title": "...", "evidence": "..."}, ...],  // 2-3 штуки
  "tips": [
    {"title": "...", "why": "...", "example": "<цитата из его диалога>", "action": "<что сделать сегодня>"},
    ...  // ровно 3
  ],
  "micro_lesson": "<одна фраза, глагол в повелительном, до 280 символов>"
}

Правила:
- Не хвали за пустоту. Если продаж мало — говори прямо.
- В каждом tip обязателен example из его же диалогов.
- Не предлагай то, что оператор уже делал хорошо (см. highlights).
- Никаких общих фраз типа «улыбайтесь» — только конкретика для phone-shop.
```

Используем существующую цепочку из `apps/tg_userclient/ai/chain.py` — она уже умеет fallback и retry.

### 4. Management command

`apps/lessons/management/commands/generate_daily_lessons.py`:

```
python manage.py generate_daily_lessons [--date YYYY-MM-DD] [--operator ID] [--dry-run]
```

По умолчанию — за вчера, для всех активных операторов. Идемпотентна (`UniqueConstraint` защищает). Каждая генерация пишет `DailyLessonAttempt`.

Запуск через systemd-timer / cron на VPS `46.101.112.215`, время **05:30 по Ташкенту** (до того как операторы проснулись, но после закрытия дня).

### 5. Доставка утром

Расширить существующий утренний runner из `apps/greetings/` или `apps/tg_bot/`. В **07:30 по Ташкенту** для каждого оператора с готовым `DailyLesson` за вчера:

TG-DM оператору (Markdown):
```
Доброе утро, {name}!

Твой вчерашний день:
📊 Продаж: {sales_count} на {revenue} UZS (средний чек {avg_check})
💬 Диалогов: {dialogs_count}, качество {avg_quality}/100
🎯 До плана: осталось {days_to_threshold} дней

Сегодняшний фокус:
👉 {micro_lesson}

[Открыть полный разбор]  <- inline-кнопка с deeplink в веб на /lessons/today
```

После успешной отправки — `delivered_at = now()`. Ошибки TG — retry по образцу `apps/tg_bot/retry.py`.

Если у оператора вчера был `skip` — утреннее сообщение всё равно шлём, но короткое: «Вчера был день без активности — сегодня хороший шанс наверстать. До плана {N} дней.» Без кнопки в урок.

### 6. API

`apps/lessons/apis.py` + `urls.py`, префикс `/api/lessons/`:

- `GET /api/lessons/today/` — свой урок за вчера (`operator = request.user.operator`). При открытии — проставить `opened_at`.
- `GET /api/lessons/history/?limit=30` — свои прошлые уроки (компактно, без full JSON — только `date, summary, micro_lesson`).
- `GET /api/lessons/?operator=<id>&date=<YYYY-MM-DD>` — для `team_lead`/`manager`, полный урок конкретного оператора.
- `GET /api/lessons/history/?operator=<id>` — то же, история.

Permissions: `IsAuthenticated` + свой vs `IsManagerOrTeamLead` для чужих.

### 7. Frontend

**Новая страница `/lessons/today`** (`frontend/src/pages/DailyLesson.tsx`):

Layout сверху вниз:
1. **Hero-карточка** — крупно: имя, дата, `micro_lesson` жирным + иконкой цели. Градиент по бренду.
2. **Ряд из 4 KPI-плашек** (переиспользовать `KpiCard`): продажи / средний чек / диалоги / качество. Каждая — с дельтой к личному baseline 30d (стрелка вверх зелёная / вниз красная).
3. **Summary** — абзац крупным шрифтом.
4. **«Что было сильно»** — зелёный блок, 2-3 highlight'а с evidence.
5. **«Что подтянуть»** — жёлто-оранжевый блок, 3 tip-карточки. Каждая:
   - Заголовок tip
   - «Почему это важно»
   - Цитата из вчерашнего диалога в блоке-цитате
   - «Что сделать сегодня» — action-строка с чекбоксом (локально в localStorage, не в БД — по трём чекам показать «Отлично, идём в бой» и закрыть блок).
6. Ссылка внизу «История моих разборов» → `/lessons/history`.

**Страница `/lessons/history`** — таблица `дата | summary | micro_lesson | открыт?`. Клик по строке — модалка с полным уроком.

**На `OperatorDetail.tsx`** (для TL/Manager) — новая секция «Обучение» рядом с «TG-диалоги»: последние 7 уроков оператора, кликом — полный разбор. Тимлид видит, что ИИ советует его подопечному и как оператор реагирует (открыл / не открыл).

**Badge на sidebar** — если `today` есть и не открыт, красная точка на пункте «Обучение».

### 8. Настройки оператора

В `apps/operators/models.py` (или через `apps/common/preferences`) — флаг `daily_lesson_opt_out = BooleanField(default=False)`. Если True — генерация пропускается, TG-DM не идёт. Управляется из `/settings` в UI.

### 9. Тесты

`apps/lessons/tests/`:

- `test_selector_collect_facts.py` — при пустом дне возвращает пустые срезы, при заполненном — правильно считает дельту к baseline.
- `test_generator_json_shape.py` — с fake LLM-провайдером (по образцу `FakeVLM` из camera_monitoring, если нужен) проверяем, что парсинг ответа не падает, при мусорном JSON — retry, затем `error`.
- `test_command_idempotent.py` — повторный запуск за тот же день не создаёт дубль.
- `test_command_skip_empty_day.py` — при 0 продаж + 0 диалогов пишет `skip`, `DailyLesson` не создаётся.
- `test_api_own_lesson.py` — оператор видит только своё, чужое → 403.
- `test_api_manager_sees_all.py` — TL/Manager видит любого.
- `test_delivery_sets_delivered_at.py` — успешный TG-DM → `delivered_at` заполнен.
- `test_delivery_retries_on_tg_error.py` — по образцу существующих `tg_bot/tests`.

Никаких эмодзи в тестах и коде. Все строки на русском там, где это UI-контент.

### 10. Наблюдаемость

- Метрика в `apps/audit/` (если там уже есть счётчики) или простой лог: сколько уроков сгенерено за день, сколько skip, сколько error, средняя длительность LLM-вызова.
- На `/admin/` — `DailyLesson` и `DailyLessonAttempt` зарегистрированы, фильтры по дате и оператору.

---

## Что НЕ делаем (out of scope)

- Никакой «геймификации» уроков (стрики, XP). Это отдельная фича, легко добавить позже поверх `opened_at`.
- Никаких командных / общеофисных разборов. Только личный урок оператору.
- Никакого редактирования урока тимлидом. TL только читает.
- Никакого автоматического «действия» по совету (типа «создать напоминание»). Чекбоксы — чисто визуальные.
- Не трогаем `MorningGreeting` — она продолжает жить параллельно (цитата + погода / что там есть). Урок — отдельное сообщение / отдельная кнопка.

---

## Порядок работы для builder-агента

1. Модели + миграция + admin.
2. Селектор фактов + юнит-тесты на нём.
3. Промпт + генератор с fake-провайдером в тестах.
4. Management command + идемпотентность.
5. API + permissions + тесты.
6. React-страницы `DailyLesson` и `LessonsHistory`.
7. Секция в `OperatorDetail` + badge в sidebar.
8. Доставка TG-DM (расширение утреннего runner) + retry-тест.
9. Systemd-timer на VPS: 05:30 генерация, 07:30 доставка.
10. Прогнать всю тест-сюиту, обновить README раздел «Ежедневная обучалка».

Регресс: должно быть **не меньше 172 passed** после мержа. Никаких изменений в существующих моделях кроме опционального `daily_lesson_opt_out` на операторе.
