import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, Shuffle, Split, UserX, Users, X } from "lucide-react";
import { toast } from "../../components/ui";
import { apiErrorMessage } from "../../lib/api-types";
import { useT2 } from "../i18n";
import { Dialog, EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum, useConfirm } from "../ui";
import {
  LEADS_PAGE_SIZE,
  useActiveOperators,
  useBulkReassign,
  useDistributeNow,
  useDistributionStatus,
  useLeadsSheetSources,
  useNeedsReviewCount,
  useOrphanLeads,
  type DistributionOperatorRow,
  type DistributionStatusResponse,
  type LeadsOperator,
} from "../api/managerDaily";
import { LeadStatusBadge, OperatorPickList, Pager } from "./Leads";

type T = ReturnType<typeof useT2>;

const COLS = "28px minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1.2fr) minmax(0, 1fr) 130px";
const DCOLS = "minmax(0, 1.3fr) 90px 90px 110px minmax(0, 2fr)";

function fmtWhen(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function initials(name: string) {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "—";
}

function badgeFor(t: T, row: DistributionOperatorRow): { cls: string; label: string; s?: string } {
  if (row.eligible) return { cls: "b-hot", label: t("orphans.dist.badge.ok"), s: "on" };
  if (row.reason.startsWith("Квота")) return { cls: "", label: t("orphans.dist.badge.quota"), s: "on" };
  if (row.reason.includes("morning-gate")) return { cls: "b-bad", label: t("orphans.dist.badge.gate"), s: "late" };
  if (row.reason.includes("не в статусе")) return { cls: "b-bad", label: t("orphans.dist.badge.disabled") };
  return { cls: "", label: t("orphans.dist.badge.dash"), s: /пауз/i.test(row.reason) ? "pause" : undefined };
}

function DistributionPanel({
  q,
  canDistribute,
  distributing,
  onDistribute,
}: {
  q: { data?: DistributionStatusResponse; isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  canDistribute: boolean;
  distributing: boolean;
  onDistribute: () => void;
}) {
  const t = useT2();
  if (q.isLoading && !q.data) {
    return (
      <section className="card">
        <LoadingBlock rows={3} />
      </section>
    );
  }
  if (q.isError && !q.data) {
    return (
      <section className="card">
        <ErrorState title={t("v2.orphans.distError")} error={q.error} onRetry={() => q.refetch()} />
      </section>
    );
  }
  const data = q.data;
  if (!data) return null;
  const eligible = data.operators.filter((o) => o.eligible).length;
  const totalOps = data.operators.length;
  const on = data.auto_distribution_enabled;
  const tip = !on ? t("orphans.dist.tooltip_disabled") : data.orphans_count === 0 ? t("orphans.dist.tooltip_empty") : t("orphans.dist.tooltip_action");

  return (
    <>
      {!on ? (
        <div className="banner b-bad" style={{ background: "var(--bad-bg)", color: "var(--bad)" }}>
          <AlertTriangle className="ic" />
          <span className="col g4 grow">
            <span className="w6">{t("v2.orphans.autoOffTitle")}</span>
            <span>{t("orphans.dist.auto_off_warning")}</span>
          </span>
          <Link className="btn btn-sm" to="/settings">{t("v2.orphans.openSettings")}</Link>
        </div>
      ) : null}
      <section className="card col" aria-label={t("orphans.dist.title")}>
        <div className="card-h wrap" style={{ alignItems: "flex-start", padding: "14px 16px" }}>
          <div className="col g4" style={{ minWidth: 0 }}>
            <span className="h3">{t("orphans.dist.title")}</span>
            <span className="s c3">
              {t("v2.orphans.batch")} <span className="num c2 w6">{data.rr_batch_size}</span> · {t("v2.orphans.auto")}{" "}
              <b className={on ? "c-ok" : "c-bad"}>{on ? t("orphans.dist.state_on") : t("orphans.dist.state_off")}</b> · {t("v2.orphans.receiving")}{" "}
              <span className="num c2 w6">{eligible}/{totalOps}</span>
            </span>
          </div>
          <button className="btn" type="button" disabled={!canDistribute} title={tip} onClick={onDistribute}>
            <Split className="ic" />
            {distributing ? t("orphans.dist.distributing") : t("orphans.dist.distribute_all", { n: data.orphans_count })}
          </button>
        </div>
        {totalOps === 0 ? (
          <div className="col" style={{ alignItems: "center", textAlign: "center", padding: "24px 20px", gap: 8 }}>
            <span className="icon-tile t-warn" style={{ width: 52, height: 52, borderRadius: 16 }}>
              <UserX className="ic ic-l" />
            </span>
            <span className="h3">{t("v2.orphans.noOpsTitle")}</span>
            <span className="s c3" style={{ maxWidth: 420 }}>{t("orphans.dist.no_operators")}</span>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 640 }}>
              <div className="tr th" style={{ gridTemplateColumns: DCOLS }}>
                <span>{t("orphans.dist.col.operator")}</span>
                <span className="r">{t("orphans.dist.col.working")}</span>
                <span className="r">{t("orphans.dist.col.postponed")}</span>
                <span>{t("orphans.dist.col.status")}</span>
                <span>{t("orphans.dist.col.reason")}</span>
              </div>
              {data.operators.map((row) => {
                const b = badgeFor(t, row);
                return (
                  <div key={row.id} className="tr" style={{ gridTemplateColumns: DCOLS, minHeight: 44, background: row.eligible ? undefined : "var(--surface-2)" }}>
                    <span className="row g8" style={{ minWidth: 0 }}>
                      <span className="ava ava-s" data-s={b.s}>{initials(row.full_name)}</span>
                      <span className="s w6 trunc">{row.full_name}</span>
                    </span>
                    <span className="r num s">{row.working_count}</span>
                    <span className={cx("r num s", !row.postponed_count && "c3")}>{row.postponed_count || "—"}</span>
                    <span><span className={cx("badge", b.cls)}>{b.label}</span></span>
                    <span className={cx("s trunc", row.eligible && "c3")} title={row.reason}>{row.reason}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function AssignDialog({
  open,
  onClose,
  count,
  operators,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  count: number;
  operators: LeadsOperator[];
  submitting: boolean;
  onSubmit: (operatorId: number) => void;
}) {
  const t = useT2();
  const [opId, setOpId] = useState("");
  useEffect(() => {
    if (open) setOpId(operators[0]?.id ? String(operators[0].id) : "");
  }, [open, operators]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("orphans.assign_modal.title", { n: count })}
      sub={t("orphans.assign_modal.hint")}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>{t("orphans.assign_modal.cancel")}</button>
          <button className="btn btn-pri" type="button" disabled={submitting || !opId} onClick={() => opId && !submitting && onSubmit(Number(opId))}>
            {submitting ? t("orphans.assign_modal.saving") : t("orphans.assign_modal.submit")}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{t("orphans.assign_modal.op_label")}</label>
        <OperatorPickList operators={operators} value={opId} onChange={setOpId} name="v2-orphans-assign" />
      </div>
    </Dialog>
  );
}

export default function Orphans() {
  const t = useT2();
  const confirm = useConfirm();
  const [sp, setSp] = useSearchParams();

  const sheetSourceId = sp.get("sheet_source") ? Number(sp.get("sheet_source")) : null;
  const statusFilter = sp.get("status") || "";
  const page = Number(sp.get("page")) || 1;

  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [assignOpen, setAssignOpen] = useState(false);

  const setFilter = (key: string, value: string | number | null) => {
    const next = new URLSearchParams(sp);
    if (value === null || value === "") next.delete(key);
    else next.set(key, String(value));
    if (key !== "page") next.delete("page");
    setSp(next);
  };

  const sources = useLeadsSheetSources();
  const operators = useActiveOperators();
  const orphans = useOrphanLeads(sheetSourceId, statusFilter, page);
  const dist = useDistributionStatus();
  const reviewCount = useNeedsReviewCount();
  const distributeNow = useDistributeNow();
  const bulk = useBulkReassign();

  const rows = orphans.data?.results ?? [];
  const total = orphans.data?.count ?? 0;
  const bySource = orphans.data?.counts_by_source ?? {};

  useEffect(() => {
    setPicked(new Set());
  }, [page, sheetSourceId, statusFilter]);

  const togglePick = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allOn = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const toggleAll = () => setPicked(allOn ? new Set() : new Set(rows.map((r) => r.id)));

  const d = dist.data;
  const eligible = useMemo(() => (d?.operators ?? []).filter((o) => o.eligible).length, [d]);
  const canDistributeNow = !!d && d.auto_distribution_enabled && d.orphans_count > 0 && !distributeNow.isPending;

  const onDistributeAll = async () => {
    if (!d || !canDistributeNow) return;
    const ok = await confirm({
      title: t("v2.orphans.allAskTitle", { n: d.orphans_count }),
      body: t("v2.orphans.allAskBody", { k: eligible }),
      confirm: t("v2.orphans.askOk"),
    });
    if (!ok) return;
    distributeNow.mutate(undefined, {
      onSuccess: (r) => {
        if (r.total === 0) toast(t("orphans.toast.pool_empty"));
        else toast.success(t("orphans.toast.distributed", { n: r.total }));
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });
  };

  const onBulkDone = {
    onSuccess: (r: { total: number }) => {
      setPicked(new Set());
      setAssignOpen(false);
      toast.success(t("orphans.toast.assigned", { n: r.total }));
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err)),
  };

  const onDistributeSelected = async () => {
    if (picked.size === 0 || bulk.isPending) return;
    const ok = await confirm({
      title: t("v2.orphans.selAskTitle", { n: picked.size }),
      body: t("v2.orphans.selAskBody"),
      confirm: t("v2.orphans.askOk"),
    });
    if (!ok) return;
    bulk.mutate({ lead_ids: Array.from(picked), mode: "round_robin" }, onBulkDone);
  };

  return (
    <>
      <PageHeader title={t("orphans.title")} meta={t("orphans.subtitle")} />
      <main className="page" style={{ gap: 16 }}>
        <div className="tabs">
          <Link className="tab" to="/leads">{t("leads.tab_all")}</Link>
          <Link className="tab" to="/leads?needs_review=1">
            {t("leads.tab_review")}
            {reviewCount.data ? <span className="cnt cnt-mute">{reviewCount.data}</span> : null}
          </Link>
          <span className="tab is-on" aria-current="page">
            {t("leads.tab_unassigned")}
            {orphans.data?.counts_by_kind?.free ? <span className="cnt">{orphans.data.counts_by_kind.free}</span> : null}
          </span>
        </div>

        <DistributionPanel q={dist} canDistribute={canDistributeNow} distributing={distributeNow.isPending} onDistribute={onDistributeAll} />

        <section className="card row g24 wrap" style={{ padding: "14px 20px", alignItems: "flex-end" }}>
          <div className="col g4">
            <span className="lbl">{t("orphans.metrics.total_label")}</span>
            <span className="kpi">{orphans.data ? fmtNum(total) : "—"}</span>
          </div>
          {Object.keys(bySource).length > 0 ? (
            <div className="col g6 grow">
              <span className="lbl">{t("orphans.metrics.by_source")}</span>
              <div className="row g16 wrap s">
                {Object.entries(bySource).map(([name, n]) => (
                  <span key={name} className="c3">
                    {name} <span className="num w6" style={{ color: "var(--ink)" }}>{n}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        {(sources.data?.length ?? 0) > 0 ? (
          <div className="row g8 wrap">
            <button className={cx("chip", sheetSourceId === null && "is-on")} type="button" onClick={() => setFilter("sheet_source", null)}>
              {t("orphans.chip.all_sources")}
            </button>
            {(sources.data ?? []).map((s) => (
              <button key={s.id} className={cx("chip", sheetSourceId === s.id && "is-on")} type="button" onClick={() => setFilter("sheet_source", s.id)}>
                {s.name}
              </button>
            ))}
          </div>
        ) : null}

        {picked.size > 0 ? (
          <div className="card row g8 wrap" style={{ padding: "10px 16px", background: "var(--ink)", color: "var(--surface)", borderColor: "var(--ink)" }}>
            <span className="s w6 grow">{t("orphans.toolbar.picked", { picked: picked.size, rows: rows.length })}</span>
            <button className="btn btn-sm btn-pri" type="button" disabled={bulk.isPending} onClick={onDistributeSelected}>
              <Shuffle className="ic ic-s" />
              {t("orphans.toolbar.distribute_selected")}
            </button>
            <button className="btn btn-sm" type="button" onClick={() => setAssignOpen(true)}>
              <Users className="ic ic-s" />
              {t("orphans.toolbar.assign_op")}
            </button>
            <button className="btn btn-sm btn-ghost" type="button" style={{ color: "var(--surface)" }} onClick={() => setPicked(new Set())}>
              <X className="ic ic-s" />
              {t("orphans.toolbar.clear_selection")}
            </button>
          </div>
        ) : null}

        <section className="card tbl" style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 720 }}>
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <input className="check" type="checkbox" checked={allOn} disabled={rows.length === 0} onChange={toggleAll} aria-label={t("orphans.table.select_all_aria")} />
              <span>{t("orphans.table.col.lead")}</span>
              <span>{t("orphans.table.col.source")}</span>
              <span>{t("orphans.table.col.product")}</span>
              <span>{t("orphans.table.col.status")}</span>
              <span className="r">{t("orphans.table.col.created")}</span>
            </div>
            {orphans.isLoading ? (
              <LoadingBlock rows={6} onRetry={() => orphans.refetch()} />
            ) : orphans.isError ? (
              <ErrorState error={orphans.error} onRetry={() => orphans.refetch()} />
            ) : rows.length === 0 ? (
              <EmptyState title={t("orphans.empty")} body={t("v2.orphans.emptyBody")} />
            ) : (
              rows.map((lead) => {
                const on = picked.has(lead.id);
                return (
                  <label key={lead.id} className={cx("tr", on && "is-sel")} style={{ gridTemplateColumns: COLS, cursor: "pointer" }}>
                    <input className="check" type="checkbox" checked={on} onChange={() => togglePick(lead.id)} aria-label={`${lead.full_name || lead.phone || lead.id}`} />
                    <span className="col" style={{ minWidth: 0 }}>
                      <span className="w6 trunc">{lead.full_name || "—"}</span>
                      {lead.phone ? (
                        <span className="num xs c3">{lead.phone}</span>
                      ) : (
                        <span className="num xs c-bad w6 trunc">{lead.phone_raw || t("orphans.table.no_phone")}</span>
                      )}
                    </span>
                    <span className="c2 trunc">{lead.sheet_source_name || "—"}</span>
                    <span className="trunc" title={lead.product_hint || undefined}>{lead.product_hint || <span className="c3">—</span>}</span>
                    <span style={{ minWidth: 0 }}><LeadStatusBadge code={lead.status} /></span>
                    <span className="r num s c2">{fmtWhen(lead.created_at)}</span>
                  </label>
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
          left={orphans.data ? <span className="s c3">{t("orphans.toolbar.total_prefix")} <span className="num c2 w6">{fmtNum(total)}</span></span> : null}
        />

        <AssignDialog
          open={assignOpen}
          onClose={() => setAssignOpen(false)}
          count={picked.size}
          operators={operators.data ?? []}
          submitting={bulk.isPending}
          onSubmit={(operatorId) => bulk.mutate({ lead_ids: Array.from(picked), operator_id: operatorId }, onBulkDone)}
        />
        {confirm.node}
      </main>
    </>
  );
}
