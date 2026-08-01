import datetime as dt
from rest_framework import serializers, status
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from django.utils import timezone

from .models import DailyLesson
from .permissions import IsOwnerOrManager, _role
from apps.users.models import Role


class DailyLessonSerializer(serializers.ModelSerializer):
    class Meta:
        model = DailyLesson
        fields = "__all__"


class DailyLessonHistorySerializer(serializers.ModelSerializer):
    class Meta:
        model = DailyLesson
        fields = ("id", "lesson_date", "summary", "micro_lesson", "opened_at")


class TodayLessonApi(APIView):
    permission_classes = [IsAuthenticated, IsOwnerOrManager]

    def get(self, request):
        profile = getattr(request.user, "profile", None)
        if not profile or not profile.operator_id:
            return Response(
                {"error": "User is not linked to an operator"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        target_date = timezone.localdate() - dt.timedelta(days=1)

        lesson = DailyLesson.objects.filter(
            operator_id=profile.operator_id, lesson_date=target_date
        ).first()
        if not lesson:
            # Lazy-generate: if the nightly cron hasn't run for this operator
            # yet (or never), build the lesson on demand so the operator
            # doesn't stare at «no lesson today».
            from apps.lessons.selectors import collect_yesterday_facts
            from apps.lessons.ai.generator import generate_daily_lesson
            from apps.operators.models import Operator

            op = Operator.objects.filter(pk=profile.operator_id).first()
            if op is None:
                return Response(
                    {"detail": "No lesson for today"},
                    status=status.HTTP_404_NOT_FOUND,
                )
            facts = collect_yesterday_facts(op, target_date)
            sales_count = facts["sales"]["count"]
            dialogs_count = facts["dialogs"]["count"]
            if sales_count == 0 and dialogs_count == 0:
                return Response(
                    {"detail": "No activity yesterday"},
                    status=status.HTTP_404_NOT_FOUND,
                )
            try:
                tenure_days = 0
                if op.hired_at:
                    tenure_days = max(0, (target_date - op.hired_at).days)
                res = generate_daily_lesson(op.full_name, tenure_days, facts)
                stats_snapshot = {
                    "sales_count": sales_count,
                    "revenue_uzs": facts["sales"]["revenue"],
                    "avg_check": facts["sales"]["avg_check"],
                    "dialogs_count": dialogs_count,
                    "avg_quality": facts["dialogs"]["avg_quality_score"],
                    "callbacks_missed": facts["callbacks"]["missed"],
                    "leads_won": facts["leads"]["won"],
                    "leads_lost": facts["leads"]["lost"],
                    "month_progress_pct": facts["context"]["month_progress_pct"],
                    "delta_revenue": facts["sales"]["delta_revenue"],
                    "delta_count": facts["sales"]["delta_count"],
                }
                lesson = DailyLesson.objects.create(
                    operator=op,
                    lesson_date=target_date,
                    summary=res["summary"],
                    highlights=res["highlights"],
                    tips=res["tips"],
                    micro_lesson=res["micro_lesson"],
                    stats_snapshot=stats_snapshot,
                    model_version=res["model_used"],
                    prompt_version="v1",
                )
            except Exception:
                return Response(
                    {"detail": "No lesson for today"},
                    status=status.HTTP_404_NOT_FOUND,
                )

        self.check_object_permissions(request, lesson)

        peek = request.query_params.get("peek") == "1"
        if not peek and lesson.opened_at is None:
            lesson.opened_at = timezone.now()
            lesson.save(update_fields=["opened_at"])

        return Response(DailyLessonSerializer(lesson).data)


class HistoryLessonApi(APIView):
    permission_classes = [IsAuthenticated, IsOwnerOrManager]

    def get(self, request):
        role = _role(request.user)

        if role in (Role.TEAM_LEAD, Role.MANAGER):
            operator_id = request.query_params.get("operator")
            if not operator_id:
                return Response(
                    {"error": "operator parameter is required for managers/team leads"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        else:
            profile = getattr(request.user, "profile", None)
            if not profile or not profile.operator_id:
                return Response(
                    {"error": "User is not linked to an operator"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            operator_id = profile.operator_id

        limit = request.query_params.get("limit")
        try:
            limit = int(limit) if limit else 30
        except ValueError:
            limit = 30

        lessons = DailyLesson.objects.filter(operator_id=operator_id).order_by("-lesson_date")[
            :limit
        ]
        return Response(DailyLessonHistorySerializer(lessons, many=True).data)


class DetailLessonApi(APIView):
    """Retrieve any lesson for managers / team-leads or owns operator.

    GET /api/lessons/?operator=<id>&date=<YYYY-MM-DD>
    """

    permission_classes = [IsAuthenticated, IsOwnerOrManager]

    def get(self, request):
        role = _role(request.user)

        operator_id = request.query_params.get("operator")
        date_str = request.query_params.get("date")

        if not operator_id or not date_str:
            # If not filtering by operator/date, default list is not supported
            return Response(
                {"error": "operator and date parameters are required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            target_date = dt.datetime.strptime(date_str, "%Y-%m-%d").date()
        except ValueError:
            return Response(
                {"error": "Invalid date format, use YYYY-MM-DD"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if role not in (Role.TEAM_LEAD, Role.MANAGER):
            profile = getattr(request.user, "profile", None)
            if not profile or str(profile.operator_id) != str(operator_id):
                return Response({"error": "Permission denied"}, status=status.HTTP_403_FORBIDDEN)

        lesson = DailyLesson.objects.filter(
            operator_id=operator_id, lesson_date=target_date
        ).first()
        if not lesson:
            return Response({"detail": "Lesson not found"}, status=status.HTTP_404_NOT_FOUND)

        return Response(DailyLessonSerializer(lesson).data)
