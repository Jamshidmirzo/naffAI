"""
Deterministic (no-LLM) intent router for the ops-agent in Telegram.

Менеджер / владелец пишут в личку боту свободным текстом — этот модуль
разбирает фразу и говорит хэндлеру, что запросили:

  - `WHY_NO_LEADS`  — «почему у Мухлисы нет лидов?»
  - `WHO_GOT`       — «кто сколько получил сегодня/вчера?»
  - `HEALTH`        — «что с сервером?» / «упал?» / «краши?»
  - `LOGS`          — «покажи логи distribute-watcher»
  - `HELP`          — не понял → показать примеры

Требования:
  - Полностью детерминированный парсинг: набор regex + словарные ключи.
  - Поддержка RU (Мухлисе), UZ (Muxlisaga), латиница/кириллица.
  - Извлечение оператора через `find_operators_by_freetext`
    (кросс-алфавитный матч).
  - «Вчера» / «kecha» → date=вчера, иначе — сегодня.

Публичный API:
  - `parse_intent(text: str) -> Intent`
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field
from enum import StrEnum


class IntentKind(StrEnum):
    WHY_NO_LEADS = "why_no_leads"
    WHO_GOT = "who_got"
    HEALTH = "health"
    LOGS = "logs"
    HELP = "help"


@dataclass
class Intent:
    """Результат разбора свободного текста."""

    kind: IntentKind
    operator_query: str = ""           # что подавать в find_operators_by_freetext
    target_date: dt.date | None = None  # None → today (обычно)
    log_service: str = ""              # для LOGS: имя контейнера / сервиса
    log_lines: int = 50                # сколько строк логов запросили
    raw: str = ""                      # исходный текст (для отладки)

    # Дополнительное поле — что рендерер должен нарисовать («сводка» vs «конкретный оператор»)
    # для WHO_GOT. Заполняется автоматически: если operator_query пустой → сводка.
    extras: dict = field(default_factory=dict)


# ---- vocabularies ---------------------------------------------------------

# Слова-триггеры «почему нет лидов». Кириллица + узбекская латиница.
# Специально ищем корни, а не полные формы — работает и «Мухлисе», и «Мухлисы».
_WHY_ROOTS = (
    "почему",
    "why",
    "otga",
    "nega",  # UZ «почему»
)
_NO_LEADS_ROOTS = (
    "нет",
    "не даёт",
    "не дает",
    "не даюt",
    "не идут",
    "не идет",
    "не пришли",
    "не работает",
    "не работат",
    "ничего",
    "мало",
    "нол",         # «ноль лидов»
    "0",
    "kelmayapti",  # UZ «не приходят»
    "kelmadi",     # UZ «не пришли»
    "kelmayapt",
    "yoq",         # UZ «нет»
    "yo'q",
    "yo‘q",
    "ishlamayapti",  # UZ «не работает»
    "olmayapti",     # UZ «не получает»
    "olmadi",
)
_LEAD_WORDS = (
    "лид",
    "лиды",
    "лидов",
    "лида",
    "заяв",       # «заявок», «заявки»
    "клиент",
    "автора",     # «автораздача»
    "автораз",
    "распредел",
    "lead",
    "leads",
    "lid",
    "lidlar",
    "lidlar",
    "taqsim",     # UZ «распределение»
    "avtotaqsim",
    "ish yo",     # «ish yo'q» — работы нет
)

_WHO_GOT_PHRASES = (
    "кто получил",
    "кто сколько",
    "кому дало",
    "кому дали",
    "сколько получил",
    "сколько дали",
    "сколько дало",
    "раздач",       # корень: «раздача», «раздачу», «раздачи», «раздали»
    "распредел",
    "kim oldi",
    "necha ta oldi",
    "kimga berildi",
    "taqsim",
    "avto",         # avtotaqsim
)

_HEALTH_PHRASES = (
    "серв",       # сервер, сервис
    "server",
    "хост",
    "host",
    "упал",
    "упала",
    "упали",
    "тормозит",
    "не работает бот",  # не путать с per-operator «не работает»
    "не отвечает",
    "перезап",       # перезапустился
    "restart",
    "restart",
    "рестарт",
    "краш",
    "crash",
    "oom",
    "ошибк",         # ошибка/ошибки
    "ошибокn",
    "здоров",        # «здоровье», «здоровый»
    "health",
    "статус контейн",
    "контейнер",
    "kontey",       # UZ «kontener»
    "server ishlamayapti",
    "yiqilib",       # UZ «упал»
    "yiqildi",
    "ishlab tur",    # UZ «работает»
    "salomatlik",    # UZ «здоровье»
)

_LOGS_PHRASES = (
    "лог",
    "логи",
    "log",
    "logs",
    "tail",
    "стдерр",
    "stderr",
    "stdout",
    "хвост",
)

_YESTERDAY_WORDS = ("вчера", "kecha")

# Контейнеры/сервисы, про которые бот умеет отдавать логи. Whitelist на
# уровне парсера — если пользователь пишет `/logs postgres`, всё равно
# упрёмся в whitelist в docker_client. Здесь список — только для
# автодетекта в свободном тексте.
KNOWN_SERVICE_ALIASES = {
    "distribute-watcher": "distribute-watcher",
    "distribute": "distribute-watcher",
    "watcher": "distribute-watcher",
    "refill": "distribute-watcher",
    "sheet-sync": "sheet-sync",
    "sheets": "sheet-sync",
    "sync": "sheet-sync",
    "morning-splitter": "morning-splitter",
    "morning": "morning-splitter",
    "splitter": "morning-splitter",
    "scheduler": "scheduler",
    "reports-scheduler": "reports-scheduler",
    "reports": "reports-scheduler",
    "userclient": "userclient",
    "telethon": "userclient",
    "bot": "bot",
    "web": "web",
    "backend": "web",
    "lesson-generator": "lesson-generator",
    "lessons": "lesson-generator",
    "ops-nightly": "ops-nightly",
    "nightly": "ops-nightly",
    "db": "db",
    "postgres": "db",
    "redis": "redis",
}

# «имя оператора» кандидат — не должно быть служебным словом. Ниже стоп-лист.
_STOPWORDS = {
    # RU
    "почему", "нет", "у", "и", "с", "на", "для", "от", "или", "не", "по",
    "что", "как", "где", "когда", "кому", "кто", "сколько", "то", "это",
    "лид", "лиды", "лидов", "лида", "заявок", "заявки", "автораздача",
    "клиент", "клиенты", "клиентов", "получил", "получила", "получили",
    "дало", "дали", "давал", "давала", "давали", "мало", "много", "ноль",
    "нолик", "работает", "работат", "сегодня", "вчера",
    "распределение", "распределилось", "сервер", "сервис", "бот", "здесь",
    "тут", "будет", "может", "стало", "стал", "работа", "работы", "лидa",
    # UZ
    "kecha", "bugun", "nega", "nima", "kim", "necha", "ta", "yoq", "yo'q",
    "yo‘q", "berildi", "berdi", "oldi", "olmadi", "olmayapti", "kelmadi",
    "kelmayapti", "avto", "lid", "lidlar", "server", "bot", "aynan",
    # generic
    "ok", "okay", "hi", "hello", "salom", "привет", "здравствуйте",
    "спасибо", "thanks",
    "please", "плз", "плиз",
}


def _norm(text: str) -> str:
    """
    Нормализация фразы: lower, схлопнуть whitespace, заменить типографские
    кавычки/апострофы, оставить только слова / знаки препинания.
    """
    if not text:
        return ""
    s = text.lower().strip()
    s = s.replace("ё", "е")
    for ch in ("'", "`", "ʼ"):
        s = s.replace(ch, "'")
    s = re.sub(r"\s+", " ", s)
    return s


def _contains_any(text: str, needles: tuple[str, ...] | list[str]) -> bool:
    return any(n in text for n in needles)


def _extract_yesterday(text: str) -> bool:
    return _contains_any(text, _YESTERDAY_WORDS)


def _extract_lines_hint(text: str) -> int:
    """`/logs bot 100` → 100; иначе default 50, cap 200. Работает и для 4+ цифр."""
    m = re.search(r"\b(\d{1,6})\b", text)
    if not m:
        return 50
    n = int(m.group(1))
    if n < 5:
        return 5
    return min(n, 200)


def _extract_service(text: str) -> str:
    """Ищем известное имя сервиса в тексте (whitelist)."""
    for alias, canonical in KNOWN_SERVICE_ALIASES.items():
        # \b-границы не работают с дефисами — используем ручную проверку.
        if alias in text:
            # Убеждаемся, что это отдельное слово (окружение — не буква/цифра).
            idx = text.find(alias)
            before = text[idx - 1] if idx > 0 else " "
            after = text[idx + len(alias)] if idx + len(alias) < len(text) else " "
            if before.isalnum() or after.isalnum():
                continue
            return canonical
    return ""


def _extract_operator_query(text: str) -> str:
    """
    Достаём слова-кандидаты на имя оператора: убираем стоп-слова,
    служебные, цифры, знаки препинания. Возвращаем строку из 1-3 слов,
    которую скормим `find_operators_by_freetext`.

    Особые случаи:
      - «у Мухлисы» → «Мухлисы»
      - «Muxlisaga» → «Muxlisaga»
      - если ничего не осталось → "".
    """
    tokens = re.findall(r"[a-zA-Zа-яА-ЯёЁʼ'ў-ў]+", text, flags=re.UNICODE)
    keep: list[str] = []
    for t in tokens:
        lt = t.lower()
        if lt in _STOPWORDS:
            continue
        if len(lt) < 3:
            continue
        # не имя, если это триггер-слово из чек-листа
        if lt in _WHY_ROOTS or lt in _NO_LEADS_ROOTS or lt in _LEAD_WORDS:
            continue
        if lt in _WHO_GOT_PHRASES or lt in _HEALTH_PHRASES or lt in _LOGS_PHRASES:
            continue
        keep.append(t)
    # Берём максимум 3 первых слова — обычно имя = 1-2 токена, а хвост
    # («Мухлисе», «Muxlisaga») — просто суффикс к имени.
    return " ".join(keep[:3])


# ---- main entry ----------------------------------------------------------


def parse_intent(text: str) -> Intent:
    """
    Разобрать свободный текст → Intent. Без внешних зависимостей —
    только regex + словари → 100% детерминировано, легко тестируется.

    Приоритеты (сверху вниз):
      1. Пустая строка → HELP.
      2. Явное «сервер / краш / упал / oom / health» → HEALTH.
         Если рядом «лог / tail» → LOGS.
      3. «Почему … нет / не работает» + имя → WHY_NO_LEADS.
      4. «Кто получил / кому дало / раздача» → WHO_GOT
         (если внутри распознали имя — per-operator история).
      5. Одно слово-имя + ничего больше → WHY_NO_LEADS (короткий вопрос).
      6. Всё остальное → HELP.
    """
    raw = text or ""
    n = _norm(raw)
    if not n:
        return Intent(kind=IntentKind.HELP, raw=raw)

    yesterday = _extract_yesterday(n)
    target_date: dt.date | None = None
    if yesterday:
        # Импорт локально — иначе тесты, которые загружают модуль без
        # Django, ломаются на timezone.now().
        from django.utils import timezone as _tz

        target_date = _tz.localdate() - dt.timedelta(days=1)

    # ---------- 1. Логи (тoлько если явно упомянуты) ------------------
    if _contains_any(n, _LOGS_PHRASES):
        service = _extract_service(n)
        lines = _extract_lines_hint(n)
        return Intent(
            kind=IntentKind.LOGS,
            log_service=service,
            log_lines=lines,
            raw=raw,
        )

    # ---------- 2. Health / краш --------------------------------------
    # Проверяем ПЕРЕД WHY_NO_LEADS, потому что «сервер не работает» иначе
    # свалится в WHY_NO_LEADS (там есть «не работает»).
    if _contains_any(n, _HEALTH_PHRASES):
        return Intent(kind=IntentKind.HEALTH, raw=raw)

    # ---------- 3. WHY_NO_LEADS --------------------------------------
    why_hit = _contains_any(n, _WHY_ROOTS) or _contains_any(n, _NO_LEADS_ROOTS)
    if why_hit:
        # проверим, что речь про лиды/раздачу — иначе можем случайно
        # уйти в этот бранч на «почему ты меня игноришь».
        if _contains_any(n, _LEAD_WORDS):
            op_q = _extract_operator_query(n)
            return Intent(
                kind=IntentKind.WHY_NO_LEADS,
                operator_query=op_q,
                target_date=target_date,
                raw=raw,
            )
        # why-триггер БЕЗ лид-слова — это не наш домен (например,
        # «почему ты не отвечаешь»). Уходим в HELP, чтобы fallback ниже
        # не подобрал случайное слово как «имя оператора».
        return Intent(kind=IntentKind.HELP, raw=raw)

    # ---------- 4. WHO_GOT --------------------------------------------
    if _contains_any(n, _WHO_GOT_PHRASES):
        op_q = _extract_operator_query(n)
        return Intent(
            kind=IntentKind.WHO_GOT,
            operator_query=op_q,
            target_date=target_date,
            raw=raw,
        )

    # ---------- 5. Просто имя оператора (короткий вопрос) -------------
    #
    # Требуем короткую фразу (1-2 слова из имени): 3+ слов уже
    # предполагает предложение, а не одиночное имя.
    tokens_all = re.findall(r"[a-zA-Zа-яА-ЯёЁʼ']+", n, flags=re.UNICODE)
    if len(tokens_all) > 2:
        return Intent(kind=IntentKind.HELP, raw=raw)
    op_q = _extract_operator_query(n)
    if op_q and 3 <= len(op_q) <= 40:
        # Пример: «Мухлиса» / «Sevinch», без вопроса → трактуем как
        # «диагностируй этого оператора».
        return Intent(
            kind=IntentKind.WHY_NO_LEADS,
            operator_query=op_q,
            target_date=target_date,
            raw=raw,
        )

    return Intent(kind=IntentKind.HELP, raw=raw)


def help_text_ru() -> str:
    """Подсказка со списком примеров вопросов — рендерится в бота."""
    return (
        "🤖 <b>Ops-агент бота</b>\n\n"
        "Спрашивайте по-русски или по-узбекски. Примеры:\n\n"
        "• «Почему у Мухлисы нет лидов?»\n"
        "• «Кто сколько получил сегодня?» / «kim necha ta oldi bugun?»\n"
        "• «Что с сервером?» / «server ishlayaptimi?»\n"
        "• «Логи distribute-watcher 100» <i>(только владельцу)</i>\n\n"
        "Или прямые команды: /whyauto, /whogot, /health, /logs."
    )
