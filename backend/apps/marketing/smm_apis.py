"""
Кабинет SMM-специалиста + подключение Meta Ads.

  GET   /marketing/smm/                          список SMM (SMM видит только себя)
  GET   /marketing/smm/overview/                 все SMM рядом (менеджер)
  GET   /marketing/smm/dashboard/?smm=           кабинет (SMM — всегда свой)
  GET   /marketing/smm/leads/?smm=               лиды SMM с телефонами
  PUT   /marketing/smm/<id>/sources/             привязать таблицы/вебхуки
  GET   /marketing/meta/connections/             токены (без самих токенов)
  POST  /marketing/meta/connections/             добавить токен
  PATCH /marketing/meta/connections/<id>/        заменить токен
  DEL   /marketing/meta/connections/<id>/
  POST  /marketing/meta/connections/<id>/check/  перепроверить, обновить аккаунты
  GET   /marketing/meta/ad-accounts/
  PATCH /marketing/meta/ad-accounts/<id>/        {smm_id, is_active}
  POST  /marketing/meta/ad-accounts/<id>/sync/   синхронизировать сейчас
  GET   /marketing/meta/pages/                   страницы Facebook (лид-формы)
  PATCH /marketing/meta/pages/<id>/              {smm_id, leads_enabled, backfill_hours}
  POST  /marketing/meta/pages/<id>/sync/         забрать заявки сейчас
"""

from __future__ import annotations

import datetime as dt

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.pagination import DefaultPagination
from apps.leads.models import SheetSource
from apps.leads.services import sheet_source_set_smm
from apps.users.models import Role
from apps.users.permissions import IsSmmOrManager, IsSuperadminOrManager

from .integrations.meta.client import MetaApiError
from .meta_services import (
    meta_ad_account_sync_now,
    meta_ad_account_update,
    meta_connection_check,
    meta_connection_create,
    meta_connection_delete,
    meta_connection_replace_token,
    meta_page_sync_now,
    meta_page_update,
)
from .models import MetaAdAccount, MetaConnection, MetaPage
from .smm_selectors import (
    smm_card,
    smm_dashboard,
    smm_lead_rows,
    smm_leads_qs,
    smm_overview,
    smm_users_qs,
)

User = get_user_model()


# ---- helpers -------------------------------------------------------------


def _is_smm(user) -> bool:
    profile = getattr(user, "profile", None)
    return bool(profile and profile.role == Role.SMM and not user.is_superuser)


class _BadRequest(Exception):
    pass


def _target_smm(request) -> User:
    """SMM всегда смотрит себя (параметр игнорируется); менеджер — `?smm=`."""
    if _is_smm(request.user):
        return request.user
    raw = request.query_params.get("smm") or (request.data or {}).get("smm")
    try:
        return smm_users_qs().get(pk=int(raw))
    except (TypeError, ValueError, User.DoesNotExist) as exc:
        raise _BadRequest("Укажите SMM-специалиста (?smm=<id>).") from exc


def _period(request) -> tuple[dt.date, dt.date]:
    q = request.query_params
    end = parse_date(q.get("date_to") or "") or timezone.localdate()
    start = parse_date(q.get("date_from") or "") or end - dt.timedelta(days=29)
    if start > end:
        start, end = end, start
    if (end - start).days > 366:
        start = end - dt.timedelta(days=366)
    return start, end


def _lang(request) -> str:
    lang = (request.query_params.get("lang") or "").lower()
    if lang in ("ru", "uz"):
        return lang
    profile = getattr(request.user, "profile", None)
    return getattr(profile, "preferred_language", None) or "ru"


def _bad(msg: str, code: int = 400) -> Response:
    return Response({"detail": msg}, status=code)


def _iso(v) -> str | None:
    return v.isoformat() if v else None


def _account_row(a: MetaAdAccount) -> dict:
    return {
        "id": a.id,
        "connection_id": a.connection_id,
        "account_id": a.account_id,
        "name": a.name,
        "currency": a.currency,
        "timezone_name": a.timezone_name,
        "account_status": a.account_status,
        "smm_id": a.smm_id,
        "smm_name": (a.smm.get_full_name() or a.smm.username) if a.smm_id and a.smm else None,
        "is_active": a.is_active,
        "last_synced_at": _iso(a.last_synced_at),
        "last_sync_error": a.last_sync_error,
        "synced_since": _iso(a.synced_since),
    }


def _page_row(p: MetaPage) -> dict:
    forms = list(p.forms.all())
    return {
        "id": p.id,
        "connection_id": p.connection_id,
        "page_id": p.page_id,
        "name": p.name,
        "tasks": p.tasks,
        "smm_id": p.smm_id,
        "smm_name": (p.smm.get_full_name() or p.smm.username) if p.smm_id and p.smm else None,
        "leads_enabled": p.leads_enabled,
        "leads_since": _iso(p.leads_since),
        "source_id": p.source_id,
        "source_name": p.source.name if p.source_id and p.source else None,
        "source_active": bool(p.source.active) if p.source_id and p.source else None,
        "last_polled_at": _iso(p.last_polled_at),
        "last_poll_error": p.last_poll_error,
        "forms": [
            {
                "id": f.id,
                "form_id": f.form_id,
                "name": f.name,
                "status": f.status,
                "last_lead_at": _iso(f.last_lead_at),
                "leads_imported": f.leads_imported,
            }
            for f in forms
        ],
    }


def _pages_qs():
    return MetaPage.objects.select_related("smm", "source").prefetch_related("forms")


def _connection_row(c: MetaConnection) -> dict:
    return {
        "id": c.id,
        "name": c.name,
        "meta_user_id": c.meta_user_id,
        "meta_user_name": c.meta_user_name,
        "token_expires_at": _iso(c.token_expires_at),
        "last_checked_at": _iso(c.last_checked_at),
        "last_error": c.last_error,
        "created_at": _iso(c.created_at),
        "accounts": [_account_row(a) for a in c.ad_accounts.select_related("smm").all()],
        "pages": [_page_row(p) for p in _pages_qs().filter(connection=c)],
    }


# ---- SMM cabinet ---------------------------------------------------------


class SmmListApi(APIView):
    permission_classes = [IsSmmOrManager]

    def get(self, request):
        users = [request.user] if _is_smm(request.user) else list(smm_users_qs())
        ids = [u.id for u in users]
        sources: dict[int, list] = {i: [] for i in ids}
        for s in SheetSource.objects.filter(smm_id__in=ids).values("id", "name", "kind", "active", "smm_id"):
            sources[s.pop("smm_id")].append(s)
        accounts: dict[int, list] = {i: [] for i in ids}
        for a in MetaAdAccount.objects.filter(smm_id__in=ids).select_related("smm"):
            accounts[a.smm_id].append(_account_row(a))
        return Response([
            {**smm_card(u), "sources": sources[u.id], "ad_accounts": accounts[u.id]}
            for u in users
        ])


class SmmOverviewApi(APIView):
    permission_classes = [IsSuperadminOrManager]

    def get(self, request):
        start, end = _period(request)
        return Response({
            "period": {"start": start.isoformat(), "end": end.isoformat()},
            "rows": smm_overview(date_from=start, date_to=end),
        })


class SmmDashboardApi(APIView):
    permission_classes = [IsSmmOrManager]

    def get(self, request):
        try:
            smm = _target_smm(request)
        except _BadRequest as exc:
            return _bad(str(exc))
        start, end = _period(request)
        data = smm_dashboard(smm_id=smm.id, date_from=start, date_to=end, lang=_lang(request))
        return Response({"smm": smm_card(smm), **data})


class SmmLeadsApi(APIView):
    permission_classes = [IsSmmOrManager]

    def get(self, request):
        try:
            smm = _target_smm(request)
        except _BadRequest as exc:
            return _bad(str(exc))
        q = request.query_params
        source_raw = q.get("source") or ""
        qs = smm_leads_qs(
            smm_id=smm.id,
            date_from=parse_date(q.get("date_from") or ""),
            date_to=parse_date(q.get("date_to") or ""),
            status=q.get("status") or None,
            ad_id=q.get("ad_id") or None,
            campaign=q.get("campaign") or None,
            source_id=int(source_raw) if source_raw.isdigit() else None,
            search=q.get("q") or None,
        )
        paginator = DefaultPagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response(smm_lead_rows(page, lang=_lang(request)))


class SmmSourcesApi(APIView):
    """PUT {source_ids: [...]} — ровно эти источники за SMM, остальные отвязать."""

    permission_classes = [IsSuperadminOrManager]

    def put(self, request, smm_id: int):
        smm = smm_users_qs().filter(pk=smm_id).first()
        if smm is None:
            return _bad("SMM-специалист не найден.", 404)
        raw = (request.data or {}).get("source_ids")
        if not isinstance(raw, list):
            return _bad("source_ids должен быть списком.")
        try:
            wanted = {int(x) for x in raw}
        except (TypeError, ValueError):
            return _bad("source_ids должен быть списком id.")
        found = set(SheetSource.objects.filter(id__in=wanted).values_list("id", flat=True))
        if found != wanted:
            return _bad(f"Нет таких источников: {sorted(wanted - found)}")
        with transaction.atomic():
            for src in SheetSource.objects.filter(smm_id=smm.id).exclude(id__in=wanted):
                sheet_source_set_smm(source=src, smm_id=None, user=request.user)
            for src in SheetSource.objects.filter(id__in=wanted):
                sheet_source_set_smm(source=src, smm_id=smm.id, user=request.user)
        return Response(
            list(SheetSource.objects.filter(smm_id=smm.id).values("id", "name", "kind", "active"))
        )


# ---- Meta connections ----------------------------------------------------


class MetaConnectionListCreateApi(APIView):
    permission_classes = [IsSuperadminOrManager]

    def get(self, request):
        return Response([_connection_row(c) for c in MetaConnection.objects.all()])

    def post(self, request):
        data = request.data or {}
        try:
            conn = meta_connection_create(
                token=str(data.get("token") or ""),
                name=str(data.get("name") or ""),
                user=request.user,
            )
        except ValueError as exc:
            return _bad(str(exc))
        return Response(_connection_row(conn), status=201)


class MetaConnectionDetailApi(APIView):
    permission_classes = [IsSuperadminOrManager]

    def patch(self, request, connection_id: int):
        conn = MetaConnection.objects.filter(pk=connection_id).first()
        if conn is None:
            return _bad("not found", 404)
        data = request.data or {}
        if "name" in data:
            conn.name = str(data.get("name") or "")[:128]
            conn.save(update_fields=["name", "updated_at"])
        if data.get("token"):
            try:
                conn = meta_connection_replace_token(conn, token=str(data["token"]), user=request.user)
            except ValueError as exc:
                return _bad(str(exc))
        return Response(_connection_row(conn))

    def delete(self, request, connection_id: int):
        conn = MetaConnection.objects.filter(pk=connection_id).first()
        if conn is None:
            return _bad("not found", 404)
        meta_connection_delete(conn, user=request.user)
        return Response(status=204)


class MetaConnectionCheckApi(APIView):
    permission_classes = [IsSuperadminOrManager]

    def post(self, request, connection_id: int):
        conn = MetaConnection.objects.filter(pk=connection_id).first()
        if conn is None:
            return _bad("not found", 404)
        return Response(_connection_row(meta_connection_check(conn)))


# ---- Meta ad accounts ----------------------------------------------------


class MetaAdAccountListApi(APIView):
    permission_classes = [IsSuperadminOrManager]

    def get(self, request):
        qs = MetaAdAccount.objects.select_related("smm").all()
        return Response([_account_row(a) for a in qs])


class MetaAdAccountDetailApi(APIView):
    permission_classes = [IsSuperadminOrManager]

    def patch(self, request, account_id: int):
        account = MetaAdAccount.objects.filter(pk=account_id).first()
        if account is None:
            return _bad("not found", 404)
        data = request.data or {}
        kwargs: dict = {}
        if "smm_id" in data:
            kwargs["smm_id"] = data.get("smm_id")
        if "is_active" in data:
            kwargs["is_active"] = bool(data.get("is_active"))
        try:
            account = meta_ad_account_update(account, user=request.user, **kwargs)
        except ValueError as exc:
            return _bad(str(exc))
        return Response(_account_row(account))


class MetaAdAccountSyncApi(APIView):
    """Менеджер — любой аккаунт; SMM — только свой."""

    permission_classes = [IsSmmOrManager]

    def post(self, request, account_id: int):
        account = MetaAdAccount.objects.select_related("connection", "smm").filter(pk=account_id).first()
        if account is None or (_is_smm(request.user) and account.smm_id != request.user.id):
            return _bad("not found", 404)
        days_raw = str((request.data or {}).get("days") or "")
        days = min(int(days_raw), 370) if days_raw.isdigit() and int(days_raw) > 0 else None
        try:
            result = meta_ad_account_sync_now(account, days=days)
        except MetaApiError as exc:
            account.refresh_from_db()
            return Response({"detail": str(exc), "account": _account_row(account)}, status=502)
        account.refresh_from_db()
        return Response({"result": result, "account": _account_row(account)})


# ---- Meta pages (лид-формы) ----------------------------------------------


class MetaPageListApi(APIView):
    permission_classes = [IsSuperadminOrManager]

    def get(self, request):
        return Response([_page_row(p) for p in _pages_qs()])


class MetaPageDetailApi(APIView):
    """PATCH {smm_id?, leads_enabled?, backfill_hours?}"""

    permission_classes = [IsSuperadminOrManager]

    def patch(self, request, page_id: int):
        page = _pages_qs().filter(pk=page_id).first()
        if page is None:
            return _bad("not found", 404)
        data = request.data or {}
        kwargs: dict = {}
        if "smm_id" in data:
            kwargs["smm_id"] = data.get("smm_id")
        if "leads_enabled" in data:
            kwargs["leads_enabled"] = bool(data.get("leads_enabled"))
        raw = str(data.get("backfill_hours") or "0")
        kwargs["backfill_hours"] = int(raw) if raw.isdigit() else 0
        try:
            page = meta_page_update(page, user=request.user, **kwargs)
        except ValueError as exc:
            return _bad(str(exc))
        return Response(_page_row(_pages_qs().get(pk=page.pk)))


class MetaPageSyncApi(APIView):
    """Забрать новые заявки страницы прямо сейчас."""

    permission_classes = [IsSuperadminOrManager]

    def post(self, request, page_id: int):
        page = MetaPage.objects.select_related("connection", "source").filter(pk=page_id).first()
        if page is None:
            return _bad("not found", 404)
        if not page.leads_enabled:
            return _bad("Сначала включите забор заявок для страницы.")
        try:
            result = meta_page_sync_now(page)
        except MetaApiError as exc:
            return Response({"detail": str(exc), "page": _page_row(_pages_qs().get(pk=page.pk))}, status=502)
        return Response({"result": result, "page": _page_row(_pages_qs().get(pk=page.pk))})
