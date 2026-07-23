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
    get_llm_provider,
)

from .models import ChatMessage, ChatSession
from .tools import TOOLS, call_tool

logger = logging.getLogger("apps.ai_chat")

MAX_TOOL_TURNS = 5

SYSTEM_PROMPT = (
    "Ты — read-only AI-ассистент для менеджера call-центра магазина телефонов naffAI. "
    "У тебя есть набор функций для чтения данных: лидов, продаж, операторов, "
    "воронок и callback'ов. Всегда предпочитай реальные данные вымыслу. "
    "Отвечай кратко, по-русски. Форматируй числа с разделителями тысяч. "
    "Если пользователь просит сделать действие (создать, удалить, назначить) — "
    "объясни что ты только для чтения."
)


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
        payload.append({
            "role": m.role,
            "content": m.content,
            "tool_name": m.tool_name,
        })
    return payload


def handle_user_message(*, session: ChatSession, text: str) -> ChatMessage:
    """
    Drive the tool-calling loop and return the final assistant message.
    """
    if not text.strip():
        raise ValueError("Empty message")

    user_msg = ChatMessage.objects.create(session=session, role=ChatMessage.ROLE_USER, content=text.strip())
    audit_log_create(
        user=session.user,
        action=AuditAction.CREATE,
        entity="ai_chat.ChatMessage",
        entity_id=user_msg.id,
        changes={"role": "user", "session_id": session.id},
    )

    provider = get_llm_provider()
    specs = _tool_specs_for_llm()

    for turn in range(MAX_TOOL_TURNS + 1):
        history = _history_payload(session)
        try:
            response: ChatResponse = provider.chat_with_tools(
                history=history,
                tool_specs=specs,
                system_prompt=SYSTEM_PROMPT,
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
            assistant = ChatMessage.objects.create(
                session=session,
                role=ChatMessage.ROLE_ASSISTANT,
                content=f"Извините, ошибка LLM: {exc}",
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
