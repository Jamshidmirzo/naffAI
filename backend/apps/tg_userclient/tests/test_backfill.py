"""
Tests for TG backfill: job creation, idempotency, runner processing, filtering, errors.

All Telethon interactions are mocked.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone as dt_tz
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from asgiref.sync import async_to_sync
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.operators.models import Operator

from ..models import (
    TgBackfillJob,
    TgBackfillJobStatus,
    TgChat,
    TgMessage,
    TgSession,
    TgSessionStatus,
)
from ..runner import ClientManager
from ..services import (
    _ensure_backfill_job,
    _parse_backfill_since,
    _reset_stale_running_jobs,
    session_verify_code,
)


def _create_operator(name: str = "Test Op", phone: str = "+998901112233") -> Operator:
    return Operator.objects.create(full_name=name, phone=phone)


def _create_active_session(operator: Operator) -> TgSession:
    return TgSession.objects.create(
        operator=operator,
        phone=operator.phone,
        status=TgSessionStatus.ACTIVE,
        encrypted_session=b"fake-session",
        consent_at=timezone.now(),
        tg_user_id=12345,
        tg_username="testop",
    )


@pytest.mark.django_db
class TestTgBackfill(TestCase):

    @patch("apps.tg_userclient.services.async_to_sync")
    def test_verify_code_creates_pending_backfill_job(self, mock_ats):
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

        with patch("apps.tg_userclient.services.decrypt_session", return_value="ss"), \
             patch("apps.tg_userclient.services.encrypt_session", return_value=(b"enc", 1)):
            session_verify_code(session=session, code="12345")

        jobs = TgBackfillJob.objects.filter(session=session)
        self.assertEqual(jobs.count(), 1)
        job = jobs.first()
        self.assertEqual(job.status, TgBackfillJobStatus.PENDING)
        self.assertEqual(job.since.strftime("%Y-%m-%d"), "2026-07-01")

    def test_ensure_backfill_job_is_idempotent(self):
        op = _create_operator()
        session = _create_active_session(op)

        job1 = _ensure_backfill_job(session)
        job2 = _ensure_backfill_job(session)

        self.assertIsNotNone(job1)
        self.assertEqual(job1.id, job2.id)
        self.assertEqual(TgBackfillJob.objects.filter(session=session).count(), 1)

    def test_new_session_after_revoke_gets_new_job(self):
        op = _create_operator()
        session = _create_active_session(op)

        # First job completed
        job1 = _ensure_backfill_job(session)
        job1.status = TgBackfillJobStatus.DONE
        job1.save()

        # Session revoked, then active again
        session.status = TgSessionStatus.REVOKED
        session.save()
        session.status = TgSessionStatus.ACTIVE
        session.save()

        job2 = _ensure_backfill_job(session)
        self.assertNotEqual(job1.id, job2.id)
        self.assertEqual(job2.status, TgBackfillJobStatus.PENDING)
        self.assertEqual(TgBackfillJob.objects.filter(session=session).count(), 2)

    @override_settings(TG_BACKFILL_SINCE="")
    def test_backfill_disabled_when_since_empty(self):
        op = _create_operator()
        session = _create_active_session(op)

        job = _ensure_backfill_job(session)
        self.assertIsNone(job)
        self.assertEqual(TgBackfillJob.objects.filter(session=session).count(), 0)

    def test_reset_stale_running_jobs(self):
        op = _create_operator()
        session = _create_active_session(op)
        job = TgBackfillJob.objects.create(
            session=session,
            since=timezone.now(),
            status=TgBackfillJobStatus.RUNNING,
            started_at=timezone.now() - timedelta(minutes=15),
        )
        # Force updated_at into the past
        TgBackfillJob.objects.filter(id=job.id).update(
            updated_at=timezone.now() - timedelta(minutes=15)
        )

        reset_count = _reset_stale_running_jobs()
        self.assertEqual(reset_count, 1)

        job.refresh_from_db()
        self.assertEqual(job.status, TgBackfillJobStatus.PENDING)

    def test_backfill_skips_messages_older_than_since(self):
        op = _create_operator()
        session = _create_active_session(op)
        since = datetime(2026, 7, 1, 0, 0, 0, tzinfo=dt_tz.utc)

        manager = ClientManager()

        mock_client = MagicMock()
        mock_msg_old = MagicMock(id=1, date=datetime(2026, 6, 30, 23, 0, 0, tzinfo=dt_tz.utc), out=False, voice=False, document=None, message="Old")
        mock_msg_new1 = MagicMock(id=2, date=datetime(2026, 7, 1, 1, 0, 0, tzinfo=dt_tz.utc), out=True, voice=False, document=None, message="New 1")
        mock_msg_new2 = MagicMock(id=3, date=datetime(2026, 7, 1, 2, 0, 0, tzinfo=dt_tz.utc), out=False, voice=False, document=None, message="New 2")

        async def _iter_messages(*args, **kwargs):
            for m in [mock_msg_old, mock_msg_new1, mock_msg_new2]:
                yield m

        mock_client.iter_messages = _iter_messages

        dialog = MagicMock(id=100, is_user=True, is_group=False, entity=MagicMock(first_name="Client", last_name="", phone="+998901234567"))

        saved = async_to_sync(manager._backfill_one_chat)(mock_client, session, dialog, since)
        self.assertEqual(saved, 2)

    def test_backfill_skips_pure_channels(self):
        op = _create_operator()
        session = _create_active_session(op)
        job = TgBackfillJob.objects.create(session=session, since=timezone.now() - timedelta(days=10))

        manager = ClientManager()

        d_private = MagicMock(is_channel=False, is_group=False, is_user=True, id=101, entity=MagicMock(first_name="User", last_name="", phone=""))
        d_group = MagicMock(is_channel=False, is_group=True, is_user=False, id=102, entity=MagicMock(title="Group"))
        d_channel = MagicMock(is_channel=True, is_group=False, is_user=False, id=103, entity=MagicMock(title="Channel"))

        mock_client = MagicMock()
        async def _iter_dialogs():
            for d in [d_private, d_group, d_channel]:
                yield d

        async def _iter_messages(*args, **kwargs):
            if False: yield

        mock_client.iter_dialogs = _iter_dialogs
        mock_client.iter_messages = _iter_messages

        async_to_sync(manager._run_backfill)(mock_client, job)

        job.refresh_from_db()
        self.assertEqual(job.status, TgBackfillJobStatus.DONE)
        self.assertEqual(job.chats_scanned, 2)

    def test_backfill_marks_error_on_exception(self):
        op = _create_operator()
        session = _create_active_session(op)
        job = TgBackfillJob.objects.create(session=session, since=timezone.now() - timedelta(days=10))

        manager = ClientManager()
        mock_client = MagicMock()

        async def _iter_dialogs_fail():
            raise RuntimeError("Telegram connection error")
            yield

        mock_client.iter_dialogs = _iter_dialogs_fail

        async_to_sync(manager._run_backfill)(mock_client, job)

        job.refresh_from_db()
        self.assertEqual(job.status, TgBackfillJobStatus.ERROR)
        self.assertIn("Telegram connection error", job.last_error)
