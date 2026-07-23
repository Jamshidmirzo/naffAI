"""
F3.A — AI chat orchestration tests.

Covers:
- Each tool handler returns a dict without raising.
- Chat loop terminates when the provider returns text.
- Chat loop invokes a tool when provider returns a tool_call.
- Session/message permission gating (manager-only).
- MAX_TOOL_TURNS safety net.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.ai_chat.models import ChatMessage, ChatSession
from apps.ai_chat.services import MAX_TOOL_TURNS, handle_user_message, session_create
from apps.ai_chat.tools import TOOLS, call_tool
from apps.leads.models import Lead
from apps.tg_userclient.ai.provider import ChatResponse, ChatToolCall
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def manager(db):
    u = User.objects.create_user(username="chat-mgr", password="pass1234")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def team_lead(db):
    u = User.objects.create_user(username="chat-lead", password="pass1234")
    Profile.objects.create(user=u, role=Role.TEAM_LEAD)
    return u


@pytest.fixture
def api():
    return APIClient()


@pytest.mark.django_db
def test_every_tool_returns_dict():
    """All tool handlers must be callable without kwargs and return dicts."""
    Lead.objects.create(status="new")
    for name in TOOLS:
        result = call_tool(name)
        assert isinstance(result, dict), f"{name} did not return a dict"


@pytest.mark.django_db
def test_call_tool_raises_for_unknown():
    with pytest.raises(KeyError):
        call_tool("nonexistent_tool")


@pytest.mark.django_db
def test_chat_loop_returns_plain_text(manager):
    session = session_create(user=manager, title="test")
    with patch("apps.ai_chat.services.get_llm_provider") as mock_get:
        class P:
            def chat_with_tools(self, *, history, tool_specs, system_prompt=""):
                return ChatResponse(text="hi there", tool_calls=[], model_version="test")

        mock_get.return_value = P()
        assistant = handle_user_message(session=session, text="Hello")
    assert assistant.role == ChatMessage.ROLE_ASSISTANT
    assert assistant.content == "hi there"


@pytest.mark.django_db
def test_chat_loop_calls_tool_then_returns_text(manager):
    session = session_create(user=manager, title="test")

    calls = {"n": 0}

    with patch("apps.ai_chat.services.get_llm_provider") as mock_get:
        class P:
            def chat_with_tools(self, *, history, tool_specs, system_prompt=""):
                calls["n"] += 1
                if calls["n"] == 1:
                    return ChatResponse(
                        tool_calls=[ChatToolCall(name="get_leads_count", arguments={})],
                        model_version="test",
                    )
                return ChatResponse(text="Всего лидов: 0", tool_calls=[], model_version="test")

        mock_get.return_value = P()
        assistant = handle_user_message(session=session, text="сколько лидов?")

    assert assistant.role == ChatMessage.ROLE_ASSISTANT
    assert "лидов" in assistant.content.lower()
    # One user + one placeholder assistant tool-call + one tool result + one final assistant.
    msgs = list(session.messages.order_by("created_at"))
    assert msgs[0].role == "user"
    assert any(m.role == "tool" and m.tool_name == "get_leads_count" for m in msgs)
    assert msgs[-1].role == "assistant"
    assert calls["n"] == 2


@pytest.mark.django_db
def test_chat_loop_stops_at_max_tool_turns(manager):
    session = session_create(user=manager, title="test")

    with patch("apps.ai_chat.services.get_llm_provider") as mock_get:
        class P:
            """Always asks for a tool call → loop must abort at MAX_TOOL_TURNS."""

            def chat_with_tools(self, *, history, tool_specs, system_prompt=""):
                return ChatResponse(
                    tool_calls=[ChatToolCall(name="get_leads_count", arguments={})],
                    model_version="test",
                )

        mock_get.return_value = P()
        assistant = handle_user_message(session=session, text="loop me")
    # Final message must be an assistant "budget exhausted" text.
    assert assistant.role == ChatMessage.ROLE_ASSISTANT
    # Turns executed = MAX_TOOL_TURNS + 1 (we allow one more chance).
    tool_msgs = session.messages.filter(role="tool", tool_name="get_leads_count").count()
    assert tool_msgs >= MAX_TOOL_TURNS


@pytest.mark.django_db
def test_manager_can_create_session_via_api(api, manager):
    api.force_authenticate(manager)
    r = api.post("/api/ai-chat/sessions/", {"title": "First"}, format="json")
    assert r.status_code == 201, r.content
    assert r.json()["title"] == "First"
    assert ChatSession.objects.filter(user=manager).count() == 1


@pytest.mark.django_db
def test_team_lead_cannot_use_ai_chat(api, team_lead):
    """Per spec, AI-chat is manager-only (not team_lead)."""
    api.force_authenticate(team_lead)
    r = api.post("/api/ai-chat/sessions/", {"title": "nope"}, format="json")
    assert r.status_code == 403


@pytest.mark.django_db
def test_session_scope_is_per_user(api, manager, db):
    other = User.objects.create_user(username="other-mgr", password="p")
    Profile.objects.create(user=other, role=Role.MANAGER)
    s = session_create(user=other, title="other's session")
    api.force_authenticate(manager)
    r = api.get(f"/api/ai-chat/sessions/{s.id}/messages/")
    assert r.status_code == 404
