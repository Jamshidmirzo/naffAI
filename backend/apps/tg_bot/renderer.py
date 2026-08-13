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

Some blocks may return :class:`report_blocks.RenderedBlock` with an
inline-button set. Buttons from all blocks are aggregated (dedup'd by
URL) into a single flat list — callers (scheduler / test-send) can turn
them into a Telegram InlineKeyboardMarkup. Legacy callers that consume
just the string keep working via `render_report(...)` which returns
the HTML only.
"""

from __future__ import annotations

from dataclasses import dataclass

from apps.tg_bot.models import BotChat, BotReport

from .report_blocks import InlineButton, RenderedBlock, blocks_for_chat_kind, get_period_range

_DIVIDER = "\n───\n"


@dataclass(frozen=True)
class ReportRender:
    html: str
    buttons: list[InlineButton]


def render_report(report: BotReport, chat: BotChat) -> str:
    """
    HTML-only entry point kept for legacy callers (tests, api.preview).
    Use `render_report_full()` when you also need inline buttons.
    """
    return render_report_full(report, chat).html


def render_report_full(report: BotReport, chat: BotChat) -> ReportRender:
    """
    Build the HTML message + collect inline buttons across all blocks.
    """
    language = chat.language or report.language or "uz"
    start, end, label_ru, label_uz = get_period_range(report.period)
    period_label = label_uz if language == "uz" else label_ru

    blocks = blocks_for_chat_kind(report.blocks or [], chat.kind)
    parts: list[str] = []
    buttons: list[InlineButton] = []
    seen_urls: set[str] = set()

    for block in blocks:
        try:
            piece = block.render(start, end, language)
        except Exception:
            import logging

            logging.getLogger(__name__).exception("block %s render failed", block.slug)
            piece = None
        if piece is None:
            continue
        if isinstance(piece, RenderedBlock):
            if piece.html:
                parts.append(piece.html)
            for btn in piece.buttons:
                if btn.url not in seen_urls:
                    buttons.append(btn)
                    seen_urls.add(btn.url)
        elif isinstance(piece, str):
            if piece:
                parts.append(piece)

    if not parts:
        fallback = "Ma'lumot yo'q" if language == "uz" else "Данных нет"
        parts = [f"<i>{fallback}</i>"]

    header = ""
    if report.include_header:
        header = f"📊 <b>{_escape(report.name)}</b>\n<i>{period_label}</i>\n────────────\n"

    return ReportRender(html=header + _DIVIDER.join(parts), buttons=buttons)


def _escape(text: str) -> str:
    """Minimal HTML escape — Telegram parse_mode=HTML."""
    return (text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
