"""
Tests for extended /healthz endpoint.
"""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

import pytest
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from apps.leads.models import SheetSource
from apps.operators.models import Operator
from apps.tg_userclient.models import TgSession, TgSessionStatus


@pytest.mark.django_db
class TestHealthCheckView(TestCase):

    def setUp(self):
        self.client = APIClient()

    def test_healthz_ok_when_healthy(self):
        response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["checks"]["db"]["status"], "ok")

    def test_healthz_warning_when_sheets_stale(self):
        SheetSource.objects.create(
            name="Test Source",
            spreadsheet_id="test_sheet_id",
            gid="0",
            active=True,
            last_synced_at=timezone.now() - timedelta(minutes=10),
        )
        response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "warning")
        self.assertEqual(data["checks"]["sheets_sync"]["status"], "warning")

    def test_healthz_warning_when_tg_sessions_down(self):
        # 2 active operators, 0 active TG sessions -> ratio < 0.5
        Operator.objects.create(full_name="Op 1", status="active")
        Operator.objects.create(full_name="Op 2", status="active")

        response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "warning")
        self.assertEqual(data["checks"]["tg_sessions"]["status"], "warning")

    @patch("django.db.connection.ensure_connection")
    def test_healthz_error_503_when_db_down(self, mock_ensure):
        mock_ensure.side_effect = RuntimeError("Database connection failure")

        response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 503)
        data = response.json()
        self.assertEqual(data["status"], "error")
        self.assertEqual(data["checks"]["db"]["status"], "error")
