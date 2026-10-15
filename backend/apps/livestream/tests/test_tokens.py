from __future__ import annotations

import json

import pytest

from apps.livestream.jwt import b64url_decode
from apps.livestream.services import LivestreamDisabledError, room_token_issue
from apps.operators.models import OperatorStatus

from .conftest import API_KEY, ROOM


def _claims(token: str) -> dict:
    return json.loads(b64url_decode(token.split(".")[1]))


@pytest.mark.django_db
def test_operator_token_publishes_camera_only(operator_user, operator):
    result = room_token_issue(user=operator_user, operator=operator, role="operator")
    claims = _claims(result.token)
    assert result.participant_identity == f"op:{operator.id}"
    assert result.room_name == ROOM
    assert claims["iss"] == API_KEY
    assert claims["video"]["room"] == ROOM
    assert claims["video"]["canPublish"] is True
    assert claims["video"]["canSubscribe"] is False
    assert claims["video"]["canPublishSources"] == ["camera"]
    assert "roomAdmin" not in claims["video"]


@pytest.mark.django_db
def test_manager_token_is_subscribe_only(make_manager):
    mgr = make_manager("m1")
    claims = _claims(room_token_issue(user=mgr, operator=None, role="manager").token)
    assert claims["video"]["canSubscribe"] is True
    assert claims["video"]["canPublish"] is False
    assert "roomAdmin" not in claims["video"]
    assert "roomRecord" not in claims["video"]


@pytest.mark.django_db
@pytest.mark.parametrize(
    "change",
    [
        {"livestream_enabled": False},
        {"is_paused": True},
        {"status": OperatorStatus.INACTIVE},
    ],
)
def test_operator_token_refused(operator_user, operator, change):
    for k, v in change.items():
        setattr(operator, k, v)
    operator.save()
    with pytest.raises(LivestreamDisabledError):
        room_token_issue(user=operator_user, operator=operator, role="operator")
