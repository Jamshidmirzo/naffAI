"""Alert engine tests: dedup, threshold enforcement, orchestrator."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.catalog.models import Channel
from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator
from apps.rop_agent import alerts as alerts_mod
from apps.rop_agent.models import AlertLog
from apps.sales.models import Sale, SaleStatus


def _make_lead(*, created_at=None, **fields):
    """Lead.created_at is auto_now_add — bypass via post-save update."""
    l = Lead.objects.create(**fields)
    if created_at is not None:
        Lead.objects.filter(pk=l.pk).update(created_at=created_at)
        l.refresh_from_db(fields=["created_at"])
    return l


@pytest.mark.django_db
def test_run_all_alerts_on_empty_db_no_exceptions():
    out = alerts_mod.run_all_alerts(persist=False)
    assert isinstance(out, list)


@pytest.mark.django_db
def test_qimmatli_long_wait_fires_and_dedups():
    now = timezone.now()
    _make_lead(
        status=LeadStatus.NEW,
        hot_until=now + timedelta(hours=1),
        created_at=now - timedelta(hours=3),
        full_name="Qimmatli A",
    )
    out = alerts_mod.check_qimmatli_long_wait()
    assert len(out) == 1
    assert out[0]["priority"] == "red"
    assert out[0]["alert_type"] == "qimmatli_long_wait"

    # Persist via orchestrator then re-run → should be deduped.
    first = alerts_mod.run_all_alerts()
    second = alerts_mod.run_all_alerts()
    first_types = {a["alert_type"] for a in first}
    second_types = {a["alert_type"] for a in second}
    assert "qimmatli_long_wait" in first_types
    assert "qimmatli_long_wait" not in second_types


@pytest.mark.django_db
def test_big_sale_celebrate_threshold():
    op = Operator.objects.create(full_name="Op Big", status="active")
    ch = Channel.objects.create(name="Telegram")
    now = timezone.now()
    # Below threshold
    Sale.objects.create(
        imei="111111111111111",
        phone_model="Xiaomi",
        operator=op,
        channel=ch,
        amount=Decimal("10000000"),
        sold_at=now,
        status=SaleStatus.CONFIRMED,
    )
    assert alerts_mod.check_big_sale_celebrate() == []
    # Above threshold
    Sale.objects.create(
        imei="222222222222222",
        phone_model="iPhone",
        operator=op,
        channel=ch,
        amount=Decimal("20000000"),
        sold_at=now,
        status=SaleStatus.CONFIRMED,
    )
    out = alerts_mod.check_big_sale_celebrate()
    assert len(out) == 1
    assert out[0]["priority"] == "info"


@pytest.mark.django_db
def test_dedup_window_persistence():
    now = timezone.now()
    # Pre-seed an AlertLog that would dedup a new qimmatli_long_wait for lead_id=42
    AlertLog.objects.create(
        alert_type="qimmatli_long_wait",
        priority="red",
        dedup_key="lead:42",
        payload={},
        message_text="prev",
    )
    # Build a lead that would otherwise fire
    _make_lead(
        id=42,
        status=LeadStatus.NEW,
        hot_until=now + timedelta(hours=1),
        created_at=now - timedelta(hours=3),
    )
    out = alerts_mod.run_all_alerts()
    types = [a["alert_type"] for a in out]
    assert "qimmatli_long_wait" not in types
