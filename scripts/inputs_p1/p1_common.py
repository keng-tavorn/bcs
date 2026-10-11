# -*- coding: utf-8 -*-
"""Shared helpers of the phase-1 synthetic workbook generator (scripts/inputs_p1/make.py · ADR-065).

Everything here is deterministic: the same code always produces the same workbook bytes.
"""
import random
from decimal import Decimal, ROUND_HALF_UP

VAT_BP = 700  # Settings.vatRate of the workbook (OQ-29 default); history and samples use it


def rng(name):
    """A random generator seeded by name, so editing one sheet does not reshuffle another."""
    return random.Random(f'bcs-p1-{name}-v1')


def taxid(prefix12):
    """13-digit Thai tax ID from 12 digits plus the mod-11 check digit (BR-TAXID-01)."""
    assert len(prefix12) == 12 and prefix12.isdigit(), prefix12
    check = (11 - sum(int(prefix12[i]) * (13 - i) for i in range(12)) % 11) % 10
    return prefix12 + str(check)


def sat(x):
    """Baht (int, str, float or Decimal) to satang, half-up (BR-MONEY-02)."""
    return int((Decimal(str(x)) * 100).to_integral_value(rounding=ROUND_HALF_UP))


def rhu(n, d):
    """Integer division rounded half-up, for non-negative n."""
    return (2 * n + d) // (2 * d)


def vat_of(net_satang, rate_bp=VAT_BP):
    return rhu(net_satang * rate_bp, 10000)


def baht(satang):
    """Satang to a number for the sheet: int when whole baht, else float with 2 places."""
    return satang // 100 if satang % 100 == 0 else round(satang / 100, 2)


def guaranteed_business_hours(days):
    """Business hours that surely lie between 08:30 of (today - days) and now, whatever today is.

    Conservative: two weekend days per started week, three more holidays in the window (Songkran,
    New Year) and one lost day at each end. The seed replays every decided row at
    (now - daysAgo) + the business hours of the row, so a row is safe when its hours fit in here.
    """
    if days <= 0:
        return 0
    weekends = 2 * ((days + 6) // 7)
    return max(0, 9 * (days - weekends - 3) - 9)
