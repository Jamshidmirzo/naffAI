"""
sale_create must auto-link a Sale to an existing Lead by phone when the
caller didn't pass an explicit `lead_id`. This closes the ~98% gap on
prod where manually-created sales left leads stuck in non-terminal
statuses (broken "operator conversion" metric).
"""

from decimal import Decimal

import pytest

from apps.catalog.models import Channel
from apps.leads.models import Lead, LeadStatus, LeadStatusLabel
from apps.operators.models import Operator
from apps.sales.services import sale_create


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Op Auto", status="active")


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Telegram")


@pytest.fixture
def terminal_labels(db):
    """
    _find_lead_by_client_phone consults `terminal_lead_status_codes()` which
    reads from LeadStatusLabel. Seed the three terminal codes we exercise
    so the tests don't depend on data migrations firing in the test DB.
    """
    for code, label in (
        ("won", "Продажа"),
        ("lost", "Потерян"),
        ("archived", "Архив"),
    ):
        LeadStatusLabel.objects.update_or_create(
            code=code,
            defaults={
                "label_ru": label,
                "label_uz": label,
                "tone": "neutral",
                "is_active": True,
                "is_terminal": True,
                "is_builtin": True,
            },
        )


@pytest.mark.django_db
def test_auto_match_flips_lead_to_won(operator, channel, terminal_labels):
    lead = Lead.objects.create(
        full_name="Клиент 1",
        phone="+998901234567",
        status=LeadStatus.NEW,
    )
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("3500000"),
        client_phone="+998901234567",
    )
    lead.refresh_from_db()
    assert sale.lead_id == lead.id
    assert lead.status == LeadStatus.WON


@pytest.mark.django_db
def test_auto_match_no_lead_creates_unlinked(operator, channel, terminal_labels):
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("3500000"),
        client_phone="+998907777777",
    )
    assert sale.lead_id is None
    assert Lead.objects.count() == 0


@pytest.mark.django_db
@pytest.mark.parametrize("terminal_status", [LeadStatus.WON, LeadStatus.LOST, LeadStatus.ARCHIVED])
def test_auto_match_terminal_lead_links_but_does_not_flip(
    operator, channel, terminal_labels, terminal_status
):
    """
    Non-terminal leads are preferred; a lead already in a terminal status
    is still linked (best-effort), but `_link_sale_to_lead_and_mark_won`
    must NOT overwrite its status.
    """
    lead = Lead.objects.create(
        full_name="Клиент 2",
        phone="+998901111111",
        status=terminal_status,
    )
    sale = sale_create(
        imei="356938035643809",
        phone_model="iPhone 14",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("4200000"),
        client_phone="+998901111111",
    )
    lead.refresh_from_db()
    assert sale.lead_id == lead.id
    # Terminal status preserved — auto-match never demotes/promotes a
    # closed lead.
    assert lead.status == terminal_status


@pytest.mark.django_db
def test_explicit_lead_id_beats_auto_match(operator, channel, terminal_labels):
    """
    If the caller passes an explicit `lead_id`, we use it verbatim even
    if a different lead would auto-match by phone.
    """
    explicit_lead = Lead.objects.create(
        full_name="Explicit lead",
        phone="+998900000000",  # different phone
        status=LeadStatus.NEW,
    )
    phone_match = Lead.objects.create(
        full_name="Phone match lead",
        phone="+998902222222",
        status=LeadStatus.NEW,
    )
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("3500000"),
        client_phone="+998902222222",
        lead_id=explicit_lead.id,
    )
    explicit_lead.refresh_from_db()
    phone_match.refresh_from_db()
    # Explicit wins.
    assert sale.lead_id == explicit_lead.id
    assert explicit_lead.status == LeadStatus.WON
    # Phone-match lead untouched.
    assert phone_match.status == LeadStatus.NEW


@pytest.mark.django_db
@pytest.mark.parametrize(
    "raw_phone",
    [
        "+998 90 123 45 67",
        "998901234567",
        "+998901234567",
        "90 123-45-67",  # last-9-digits fallback in normalize_uz_phone
        "  +998-90-123-45-67  ",
    ],
)
def test_auto_match_normalises_phone_variants(
    operator, channel, terminal_labels, raw_phone
):
    lead = Lead.objects.create(
        full_name="Клиент Phone",
        phone="+998901234567",
        status=LeadStatus.NEW,
    )
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("3500000"),
        client_phone=raw_phone,
    )
    lead.refresh_from_db()
    assert sale.lead_id == lead.id, f"phone variant {raw_phone!r} did not match"
    assert lead.status == LeadStatus.WON


@pytest.mark.django_db
def test_auto_match_prefers_active_over_terminal(operator, channel, terminal_labels):
    """
    Two leads share a phone (dupe from historical sheet imports). Priority
    goes to the still-workable lead — flipping it to WON is the useful
    action.
    """
    Lead.objects.create(
        full_name="Old lost",
        phone="+998903333333",
        status=LeadStatus.LOST,
    )
    active = Lead.objects.create(
        full_name="New active",
        phone="+998903333333",
        status=LeadStatus.NEW,
    )
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("3500000"),
        client_phone="+998903333333",
    )
    active.refresh_from_db()
    assert sale.lead_id == active.id
    assert active.status == LeadStatus.WON


@pytest.mark.django_db
def test_auto_match_skipped_when_client_phone_empty(operator, channel, terminal_labels):
    Lead.objects.create(
        full_name="Клиент",
        phone="+998901234567",
        status=LeadStatus.NEW,
    )
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("3500000"),
        client_phone="",
    )
    assert sale.lead_id is None
