"""
Tests for DRF rate limiting / throttling on auth endpoints.
"""

from __future__ import annotations

import pytest
from django.core.cache import cache
from django.test import TestCase
from rest_framework.test import APIClient


@pytest.mark.django_db
class TestThrottling(TestCase):

    def setUp(self):
        cache.clear()
        self.client = APIClient()

    def tearDown(self):
        cache.clear()

    def test_login_rate_throttle_blocks_11th_request(self):
        url = "/api/auth/login/"
        payload = {"username": "testuser", "password": "wrongpassword"}

        for i in range(10):
            response = self.client.post(url, payload)
            self.assertIn(response.status_code, [400, 200])

        # 11th request must be throttled with 429
        response_11 = self.client.post(url, payload)
        self.assertEqual(response_11.status_code, 429)

    def test_anon_rate_throttle_configured(self):
        # Verify throttle settings are present in base settings
        from django.conf import settings
        rates = settings.REST_FRAMEWORK.get("DEFAULT_THROTTLE_RATES", {})
        self.assertEqual(rates.get("login"), "10/min")
        self.assertEqual(rates.get("anon"), "20/min")
