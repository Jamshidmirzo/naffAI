from __future__ import annotations

import datetime as dt

from django.utils import timezone

from apps.operators.models import Operator

from .models import DailyGreetingShown, DailyQuote


def daily_quote_for(*, date: dt.date, language: str) -> DailyQuote | None:
    return DailyQuote.objects.filter(quote_date=date, language=language).first()


def should_show_greeting(*, operator: Operator, today: dt.date | None = None) -> bool:
    today = today or timezone.localdate()
    return not DailyGreetingShown.objects.filter(operator=operator, date=today).exists()
