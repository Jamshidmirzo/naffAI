"""
BotReport renderer — turns a BotReport + BotChat pair into a single HTML
message for Telegram (parse_mode=HTML).

Layout:

    📊 <b>{report.name}</b>
    <i>{period_label}</i>
    ────────────
    {block_1}
    ───
    {block_2}
    ───
    ...

Blocks that render to None (no data) are silently dropped, so an empty
period produces a compact "nothing to report" message rather than a wall
of zeros.
"""

from __future__ import annotations

from apps.tg_bot.models import BotChat, BotReport

from .report_blocks import blocks_for_chat_kind, get_period_range

_DIVIDER = "\n───\n"


def render_report(report: BotReport, chat: BotChat) -> str:
    """
    Build the HTML message. Uses the recipient's language override if set,
    otherwise falls back to the report's own language.
    """
    language = chat.language or report.language or "uz"
    start, end, label_ru, label_uz = get_period_range(report.period)
    period_label = label_uz if language == "uz" else label_ru

    blocks = blocks_for_chat_kind(report.blocks or [], chat.kind)
    parts: list[str] = []
    for block in blocks:
        try:
            piece = block.render(start, end, language)
        except Exception as exc:
            import logging

            logging.getLogger(__name__).exception(
                "block %s render failed", block.slug
            )
            piece = None
        if piece:
            parts.append(piece)

    if not parts:
        fallback = "Ma'lumot yo'q" if language == "uz" else "Данных нет"
        parts = [f"<i>{fallback}</i>"]

    header = ""
    if report.include_header:
        header = f"📊 <b>{_escape(report.name)}</b>\n<i>{period_label}</i>\n────────────\n"

    return header + _DIVIDER.join(parts)


def _escape(text: str) -> str:
    """Minimal HTML escape — Telegram parse_mode=HTML."""
    return (
        (text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
