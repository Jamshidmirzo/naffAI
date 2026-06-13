from decimal import Decimal

from apps.payroll.models import PayoutType, PayrollRule
from apps.payroll.services import compute_payout


def _rule(payout_type, value=Decimal("0"), tiers=None, threshold=Decimal("50000000")):
    return PayrollRule(
        scope="global",
        threshold=threshold,
        payout_type=payout_type,
        payout_value=value,
        tiers=tiers or [],
        is_active=True,
    )


def test_below_threshold_is_zero():
    rule = _rule(PayoutType.PERCENT, Decimal("3"))
    assert compute_payout(Decimal("30000000"), rule) == Decimal("0.00")


def test_fixed_above_threshold():
    rule = _rule(PayoutType.FIXED, Decimal("1500000"))
    assert compute_payout(Decimal("55000000"), rule) == Decimal("1500000.00")


def test_percent_above_threshold():
    rule = _rule(PayoutType.PERCENT, Decimal("3"))
    # 3% of (60M - 50M) = 300_000
    assert compute_payout(Decimal("60000000"), rule) == Decimal("300000.00")


def test_tiers_progressive():
    rule = _rule(
        PayoutType.TIERS,
        tiers=[
            {"from": 50_000_000, "rate_percent": 3},
            {"from": 80_000_000, "rate_percent": 5},
            {"from": 120_000_000, "rate_percent": 7},
        ],
    )
    # 90M: 30M @ 3% + 10M @ 5% = 900k + 500k = 1_400_000
    assert compute_payout(Decimal("90000000"), rule) == Decimal("1400000.00")
