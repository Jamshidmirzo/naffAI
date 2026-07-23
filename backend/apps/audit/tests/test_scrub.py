"""
The audit-log sanitizer redacts sensitive values before they hit AuditLog.changes.
Keys matching (password|secret|session|token|api_key|access_key) — case-insensitive —
have their value replaced with "<redacted>". Structure is preserved.
"""

from __future__ import annotations

import pytest

from apps.audit.models import AuditLog
from apps.audit.services import _scrub_for_tests as _scrub
from apps.audit.services import audit_log_create


def test_scrub_redacts_top_level_password_session_token() -> None:
    scrubbed = _scrub(
        {
            "password": "hunter2",
            "session_string": "1apzZ...",
            "api_key": "sk-abc",
            "access_key": "AKIA...",
            "some_token": "eyJhb...",
            "operator_id": 42,
        }
    )
    assert scrubbed["password"] == "<redacted>"
    assert scrubbed["session_string"] == "<redacted>"
    assert scrubbed["api_key"] == "<redacted>"
    assert scrubbed["access_key"] == "<redacted>"
    assert scrubbed["some_token"] == "<redacted>"
    # Non-sensitive keys pass through untouched.
    assert scrubbed["operator_id"] == 42


def test_scrub_walks_nested_structures() -> None:
    scrubbed = _scrub(
        {
            "outer": {
                "password": "hunter2",
                "nested_list": [
                    {"secret": "s1", "public": 1},
                    {"public_only": 2},
                ],
            },
            "list": [
                {"session": "abc"},
                "plain-string",
                123,
            ],
        }
    )
    assert scrubbed["outer"]["password"] == "<redacted>"
    assert scrubbed["outer"]["nested_list"][0]["secret"] == "<redacted>"
    assert scrubbed["outer"]["nested_list"][0]["public"] == 1
    assert scrubbed["outer"]["nested_list"][1]["public_only"] == 2
    assert scrubbed["list"][0]["session"] == "<redacted>"
    assert scrubbed["list"][1] == "plain-string"
    assert scrubbed["list"][2] == 123


def test_scrub_is_case_insensitive() -> None:
    scrubbed = _scrub({"Password": "x", "SESSION_STRING": "y", "Api_Key": "z"})
    assert scrubbed["Password"] == "<redacted>"
    assert scrubbed["SESSION_STRING"] == "<redacted>"
    assert scrubbed["Api_Key"] == "<redacted>"


def test_scrub_leaves_scalars_and_empty_alone() -> None:
    assert _scrub(None) is None
    assert _scrub(42) == 42
    assert _scrub("plain") == "plain"
    assert _scrub({}) == {}
    assert _scrub([]) == []


@pytest.mark.django_db
def test_audit_log_create_writes_redacted_changes() -> None:
    entry = audit_log_create(
        user=None,
        action="update",
        entity="test.Entity",
        entity_id=1,
        changes={
            "password": "plaintext-would-be-a-disaster",
            "operator_id": 7,
            "meta": {"session_string": "hidden"},
        },
    )
    entry.refresh_from_db()
    assert entry.changes["password"] == "<redacted>"
    assert entry.changes["operator_id"] == 7
    assert entry.changes["meta"]["session_string"] == "<redacted>"

    # Row is actually persisted with the redacted body.
    persisted = AuditLog.objects.get(pk=entry.pk)
    assert persisted.changes["password"] == "<redacted>"
