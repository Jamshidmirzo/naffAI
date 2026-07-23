"""
Read-only selectors for TG userclient data (HackSoft pattern).
"""

from __future__ import annotations

from django.db.models import QuerySet

from .models import TgAiInsight, TgBackfillJob, TgChat, TgMessage, TgSession


def tg_session_for_operator(operator_id: int) -> TgSession | None:
    return TgSession.objects.filter(operator_id=operator_id).first()


def tg_session_by_id(session_id: int) -> TgSession | None:
    return TgSession.objects.select_related("operator").filter(id=session_id).first()


def tg_chats_for_operator(operator_id: int) -> QuerySet[TgChat]:
    return (
        TgChat.objects.filter(session__operator_id=operator_id)
        .select_related("lead")
        .order_by("-last_message_at")
    )


def tg_messages_for_chat(chat_id: int, limit: int = 50) -> QuerySet[TgMessage]:
    return (
        TgMessage.objects.filter(chat_id=chat_id)
        .order_by("-sent_at")[:limit]
    )


def tg_insights_for_operator(operator_id: int) -> QuerySet[TgAiInsight]:
    return (
        TgAiInsight.objects.filter(session__operator_id=operator_id)
        .order_by("-until")
    )


def tg_insights_for_chat(chat_id: int) -> QuerySet[TgAiInsight]:
    return (
        TgAiInsight.objects.filter(chat_id=chat_id)
        .order_by("-until")
    )


def tg_backfill_jobs_for_operator(operator_id: int) -> QuerySet[TgBackfillJob]:
    return (
        TgBackfillJob.objects.filter(session__operator_id=operator_id)
        .order_by("-id")[:10]
    )


def tg_session_status_dict(operator_id: int) -> dict:
    """Return a serializable dict with session status info."""
    session = tg_session_for_operator(operator_id)
    if not session:
        return {"operator_id": operator_id, "status": None, "latest_backfill_job": None}

    latest_job = session.backfill_jobs.order_by("-id").first()
    job_dict = None
    if latest_job:
        job_dict = {
            "id": latest_job.id,
            "status": latest_job.status,
            "since": latest_job.since,
            "chats_scanned": latest_job.chats_scanned,
            "messages_saved": latest_job.messages_saved,
            "started_at": latest_job.started_at,
            "finished_at": latest_job.finished_at,
            "last_error": latest_job.last_error,
        }

    return {
        "operator_id": operator_id,
        "session_id": session.id,
        "status": session.status,
        "tg_username": session.tg_username,
        "last_connected_at": session.last_connected_at,
        "last_error": session.last_error,
        "latest_backfill_job": job_dict,
    }
