"""
Tests for batch purging of old Telegram messages.
"""

from __future__ import annotations

from io import StringIO
from datetime import timedelta

import pytest
from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone

from apps.operators.models import Operator

from ..models import TgChat, TgMessage, TgSession, TgSessionStatus


@pytest.mark.django_db
class TestBatchPurge(TestCase):

    def setUp(self):
        op = Operator.objects.create(full_name="Op Test", phone="+998901234567")
        session = TgSession.objects.create(
            operator=op,
            phone=op.phone,
            status=TgSessionStatus.ACTIVE,
            encrypted_session=b"session",
        )
        self.chat = TgChat.objects.create(
            session=session,
            tg_chat_id=100,
            title="Chat 100",
        )

        old_date = timezone.now() - timedelta(days=100)
        recent_date = timezone.now() - timedelta(days=10)

        # Create 15 old messages
        for i in range(15):
            TgMessage.objects.create(
                chat=self.chat,
                tg_message_id=1000 + i,
                text=f"Old message {i}",
                sent_at=old_date,
            )

        # Create 5 recent messages
        for i in range(5):
            TgMessage.objects.create(
                chat=self.chat,
                tg_message_id=2000 + i,
                text=f"Recent message {i}",
                sent_at=recent_date,
            )

    def test_purge_deletes_old_messages_in_batches(self):
        out = StringIO()
        call_command("purge_old_tg_messages", days=90, stdout=out)

        output = out.getvalue()
        self.assertIn("batch:", output)
        self.assertIn("total: 15", output)
        self.assertEqual(TgMessage.objects.count(), 5)

    def test_purge_dry_run_leaves_messages(self):
        out = StringIO()
        call_command("purge_old_tg_messages", days=90, dry_run=True, stdout=out)

        output = out.getvalue()
        self.assertIn("[DRY RUN]", output)
        self.assertEqual(TgMessage.objects.count(), 20)
