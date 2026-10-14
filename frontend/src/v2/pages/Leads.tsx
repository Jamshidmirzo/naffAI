import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ExternalLink, Phone, RefreshCw, RotateCcw, Search, Send, Table, Users, X } from "lucide-react";
import { toast } from "../../components/ui";
import { OperatorDiagnosticsModal } from "../../components/operators/OperatorDiagnosticsModal";
import { useLeadStatuses, useLeadStatusInfo, type LeadStatusTone } from "../../hooks/useLeadStatuses";
import { useLang } from "../../store/lang";
import type { Lead } from "../../lib/leads";
import { useT2 } from "../i18n";
import { Dialog, EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum, useConfirm } from "../ui";
import {
  LEADS_PAGE_SIZE,
  apiErrorText,
  useActiveOperators,
  useDistributionStatus,
  useLeadsList,
  useLeadsReassign,
  useLeadsSheetSources,
  useNeedsReviewCount,
  useOrphansCount,
  useSheetFlushWritebacks,
  useSheetHealthOverview,
  useSheetRescan,
  useSheetSyncAll,
  useSheetSyncOne,
  type DistributionOperatorRow,
  type LeadsOperator,
  type LeadsQuick,
} from "../api/managerDaily";

type T = ReturnType<typeof useT2>;

const COLS = "28px minmax(150px, 1.5fr) minmax(0, 0.8fr) minmax(0, 1fr) minmax(0, 1.2fr) 52px 110px";

/* fields the list may carry on some backends (not in LeadSerializer today) */
type LeadExtra = Lead & { calls_count?: number; callback_at?: string | null; source_name?: string };

export function toneClass(tone: LeadStatusTone | string | undefined): string {
  switch (tone) {
    case "danger":
      return "b-bad";
    case "hot":
      return "b-hot";
    case "success":
      return "b-ok";
    case "info":
      return "b-info";
    default:
      return "";
  }
}

export function LeadStatusBadge({ code }: { code: string | null | undefined }) {
  const info = useLeadStatusInfo(code);
  return (
    <span className={cx("badge", toneClass(info.tone))} style={{ maxWidth: "100%" }}>
      <i className="dot" />
      <span className="trunc">{info.label}</span>
    </span>
  );
}

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function isOverdue(iso: string | null | undefined) {
  if (!iso) return false;
  const v = new Date(iso).getTime();
  return Number.isFinite(v) && v < Date.now();
}

export function timeAgo(t: T, iso: string | null | undefined): string {
  if (!iso) return t("v2.leads.ago.never");
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 10) return t("v2.leads.ago.now");
  if (sec < 60) return t("v2.leads.ago.sec", { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t("v2.leads.ago.min", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("v2.leads.ago.hr", { n: hr });
  return t("v2.leads.ago.day", { n: Math.floor(hr / 24) });
}

function initials(name: string) {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "—";
}

/** Pager as on the artboards: «Показано 1–50 из N · Назад 1 2 3 … 97 Вперёд». */
export function Pager({ page, total, pageSize, onChange, left }: { page: number; total: number; pageSize: number; onChange: (p: number) => void; left?: ReactNode }) {
  const t = useT2();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= 0) return left ? <div className="row between wrap g8">{left}</div> : null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const nums: Array<number | "…"> = [];
  const add = (n: number) => {
    if (n < 1 || n > pages || nums.includes(n)) return;
    const last = nums[nums.length - 1];
    if (typeof last === "number" && n - last > 1) nums.push("…");
    nums.push(n);
  };
  [1, page - 1, page, page + 1, pages].sort((a, b) => a - b).forEach(add);
  return (
    <div className="row between wrap g8">
      <span>{left}</span>
      <nav className="row g8 wrap" aria-label={t("v2.leads.pager.label")}>
        <span className="s c3">{t("v2.leads.pager.shown", { from: fmtNum(from), to: fmtNum(to), total: fmtNum(total) })}</span>
        <button className="btn btn-sm" type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>{t("v2.leads.pager.prev")}</button>
        {nums.map((n, i) =>
          n === "…" ? (
            <span key={`e${i}`} className="c3">…</span>
          ) : (
            <button
              key={n}
              className={cx("btn btn-sm btn-sq", n === page && "btn-pri")}
              type="button"
              aria-current={n === page ? "page" : undefined}
              onClick={() => n !== page && onChange(n)}
              style={{ width: "auto", minWidth: 30, padding: "0 8px" }}
            >
              <span className="num">{n}</span>
            </button>
          ),
        )}
        <button className="btn btn-sm" type="button" disabled={page >= pages} onClick={() => onChange(page + 1)}>{t("v2.leads.pager.next")}</button>
      </nav>
    </div>
  );
}

/* ───────────────────────── Google Sheets bar + diagnostics ───────────────────────── */

function SheetSyncBarV2() {
  const t = useT2();
  const [diagOpen, setDiagOpen] = useState(false);
  const [opDiagOpen, setOpDiagOpen] = useState(false);
  const overview = useSheetHealthOverview(30_000);
  const syncAll = useSyncAllWithToast();

  const d = overview.data;
  if (!d || d.total_active_sources === 0) return null;
  const hasErrors = !d.overall_healthy;
  const errorCount = d.sources.filter((s) => !s.is_healthy).length;

  return (
    <>
      <section
        className="card row g12 wrap"
        style={{ padding: "8px 10px 8px 16px", ...(hasErrors ? { background: "var(--bad-bg)", borderColor: "var(--bad-bg)" } : {}) }}
        aria-label={t("v2.leads.sync.label")}
      >
        <i className="dot" style={{ color: hasErrors ? "var(--bad-solid)" : "var(--ok-solid)", width: 10, height: 10 }} />
        <span className="s w6">{t("v2.leads.sync.label")}</span>
        {hasErrors ? (
          <span className="s c-bad w6 row g6" style={{ whiteSpace: "nowrap" }}>
            <AlertTriangle className="ic ic-s" />
            {t("v2.leads.sync.errors", { n: errorCount })}
          </span>
        ) : (
          <span className="s c3 grow trunc">
            <span className="num c2 w6">{d.total_active_sources}</span> {t("v2.leads.sync.connected")} · {t("v2.leads.sync.lastCheck")}{" "}
            <span className="c2 w6">{timeAgo(t, d.latest_sync_at)}</span> · {t("v2.leads.sync.queue")}{" "}
            <span className="num c2 w6">{d.writeback.pending_count}</span>
          </span>
        )}
        {hasErrors ? <span className="grow" /> : null}
        <button className="btn btn-ghost btn-sm" type="button" disabled={syncAll.isPending} onClick={() => syncAll.mutate()}>
          <RefreshCw className="ic ic-s" style={syncAll.isPending ? { animation: "spin 1s linear infinite" } : undefined} />
          {syncAll.isPending ? t("v2.leads.sync.checking") : t("v2.leads.sync.checkNow")}
        </button>
        <button className="btn btn-sm" type="button" onClick={() => setDiagOpen(true)}>
          <Table className="ic ic-s" />
          {t("v2.leads.sync.tables")}
        </button>
        <button className="btn btn-sm" type="button" onClick={() => setOpDiagOpen(true)}>
          <Users className="ic ic-s" />
          {t("v2.leads.sync.operators")}
        </button>
      </section>
      <SheetDiagDialog open={diagOpen} onClose={() => setDiagOpen(false)} />
      <OperatorDiagnosticsModal open={opDiagOpen} onClose={() => setOpDiagOpen(false)} />
    </>
  );
}

function useSyncAllWithToast() {
  const t = useT2();
  const m = useSheetSyncAll();
  return {
    isPending: m.isPending,
    mutate: () =>
      m.mutate(undefined, {
        onSuccess: (data) =>
          toast.success(t("v2.leads.sync.doneAll", { sources: data?.total_sources ?? 0, read: data?.total_read ?? 0, created: data?.total_created ?? 0 })),
        onError: (err) => toast.error(apiErrorText(err, t("v2.leads.sync.failAll"))),
      }),
  };
}

function SheetDiagDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT2();
  const confirm = useConfirm();
  const q = useSheetHealthOverview(open ? 10_000 : false, open);
  const syncAll = useSyncAllWithToast();
  const flush = useSheetFlushWritebacks();
  const syncOne = useSheetSyncOne();
  const rescan = useSheetRescan();
  const d = q.data;

  const onRescan = async (id: number, name: string) => {
    const ok = await confirm({ title: t("v2.leads.diag.rescanAskTitle"), body: t("v2.leads.diag.rescanAskBody", { name }), confirm: t("v2.leads.diag.rescan") });
    if (!ok) return;
    rescan.mutate(id, {
      onSuccess: (r) => toast.success(t("v2.leads.diag.rescanDone", { read: r?.read ?? 0, created: r?.created ?? 0, merged: r?.merged ?? 0 })),
      onError: (err) => toast.error(apiErrorText(err, t("v2.leads.diag.rescanFail"))),
    });
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        width={780}
        title={t("v2.leads.diag.title")}
        sub={t("v2.leads.diag.sub")}
        footer={
          <>
            <Link className="btn btn-ghost" to="/sheet-sources" onClick={onClose}>{t("v2.leads.sync.tables")}</Link>
            <span className="grow" />
            <button className="btn" type="button" onClick={onClose}>{t("common.close")}</button>
            <button className="btn btn-pri" type="button" disabled={syncAll.isPending} onClick={() => syncAll.mutate()}>
              <RefreshCw className="ic" />
              {syncAll.isPending ? t("v2.leads.sync.checking") : t("v2.leads.diag.checkAll")}
            </button>
          </>
        }
      >
        {q.isLoading ? (
          <LoadingBlock rows={3} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !d ? null : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
              <section className="card col g6" style={{ padding: 14 }}>
                <span className="row between"><span className="lbl">{t("v2.leads.diag.kpiSheets")}</span><Table className="ic ic-s c3" /></span>
                <span className="row g8" style={{ alignItems: "baseline" }}>
                  <span className="kpi" style={{ fontSize: 20, lineHeight: "26px" }}>{t("v2.leads.diag.active", { n: d.total_active_sources })}</span>
                  <span className="xs c3">{t("v2.leads.diag.healthy", { n: d.sources.filter((s) => s.is_healthy).length })}</span>
                </span>
                <span className="xs c3">{t("v2.leads.diag.lastCheck")} <span className="c2 w6">{timeAgo(t, d.latest_sync_at)}</span></span>
              </section>
              <section className="card col g6" style={{ padding: 14 }}>
                <span className="row between"><span className="lbl">{t("v2.leads.diag.kpiWrite")}</span><Send className="ic ic-s c3" /></span>
                <span className="row g8" style={{ alignItems: "baseline" }}>
                  <span className="kpi" style={{ fontSize: 20, lineHeight: "26px" }}>{t("v2.leads.diag.queued", { n: d.writeback.pending_count })}</span>
                  {d.writeback.failed_count > 0 ? <span className="xs c-bad w6">{t("v2.leads.diag.failed", { n: d.writeback.failed_count })}</span> : null}
                </span>
                <span className="row between xs c3">
                  <span>{t("v2.leads.diag.lastHour", { n: d.writeback.done_last_1h })}</span>
                  {d.writeback.pending_count > 0 ? (
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      style={{ height: 24 }}
                      disabled={flush.isPending}
                      onClick={() =>
                        flush.mutate(undefined, {
                          onSuccess: (r) => toast.success(t("v2.leads.diag.flushDone", { ok: r?.stats?.ok ?? 0, left: r?.remaining_pending ?? 0 })),
                          onError: (err) => toast.error(apiErrorText(err, t("v2.leads.diag.flushFail"))),
                        })
                      }
                    >
                      {t("v2.leads.diag.flushNow")}
                    </button>
                  ) : null}
                </span>
              </section>
              <section className="card col g6" style={{ padding: 14 }}>
                <span className="lbl">{t("v2.leads.diag.kpiState")}</span>
                <span>
                  {d.overall_healthy ? (
                    <span className="badge b-ok"><CheckCircle2 className="ic ic-s" />{t("v2.leads.diag.allGood")}</span>
                  ) : (
                    <span className="badge b-bad"><AlertTriangle className="ic ic-s" />{t("v2.leads.diag.hasError")}</span>
                  )}
                </span>
                <span className="xs c3">{t("v2.leads.diag.autoEvery")}</span>
              </section>
            </div>

            <span className="lbl" style={{ marginTop: 4 }}>{t("v2.leads.diag.listTitle")}</span>
            {d.sources.length === 0 ? (
              <EmptyState title={t("v2.leads.diag.none")} />
            ) : (
              <div className="col g8" style={{ maxHeight: 380, overflowY: "auto" }}>
                {d.sources.map((s) => (
                  <section key={s.id} className="card col g8" style={{ padding: 12 }}>
                    <div className="row g8 between wrap">
                      <span className="row g8" style={{ minWidth: 0 }}>
                        <i className="dot" style={{ color: s.is_healthy ? "var(--ok-solid)" : "var(--bad-solid)", width: 10, height: 10 }} />
                        <span className="s w6 trunc">{s.name}</span>
                        <span className="xs c3 trunc">({s.worksheet_name || `gid: ${s.gid}`})</span>
                        <a
                          className="btn btn-ghost btn-sq btn-sm"
                          href={`https://docs.google.com/spreadsheets/d/${s.spreadsheet_id}/edit#gid=${s.gid}`}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={t("v2.leads.diag.open")}
                          title={t("v2.leads.diag.open")}
                        >
                          <ExternalLink className="ic ic-s" />
                        </a>
                      </span>
                      <span className="row g6">
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          disabled={syncOne.isPending}
                          onClick={() =>
                            syncOne.mutate(s.id, {
                              onSuccess: (r) => toast.success(t("v2.leads.diag.oneDone", { read: r?.read ?? 0, created: r?.created ?? 0, merged: r?.merged ?? 0 })),
                              onError: (err) => toast.error(apiErrorText(err, t("v2.leads.diag.oneFail"))),
                            })
                          }
                        >
                          <RefreshCw className="ic ic-s" />
                          {t("v2.leads.diag.check")}
                        </button>
                        <button className="btn btn-ghost btn-sm" type="button" title={t("v2.leads.diag.rescanTitle")} disabled={rescan.isPending} onClick={() => onRescan(s.id, s.name)}>
                          <RotateCcw className="ic ic-s" />
                          {t("v2.leads.diag.rescan")}
                        </button>
                      </span>
                    </div>
                    <div className="row wrap xs c3" style={{ columnGap: 16, rowGap: 4 }}>
                      <span>{t("v2.leads.diag.lastCheck")} <span className="c2 w6">{timeAgo(t, s.last_synced_at)}</span></span>
                      <span>{t("v2.leads.diag.lastRow")} <span className="num c2 w6">{s.last_synced_row}</span></span>
                      <span>{t("v2.leads.diag.today", { today: s.leads_today, total: s.leads_total })}</span>
                      <span>
                        {t("v2.leads.diag.writeback")}{" "}
                        {s.writeback_enabled ? (
                          <span className="c-ok w6">{t("v2.leads.diag.wbOn", { s: s.writeback_status_col || "D", o: s.writeback_operator_col || "E" })}</span>
                        ) : (
                          <span>{t("v2.leads.diag.wbOff")}</span>
                        )}
                      </span>
                    </div>
                    {s.last_sync_error ? (
                      <div className="banner b-bad" style={{ background: "var(--bad-bg)", color: "var(--bad)" }}>
                        <AlertTriangle className="ic" />
                        <span className="col g4">
                          <span><span className="w6">{t("v2.leads.diag.error")}</span> {s.last_sync_error}</span>
                          <span className="xs">{t("v2.leads.diag.errorHint")}</span>
                        </span>
                      </div>
                    ) : null}
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </Dialog>
      {confirm.node}
    </>
  );
}

/* ───────────────────────── Assign dialog (shared with Orphans) ───────────────────────── */

export function operatorNote(t: T, row: DistributionOperatorRow | undefined): { text: string; warn: boolean; s?: string } {
  if (!row) return { text: "", warn: false };
  const working = t("v2.leads.op.working", { n: row.working_count });
  if (row.eligible) return { text: `${working} · ${t("v2.leads.op.ok")}`, warn: false, s: "on" };
  const paused = /пауз|pause/i.test(row.reason);
  return { text: `${working} · ${row.reason}`, warn: true, s: paused ? "pause" : row.reason.includes("morning-gate") ? "late" : undefined };
}

export function OperatorPickList({ operators, value, onChange, name }: { operators: LeadsOperator[]; value: string; onChange: (v: string) => void; name: string }) {
  const t = useT2();
  const dist = useDistributionStatus();
  const byId = useMemo(() => new Map((dist.data?.operators ?? []).map((o) => [o.id, o])), [dist.data]);
  const [q, setQ] = useState("");
  const list = q.trim() ? operators.filter((o) => o.full_name.toLowerCase().includes(q.trim().toLowerCase())) : operators;
  return (
    <div className="col g8">
      {operators.length > 8 ? (
        <div className="inwrap">
          <Search className="ic" />
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("common.operator")} aria-label={t("common.operator")} />
        </div>
      ) : null}
      <div className="card col" role="radiogroup" aria-label={t("common.operator")} style={{ maxHeight: 280, overflowY: "auto" }}>
        {list.map((o) => {
          const note = operatorNote(t, byId.get(o.id));
          return (
            <label key={o.id} className="li" style={{ minHeight: 48, cursor: "pointer" }}>
              <input type="radio" name={name} checked={value === String(o.id)} onChange={() => onChange(String(o.id))} />
              <span className="ava ava-s" data-s={note.s}>{initials(o.full_name)}</span>
              <span className="col grow" style={{ minWidth: 0 }}>
                <span className="s w6 trunc">{o.full_name}</span>
                {note.text ? <span className={cx("xs trunc", note.warn ? "c-hot" : "c3")} title={note.text}>{note.text}</span> : null}
              </span>
            </label>
          );
        })}
        {list.length === 0 ? <div className="s c3" style={{ padding: 16 }}>{t("v2.cmd.nothing")}</div> : null}
      </div>
    </div>
  );
}

function AssignDialog({ open, onClose, ids, operators, onDone }: { open: boolean; onClose: () => void; ids: number[]; operators: LeadsOperator[]; onDone: () => void }) {
  const t = useT2();
  const [opId, setOpId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const mut = useLeadsReassign();

  useEffect(() => {
    if (open) {
      setOpId(operators[0]?.id ? String(operators[0].id) : "");
      setReason("");
      setError("");
    }
  }, [open, operators]);

  const submit = () => {
    if (!opId) {
      setError(t("leads.pick_operator"));
      return;
    }
    if (mut.isPending) return;
    mut.mutate(
      { ids, operatorId: Number(opId), reason },
      {
        onSuccess: onDone,
        onError: (err) => setError(apiErrorText(err, t("v2.state.errorBody"))),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${t("leads.assign")} · ${ids.length}`}
      sub={ids.length === 1 ? t("leads.reassign_one") : t("leads.reassign_many", { n: ids.length })}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-pri" type="button" disabled={mut.isPending || !opId} onClick={submit}>
            {mut.isPending ? t("common.saving") : ids.length > 1 ? t("v2.leads.assignN", { n: ids.length }) : t("leads.assign_short")}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{t("common.operator")}</label>
        <OperatorPickList operators={operators} value={opId} onChange={setOpId} name="v2-leads-assign" />
      </div>
      <div className="field">
        <label htmlFor="v2-leads-reason">{t("leads.reason_optional")}</label>
        <input id="v2-leads-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("leads.reason_ph")} />
      </div>
      {error ? (
        <div className="banner b-bad" role="alert" style={{ background: "var(--bad-bg)", color: "var(--bad)" }}>
          <AlertTriangle className="ic" />
          <span>{error}</span>
        </div>
      ) : null}
    </Dialog>
  );
}

/* ───────────────────────── Lead side panel ───────────────────────── */

function LeadPanel({ lead, onReassign, onClose }: { lead: LeadExtra; onReassign: () => void; onClose: () => void }) {
  const t = useT2();
  const src = lead.sheet_source_name ?? lead.source_name ?? lead.source ?? "—";
  const fields: Array<[string, ReactNode]> = [
    [t("v2.leads.panel.source"), src || "—"],
    [t("v2.leads.panel.operator"), lead.operator_name || <span className="c3">{t("leads.unassigned_lower")}</span>],
    [t("v2.leads.panel.product"), lead.product_hint || "—"],
    [t("v2.leads.panel.created"), <span className="num">{fmtWhen(lead.created_at)}</span>],
  ];
  if (lead.assigned_at) fields.push([t("v2.leads.panel.assigned"), <span className="num">{fmtWhen(lead.assigned_at)}</span>]);
  if (lead.previous_operator_name) fields.push([t("v2.leads.panel.prevOperator"), lead.previous_operator_name]);
  if (lead.phone_alt) fields.push([t("v2.leads.panel.phoneAlt"), <span className="num">{lead.phone_alt}</span>]);
  if (lead.sheet_row_index) fields.push([t("v2.leads.panel.sheetRow"), <span className="num">{lead.sheet_row_index}</span>]);
  if (lead.callback_at) fields.push([t("leads.col_callback"), <span className={cx("num", isOverdue(lead.callback_at) && "c-hot w6")}>{fmtWhen(lead.callback_at)}</span>]);

  return (
    <aside className="panel card col" style={{ flex: "0 1 340px", position: "sticky", top: 16 }} aria-label={lead.full_name || lead.phone || "—"}>
      <div className="card-h" style={{ alignItems: "flex-start" }}>
        <div className="col" style={{ minWidth: 0 }}>
          <span className="h3 trunc">{lead.full_name || "—"}</span>
          <span className={cx("num xs", lead.phone ? "c3" : "c-bad w6")}>{lead.phone || lead.phone_raw || t("leads.no_phone")}</span>
        </div>
        <span className="row g6">
          <LeadStatusBadge code={lead.status} />
          <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("v2.leads.panel.close")} onClick={onClose}>
            <X className="ic" />
          </button>
        </span>
      </div>
      {lead.needs_review ? (
        <div className="banner b-warn" style={{ margin: "12px 16px 0" }}>
          <AlertTriangle className="ic" />
          <span>{t("v2.leads.panel.review")}</span>
        </div>
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12, padding: 16 }}>
        {fields.map(([k, v]) => (
          <div key={k} className="col g4" style={{ minWidth: 0 }}>
            <span className="lbl">{k}</span>
            <span className="s" style={{ overflowWrap: "anywhere" }}>{v}</span>
          </div>
        ))}
      </div>
      {lead.postponed_at ? (
        <>
          <hr className="hr" />
          <div className="col g4" style={{ padding: "12px 16px" }}>
            <span className="lbl">{t("v2.leads.panel.postponed")}</span>
            <span className="s c2">
              <span className="num">{fmtWhen(lead.postponed_at)}</span>
              {lead.postponed_by_name ? ` · ${lead.postponed_by_name}` : ""}
              {lead.postpone_reason ? ` · ${lead.postpone_reason}` : ""}
            </span>
          </div>
        </>
      ) : null}
      <hr className="hr" />
      <div className="row g8" style={{ padding: "14px 16px" }}>
        <button className="btn grow" type="button" onClick={onReassign}>
          <Users className="ic" />
          {t("v2.leads.panel.reassign")}
        </button>
        {lead.phone ? (
          <a className="btn grow" href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`}>
            <Phone className="ic" />
            {t("v2.leads.panel.call")}
          </a>
        ) : null}
      </div>
    </aside>
  );
}

/* ───────────────────────── Page ───────────────────────── */

export default function Leads() {
  const t = useT2();
  const lang = useLang((s) => s.lang);
  const [sp, setSp] = useSearchParams();

  const quick: LeadsQuick = sp.get("needs_review") === "1" ? "review" : "all";
  const search = sp.get("search") || "";
  const sheetSourceId = sp.get("sheet_source") ? Number(sp.get("sheet_source")) : null;
  const operator = sp.get("operator") || "";
  const status = sp.get("status") || "";
  const page = Number(sp.get("page")) || 1;

  const [searchInput, setSearchInput] = useState(search);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [openId, setOpenId] = useState<number | null>(null);
  const [assignIds, setAssignIds] = useState<number[] | null>(null);

  const setFilter = (key: string, value: string | number | null) => {
    const next = new URLSearchParams(sp);
    if (value === null || value === "") next.delete(key);
    else next.set(key, String(value));
    if (key !== "page") next.delete("page");
    setSp(next);
  };

  // debounce search → URL (old page wrote every keystroke)
  useEffect(() => {
    if (searchInput === search) return;
    const id = window.setTimeout(() => setFilter("search", searchInput.trim() ? searchInput : null), 300);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);
  useEffect(() => setSearchInput(search), [search]);

  const setQuick = (q: LeadsQuick) => {
    const next = new URLSearchParams(sp);
    next.delete("needs_review");
    next.delete("unassigned");
    if (q === "review") next.set("needs_review", "1");
    next.delete("page");
    setSp(next);
  };

  const sources = useLeadsSheetSources();
  const operators = useActiveOperators();
  const statuses = useLeadStatuses();
  const leads = useLeadsList({ quick, search, sheetSourceId, page, operator, status });
  const reviewCount = useNeedsReviewCount();
  const orphansCount = useOrphansCount();

  const rows = (leads.data?.results ?? []) as LeadExtra[];
  const total = leads.data?.count ?? 0;

  useEffect(() => {
    setPicked(new Set());
  }, [page, quick, search, sheetSourceId, operator, status]);

  const overdue = useMemo(() => rows.filter((r) => isOverdue(r.callback_at)).length, [rows]);
  const current = rows.find((r) => r.id === openId) ?? null;

  const togglePick = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allOn = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const toggleAll = () => setPicked(allOn ? new Set() : new Set(rows.map((r) => r.id)));

  // Old «Без оператора» tab sent ?unassigned=1, which /leads/ ignores; the pool lives on /leads/orphans.
  if (sp.get("unassigned") === "1") return <Navigate to="/leads/orphans" replace />;

  const statusOptions = (statuses.data ?? []).filter((s) => s.is_active);

  return (
    <>
      <PageHeader title={t("leads.title")} meta={t("leads.subtitle")}>
        <div className="inwrap" style={{ width: 300, maxWidth: "100%" }}>
          <Search className="ic" />
          <input className="input" type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder={t("leads.search_ph")} aria-label={t("leads.search_ph")} />
        </div>
      </PageHeader>
      <main className="page" style={{ gap: 14 }}>
        <SheetSyncBarV2 />

        <div className="tabs" role="tablist">
          <button className={cx("tab", quick === "all" && "is-on")} type="button" role="tab" aria-selected={quick === "all"} onClick={() => setQuick("all")}>
            {t("leads.tab_all")}
            {quick === "all" && leads.data ? <span className="num xs c3">{fmtNum(total)}</span> : null}
          </button>
          <button className={cx("tab", quick === "review" && "is-on")} type="button" role="tab" aria-selected={quick === "review"} onClick={() => setQuick("review")}>
            {t("leads.tab_review")}
            {reviewCount.data ? <span className="cnt cnt-mute">{reviewCount.data}</span> : null}
          </button>
          <Link className="tab" to="/leads/orphans">
            {t("leads.tab_unassigned")}
            {orphansCount.data ? <span className="cnt">{orphansCount.data}</span> : null}
          </Link>
        </div>

        <div className="row g8 wrap">
          {(sources.data?.length ?? 0) > 0 ? (
            <>
              <button className={cx("chip", sheetSourceId === null && "is-on")} type="button" onClick={() => setFilter("sheet_source", null)}>
                {t("leads.all_sources")}
              </button>
              {(sources.data ?? []).map((s) => (
                <button key={s.id} className={cx("chip", sheetSourceId === s.id && "is-on")} type="button" onClick={() => setFilter("sheet_source", s.id)}>
                  {s.name}
                </button>
              ))}
            </>
          ) : null}
          <span className="grow" />
          <select
            className="input"
            aria-label={t("v2.leads.filterOperator")}
            value={operator}
            onChange={(e) => setFilter("operator", e.target.value || null)}
            style={{ width: 190, height: 32, borderRadius: 99, fontSize: 13, borderColor: "var(--line-2)" }}
          >
            <option value="">{t("v2.leads.allOperators")}</option>
            {(operators.data ?? []).map((o) => (
              <option key={o.id} value={o.id}>{o.full_name}</option>
            ))}
          </select>
          <select
            className="input"
            aria-label={t("v2.leads.filterStatus")}
            value={status}
            onChange={(e) => setFilter("status", e.target.value || null)}
            style={{ width: 170, height: 32, borderRadius: 99, fontSize: 13, borderColor: "var(--line-2)" }}
          >
            <option value="">{t("v2.leads.allStatuses")}</option>
            {statusOptions.map((s) => (
              <option key={s.code} value={s.code}>{lang === "uz" && s.label_uz ? s.label_uz : s.label_ru}</option>
            ))}
          </select>
        </div>

        <div className="split">
          <section className="list col g8">
            {picked.size > 0 ? (
              <div className="card row g12 wrap" style={{ padding: "8px 16px", background: "var(--ink)", color: "var(--surface)", borderColor: "var(--ink)" }}>
                <span className="s w6 grow">{t("leads.picked", { n: picked.size })}</span>
                <button className="btn btn-sm btn-pri" type="button" onClick={() => setAssignIds(Array.from(picked))}>
                  <Users className="ic ic-s" />
                  {t("leads.assign")}
                </button>
                <button className="btn btn-sm" type="button" onClick={() => setPicked(new Set())}>
                  <X className="ic ic-s" />
                  {t("leads.clear_selection")}
                </button>
              </div>
            ) : null}

            <section className="card tbl" style={{ overflowX: "auto" }}>
              <div style={{ minWidth: 760 }}>
                <div className="tr th" style={{ gridTemplateColumns: COLS }}>
                  <input className="check" type="checkbox" checked={allOn} onChange={toggleAll} disabled={rows.length === 0} aria-label={t("leads.select_all")} />
                  <span>{t("leads.col_lead")}</span>
                  <span>{t("leads.col_source")}</span>
                  <span>{t("common.operator")}</span>
                  <span>{t("common.status")}</span>
                  <span className="r">{t("leads.col_calls")}</span>
                  <span className="r">{t("leads.col_callback")}</span>
                </div>
                {leads.isLoading ? (
                  <LoadingBlock rows={6} onRetry={() => leads.refetch()} />
                ) : leads.isError ? (
                  <ErrorState error={leads.error} onRetry={() => leads.refetch()} />
                ) : rows.length === 0 ? (
                  <EmptyState title={t("leads.empty")} body={t("v2.leads.emptyBody")} />
                ) : (
                  rows.map((lead) => {
                    const on = picked.has(lead.id);
                    const src = lead.sheet_source_name ?? lead.source_name ?? "—";
                    const cbOver = isOverdue(lead.callback_at);
                    return (
                      <div
                        key={lead.id}
                        className={cx("tr", (on || openId === lead.id) && "is-sel")}
                        style={{ gridTemplateColumns: COLS, cursor: "pointer" }}
                        onClick={() => setOpenId(lead.id)}
                      >
                        <input
                          className="check"
                          type="checkbox"
                          checked={on}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => togglePick(lead.id)}
                          aria-label={t("v2.leads.selectRow", { name: lead.full_name || lead.phone || String(lead.id) })}
                        />
                        <button
                          className="col"
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenId(lead.id);
                          }}
                          style={{ minWidth: 0, padding: "4px 0", border: 0, background: "none", textAlign: "left", gap: 1, color: "inherit" }}
                        >
                          <span className="row g6" style={{ minWidth: 0 }}>
                            {lead.needs_review ? <AlertTriangle className="ic ic-s c-hot" aria-label={t("leads.tab_review")} /> : null}
                            <span className="w6 trunc">{lead.full_name || "—"}</span>
                          </span>
                          {lead.phone ? (
                            <span className="num xs c3" style={{ whiteSpace: "nowrap" }}>{lead.phone}</span>
                          ) : (
                            <span className="num xs c-bad w6 trunc">{lead.phone_raw || t("leads.no_phone")}</span>
                          )}
                          {lead.product_hint ? <span className="xs w5 c-hot trunc" title={lead.product_hint}>{lead.product_hint}</span> : null}
                        </button>
                        <span className="c2 trunc">{src}</span>
                        <span className="trunc">{lead.operator_name || <span className="c3">{t("leads.unassigned_lower")}</span>}</span>
                        <span style={{ minWidth: 0 }}><LeadStatusBadge code={lead.status} /></span>
                        <span className="r num">{lead.calls_count ?? "—"}</span>
                        <span className={cx("r num s", cbOver ? "c-hot w6" : !lead.callback_at && "c3")}>{lead.callback_at ? fmtWhen(lead.callback_at) : "—"}</span>
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            <Pager
              page={page}
              total={total}
              pageSize={LEADS_PAGE_SIZE}
              onChange={(p) => setFilter("page", p > 1 ? p : null)}
              left={
                leads.data ? (
                  <span className="s c3">
                    {t("common.total")}: <span className="num c2 w6">{fmtNum(total)}</span>
                    {overdue > 0 ? (
                      <>
                        {" · "}
                        <span className="c-hot w6">{t("leads.overdue", { n: overdue })}</span>
                      </>
                    ) : null}
                  </span>
                ) : null
              }
            />
          </section>

          {current ? (
            <LeadPanel lead={current} onReassign={() => setAssignIds([current.id])} onClose={() => setOpenId(null)} />
          ) : rows.length > 0 ? (
            <aside className="panel card" style={{ flex: "0 1 340px" }}>
              <EmptyState title={t("v2.leads.panel.hint")} />
            </aside>
          ) : null}
        </div>

        <AssignDialog
          open={!!assignIds}
          onClose={() => setAssignIds(null)}
          ids={assignIds ?? []}
          operators={operators.data ?? []}
          onDone={() => {
            const many = (assignIds?.length ?? 0) > 1 || (assignIds ?? []).some((id) => picked.has(id));
            setAssignIds(null);
            if (many) setPicked(new Set());
            toast.success(t("leads.op_assigned"));
          }}
        />
      </main>
    </>
  );
}
