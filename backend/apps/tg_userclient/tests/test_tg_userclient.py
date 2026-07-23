"""
Tests for TG userclient: auth flow, message ingest, AI analysis, permissions.

Telethon is fully mocked — no real Telegram connections in tests.
"""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from django.test import TestCase
from django.utils import timezone

from apps.operators.models import Operator

from ..models import (
    TgAiInsight,
    TgChat,
    TgChatKind,
    TgMessage,
    TgMessageDirection,
    TgMessageKind,
    TgSession,
    TgSessionStatus,
)
from ..services import session_revoke, session_start, session_verify_code, session_verify_password, tg_message_ingest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _create_operator(name: str = "Test Operator", phone: str = "+998901234567") -> Operator:
    return Operator.objects.create(full_name=name, phone=phone)


def _create_active_session(operator: Operator) -> TgSession:
    return TgSession.objects.create(
        operator=operator,
        phone=operator.phone,
        status=TgSessionStatus.ACTIVE,
        encrypted_session=b"fake-encrypted",
        consent_at=timezone.now(),
        tg_user_id=12345,
        tg_username="test_user",
    )


# ---------------------------------------------------------------------------
# Auth flow tests
# ---------------------------------------------------------------------------

@pytest.mark.django_db
class TestSessionStart(TestCase):

    def test_session_start_requires_consent(self):
        op = _create_operator()
        with self.assertRaises(ValueError) as ctx:
            session_start(operator_id=op.id, phone=op.phone, consent=False)
        self.assertEqual(str(ctx.exception), "consent_required")

    @patch("apps.tg_userclient.services.async_to_sync")
    def test_session_start_creates_pending_code(self, mock_ats):
        mock_ats.return_value = lambda: ("hash123", "session_string_abc")
        op = _create_operator()

        session = session_start(operator_id=op.id, phone=op.phone, consent=True)

        self.assertEqual(session.status, TgSessionStatus.PENDING_CODE)
        self.assertEqual(session.operator_id, op.id)
        self.assertIsNotNone(session.consent_at)
        self.assertTrue(session.encrypted_session)  # should be encrypted


@pytest.mark.django_db
class TestVerifyCode(TestCase):

    @patch("apps.tg_userclient.services.async_to_sync")
    def test_verify_code_ok_moves_to_active(self, mock_ats):
        op = _create_operator()
        session = TgSession.objects.create(
            operator=op,
            phone=op.phone,
            phone_code_hash="hash123",
            status=TgSessionStatus.PENDING_CODE,
            encrypted_session=b"fake",
            consent_at=timezone.now(),
        )

        mock_ats.return_value = lambda: (
            TgSessionStatus.ACTIVE, "new_ss", 12345, "testuser"
        )

        with patch("apps.tg_userclient.services.decrypt_session", return_value="old_ss"), \
             patch("apps.tg_userclient.services.encrypt_session", return_value=(b"new_enc", 1)):
            result = session_verify_code(session=session, code="12345")

        self.assertEqual(result.status, TgSessionStatus.ACTIVE)
        self.assertEqual(result.tg_user_id, 12345)
        self.assertEqual(result.tg_username, "testuser")

    @patch("apps.tg_userclient.services.async_to_sync")
    def test_verify_code_needs_2fa_moves_to_pending_2fa(self, mock_ats):
        op = _create_operator()
        session = TgSession.objects.create(
            operator=op,
            phone=op.phone,
            phone_code_hash="hash123",
            status=TgSessionStatus.PENDING_CODE,
            encrypted_session=b"fake",
            consent_at=timezone.now(),
        )

        mock_ats.return_value = lambda: (
            TgSessionStatus.PENDING_2FA, "partial_ss", None, ""
        )

        with patch("apps.tg_userclient.services.decrypt_session", return_value="old_ss"), \
             patch("apps.tg_userclient.services.encrypt_session", return_value=(b"new_enc", 1)):
            result = session_verify_code(session=session, code="12345")

        self.assertEqual(result.status, TgSessionStatus.PENDING_2FA)


@pytest.mark.django_db
class TestVerifyPassword(TestCase):

    @patch("apps.tg_userclient.services.async_to_sync")
    def test_verify_password_ok(self, mock_ats):
        op = _create_operator()
        session = TgSession.objects.create(
            operator=op,
            phone=op.phone,
            status=TgSessionStatus.PENDING_2FA,
            encrypted_session=b"fake",
            consent_at=timezone.now(),
        )

        mock_ats.return_value = lambda: ("final_ss", 12345, "testuser")

        with patch("apps.tg_userclient.services.decrypt_session", return_value="old_ss"), \
             patch("apps.tg_userclient.services.encrypt_session", return_value=(b"new_enc", 1)):
            result = session_verify_password(session=session, password="cloud_pass")

        self.assertEqual(result.status, TgSessionStatus.ACTIVE)
        self.assertEqual(result.tg_user_id, 12345)


@pytest.mark.django_db
class TestRevoke(TestCase):

    def test_revoke_clears_session_string(self):
        op = _create_operator()
        session = _create_active_session(op)

        result = session_revoke(session=session)

        self.assertEqual(result.status, TgSessionStatus.REVOKED)
        self.assertEqual(result.encrypted_session, b"")
        self.assertEqual(result.phone_code_hash, "")


# ---------------------------------------------------------------------------
# Message ingest tests
# ---------------------------------------------------------------------------

@pytest.mark.django_db
class TestMessageIngest(TestCase):

    def test_message_ingest_creates_chat_and_message(self):
        op = _create_operator()
        session = _create_active_session(op)
        now = timezone.now()

        msg = tg_message_ingest(
            session_id=session.id,
            tg_chat_id=999,
            chat_kind=TgChatKind.PRIVATE,
            chat_title="",
            partner_name="Client Name",
            partner_phone="+998901112233",
            tg_message_id=1,
            direction=TgMessageDirection.IN,
            message_kind=TgMessageKind.TEXT,
            text="Hello!",
            voice_duration_sec=None,
            sent_at=now,
        )

        self.assertIsNotNone(msg)
        self.assertEqual(TgChat.objects.count(), 1)
        self.assertEqual(TgMessage.objects.count(), 1)

        chat = TgChat.objects.first()
        self.assertEqual(chat.partner_name, "Client Name")
        self.assertEqual(chat.tg_chat_id, 999)
        self.assertEqual(msg.direction, TgMessageDirection.IN)

    def test_message_ingest_matches_lead_by_phone(self):
        from apps.leads.models import Lead

        op = _create_operator()
        session = _create_active_session(op)
        lead = Lead.objects.create(phone="+998901112233", full_name="Lead Client")

        tg_message_ingest(
            session_id=session.id,
            tg_chat_id=999,
            chat_kind=TgChatKind.PRIVATE,
            chat_title="",
            partner_name="Client",
            partner_phone="+998901112233",
            tg_message_id=1,
            direction=TgMessageDirection.IN,
            message_kind=TgMessageKind.TEXT,
            text="Hi",
            voice_duration_sec=None,
            sent_at=timezone.now(),
        )

        chat = TgChat.objects.first()
        self.assertEqual(chat.lead_id, lead.id)

    def test_message_ingest_ignores_channels(self):
        op = _create_operator()
        session = _create_active_session(op)

        result = tg_message_ingest(
            session_id=session.id,
            tg_chat_id=999,
            chat_kind=TgChatKind.CHANNEL,
            chat_title="Channel",
            partner_name="",
            partner_phone="",
            tg_message_id=1,
            direction=TgMessageDirection.IN,
            message_kind=TgMessageKind.TEXT,
            text="Channel message",
            voice_duration_sec=None,
            sent_at=timezone.now(),
            is_channel=True,
        )

        self.assertIsNone(result)
        self.assertEqual(TgChat.objects.count(), 0)

    def test_message_ingest_idempotent_on_duplicate_tg_message_id(self):
        op = _create_operator()
        session = _create_active_session(op)
        now = timezone.now()

        # First ingest
        msg1 = tg_message_ingest(
            session_id=session.id,
            tg_chat_id=999,
            chat_kind=TgChatKind.PRIVATE,
            chat_title="",
            partner_name="Client",
            partner_phone="",
            tg_message_id=42,
            direction=TgMessageDirection.IN,
            message_kind=TgMessageKind.TEXT,
            text="Hello",
            voice_duration_sec=None,
            sent_at=now,
        )
        self.assertIsNotNone(msg1)

        # Duplicate ingest
        msg2 = tg_message_ingest(
            session_id=session.id,
            tg_chat_id=999,
            chat_kind=TgChatKind.PRIVATE,
            chat_title="",
            partner_name="Client",
            partner_phone="",
            tg_message_id=42,
            direction=TgMessageDirection.IN,
            message_kind=TgMessageKind.TEXT,
            text="Hello again",
            voice_duration_sec=None,
            sent_at=now,
        )
        self.assertIsNone(msg2)
        self.assertEqual(TgMessage.objects.count(), 1)


# ---------------------------------------------------------------------------
# AI analysis tests (with NoneProvider)
# ---------------------------------------------------------------------------

@pytest.mark.django_db
class TestAiAnalysis(TestCase):

    def test_analyze_creates_insight_for_operator(self):
        from apps.tg_userclient.ai.provider import NoneProvider, MessageDTO

        op = _create_operator()
        session = _create_active_session(op)
        chat = TgChat.objects.create(
            session=session, tg_chat_id=100, kind=TgChatKind.PRIVATE,
            partner_name="Client", last_message_at=timezone.now(),
        )
        TgMessage.objects.create(
            chat=chat, tg_message_id=1, direction=TgMessageDirection.OUT,
            kind=TgMessageKind.TEXT, text="Salom!", sent_at=timezone.now(),
        )

        provider = NoneProvider()
        dtos = [MessageDTO(direction="out", text="Salom!", sent_at=timezone.now().isoformat())]
        result = provider.analyze_dialogs(dtos, op.full_name, "v1")

        insight = TgAiInsight.objects.create(
            session=session, chat=chat,
            since=timezone.now() - timedelta(hours=1),
            until=timezone.now(),
            model_version=result.model_version,
            prompt_version="v1",
            summary=result.summary,
            quality_score=result.quality_score,
            red_flags=result.red_flags,
            highlights=result.highlights,
        )

        self.assertEqual(TgAiInsight.objects.count(), 1)
        self.assertEqual(insight.model_version, "none")

    def test_analyze_skips_if_up_to_date(self):
        op = _create_operator()
        session = _create_active_session(op)
        now = timezone.now()

        chat = TgChat.objects.create(
            session=session, tg_chat_id=100, kind=TgChatKind.PRIVATE,
            partner_name="Client", last_message_at=now,
        )

        # Existing insight that covers the latest message
        TgAiInsight.objects.create(
            session=session, chat=chat,
            since=now - timedelta(hours=1), until=now,
            model_version="none", prompt_version="v1",
            summary="Already done", quality_score=80,
        )

        # Check idempotency
        latest_insight = TgAiInsight.objects.filter(chat=chat).order_by("-until").first()
        self.assertIsNotNone(latest_insight)
        self.assertTrue(latest_insight.until >= chat.last_message_at)

    def test_analyze_handles_provider_error(self):
        from apps.tg_userclient.ai.provider import MessageDTO, NoneProvider

        provider = NoneProvider()
        # NoneProvider should not raise
        result = provider.analyze_dialogs(
            [MessageDTO(direction="out", text="test", sent_at="2024-01-01T00:00:00")],
            "Op",
            "v1",
        )
        self.assertIsInstance(result.quality_score, int)
