"""
Матрица интентов для parse_intent() — детерминированный парсер
без LLM. Тесты бьют по конкретным фразам из плана + edge-кейсы.

Тесты не требуют БД (модуль agent.py импортирует django timezone
только внутри бранча «вчера»; общая матрица его не трогает).
"""

from __future__ import annotations

import datetime as dt

import pytest

from apps.tg_bot.agent import IntentKind, parse_intent


class TestWhyNoLeadsIntent:
    """
    Ключевой use-case: менеджер спрашивает «почему у Мухлисы нет лидов»
    в разных формах — русский / узбекский / латиница.
    """

    def test_russian_why_no_leads(self):
        r = parse_intent("почему у Мухлисы нет лидов")
        assert r.kind == IntentKind.WHY_NO_LEADS
        assert "мухлис" in r.operator_query.lower()

    def test_russian_short(self):
        r = parse_intent("почему Мухлисе не дают лиды")
        assert r.kind == IntentKind.WHY_NO_LEADS
        assert "мухлис" in r.operator_query.lower()

    def test_uz_kelmayapti(self):
        r = parse_intent("Muxlisaga lidlar kelmayapti nega")
        assert r.kind == IntentKind.WHY_NO_LEADS
        assert "muxlis" in r.operator_query.lower()

    def test_uz_yoq(self):
        r = parse_intent("Muxlisada lidlar yo'q")
        assert r.kind == IntentKind.WHY_NO_LEADS

    def test_bare_operator_name_is_diagnose(self):
        """
        Одно слово — имя оператора без вопроса — трактуем как «диагностируй».
        """
        r = parse_intent("Sevinch")
        assert r.kind == IntentKind.WHY_NO_LEADS
        assert "sevinch" in r.operator_query.lower()

    def test_why_without_lead_word_is_help(self):
        """
        «Почему» без темы про лиды — падает в HELP или что-то отличное
        от WHY_NO_LEADS (иначе поймаем «почему ты меня игноришь»).
        """
        r = parse_intent("почему ты не отвечаешь")
        # Не должен быть WHY_NO_LEADS. Может быть HELP или (если внутри
        # окажутся слова из stopwords, оставив пусто) — HELP.
        assert r.kind != IntentKind.WHY_NO_LEADS


class TestWhoGotIntent:
    def test_ru_who_got_today(self):
        r = parse_intent("кто сколько получил сегодня")
        assert r.kind == IntentKind.WHO_GOT
        assert r.target_date is None
        assert r.operator_query == ""

    def test_ru_who_got_with_operator(self):
        r = parse_intent("кто сколько получил Мухлиса")
        # Имя внутри → per-operator в рендере
        assert r.kind == IntentKind.WHO_GOT

    @pytest.mark.django_db  # уходим в django timezone для «вчера»
    def test_ru_who_got_yesterday(self):
        r = parse_intent("кто сколько получил вчера")
        assert r.kind == IntentKind.WHO_GOT
        # target_date — вчерашняя дата
        assert isinstance(r.target_date, dt.date)

    def test_uz_kim_oldi(self):
        r = parse_intent("kim necha ta oldi bugun")
        assert r.kind == IntentKind.WHO_GOT

    def test_razdacha(self):
        r = parse_intent("покажи раздачу за сегодня")
        assert r.kind == IntentKind.WHO_GOT


class TestHealthIntent:
    def test_server_status(self):
        r = parse_intent("что с сервером")
        assert r.kind == IntentKind.HEALTH

    def test_crash(self):
        r = parse_intent("бот упал?")
        # упал → HEALTH
        assert r.kind == IntentKind.HEALTH

    def test_health_word(self):
        r = parse_intent("health")
        assert r.kind == IntentKind.HEALTH

    def test_uz_server_ishlayaptimi(self):
        r = parse_intent("server ishlayaptimi")
        # 'serv' в HEALTH_PHRASES
        assert r.kind == IntentKind.HEALTH

    def test_oom(self):
        r = parse_intent("были ли OOM за ночь")
        assert r.kind == IntentKind.HEALTH


class TestLogsIntent:
    def test_ru_logs(self):
        r = parse_intent("покажи логи distribute-watcher")
        assert r.kind == IntentKind.LOGS
        assert r.log_service == "distribute-watcher"

    def test_ru_logs_with_lines(self):
        r = parse_intent("логи bot 100 строк")
        assert r.kind == IntentKind.LOGS
        assert r.log_service == "bot"
        assert r.log_lines == 100

    def test_logs_alias(self):
        r = parse_intent("хвост watcher")
        assert r.kind == IntentKind.LOGS
        assert r.log_service == "distribute-watcher"

    def test_tail_word(self):
        r = parse_intent("tail sheets 30")
        assert r.kind == IntentKind.LOGS
        assert r.log_service == "sheet-sync"
        assert r.log_lines == 30

    def test_lines_cap_at_200(self):
        r = parse_intent("логи bot 9000 строк")
        assert r.kind == IntentKind.LOGS
        assert r.log_lines == 200


class TestHelpFallback:
    def test_empty(self):
        r = parse_intent("")
        assert r.kind == IntentKind.HELP

    def test_garbage(self):
        r = parse_intent("!@#$%^&*()")
        assert r.kind == IntentKind.HELP

    def test_greeting(self):
        r = parse_intent("привет")
        assert r.kind == IntentKind.HELP

    def test_thanks(self):
        r = parse_intent("спасибо")
        assert r.kind == IntentKind.HELP

    def test_lone_short_number(self):
        # Одно число без слов — не имя, не команда.
        r = parse_intent("123")
        # digits меньше 3 длины токенов → отсеются, но всё равно HELP
        assert r.kind == IntentKind.HELP


class TestPriorityOrdering:
    """
    Приоритет: HEALTH проверяется перед WHY_NO_LEADS, чтобы фразы
    типа «сервер не работает» не сваливались в WHY (там тоже есть «не работает»).
    """

    def test_server_not_working_is_health_not_why(self):
        r = parse_intent("сервер не работает")
        assert r.kind == IntentKind.HEALTH

    def test_bot_not_answering_is_health(self):
        r = parse_intent("бот не отвечает")
        assert r.kind == IntentKind.HEALTH

    def test_logs_wins_over_health(self):
        # Если явно логи упомянуты — приоритет за LOGS, а не HEALTH.
        r = parse_intent("покажи логи с ошибками bot")
        assert r.kind == IntentKind.LOGS


class TestLeadersIntent:
    """
    «Дай отчёт по операторам сейчас» — тот же 3-часовой лидерборд, но
    по запросу. Триггеры: «отчёт», «hisobot», «рейтинг», «сводка»,
    «топ операторов», «3 часа/soat».
    """

    def test_ru_otchet(self):
        r = parse_intent("отчёт по операторам")
        assert r.kind == IntentKind.LEADERS

    def test_ru_svodka(self):
        r = parse_intent("дай сводку сейчас")
        assert r.kind == IntentKind.LEADERS

    def test_ru_top_operators(self):
        r = parse_intent("покажи топ операторов")
        assert r.kind == IntentKind.LEADERS

    def test_ru_rating(self):
        r = parse_intent("рейтинг операторов")
        assert r.kind == IntentKind.LEADERS

    def test_uz_hisobot(self):
        r = parse_intent("hisobot bering")
        assert r.kind == IntentKind.LEADERS

    def test_ru_3_hours(self):
        r = parse_intent("дай отчёт за 3 часа")
        assert r.kind == IntentKind.LEADERS

    def test_leaders_beats_who_got_on_ambiguous(self):
        # «сколько поговорил» триггерит и WHO_GOT (сколько получил), и
        # LEADERS. Лидерборд полнее — приоритет за ним.
        r = parse_intent("сколько поговорил каждый оператор")
        assert r.kind == IntentKind.LEADERS

    def test_calls_ru(self):
        r = parse_intent("сколько звонков сделали сегодня")
        assert r.kind == IntentKind.LEADERS
        assert r.operator_query == ""  # период не указан → сегодня

    def test_calls_uz(self):
        r = parse_intent("bugun operatorlar necha ta qo'ng'iroq qildi")
        assert r.kind == IntentKind.LEADERS

    def test_leaders_period_yesterday(self):
        r = parse_intent("отчёт вчера")
        assert r.kind == IntentKind.LEADERS
        assert r.operator_query == "вчера"

    def test_leaders_period_week(self):
        r = parse_intent("сводка за неделю")
        assert r.kind == IntentKind.LEADERS
        assert r.operator_query == "неделя"

    def test_leaders_period_month(self):
        r = parse_intent("рейтинг за месяц")
        assert r.kind == IntentKind.LEADERS
        assert r.operator_query == "месяц"

    def test_calls_period_yesterday(self):
        r = parse_intent("звонки вчера")
        assert r.kind == IntentKind.LEADERS
        assert r.operator_query == "вчера"
