from django.urls import path

from .apis import (
    TgBackfillJobsApi,
    TgChatsApi,
    TgInsightsApi,
    TgMessagesApi,
    TgCoachingApi,
    TgQueueApi,
    TgRetryBackfillApi,
    TgRevokeApi,
    TgSessionStartApi,
    TgStatusApi,
    TgVerifyCodeApi,
    TgVerifyPasswordApi,
)

urlpatterns = [
    # Auth flow
    path("start/", TgSessionStartApi.as_view(), name="tg_userclient_start"),
    path("verify-code/", TgVerifyCodeApi.as_view(), name="tg_userclient_verify_code"),
    path("verify-password/", TgVerifyPasswordApi.as_view(), name="tg_userclient_verify_password"),
    path("revoke/", TgRevokeApi.as_view(), name="tg_userclient_revoke"),
    path("status/", TgStatusApi.as_view(), name="tg_userclient_status"),
    # Manager read-only
    path("chats/", TgChatsApi.as_view(), name="tg_userclient_chats"),
    path("messages/", TgMessagesApi.as_view(), name="tg_userclient_messages"),
    path("insights/", TgInsightsApi.as_view(), name="tg_userclient_insights"),
    path("backfill-jobs/", TgBackfillJobsApi.as_view(), name="tg_userclient_backfill_jobs"),
    path("backfill-jobs/retry/", TgRetryBackfillApi.as_view(), name="tg_userclient_backfill_jobs_retry"),
    path("queue/", TgQueueApi.as_view(), name="tg_userclient_queue"),
    path("coaching/", TgCoachingApi.as_view(), name="tg_userclient_coaching"),
]
