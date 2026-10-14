import { useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Check, Search, Trash2 } from "lucide-react";
import { useT2 } from "../i18n";
import { Dialog, EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum } from "../ui";
import { toNum, useDeletedOperators, type DeletedRow } from "../api/branch";

/**
 * /team/deleted-operators — read-only journal of hard-deleted operators
 * (AuditLog entity=operators.Operator, action=delete). No restore flow —
 * it does not exist in the backend. Row click → detail window.
 */

const COLS = "minmax(160px, 1.2fr) 140px 128px minmax(110px, 1fr) minmax(160px, 1.6fr) 72px 120px 112px";

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function statusKey(s: string | undefined): string | null {
  if (s === "active") return "v2.deleted.st.active";
  if (s === "trainee") return "v2.deleted.st.trainee";
  if (s === "inactive") return "v2.deleted.st.inactive";
  return null;
}

export default function DeletedOperators() {
  const t = useT2();
  const q = useDeletedOperators();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<DeletedRow | null>(null);

  const all = q.data?.results ?? [];
  const s = search.trim().toLowerCase();
  const rows = useMemo(() => {
    if (!s) return all;
    return all.filter((r) =>
      `${r.snapshot.full_name} ${r.snapshot.phone} ${r.deleted_by_username} ${r.comment}`.toLowerCase().includes(s),
    );
  }, [all, s]);

  const totalSum = useMemo(() => all.reduce((a, r) => a + toNum(r.sales_total), 0), [all]);
  const totalCount = useMemo(() => all.reduce((a, r) => a + (r.sales_count || 0), 0), [all]);
  const noReason = useMemo(() => all.filter((r) => !r.comment).length, [all]);

  const header = (
    <PageHeader title={t("super_manager.deleted_ops.title")}>
      <div className="inwrap" style={{ width: 380, maxWidth: "100%" }}>
        <Search className="ic" />
        <input
          className="input"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("super_manager.deleted_ops.search_ph")}
          aria-label={t("v2.deleted.searchAria")}
        />
      </div>
    </PageHeader>
  );

  const statusBadge = (st: string | undefined) => {
    const k = statusKey(st);
    return k ? <span className="badge" style={{ height: 18, fontSize: 11 }}>{t(k)}</span> : null;
  };

  let body: ReactNode;
  if (q.isLoading) body = <LoadingBlock rows={6} onRetry={() => q.refetch()} />;
  else if (q.isError) body = <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  else if (all.length === 0)
    body = <EmptyState icon={<Trash2 className="ic ic-l" />} title={t("super_manager.deleted_ops.empty")} body={t("v2.deleted.emptyBody")} />;
  else if (rows.length === 0)
    body = <EmptyState icon={<Search className="ic ic-l" />} title={t("v2.deleted.nothingFound", { q: search.trim() })} body={t("v2.deleted.nothingFoundBody")} />;
  else
    body = (
      <div style={{ minWidth: 1040 }}>
        <div className="tr th" style={{ gridTemplateColumns: COLS }}>
          <span>{t("super_manager.deleted_ops.col_operator")}</span>
          <span>{t("common.phone")}</span>
          <span>{t("super_manager.deleted_ops.col_deleted_at")}</span>
          <span>{t("super_manager.deleted_ops.col_deleted_by")}</span>
          <span>{t("super_manager.deleted_ops.col_comment")}</span>
          <span className="r">{t("super_manager.deleted_ops.col_sales_count")}</span>
          <span className="r">{t("super_manager.deleted_ops.col_sales_total")}</span>
          <span className="r">{t("super_manager.deleted_ops.col_restored")}</span>
        </div>
        {rows.map((r) => (
          <div
            key={r.audit_id}
            className={cx("tr", selected?.audit_id === r.audit_id && "is-sel")}
            role="button"
            tabIndex={0}
            style={{ gridTemplateColumns: COLS, minHeight: 54, cursor: "pointer" }}
            onClick={() => setSelected(r)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setSelected(r);
              }
            }}
          >
            <span className="col g4" style={{ minWidth: 0, alignItems: "flex-start" }}>
              <span className="w6 trunc" style={{ maxWidth: "100%" }}>{r.snapshot.full_name || `#${r.operator_id ?? "—"}`}</span>
              {statusBadge(r.snapshot.status)}
            </span>
            <span className="num xs c2">{r.snapshot.phone || "—"}</span>
            <span className="num s c2">{fmtDateTime(r.deleted_at)}</span>
            <span className="s trunc">{r.deleted_by_username || "—"}</span>
            {r.comment ? (
              <span className="s trunc" title={r.comment}>{r.comment}</span>
            ) : (
              <span className="s trunc c-bad w6 row g4">
                <AlertTriangle className="ic ic-s" />
                {t("super_manager.deleted_ops.no_comment")}
              </span>
            )}
            <span className="r num">{fmtNum(r.sales_count)}</span>
            <span className="r num w6">{fmtNum(r.sales_total)}</span>
            <span className="r">
              {r.restored_sales_count > 0 ? (
                <span className="badge b-ok" aria-label={t("v2.deleted.restoredN", { n: r.restored_sales_count })}>{r.restored_sales_count}</span>
              ) : (
                <span className="c3">—</span>
              )}
            </span>
          </div>
        ))}
      </div>
    );

  const sel = selected;
  return (
    <>
      {header}
      <main className="page">
        <p className="s c3" style={{ maxWidth: 720, margin: 0 }}>{t("v2.deleted.subtitle")}</p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16 }}>
          <section className="card col g4 pad">
            <span className="lbl">{t("super_manager.deleted_ops.kpi_total")}</span>
            <span className="kpi num">{q.data ? fmtNum(q.data.count) : "—"}</span>
          </section>
          <section className="card col g4 pad">
            <span className="lbl">{t("super_manager.deleted_ops.kpi_sales_count")}</span>
            <span className="kpi num">{q.data ? fmtNum(totalCount) : "—"}</span>
          </section>
          <section className="card col g4 pad">
            <span className="lbl">{t("super_manager.deleted_ops.kpi_sales_total")}</span>
            <span className="kpi num">{q.data ? fmtNum(totalSum) : "—"}</span>
          </section>
          <section className="card col g4 pad" style={noReason > 0 ? { borderColor: "var(--bad-solid)" } : undefined}>
            <span className="lbl">{t("super_manager.deleted_ops.kpi_empty_comments")}</span>
            <span className="kpi num" style={noReason > 0 ? { color: "var(--bad)" } : undefined}>{q.data ? fmtNum(noReason) : "—"}</span>
            <span className="xs c3">{t("super_manager.deleted_ops.kpi_empty_hint")}</span>
          </section>
        </div>

        <section className="card tbl" style={{ overflowX: "auto" }}>{body}</section>
      </main>

      <Dialog
        open={!!sel}
        onClose={() => setSelected(null)}
        width={640}
        title={
          sel ? (
            <span className="row g8 wrap">
              <span>{sel.snapshot.full_name || `#${sel.operator_id ?? "—"}`}</span>
              {statusBadge(sel.snapshot.status)}
            </span>
          ) : (
            ""
          )
        }
        sub={
          sel
            ? t("super_manager.deleted_ops.deleted_by_at", { by: sel.deleted_by_username || "—", at: fmtDateTime(sel.deleted_at) })
            : undefined
        }
      >
        {sel ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
              <div className="well col g4" style={{ padding: "10px 12px" }}>
                <span className="lbl">{t("common.phone")}</span>
                <span className="num s w6">{sel.snapshot.phone || "—"}</span>
              </div>
              <div className="well col g4" style={{ padding: "10px 12px" }}>
                <span className="lbl">{t("super_manager.deleted_ops.hired_at")}</span>
                <span className="num s w6">{sel.snapshot.hired_at || "—"}</span>
              </div>
              <div className="well col g4" style={{ padding: "10px 12px" }}>
                <span className="lbl">{t("super_manager.deleted_ops.col_sales_count")}</span>
                <span className="num s w6">{fmtNum(sel.sales_count)}</span>
              </div>
              <div className="well col g4" style={{ padding: "10px 12px" }}>
                <span className="lbl">{t("super_manager.deleted_ops.col_sales_total")}</span>
                <span className="num s w6">{fmtNum(sel.sales_total)}</span>
              </div>
            </div>

            <div className="col g6">
              <span className="lbl">{t("super_manager.deleted_ops.col_comment")}</span>
              <p className={cx("s", !sel.comment && "c-bad")} style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                {sel.comment || t("super_manager.deleted_ops.no_comment_long")}
              </p>
            </div>

            {sel.restored_sales_count > 0 ? (
              <div className="banner" style={{ background: "var(--ok-bg)", color: "var(--ok)" }}>
                <Check className="ic" />
                <span>{t("super_manager.deleted_ops.restored_badge", { n: sel.restored_sales_count })}</span>
              </div>
            ) : null}

            <div className="col g8">
              <span className="lbl">{t("super_manager.deleted_ops.cascade_title")}</span>
              {(
                [
                  ["super_manager.deleted_ops.cascade_sales_soft_deleted", sel.deleted_related?.sales_soft_deleted_count, sel.restored_sales_count === 0],
                  ["super_manager.deleted_ops.cascade_sales_shrunk", sel.deleted_related?.sales_shrunk_count, false],
                  ["super_manager.deleted_ops.cascade_leads_detached", sel.deleted_related?.lead_assignments_detached, false],
                  ["super_manager.deleted_ops.cascade_calls_detached", sel.deleted_related?.call_attempts_detached, false],
                ] as [string, number | undefined, boolean][]
              ).map(([k, v, warn]) => (
                <div key={k} className="row between s">
                  <span>{t(k)}</span>
                  <span className={cx("num w6", warn && (v ?? 0) > 0 && "c-bad")}>{fmtNum(v ?? 0)}</span>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </Dialog>
    </>
  );
}
