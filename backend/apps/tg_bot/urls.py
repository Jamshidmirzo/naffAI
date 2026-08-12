from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .apis import (
    BotAuditListApi,
    BotBlocksApi,
    BotChatDetailApi,
    BotChatListApi,
    BotReportViewSet,
)

router = DefaultRouter()
router.register(r"reports", BotReportViewSet, basename="bot-reports")

urlpatterns = [
    path("chats/", BotChatListApi.as_view()),
    path("chats/<int:pk>/", BotChatDetailApi.as_view()),
    path("blocks/", BotBlocksApi.as_view()),
    path("audit/", BotAuditListApi.as_view()),
    path("", include(router.urls)),
]
