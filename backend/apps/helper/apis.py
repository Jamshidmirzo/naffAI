"""
Thin views — единственный endpoint /operator-suggestions/, GET-only.

Redis cache 30s: помощник дёргается react-query'ем каждые 60s пока
панель открыта; кэш срезает нагрузку в 2× при одновременном использовании
2+ оператора одной и той же вкладкой (маловероятно, но бесплатно).
"""

from __future__ import annotations

from django.core.cache import cache
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.operators.selectors import operator_get

from .faq import FAQ
from .services import build_operator_suggestions, suggestions_to_payload


CACHE_TTL_SECONDS = 30


def _faq_payload() -> list[dict]:
    # Возвращаем прямо FAQ — он уже list[dict] с ru+uz. Копия не нужна:
    # JSON-сериализация не мутирует данные.
    return FAQ


class OperatorHelperApi(APIView):
    """
    GET /api/helper/operator-suggestions/
      → {suggestions: [...], faq: [...]}

    Оператор — свои подсказки. Менеджер/team_lead без operator_id →
    подсказок нет (helper предназначен операторам), но FAQ отдаётся —
    менеджер может им пользоваться если хочет заглянуть в справку.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        profile = getattr(request.user, "profile", None)
        op_id = getattr(profile, "operator_id", None) if profile else None
        if not op_id:
            return Response({"suggestions": [], "faq": _faq_payload()})

        cache_key = f"helper:suggestions:{op_id}"
        cached = cache.get(cache_key)
        if cached is None:
            operator = operator_get(op_id)
            if operator is None:
                return Response({"suggestions": [], "faq": _faq_payload()})
            suggestions = build_operator_suggestions(operator)
            cached = suggestions_to_payload(suggestions)
            cache.set(cache_key, cached, CACHE_TTL_SECONDS)

        return Response({"suggestions": cached, "faq": _faq_payload()})
