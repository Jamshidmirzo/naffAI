import pytest
from django.utils import timezone
from apps.operators.models import Operator
from apps.leads.models import Lead, LeadStatus
from apps.tg_userclient.models import TgChat, TgChatKind, TgSession, TgSessionStatus
from apps.tg_userclient.services import tg_message_ingest


@pytest.mark.django_db
def test_tg_chat_lead_match_by_name_exact_case_insensitive():
    op = Operator.objects.create(full_name="Op1", phone="+998900000001")
    session = TgSession.objects.create(operator=op, phone="+998900000001", status=TgSessionStatus.ACTIVE)
    lead = Lead.objects.create(full_name="Jasur Karim", phone="+998901234567", status=LeadStatus.NEW)

    msg = tg_message_ingest(
        session_id=session.id,
        tg_chat_id=1001,
        chat_kind=TgChatKind.PRIVATE,
        chat_title="Jasur",
        partner_name="jasur karim",
        partner_phone="",
        tg_message_id=1,
        direction="in",
        message_kind="text",
        text="Hello",
        voice_duration_sec=None,
        sent_at=timezone.now(),
    )

    assert msg is not None
    chat = TgChat.objects.get(session=session, tg_chat_id=1001)
    assert chat.lead_id == lead.id


@pytest.mark.django_db
def test_tg_chat_lead_match_by_name_ignores_archived_lead():
    op = Operator.objects.create(full_name="Op2", phone="+998900000002")
    session = TgSession.objects.create(operator=op, phone="+998900000002", status=TgSessionStatus.ACTIVE)
    Lead.objects.create(full_name="Old Lead", phone="+998901234568", status=LeadStatus.ARCHIVED)

    msg = tg_message_ingest(
        session_id=session.id,
        tg_chat_id=1002,
        chat_kind=TgChatKind.PRIVATE,
        chat_title="Old Lead",
        partner_name="Old Lead",
        partner_phone="",
        tg_message_id=1,
        direction="in",
        message_kind="text",
        text="Hello",
        voice_duration_sec=None,
        sent_at=timezone.now(),
    )

    assert msg is not None
    chat = TgChat.objects.get(session=session, tg_chat_id=1002)
    assert chat.lead_id is None
