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
            return Response({"detail": "No lesson for today"}, status=status.HTTP_404_NOT_FOUND)

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
