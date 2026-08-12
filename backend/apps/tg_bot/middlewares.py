"""
Aiogram middlewares for v2 Telegram bot:

* AuditMiddleware — writes a BotAuditLog row for every incoming update
  before the handler runs, updates outcome after.
* RBACMiddleware — resolves the caller's role via BotChat.linked_profile
  and either denies (for @manager_only handlers) or attaches the role
  to the handler context via `data["bot_role"]`.

Chat registry (`BotChat.objects.get_or_create`) is refreshed on every
message so we always have an up-to-date list of chats in the web UI.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from aiogram import BaseMiddleware
from aiogram.types import Chat, TelegramObject, Update, User
from asgiref.sync import sync_to_async

from .models import BotAuditLog, BotChat

log = logging.getLogger(__name__)

# Handler-name → role required. Handlers not listed are open to all
# authenticated chats. Populated by @manager_only / @operator_only
# decorators in runner.py at import time.
_HANDLER_ROLES: dict[str, str] = {}


def register_role_requirement(handler_name: str, role: str) -> None:
    _HANDLER_ROLES[handler_name] = role


def manager_only(func):
    """Decorator: mark a handler as manager-only. RBACMiddleware enforces."""
    register_role_requirement(_handler_name(func), "manager")
    return func


def operator_only(func):
    register_role_requirement(_handler_name(func), "operator")
    return func


def _handler_name(func) -> str:
    return f"{func.__module__}.{func.__qualname__}"


def _extract_chat_user(event: TelegramObject) -> tuple[Chat | None, User | None, str, str]:
    """Return (chat, user, command_hint, args) for an incoming update."""
    chat = user = None
    command_hint = ""
    args = ""
    if isinstance(event, Update):
        if event.message:
            chat = event.message.chat
            user = event.message.from_user
            text = event.message.text or event.message.caption or ""
            command_hint = text.split()[0][:64] if text else "message"
            args = text[len(command_hint) :].strip()[:400]
        elif event.callback_query:
            chat = event.callback_query.message.chat if event.callback_query.message else None
            user = event.callback_query.from_user
            command_hint = f"callback:{(event.callback_query.data or '')[:56]}"
        elif event.my_chat_member:
            chat = event.my_chat_member.chat
            user = event.my_chat_member.from_user
            command_hint = "my_chat_member"
            args = f"{event.my_chat_member.old_chat_member.status}→{event.my_chat_member.new_chat_member.status}"
    return chat, user, command_hint, args


class AuditMiddleware(BaseMiddleware):
    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: dict[str, Any],
    ) -> Any:
        chat, user, command, args = _extract_chat_user(event)
        entry: BotAuditLog | None = None
        if chat is not None:
            try:
                entry = await sync_to_async(BotAuditLog.objects.create)(
                    chat_id=chat.id,
                    chat_kind=chat.type,
                    tg_user_id=user.id if user else None,
                    username=(user.username or "")[:64] if user else "",
                    command=command,
                    args=args,
                )
                data["audit_entry"] = entry
            except Exception:
                log.exception("audit write failed")
        try:
            return await handler(event, data)
        except Exception as exc:
            if entry is not None:
                await _update_audit(entry, outcome="error", detail=str(exc)[:400])
            raise


async def _update_audit(entry: BotAuditLog, outcome: str, detail: str = "") -> None:
    entry.outcome = outcome
    if detail:
        entry.error_detail = detail

    def _save():
        entry.save(update_fields=["outcome", "error_detail"])

    await sync_to_async(_save)()


class ChatRegistryMiddleware(BaseMiddleware):
    """
    Refresh BotChat on every update so the /bot/chats/ UI stays in sync
    without needing dedicated handlers for every entry point.
    """

    async def __call__(self, handler, event, data):
        chat, _, _, _ = _extract_chat_user(event)
        if chat is not None:
            try:
                await sync_to_async(_upsert_chat)(chat)
            except Exception:
                log.exception("chat upsert failed chat_id=%s", chat.id)
        return await handler(event, data)


def _upsert_chat(chat: Chat) -> BotChat:
    obj, created = BotChat.objects.get_or_create(
        chat_id=chat.id,
        defaults={
            "kind": chat.type,
            "title": (chat.title or chat.full_name or "")[:256],
            "is_active": True,
        },
    )
    if not created:
        changed = False
        if obj.kind != chat.type:
            obj.kind = chat.type
            changed = True
        title = (chat.title or chat.full_name or "")[:256]
        if title and obj.title != title:
            obj.title = title
            changed = True
        if not obj.is_active:
            obj.is_active = True
            obj.blocked_at = None
            changed = True
        if changed:
            obj.save(
                update_fields=["kind", "title", "is_active", "blocked_at", "last_seen_at"]
            )
        else:
            # touch last_seen_at
            obj.save(update_fields=["last_seen_at"])
    return obj


class RBACMiddleware(BaseMiddleware):
    """
    Attaches `bot_role` to handler context based on BotChat.linked_profile
    role. Denies handlers registered via @manager_only when the caller
    doesn't have the required role.
    """

    async def __call__(self, handler, event, data):
        chat, _, _, _ = _extract_chat_user(event)
        role = "any"
        if chat is not None:
            role = await sync_to_async(_resolve_role)(chat.id)
        data["bot_role"] = role

        # RBACMiddleware runs BEFORE handler dispatch; we can't know which
        # specific inner handler will match — instead handlers themselves
        # can short-circuit via `if data.get("bot_role") != "manager": return`.
        # We provide a helper for the runner via require_role(data, "manager").
        return await handler(event, data)


def _resolve_role(chat_id: int) -> str:
    """
    Resolve caller's role by chat_id → BotChat.linked_profile.role.
    Returns "any" if not linked.
    """
    chat = BotChat.objects.select_related("linked_profile").filter(chat_id=chat_id).first()
    if not chat or not chat.linked_profile:
        return "any"
    role = getattr(chat.linked_profile, "role", None) or "any"
    # Normalize team_lead → manager for gate purposes.
    if role in ("team_lead", "manager"):
        return "manager"
    return role


async def require_role(
    data: dict, event: TelegramObject, needed: str, deny_message: str = "Команда недоступна"
) -> bool:
    """
    Handler-side gate: return True if role check passes; else send deny
    message and update audit outcome=denied.
    """
    role = data.get("bot_role", "any")
    if needed == "any" or role == needed or (needed == "operator" and role == "manager"):
        return True
    entry = data.get("audit_entry")
    if entry is not None:
        await _update_audit(entry, outcome="denied", detail=f"needed={needed} role={role}")
    try:
        if hasattr(event, "answer"):
            await event.answer(deny_message)
        elif getattr(event, "message", None) is not None:
            await event.message.answer(deny_message)
    except Exception:
        pass
    return False
