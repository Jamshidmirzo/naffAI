"""
Tests for stale RUNNING job reset, FloodWait > 5 min release, and heartbeat updates.
"""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import MagicMock

import pytest
from asgiref.sync import async_to_sync
from django.test import TestCase, override_settings
from django.utils import timezone
from telethon.errors import FloodWaitError

from apps.operators.models import Operator

from ..models import TgBackfillJob, TgBackfillJobStatus, TgSession, TgSessionStatus
from ..runner import ClientManager
from ..services import _reset_stale_running_jobs


@pytest.mark.django_db
class TestStaleRunningResetAndHeartbeat(TestCase):

    def setUp(self):
        self.operator = Operator.objects.create(full_name="Op Test", phone="+998901234567")
        self.session = TgSession.objects.create(
            operator=self.operator,
            phone=self.operator.phone,
            status=TgSessionStatus.ACTIVE,
            encrypted_session=b"session",
        )

    def test_stale_running_reset_after_5min(self):
        job = TgBackfillJob.objects.create(
            session=self.session,
            since=timezone.now(),
            status=TgBackfillJobStatus.RUNNING,
        )
        # Force updated_at to 6 minutes ago
        TgBackfillJob.objects.filter(id=job.id).update(
            updated_at=timezone.now() - timedelta(minutes=6)
        )

        count = _reset_stale_running_jobs()
        self.assertEqual(count, 1)

        job.refresh_from_db()
        self.assertEqual(job.status, TgBackfillJobStatus.PENDING)

    def test_floodwait_over_5min_releases_to_pending(self):
        job = TgBackfillJob.objects.create(
            session=self.session,
            since=timezone.now(),
            status=TgBackfillJobStatus.PENDING,
        )

        manager = ClientManager()
        mock_client = MagicMock()

        async def _iter_dialogs_flood():
            raise FloodWaitError(request=None, capture=360)  # 360 sec > 300 sec
            yield

        mock_client.iter_dialogs = _iter_dialogs_flood

        async_to_sync(manager._run_backfill)(mock_client, job)

        job.refresh_from_db()
        self.assertEqual(job.status, TgBackfillJobStatus.PENDING)
        self.assertIsNone(job.started_at)

    def test_heartbeat_updates_timestamp(self):
        job = TgBackfillJob.objects.create(
            session=self.session,
            since=timezone.now() - timedelta(days=1),
            status=TgBackfillJobStatus.PENDING,
        )

        manager = ClientManager()
        mock_client = MagicMock()

        # Create 12 dialogs to trigger heartbeat on 10th chat
        dialogs = [
            MagicMock(
                is_channel=False,
                is_group=False,
                is_user=True,
                id=100 + i,
                entity=MagicMock(first_name=f"User{i}", last_name="", phone="")
            )
            for i in range(12)
        ]

        async def _iter_dialogs():
            for d in dialogs:
                yield d

        async def _iter_messages(*args, **kwargs):
            if False: yield

        mock_client.iter_dialogs = _iter_dialogs
        mock_client.iter_messages = _iter_messages

        async_to_sync(manager._run_backfill)(mock_client, job)

        job.refresh_from_db()
        self.assertEqual(job.status, TgBackfillJobStatus.DONE)
        self.assertEqual(job.chats_scanned, 12)
