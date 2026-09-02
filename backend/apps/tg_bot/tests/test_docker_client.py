"""
Юнит-тесты для docker_client.py — без реального docker.

Проверяем ключевые примитивы:
  1. demultiplex_log_frames — понимает 8-байтовые фреймы Docker API.
  2. _short_name — правильно снимает compose-префикс.
  3. tail_logs — whitelist работает (не даёт вытащить логи запрещённого).
"""

from __future__ import annotations

import struct

from apps.tg_bot.docker_client import (
    LOG_WHITELIST,
    _short_name,
    demultiplex_log_frames,
)


def _mk_frame(stream: int, payload: bytes) -> bytes:
    """Сгенерировать один docker-log фрейм: [stream, 0, 0, 0, len_be32] + payload."""
    header = bytes([stream, 0, 0, 0]) + struct.pack(">I", len(payload))
    return header + payload


class TestDemultiplex:
    def test_single_stdout_frame(self):
        raw = _mk_frame(1, b"hello world\n")
        lines = demultiplex_log_frames(raw)
        assert lines == ["hello world"]

    def test_multiple_frames_stdout_stderr(self):
        raw = _mk_frame(1, b"line1\n") + _mk_frame(2, b"error!\n") + _mk_frame(1, b"line2\n")
        lines = demultiplex_log_frames(raw)
        assert lines == ["line1", "error!", "line2"]

    def test_empty_bytes(self):
        assert demultiplex_log_frames(b"") == []

    def test_multiline_payload_is_split(self):
        raw = _mk_frame(1, b"a\nb\nc\n")
        assert demultiplex_log_frames(raw) == ["a", "b", "c"]

    def test_tty_mode_fallback(self):
        """
        Если docker в TTY-режиме — потока не мультиплексируют, первый
        байт может быть буквой, и uint32 длины не совпадёт. Мы должны
        не упасть и просто вернуть текст как есть.
        """
        raw = b"hello no framing here\n"
        lines = demultiplex_log_frames(raw)
        # decoded fallback
        assert lines == ["hello no framing here"]

    def test_truncated_frame_gracefully(self):
        # Заголовок обещает 100 байт, а payload короче — не должно упасть,
        # уходим в fallback.
        header = bytes([1, 0, 0, 0]) + struct.pack(">I", 100)
        raw = header + b"only 10bytes"
        # Не падает, возвращает что-то (fallback декод как есть).
        lines = demultiplex_log_frames(raw)
        assert isinstance(lines, list)

    def test_trailing_blank_lines_trimmed(self):
        raw = _mk_frame(1, b"one\n\n\n")
        assert demultiplex_log_frames(raw) == ["one"]


class TestShortName:
    def test_compose_style_name(self):
        assert _short_name("/naffai-web-1") == "web"

    def test_compose_multi_segment(self):
        assert _short_name("/naffai-distribute-watcher-1") == "distribute-watcher"

    def test_no_slash(self):
        assert _short_name("bot") == "bot"

    def test_no_trailing_number(self):
        # Если хвост не число — не трогаем.
        assert _short_name("/postgres") == "postgres"


class TestLogWhitelist:
    def test_essential_services_are_whitelisted(self):
        assert "bot" in LOG_WHITELIST
        assert "web" in LOG_WHITELIST
        assert "distribute-watcher" in LOG_WHITELIST
        assert "sheet-sync" in LOG_WHITELIST

    def test_db_and_secrets_not_whitelisted(self):
        # DB не должна быть в списке — там может быть чувствительное.
        assert "db" not in LOG_WHITELIST
        assert "postgres" not in LOG_WHITELIST
        assert "docker-proxy" not in LOG_WHITELIST


def test_tail_logs_rejects_non_whitelisted():
    """
    Даже если контейнер существует, но не в whitelist — мы отказываем
    ДО обращения к proxy. Тестируется без сети.
    """
    import asyncio

    from apps.tg_bot.docker_client import tail_logs

    lines, err = asyncio.run(tail_logs("db", 10))
    assert lines == []
    assert "недоступны" in err or "недоступно" in err or "Разрешено" in err
