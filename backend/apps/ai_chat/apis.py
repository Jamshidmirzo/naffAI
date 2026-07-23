from __future__ import annotations

from rest_framework import serializers
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.generics import ListCreateAPIView
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.users.permissions import IsManager

from .models import ChatMessage, ChatSession
from .selectors import session_for_user, session_messages, user_sessions
from .services import handle_user_message, session_create


class ChatSessionSerializer(serializers.ModelSerializer):
    class Meta:
        model = ChatSession
        fields = ["id", "title", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class ChatMessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = ChatMessage
        fields = [
            "id",
            "role",
            "content",
            "tool_calls",
            "tool_name",
            "model_used",
            "provider_used",
            "created_at",
        ]
        read_only_fields = ["id", "role", "created_at"]


class ChatSessionListCreateApi(ListCreateAPIView):
    permission_classes = [IsManager]
    serializer_class = ChatSessionSerializer

    def get_queryset(self):
        return user_sessions(self.request.user)

    def create(self, request, *args, **kwargs):
        title = (request.data or {}).get("title", "")
        session = session_create(user=request.user, title=title)
        return Response(ChatSessionSerializer(session).data, status=201)


class ChatMessagesApi(APIView):
    permission_classes = [IsManager]

    def get(self, request, session_id: int):
        session = session_for_user(user=request.user, session_id=session_id)
        if not session:
            raise NotFound("Session not found")
        rows = session_messages(session)
        return Response(ChatMessageSerializer(rows, many=True).data)

    def post(self, request, session_id: int):
        session = session_for_user(user=request.user, session_id=session_id)
        if not session:
            raise NotFound("Session not found")
        content = (request.data or {}).get("content", "").strip()
        if not content:
            raise ValidationError({"content": "Пустое сообщение."})
        assistant_msg = handle_user_message(session=session, text=content)
        # Return the full message history — simpler for the FE.
        rows = session_messages(session)
        return Response({
            "messages": ChatMessageSerializer(rows, many=True).data,
            "last_assistant_id": assistant_msg.id,
        })
