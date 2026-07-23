from __future__ import annotations

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .selectors import should_show_greeting
from .services import DEFAULT_LANGUAGE, get_or_create_daily_quote, mark_greeting_shown


def _operator_for(request):
    profile = getattr(request.user, "profile", None)
    return getattr(profile, "operator", None) if profile else None


class MorningGreetingApi(APIView):
    """Return today's quote plus a "should_show" hint for the operator."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        language = request.query_params.get("language") or DEFAULT_LANGUAGE
        quote = get_or_create_daily_quote(language=language)

        operator = _operator_for(request)
        show = should_show_greeting(operator=operator) if operator else True

        return Response({
            "quote": quote.text,
            "author": quote.author,
            "language": quote.language,
            "should_show": bool(show),
            "generated_by_model": quote.generated_by_model,
            "provider_used": quote.provider_used,
        })


class MorningGreetingDismissApi(APIView):
    """Mark today's quote as shown for the requesting operator."""

    permission_classes = [IsAuthenticated]

    def post(self, request):
        operator = _operator_for(request)
        if operator is None:
            # Non-operators (team_lead / manager) don't have receipts; be
            # tolerant and return 200 so the UI can just move on.
            return Response({"marked": False})
        mark_greeting_shown(operator=operator)
        return Response({"marked": True})
