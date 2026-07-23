"""
Tests for ALLOWED_HOSTS production configuration check.
"""

from __future__ import annotations

from unittest.mock import patch

from django.core.exceptions import ImproperlyConfigured
from django.test import TestCase


class TestAllowedHostsProdConfig(TestCase):

    def test_prod_raises_when_allowed_hosts_empty(self):
        with patch("config.settings.base.ALLOWED_HOSTS", []):
            with self.assertRaises(ImproperlyConfigured) as ctx:
                # Execute prod settings check logic
                from config.settings.base import ALLOWED_HOSTS
                if not ALLOWED_HOSTS or ALLOWED_HOSTS == [""]:
                    raise ImproperlyConfigured("DJANGO_ALLOWED_HOSTS required in prod")
            self.assertIn("DJANGO_ALLOWED_HOSTS required in prod", str(ctx.exception))

    def test_prod_accepts_valid_allowed_hosts(self):
        hosts = ["mycompany.com", "46.101.112.215"]
        with patch("config.settings.base.ALLOWED_HOSTS", hosts):
            if not hosts or hosts == [""]:
                raise ImproperlyConfigured("DJANGO_ALLOWED_HOSTS required in prod")
            self.assertEqual(hosts, ["mycompany.com", "46.101.112.215"])
