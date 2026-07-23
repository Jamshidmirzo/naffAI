"""
Extended healthcheck endpoint checking DB, Sheets sync, TG session ratio, AI insights, and bot DM status.
"""

from __future__ import annotations

from django.db import connection
from django.utils import timezone
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.leads.models import SheetSource
from apps.operators.models import Operator
from apps.tg_bot.models import BotSubscription
from apps.tg_userclient.models import TgAiInsight, TgSession


class HealthCheckView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        checks = {}
        overall = "ok"

        # 1. DB connection check
        try:
            connection.ensure_connection()
            checks["db"] = {"status": "ok"}
        except Exception as e:
            checks["db"] = {"status": "error", "detail": str(e)}
            overall = "error"

        # 2. Google Sheets sync freshness
        try:
            latest = (
                SheetSource.objects.filter(active=True)
                .order_by("-last_synced_at")
                .first()
            )
            if latest and latest.last_synced_at:
                age_min = (
                    timezone.now() - latest.last_synced_at
                ).total_seconds() / 60.0
                checks["sheets_sync"] = {
                    "status": "warning" if age_min > 5 else "ok",
                    "age_min": round(age_min, 1),
                }
                if age_min > 5 and overall == "ok":
                    overall = "warning"
        except Exception as e:
            checks["sheets_sync"] = {"status": "warning", "detail": str(e)}

        # 3. TG sessions active ratio
        try:
            total_ops = Operator.objects.filter(status="active").count()
            active_sess = TgSession.objects.filter(status="active").count()
            ratio = active_sess / total_ops if total_ops else 1.0
            checks["tg_sessions"] = {
                "status": "warning" if ratio < 0.5 else "ok",
                "active": active_sess,
                "total": total_ops,
            }
            if ratio < 0.5 and overall == "ok":
                overall = "warning"
        except Exception as e:
            checks["tg_sessions"] = {"status": "warning", "detail": str(e)}

        # 4. AI insights freshness
        try:
            latest_ai = TgAiInsight.objects.order_by("-created_at").first()
            if latest_ai and latest_ai.created_at:
                age_h = (
                    timezone.now() - latest_ai.created_at
                ).total_seconds() / 3600.0
                checks["ai_insights"] = {
                    "status": "warning" if age_h > 2 else "ok",
                    "age_h": round(age_h, 1),
                }
                if age_h > 2 and overall == "ok":
                    overall = "warning"
        except Exception as e:
            checks["ai_insights"] = {"status": "warning", "detail": str(e)}

        # 5. DM-blocked count
        try:
            blocked = BotSubscription.objects.filter(
                blocked_at__isnull=False
            ).count()
            checks["tg_bot_blocked_dms"] = {
                "status": "ok" if blocked < 3 else "warning",
                "count": blocked,
            }
        except Exception:
            pass

        http_status = 200 if overall != "error" else 503
        return Response({"status": overall, "checks": checks}, status=http_status)
