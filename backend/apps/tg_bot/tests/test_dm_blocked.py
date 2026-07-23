"""
Tests for BotSubscription DM-blocked functionality.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from asgiref.sync import async_to_sync
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.leads.models import Lead
from apps.tg_bot.models import BotSubscription
from apps.tg_bot.notify import send_callback_dm
from apps.tg_bot.selectors import subscriptions_ready_for_dm


@pytest.mark.django_db
class TestDmBlocked(TestCase):

    def setUp(self):
        self.sub = BotSubscription.objects.create(
            chat_id=12345678,
            chat_title="Test Chat",
            is_active=True,
        )
        self.lead = Lead.objects.create(full_name="Test Client", phone="+998901234567")
        self.reminder = MagicMock(id=1, lead=self.lead, remind_at=timezone.now())

    @override_settings(TELEGRAM_BOT_TOKEN="fake:token")
    @patch("aiogram.Bot")
    def test_dm_forbidden_marks_blocked(self, mock_bot_cls):
        from aiogram.exceptions import TelegramForbiddenError

        mock_bot = AsyncMock()
        mock_bot.send_message.side_effect = TelegramForbiddenError(
            method=MagicMock(), message="Forbidden: bot was blocked by the user"
        )
        mock_bot_cls.return_value = mock_bot

        res = async_to_sync(send_callback_dm)(self.sub.chat_id, self.reminder)
        self.assertFalse(res)

        self.sub.refresh_from_db()
        self.assertIsNotNone(self.sub.blocked_at)

    def test_dm_skipped_for_blocked_subscription(self):
        self.sub.blocked_at = timezone.now()
        self.sub.save()

        ready_subs = list(subscriptions_ready_for_dm())
        self.assertNotIn(self.sub, ready_subs)
