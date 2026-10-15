"""
Public lead intake: `POST /api/integrations/leads/<token>/`.

The token in the path is the only auth (that is how LeadPixel «Своя CRM»,
Make, Zapier etc. call a webhook). Unknown / inactive token → 404 so the
endpoint does not reveal which tokens exist. GET / HEAD on the same URL
answer 200 — many tools «test» a webhook URL before saving it.

Body: JSON object / array, `application/x-www-form-urlencoded` or
multipart form. Parsed flexibly (`parse.py`), every request is journaled
in `InboundLeadEvent`.
"""

from __future__ import annotations

import ipaddress
import json
import logging
from urllib.parse import parse_qsl

from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from apps.leads.models import InboundLeadEventOutcome
from apps.leads.selectors import webhook_source_by_token

from .services import inbound_journal, inbound_leads_process

logger = logging.getLogger("leads.webhook")

MAX_BODY_BYTES = 256 * 1024


class LeadWebhookThrottle(AnonRateThrottle):
    scope = "lead_webhook"


class _BodyError(Exception):
    pass


def _client_ip(request) -> str | None:
    xff = request.META.get("HTTP_X_FORWARDED_FOR") or ""
    ip = xff.split(",")[0].strip() if xff else (request.META.get("REMOTE_ADDR") or "")
    try:
        return str(ipaddress.ip_address(ip))
    except ValueError:
        return None


def _decode_body(request, raw: bytes):
    """JSON (object/array) or form → python data. Raises _BodyError."""
    ctype = (request.META.get("CONTENT_TYPE") or "").lower()
    if "multipart/form-data" in ctype:
        return request._request.POST.dict()
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        raise _BodyError("empty body")
    if "x-www-form-urlencoded" in ctype:
        return dict(parse_qsl(text, keep_blank_values=True))
    try:
        return json.loads(text)
    except ValueError:
        if "json" in ctype:
            raise _BodyError("invalid JSON") from None
    # Без content-type / text/plain: пробуем как форму.
    if "=" in text:
        pairs = parse_qsl(text, keep_blank_values=True)
        if pairs:
            return dict(pairs)
    raise _BodyError("unsupported body: send JSON or form data")


class LeadWebhookApi(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [LeadWebhookThrottle]
    # Тело разбираем сами (гибкий формат, лимит размера) — DRF-парсеры не нужны.
    parser_classes = []

    def get(self, request, token: str):
        source = webhook_source_by_token(token)
        if source is None:
            return Response({"ok": False, "error": "not found"}, status=404)
        return Response({"ok": True, "source": source.name})

    def post(self, request, token: str):
        source = webhook_source_by_token(token)
        if source is None:
            return Response({"ok": False, "error": "not found"}, status=404)

        try:
            declared = int(request.META.get("CONTENT_LENGTH") or 0)
        except ValueError:
            declared = 0
        if declared > MAX_BODY_BYTES:
            return Response({"ok": False, "error": "payload too large"}, status=413)
        raw = request.body
        if len(raw) > MAX_BODY_BYTES:
            return Response({"ok": False, "error": "payload too large"}, status=413)

        remote_ip = _client_ip(request)
        try:
            body = _decode_body(request, raw)
        except _BodyError as exc:
            inbound_journal(
                source=source,
                payload={"_raw": raw[:16 * 1024].decode("utf-8", errors="replace")},
                outcome=InboundLeadEventOutcome.INVALID,
                error=str(exc),
                remote_ip=remote_ip,
            )
            return Response({"ok": False, "error": str(exc)}, status=400)

        results, is_batch = inbound_leads_process(source=source, body=body, remote_ip=remote_ip)
        logger.info(
            "webhook source=%s ip=%s results=%s",
            source.id,
            remote_ip,
            [r.outcome for r in results],
        )

        if any(r.outcome == InboundLeadEventOutcome.ERROR for r in results):
            http_status = 500  # sender retries; done items come back as duplicate
        elif all(r.outcome == InboundLeadEventOutcome.INVALID for r in results):
            http_status = 400
        else:
            http_status = 200

        if is_batch:
            return Response(
                {"ok": http_status == 200, "results": [r.as_dict() for r in results]},
                status=http_status,
            )
        r = results[0]
        if not r.ok:
            return Response({"ok": False, "error": r.error}, status=http_status)
        return Response({"ok": True, "lead_id": r.lead_id, "result": r.outcome}, status=http_status)
