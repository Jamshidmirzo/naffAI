from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .apis import (
    BotAuditListApi,
    BotBlocksApi,
    BotChatDetailApi,
    BotChatListApi,
    BotReportPreviewAsApi,
    BotReportViewSet,
    BotSubscriberDetailApi,
    BotSubscriberListApi,
    BotTemplateListApi,
)

router = DefaultRouter()
router.register(r"reports", BotReportViewSet, basename="bot-reports")

urlpatterns = [
    path("chats/", BotChatListApi.as_view()),
    path("chats/<int:pk>/", BotChatDetailApi.as_view()),
    path("blocks/", BotBlocksApi.as_view()),
    path("templates/", BotTemplateListApi.as_view()),
    path("subscribers/", BotSubscriberListApi.as_view()),
    path("subscribers/<int:pk>/", BotSubscriberDetailApi.as_view()),
    path("reports/preview_as/", BotReportPreviewAsApi.as_view()),
    path("audit/", BotAuditListApi.as_view()),
    path("", include(router.urls)),
]
