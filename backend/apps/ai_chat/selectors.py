from __future__ import annotations

from django.contrib.auth import get_user_model

from .models import ChatMessage, ChatSession

User = get_user_model()


def user_sessions(user):
    return ChatSession.objects.filter(user=user).order_by("-updated_at")


def session_messages(session: ChatSession):
    return session.messages.order_by("created_at")


def session_for_user(*, user, session_id: int) -> ChatSession | None:
    return ChatSession.objects.filter(pk=session_id, user=user).first()
