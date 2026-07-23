import pytest
from unittest.mock import MagicMock, patch
from django.core.management import call_command
from django.utils import timezone
from apps.operators.models import Operator
from apps.tg_userclient.models import (
    TgAiInsightAttempt,
    TgAiInsightAttemptStatus,
    TgChat,
    TgChatKind,
    TgMessage,
    TgSession,
    TgSessionStatus,
)


@pytest.mark.django_db
def test_analyze_records_success_attempt():
    op = Operator.objects.create(full_name="Op Analysis", phone="+998901111111")
    session = TgSession.objects.create(operator=op, phone="+998901111111", status=TgSessionStatus.ACTIVE)
    chat = TgChat.objects.create(session=session, tg_chat_id=5001, kind=TgChatKind.PRIVATE, last_message_at=timezone.now())
    TgMessage.objects.create(chat=chat, tg_message_id=1, direction="in", kind="text", text="Hi", sent_at=timezone.now())

    mock_provider = MagicMock()
    mock_result = MagicMock(model_version="v1", summary="Good chat", quality_score=90, red_flags=[], highlights=[])
    mock_provider.analyze_dialogs.return_value = mock_result

    with patch("apps.tg_userclient.management.commands.analyze_tg_dialogs.get_provider", return_value=mock_provider):
        call_command("analyze_tg_dialogs")

    attempt = TgAiInsightAttempt.objects.filter(chat=chat).last()
    assert attempt is not None
    assert attempt.status == TgAiInsightAttemptStatus.SUCCESS


@pytest.mark.django_db
def test_analyze_records_retriable_error_with_backoff():
    op = Operator.objects.create(full_name="Op Error", phone="+998901111112")
    session = TgSession.objects.create(operator=op, phone="+998901111112", status=TgSessionStatus.ACTIVE)
    chat = TgChat.objects.create(session=session, tg_chat_id=5002, kind=TgChatKind.PRIVATE, last_message_at=timezone.now())
    TgMessage.objects.create(chat=chat, tg_message_id=1, direction="in", kind="text", text="Hi", sent_at=timezone.now())

    mock_provider = MagicMock()
    mock_provider.analyze_dialogs.side_effect = Exception("LLM 500 Server Error")

    with patch("apps.tg_userclient.management.commands.analyze_tg_dialogs.get_provider", return_value=mock_provider):
        call_command("analyze_tg_dialogs")

    attempt = TgAiInsightAttempt.objects.filter(chat=chat).last()
    assert attempt is not None
    assert attempt.status == TgAiInsightAttemptStatus.ERROR_RETRIABLE
    assert attempt.next_retry_at > timezone.now()


@pytest.mark.django_db
def test_analyze_escalates_to_permanent_after_3_retries():
    op = Operator.objects.create(full_name="Op Permanent", phone="+998901111113")
    session = TgSession.objects.create(operator=op, phone="+998901111113", status=TgSessionStatus.ACTIVE)
    chat = TgChat.objects.create(session=session, tg_chat_id=5003, kind=TgChatKind.PRIVATE, last_message_at=timezone.now())
    TgMessage.objects.create(chat=chat, tg_message_id=1, direction="in", kind="text", text="Hi", sent_at=timezone.now())

    # Pre-create 3 retriable attempts
    for _ in range(3):
        TgAiInsightAttempt.objects.create(
            chat=chat,
            session=session,
            status=TgAiInsightAttemptStatus.ERROR_RETRIABLE,
            error_message="Fail",
            next_retry_at=timezone.now() - timezone.timedelta(seconds=10),
        )

    mock_provider = MagicMock()
    mock_provider.analyze_dialogs.side_effect = Exception("LLM 500 Server Error")

    with patch("apps.tg_userclient.management.commands.analyze_tg_dialogs.get_provider", return_value=mock_provider):
        call_command("analyze_tg_dialogs")

    latest_attempt = TgAiInsightAttempt.objects.filter(chat=chat).order_by("-attempted_at").first()
    assert latest_attempt is not None
    assert latest_attempt.status == TgAiInsightAttemptStatus.ERROR_PERMANENT
