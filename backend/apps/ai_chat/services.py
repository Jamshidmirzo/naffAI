"""
Chat orchestration.

The main entry-point is ``handle_user_message``, which drives the loop:
- persist the user message,
- ask the LLM,
- if it wants to call tools, call them (locally, read-only),
- feed results back to the LLM,
- repeat until the LLM returns plain text or we hit ``MAX_TOOL_TURNS``.

All persisted messages get an ``audit_log_create`` entry so the audit
surface can show who talked to the bot and when.
"""

from __future__ import annotations

import json
import logging

from django.db import transaction

from apps.audit.services import AuditAction, audit_log_create
from apps.tg_userclient.ai.provider import (
    ChatResponse,
    LLMChainExhaustedError,
    get_ai_chat_provider,
    get_provider_by_key,
)

from .models import ChatMessage, ChatSession
from .tools import TOOLS, call_tool

logger = logging.getLogger("apps.ai_chat")

MAX_TOOL_TURNS = 5

_BASE_PROMPT_RU = (
    "Ты — read-only AI-ассистент для менеджера call-центра магазина телефонов "
    "naffAI в Ташкенте (Узбекистан). У тебя есть набор функций (tools) для "
    "чтения РЕАЛЬНЫХ данных из базы: продаж, лидов, операторов, воронок, "
    "callback'ов, каналов, моделей телефонов.\n\n"
    "КРИТИЧЕСКИЕ ПРАВИЛА:\n"
    "1. НИКОГДА не придумывай числа, имена операторов, суммы, модели. Если "
    "нужны данные — ОБЯЗАТЕЛЬНО вызови подходящую функцию.\n"
    "2. Все суммы — в узбекских сумах (UZS/сум). Никогда не используй "
    "рубли, доллары, евро — только сум. Форматируй с разделителями тысяч, "
    "например «41 500 000 сум».\n"
    "3. {LANG_RULE}\n"
    "4. Если пользователь просит сделать действие (создать, удалить, "
    "назначить, изменить) — объясни, что ты только для чтения.\n"
    "5. Если функция вернула пустой результат — так и скажи: «за период "
    "продаж нет» / «лидов нет», а не выдумывай.\n"
    "6. Статусы лидов — ТОЛЬКО те что реально есть в системе через "
    "get_lead_status_breakdown(). НИКОГДА не переводи их в стандартные "
    "CRM-термины (new/contacted/callback/sold/lost). Наши статусы — "
    "узбекские/русские: \"Javob bermadi 1\", \"Telfoni ochiq\", \"Do'konga "
    "keladi\", \"Harid Qildi\", \"Qarzi bor\", \"TG'га боғланди\", и т.д.\n"
    "7. НЕ используй markdown-таблицы (| ... |). Используй списки с "
    "эмодзи: \"🟢 Название — N\", каждый на новой строке. Это удобнее "
    "в мобильном чате."
)

LANG_RULES = {
    "ru": "Отвечай кратко, по-русски. Не пересказывай данные буквально — выделяй главное.",
    "uz": (
        "Отвечай ТОЛЬКО на узбекском языке (o'zbekcha, lotin yozuvida). "
        "Никогда не переходи на русский, даже если вопрос был на русском. "
        "Кратко, выделяй главное. Валюта: so'm."
    ),
}


def build_system_prompt(language: str = "ru") -> str:
    lang = (language or "ru").lower()
    if lang not in LANG_RULES:
        lang = "ru"
    return _BASE_PROMPT_RU.replace("{LANG_RULE}", LANG_RULES[lang])


# Kept as module-level alias for backwards compatibility (older imports).
SYSTEM_PROMPT = build_system_prompt("ru")


@transaction.atomic
def session_create(*, user, title: str = "") -> ChatSession:
    session = ChatSession.objects.create(user=user, title=title or "Новая сессия")
    audit_log_create(
        user=user,
        action=AuditAction.CREATE,
        entity="ai_chat.ChatSession",
        entity_id=session.id,
        changes={"title": session.title},
    )
    return session


def _tool_specs_for_llm() -> dict:
    """Return the TOOLS dict stripped of the (non-JSON) `handler` callable."""
    return {
        name: {
            "description": spec["description"],
            "parameters": spec["parameters"],
        }
        for name, spec in TOOLS.items()
    }


def _history_payload(session: ChatSession) -> list[dict]:
    payload = []
    for m in session.messages.order_by("created_at"):
        payload.append(
            {
                "role": m.role,
                "content": m.content,
                "tool_name": m.tool_name,
                "tool_calls": m.tool_calls or [],
            }
        )
    return payload


def handle_user_message(
    *,
    session: ChatSession,
    text: str,
    provider_key: str = "",
    language: str = "ru",
) -> ChatMessage:
    """
    Drive the tool-calling loop and return the final assistant message.
    """
    if not text.strip():
        raise ValueError("Empty message")

    user_msg = ChatMessage.objects.create(
        session=session, role=ChatMessage.ROLE_USER, content=text.strip()
    )
    audit_log_create(
        user=session.user,
        action=AuditAction.CREATE,
        entity="ai_chat.ChatMessage",
        entity_id=user_msg.id,
        changes={
            "role": "user",
            "session_id": session.id,
            "provider_key": provider_key,
            "language": language,
        },
    )

    provider = get_provider_by_key(provider_key) if provider_key else get_ai_chat_provider()
    specs = _tool_specs_for_llm()
    prompt = build_system_prompt(language)

    for turn in range(MAX_TOOL_TURNS + 1):
        history = _history_payload(session)
        try:
            response: ChatResponse = provider.chat_with_tools(
                history=history,
                tool_specs=specs,
                system_prompt=prompt,
            )
        except LLMChainExhaustedError as exc:
            logger.warning("LLM chain exhausted for chat: %s", exc)
            assistant = ChatMessage.objects.create(
                session=session,
                role=ChatMessage.ROLE_ASSISTANT,
                content=(
                    "AI-провайдеры сейчас недоступны (все резервы исчерпаны). "
                    "Попробуйте через несколько минут."
                ),
                provider_used="exhausted",
            )
            return assistant
        except Exception as exc:
            logger.exception("LLM chat_with_tools failed: %s", exc)
            # User-facing text kept clean; the raw exception is in the log
            # for whoever is on-call. If we knew this was a rate-limit we
            # would have branched into LLMChainExhaustedError above, so
            # anything landing here is unexpected → generic retry hint.
            assistant = ChatMessage.objects.create(
                session=session,
                role=ChatMessage.ROLE_ASSISTANT,
                content=(
                    "AI временно недоступен — попробуйте ещё раз через минуту. "
                    "Если повторится, скажите менеджеру."
                ),
            )
            return assistant

        if not response.tool_calls:
            assistant = ChatMessage.objects.create(
                session=session,
                role=ChatMessage.ROLE_ASSISTANT,
                content=response.text or "(пустой ответ)",
                model_used=response.model_version or "",
                provider_used=response.provider or "",
            )
            session.updated_at = assistant.updated_at
            session.save(update_fields=["updated_at"])
            audit_log_create(
                user=session.user,
                action=AuditAction.CREATE,
                entity="ai_chat.ChatMessage",
                entity_id=assistant.id,
                changes={"role": "assistant", "session_id": session.id, "turn": turn},
            )
            return assistant

        # Persist a lightweight assistant "tool-request" placeholder so the
        # history the LLM sees on the next turn is faithful.
        request_stub = ChatMessage.objects.create(
            session=session,
            role=ChatMessage.ROLE_ASSISTANT,
            content="",
            tool_calls=[{"name": tc.name, "arguments": tc.arguments} for tc in response.tool_calls],
            model_used=response.model_version or "",
            provider_used=response.provider or "",
        )

        # Run each tool and add a `tool` message per result.
        for tool_call in response.tool_calls:
            try:
                result = call_tool(tool_call.name, **tool_call.arguments)
                payload = json.dumps(result, default=str)[:8000]
            except Exception as exc:
                payload = json.dumps({"error": str(exc)})
            ChatMessage.objects.create(
                session=session,
                role=ChatMessage.ROLE_TOOL,
                content=payload,
                tool_name=tool_call.name,
            )
        _ = request_stub  # keep reference; already persisted

    # Loop budget exhausted → best-effort final message.
    assistant = ChatMessage.objects.create(
        session=session,
        role=ChatMessage.ROLE_ASSISTANT,
        content=("Не удалось завершить ответ за допустимое количество шагов."),
    )
    return assistant


__all__ = [
    "MAX_TOOL_TURNS",
    "handle_user_message",
    "session_create",
]
