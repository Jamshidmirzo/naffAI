"""
`refill_operator_leads` защищён pg_advisory_xact_lock: два конкурентных
refill'а для одного оператора сериализуются, не выдают лишних лидов
поверх лимита пула.

Без advisory lock watcher-минутка и on_commit-хук после закрытия могли
запуститься одновременно, каждый посчитать «нужно 5» и оба выдать по 5
→ у оператора внезапно 10 новых лидов.
"""

from __future__ import annotations

import threading

import pytest
from django.conf import settings as dj_settings
from django.db import connection

from apps.leads.models import Lead, LeadStatus
from apps.leads.services import refill_operator_leads
from apps.operators.models import Operator, OperatorStatus

_IS_POSTGRES = dj_settings.DATABASES["default"]["ENGINE"].endswith("postgresql")

pytestmark = pytest.mark.skipif(
    not _IS_POSTGRES,
    reason="pg_advisory_xact_lock — только postgres; на SQLite тест не имеет смысла",
)


@pytest.mark.django_db(transaction=True)
def test_two_concurrent_refills_do_not_over_assign():
    """Два потока пытаются налить одному оператору по 5, но в пуле — 3.

    С advisory lock второй поток дождётся первого, увидит пустой пул и
    вернёт []. Суммарно оператор получит все 3 лида, никаких дублей."""

    if connection.vendor != "postgresql":
        pytest.skip("advisory lock — только postgres")

    op = Operator.objects.create(full_name="Concurrent op", status=OperatorStatus.ACTIVE)
    for i in range(3):
        Lead.objects.create(
            full_name=f"L-{i}",
            phone=f"+9989{i:08d}",
            status=LeadStatus.NEW,
            operator=None,
        )

    results: list[list[Lead]] = []
    errors: list[BaseException] = []

    def worker():
        try:
            # Каждый поток открывает свою транзакцию (refill_operator_leads
            # уже @transaction.atomic).
            leads = refill_operator_leads(operator=op, size=5)
            results.append(leads)
        except BaseException as exc:  # pragma: no cover
            errors.append(exc)
        finally:
            connection.close()

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, errors
    total_assigned = sum(len(r) for r in results)
    # Ровно 3 (весь пул), не 6 и не больше.
    assert total_assigned == 3
    assert Lead.objects.filter(operator=op).count() == 3
    assert Lead.objects.filter(operator__isnull=True).count() == 0
