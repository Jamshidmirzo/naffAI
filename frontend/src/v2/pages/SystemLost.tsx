import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "../../components/ui";
import { apiErrorMessage } from "../../lib/api-types";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum, useConfirm } from "../ui";
import { LEADS_PAGE_SIZE, useRecoverSystemLost, useSystemLost, type SystemLostLead } from "../api/managerDaily";
import { LeadStatusBadge, Pager } from "./Leads";

const COLS = "minmax(0, 1.3fr) minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1.1fr) 110px minmax(0, 1.2fr) 172px";

function fmtWhen(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function validDays(v: string): boolean {
  if (!/^\d+$/.test(v)) return false;
  const n = Number(v);
  return n >= 1 && n <= 365;
}

export default function SystemLost() {
  const t = useT2();
  const confirm = useConfirm();
  const [sp, setSp] = useSearchParams();

  const reason = sp.get("reason") || "";
  const days = sp.get("days") || "";
  const page = Number(sp.get("page")) || 1;

  const [daysInput, setDaysInput] = useState(days);
  useEffect(() => setDaysInput(days), [days]);
  const daysBad = daysInput !== "" && !validDays(daysInput);

  const setFilter = (key: string, value: string | number | null) => {
    const next = new URLSearchParams(sp);
    if (value === null || value === "") next.delete(key);
    else next.set(key, String(value));
    if (key !== "page") next.delete("page");
    setSp(next);
  };

  const onDays = (v: string) => {
    setDaysInput(v);
    if (v === "") setFilter("days", null);
    else if (validDays(v)) setFilter("days", v);
  };

  const list = useSystemLost(reason, days, page);
  const recover = useRecoverSystemLost();
  const [busyId, setBusyId] = useState<number | null>(null);

  const summary = list.data?.summary ?? { total: 0, by_reason: {}, top_original_operators: [] };
  const knownReasons = list.data?.known_reasons ?? [];
  const rows = list.data?.results ?? [];
  const total = list.data?.count ?? 0;

  const reasonLabel = (code: string) => {
    const key = `system_lost.reason.${code}`;
    const tr = t(key);
    return tr === key ? code : tr;
  };

  const onRecover = async (lead: SystemLostLead) => {
    if (recover.isPending) return;
    const ok = await confirm({
      title: t("v2.lost.askTitle"),
      body: (
        <span className="col g8">
          <span className="c2">
            <span className="w6">{lead.full_name || "—"}</span> · <span className="num">{lead.phone || lead.phone_raw || t("orphans.table.no_phone")}</span>
          </span>
          <span>{t("v2.lost.askBody")}</span>
        </span>
      ),
      confirm: t("system_lost.action.recover"),
    });
    if (!ok) return;
    setBusyId(lead.id);
    recover.mutate(lead.id, {
      onSuccess: () => toast.success(t("system_lost.toast.recovered")),
      onError: (err) => toast.error(apiErrorMessage(err)),
      onSettled: () => setBusyId(null),
    });
  };

  return (
    <>
      <PageHeader title={t("system_lost.title")} meta={t("system_lost.subtitle")}>
        <span className="badge b-info">{t("v2.lost.superOnly")}</span>
        <span className="col g4" style={{ alignItems: "flex-end" }}>
          <label className="row g8 s c2">
            {t("v2.lost.lastDays")}
            <input
              className={cx("input num", daysBad && "is-bad")}
              type="number"
              min={1}
              max={365}
              value={daysInput}
              placeholder="—"
              aria-label={t("v2.lost.daysAria")}
              aria-invalid={daysBad || undefined}
              onChange={(e) => onDays(e.target.value)}
              style={{ width: 84, height: 36, textAlign: "right" }}
            />
            {t("v2.lost.days")}
          </label>
          <span className={cx("xs", daysBad ? "c-bad w6" : "c3")}>{daysBad ? t("v2.lost.daysErr") : t("v2.lost.daysHint")}</span>
        </span>
      </PageHeader>
      <main className="page">
        <p className="s c3" style={{ maxWidth: 760, margin: 0 }}>{t("v2.lost.intro")}</p>

        <section className="card row wrap" style={{ padding: "16px 20px", gap: 40, alignItems: "flex-start" }}>
          <div className="col g4">
            <span className="lbl">{t("system_lost.summary.total")}</span>
            <span className="kpi">{list.data ? fmtNum(summary.total) : "—"}</span>
            {/* the backend summary ignores the reason/days filters */}
            <span className="xs c3">{t("v2.lost.allTime")}</span>
          </div>
          {Object.keys(summary.by_reason).length > 0 ? (
            <div className="col g8" style={{ minWidth: 260 }}>
              <span className="lbl">{t("system_lost.summary.by_reason")}</span>
              {Object.entries(summary.by_reason).map(([code, n]) => (
                <div key={code} className="row between s g16">
                  <span className="c2">{reasonLabel(code)}</span>
                  <span className="num w6">{n}</span>
                </div>
              ))}
            </div>
          ) : null}
          {summary.top_original_operators.length > 0 ? (
            <div className="col g8 grow" style={{ minWidth: 220 }}>
              <span className="lbl">{t("system_lost.summary.top_operators")}</span>
              <div className="row g16 wrap s">
                {summary.top_original_operators.map((r) => (
                  <span key={r.name} className="c2">
                    {r.name} <span className="num w6" style={{ color: "var(--ink)" }}>{r.count}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <div className="row g8 wrap">
          <button className={cx("chip", reason === "" && "is-on")} type="button" onClick={() => setFilter("reason", null)}>
            {t("system_lost.filter.all_reasons")}
          </button>
          {knownReasons.map((code) => (
            <button key={code} className={cx("chip", reason === code && "is-on")} type="button" onClick={() => setFilter("reason", code)}>
              {reasonLabel(code)}
            </button>
          ))}
        </div>

        <section className="card tbl" style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 960 }}>
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <span>{t("system_lost.table.col.lead")}</span>
              <span>{t("system_lost.table.col.original_operator")}</span>
              <span>{t("system_lost.table.col.status_before")}</span>
              <span>{t("system_lost.table.col.reason")}</span>
              <span className="r">{t("system_lost.table.col.lost_at")}</span>
              <span>{t("system_lost.table.col.comment")}</span>
              <span />
            </div>
            {list.isLoading ? (
              <LoadingBlock rows={6} onRetry={() => list.refetch()} />
            ) : list.isError ? (
              <ErrorState error={list.error} onRetry={() => list.refetch()} />
            ) : rows.length === 0 ? (
              <EmptyState title={t("system_lost.empty")} body={t("v2.lost.emptyBody")} />
            ) : (
              rows.map((lead) => (
                <div key={lead.id} className="tr" style={{ gridTemplateColumns: COLS }}>
                  <span className="col" style={{ minWidth: 0 }}>
                    <span className="w6 trunc">{lead.full_name || "—"}</span>
                    {lead.phone ? (
                      <span className="num xs c3">{lead.phone}</span>
                    ) : (
                      <span className="num xs c-bad w6 trunc">{lead.phone_raw || t("orphans.table.no_phone")}</span>
                    )}
                  </span>
                  <span className="trunc">{lead.lost_original_operator_name || <span className="c3">—</span>}</span>
                  <span style={{ minWidth: 0 }}>{lead.lost_original_status ? <LeadStatusBadge code={lead.lost_original_status} /> : <span className="c3">—</span>}</span>
                  <span className="s c2">{reasonLabel(lead.lost_reason)}</span>
                  <span className="r num s c3">{fmtWhen(lead.lost_at)}</span>
                  <span className="s c3 trunc" title={lead.lost_comment || undefined}>{lead.lost_comment || "—"}</span>
                  <span className="r">
                    <button className="btn btn-sm" type="button" disabled={recover.isPending} onClick={() => onRecover(lead)}>
                      {busyId === lead.id ? t("system_lost.action.recovering") : t("system_lost.action.recover")}
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>
        </section>

        <Pager page={page} total={total} pageSize={LEADS_PAGE_SIZE} onChange={(p) => setFilter("page", p > 1 ? p : null)} />
        {confirm.node}
      </main>
    </>
  );
}
