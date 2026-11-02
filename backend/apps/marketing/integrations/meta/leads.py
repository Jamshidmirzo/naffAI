"""
Заявки из лид-форм Meta → лиды CRM (вместо LeadPixel).

Для каждой включённой `MetaPage`:
  1. токен страницы (из `/me/accounts` по токену подключения, иначе
     `/{page_id}?fields=access_token`);
  2. формы страницы (`/{page_id}/leadgen_forms`) → `MetaLeadForm`;
  3. новые заявки каждой формы (`/{form_id}/leads`, фильтр time_created >
     последней забранной − 10 мин) → `inbound_lead_process` того же
     webhook-приёма: разбор field_data, `metadata["ad"]` (ad_id, кампания,
     группа, объявление, форма), раздача операторам источника, дедуп по
     meta_lead_id и телефону.
Источник страницы — webhook-источник без HTTP-приёма; его `smm` = SMM страницы,
так что лиды сразу видны в кабинете специалиста.
"""

from __future__ import annotations

import datetime as dt
import logging

from django.db import transaction
from django.utils import timezone

from apps.audit.services import AuditAction, audit_log_create
from apps.leads.integrations.webhook.services import inbound_lead_process
from apps.leads.models import DistributionMode, LeadStatus, SheetSource, SheetSourceKind
from apps.marketing.models import MetaLeadForm, MetaPage

from .client import MetaApiError, MetaClient
from .sync import client_for_connection

logger = logging.getLogger("apps.marketing.meta")

# Запас при повторном опросе: заявки, пришедшие «задним числом», не теряем;
# повторы отсекает дедуп по meta_lead_id.
OVERLAP = dt.timedelta(minutes=10)
SKIP_FORM_STATUSES = {"ARCHIVED", "DELETED"}


def parse_meta_time(value: str | None) -> dt.datetime | None:
    """'2026-11-02T09:15:20+0000' → aware datetime."""
    if not value:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S.%f%z"):
        try:
            return dt.datetime.strptime(value, fmt)
        except ValueError:
            continue
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


@transaction.atomic
def meta_page_ensure_source(page: MetaPage, *, user=None) -> SheetSource:
    """Источник для лидов страницы (создаётся один раз), smm = SMM страницы."""
    if page.source_id:
        src = page.source
        if src.smm_id != page.smm_id:
            src.smm_id = page.smm_id
            src.save(update_fields=["smm", "updated_at"])
        return src
    src = SheetSource.objects.create(
        name=f"Meta · {page.name or page.page_id}"[:128],
        kind=SheetSourceKind.WEBHOOK,
        spreadsheet_id="",
        gid=0,
        column_map={},
        default_status=LeadStatus.NEW,
        active=True,
        distribution_mode=DistributionMode.ALIAS_OR_ROUND_ROBIN,
        writeback_columns={"enabled": False},
        # Заявка с рекламы — клиент ждёт звонка прямо сейчас.
        is_hot=True,
        hot_sla_minutes=10,
        # Без webhook_token / ключа: HTTP-приём закрыт, лиды кладёт воркер.
        webhook_token=None,
        webhook_api_key="",
        smm_id=page.smm_id,
    )
    page.source = src
    page.save(update_fields=["source", "updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.CREATE,
        entity="leads.SheetSource",
        entity_id=src.id,
        changes={"name": src.name, "kind": src.kind, "meta_page": page.page_id, "smm_id": page.smm_id},
        comment="Источник лидов из лид-форм Meta",
    )
    return src


def _page_client(page: MetaPage, client: MetaClient) -> MetaClient:
    token = ""
    try:
        for row in client.pages():
            if str(row.get("id")) == page.page_id:
                token = str(row.get("access_token") or "")
                break
    except MetaApiError:
        token = ""
    if not token:
        token = client.page_token(page.page_id)
    if not token:
        raise MetaApiError("нет доступа к странице (токен страницы не выдан)")
    return client.with_token(token)


def meta_page_forms_refresh(page: MetaPage, pclient: MetaClient) -> list[MetaLeadForm]:
    out = []
    for row in pclient.lead_forms(page.page_id):
        form_id = str(row.get("id") or "")
        if not form_id:
            continue
        form, _ = MetaLeadForm.objects.update_or_create(
            form_id=form_id,
            defaults={
                "page": page,
                "name": str(row.get("name") or "")[:512],
                "status": str(row.get("status") or "")[:32],
            },
        )
        out.append(form)
    return out


def meta_form_leads_import(
    page: MetaPage, form: MetaLeadForm, pclient: MetaClient
) -> dict[str, int]:
    since = page.leads_since
    if form.last_lead_at and (since is None or form.last_lead_at - OVERLAP > since):
        since = form.last_lead_at - OVERLAP
    stats = {"seen": 0, "created": 0, "merged": 0, "duplicate": 0, "invalid": 0, "error": 0}
    newest = form.last_lead_at
    for lead in pclient.form_leads(form.form_id, since):
        created = parse_meta_time(lead.get("created_time"))
        if page.leads_since and created and created <= page.leads_since:
            continue  # Meta фильтрует по секундам — страхуемся
        stats["seen"] += 1
        record = {
            **lead,
            "meta_lead_id": str(lead.get("id") or ""),
            "form_id": str(lead.get("form_id") or form.form_id),
            "form_name": form.name,
            "source": "Meta Lead Ads",
        }
        res = inbound_lead_process(source=page.source, record=record)
        key = res.outcome if res.outcome in stats else ("created" if res.ok else "error")
        stats[key] = stats.get(key, 0) + 1
        if created and (newest is None or created > newest):
            newest = created
    if newest != form.last_lead_at or stats["created"]:
        form.last_lead_at = newest
        form.leads_imported += stats["created"]
        form.save(update_fields=["last_lead_at", "leads_imported", "updated_at"])
    return stats


def meta_page_leads_sync(page: MetaPage, *, client: MetaClient | None = None) -> dict:
    if not page.leads_enabled:
        return {"page": page.page_id, "skipped": "disabled"}
    src = meta_page_ensure_source(page)
    if not src.active:
        # Источник выключили в «Источниках лидов» — заявки не забираем.
        return {"page": page.page_id, "skipped": "source inactive"}
    own = client is None
    total: dict[str, int] = {"forms": 0, "seen": 0, "created": 0, "merged": 0, "duplicate": 0, "invalid": 0, "error": 0}
    try:
        client = client or client_for_connection(page.connection)
        pclient = _page_client(page, client)
        for form in meta_page_forms_refresh(page, pclient):
            if form.status.upper() in SKIP_FORM_STATUSES:
                continue
            total["forms"] += 1
            for k, v in meta_form_leads_import(page, form, pclient).items():
                total[k] = total.get(k, 0) + v
    except MetaApiError as exc:
        page.last_polled_at = timezone.now()
        page.last_poll_error = str(exc)[:2000]
        page.save(update_fields=["last_polled_at", "last_poll_error", "updated_at"])
        raise
    finally:
        if own and client is not None:
            client.close()
    page.last_polled_at = timezone.now()
    page.last_poll_error = ""
    page.save(update_fields=["last_polled_at", "last_poll_error", "updated_at"])
    if total["created"] or total["error"]:
        logger.info("meta leads %s: %s", page.page_id, total)
    return {"page": page.page_id, **total}


def meta_leads_sync_all() -> list[dict]:
    out = []
    pages = MetaPage.objects.filter(leads_enabled=True).select_related("connection", "source")
    for page in pages:
        try:
            out.append({"ok": True, **meta_page_leads_sync(page)})
        except MetaApiError as exc:
            logger.warning("meta leads %s failed: %s", page.page_id, exc)
            out.append({"ok": False, "page": page.page_id, "error": str(exc)})
        except Exception as exc:
            logger.exception("meta leads %s crashed", page.page_id)
            page.last_poll_error = f"внутренняя ошибка: {exc}"[:2000]
            page.save(update_fields=["last_poll_error", "updated_at"])
            out.append({"ok": False, "page": page.page_id, "error": str(exc)})
    return out


__all__ = [
    "meta_form_leads_import",
    "meta_leads_sync_all",
    "meta_page_ensure_source",
    "meta_page_forms_refresh",
    "meta_page_leads_sync",
    "parse_meta_time",
]
