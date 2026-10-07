import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Search, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { Card, Modal, StatusBadge } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";
import { formatUZS } from "../lib/format";

/**
 * «Удалённые операторы» — журнал hard-удалений из `AuditLog`
 * (entity='operators.Operator', action='delete'). Для super_manager
 * и superadmin: кто/когда/зачем снёс оператора, сколько у него было
 * продаж за 90 дней до удаления и сколько уже восстановлено.
 *
 * Открывается через `/team/deleted-operators`. API:
 * `GET /api/operators/deleted/` (permission IsManager, но нам хватает
 * super_manager + superadmin bypass через RoleGate на фронте).
 */

interface DeletedRow {
  audit_id: number;
  operator_id: number | null;
  snapshot: {
    full_name: string;
    phone: string;
    status: string;
    hired_at: string | null;
  };
  deleted_at: string;
  deleted_by_user_id: number | null;
  deleted_by_username: string;
  comment: string;
  sales_count: number;
  sales_total: string;
  restored_sales_count: number;
  deleted_related: {
    sales_soft_deleted_count: number;
    sales_shrunk_count: number;
    sales_unlinked: number;
    lead_assignments_detached: number;
    call_attempts_detached: number;
  };
}

function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "short",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function DeletedOperators() {
  const t = useT();
  usePageHeader(
    { title: t("super_manager.deleted_ops.title") },
    [t("super_manager.deleted_ops.title")],
  );

  const q = useQuery<{ results: DeletedRow[]; count: number }>({
    queryKey: ["deleted-operators"],
    queryFn: () =>
      api.get<{ results: DeletedRow[]; count: number }>("/operators/deleted/").then(
        (r) => r.data,
      ),
    staleTime: 60_000,
  });

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<DeletedRow | null>(null);

  const rows = useMemo(() => {
    const base = q.data?.results ?? [];
    const s = search.trim().toLowerCase();
    if (!s) return base;
    return base.filter((r) => {
      const haystack = `${r.snapshot.full_name} ${r.snapshot.phone} ${r.deleted_by_username} ${r.comment}`
        .toLowerCase();
      return haystack.includes(s);
    });
  }, [q.data, search]);

  const totalSales = useMemo(
    () =>
      (q.data?.results ?? []).reduce(
        (acc, r) => acc + Number(r.sales_total || 0),
        0,
      ),
    [q.data],
  );
  const totalCount = useMemo(
    () =>
      (q.data?.results ?? []).reduce((acc, r) => acc + r.sales_count, 0),
    [q.data],
  );
  const emptyComments = useMemo(
    () => (q.data?.results ?? []).filter((r) => !r.comment).length,
    [q.data],
  );

  return (
    <div className="mx-auto max-w-[1200px] flex flex-col gap-5">
      <section className="flex flex-wrap items-center justify-between gap-3 animate-nfFadeUp">
        <div className="text-[13px] text-muted max-w-[640px]">
          {t("super_manager.deleted_ops.subtitle")}
        </div>
      </section>

      {/* KPI */}
      <section className="grid gap-3 md:grid-cols-4">
        <Card padded>
          <div className="text-[11.5px] text-muted uppercase tracking-wide">
            {t("super_manager.deleted_ops.kpi_total")}
          </div>
          <div className="text-[22px] font-semibold tracking-tight tabular-nums mt-1">
            {q.data?.count ?? 0}
          </div>
        </Card>
        <Card padded>
          <div className="text-[11.5px] text-muted uppercase tracking-wide">
            {t("super_manager.deleted_ops.kpi_sales_count")}
          </div>
          <div className="text-[22px] font-semibold tracking-tight tabular-nums mt-1">
            {totalCount}
          </div>
        </Card>
        <Card padded>
          <div className="text-[11.5px] text-muted uppercase tracking-wide">
            {t("super_manager.deleted_ops.kpi_sales_total")}
          </div>
          <div className="text-[22px] font-semibold tracking-tight tabular-nums mt-1">
            {formatUZS(totalSales)}
          </div>
        </Card>
        <Card padded>
          <div className="text-[11.5px] text-muted uppercase tracking-wide">
            {t("super_manager.deleted_ops.kpi_empty_comments")}
          </div>
          <div
            className="text-[22px] font-semibold tracking-tight tabular-nums mt-1"
            style={{
              color: emptyComments > 0 ? "var(--danger)" : undefined,
            }}
          >
            {emptyComments}
          </div>
          <div className="text-[11.5px] text-muted mt-1">
            {t("super_manager.deleted_ops.kpi_empty_hint")}
          </div>
        </Card>
      </section>

      {/* Search */}
      <section className="animate-nfFadeUp">
        <div className="relative max-w-[420px]">
          <Search
            className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: "var(--muted)" }}
          />
          <input
            className="nf-input"
            style={{ paddingLeft: 32 }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("super_manager.deleted_ops.search_ph")}
          />
        </div>
      </section>

      {/* Table */}
      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{
            gridTemplateColumns: "1.5fr 1fr 1fr .9fr 1.6fr .7fr .9fr .7fr",
          }}
        >
          <div>{t("super_manager.deleted_ops.col_operator")}</div>
          <div>{t("common.phone")}</div>
          <div>{t("super_manager.deleted_ops.col_deleted_at")}</div>
          <div>{t("super_manager.deleted_ops.col_deleted_by")}</div>
          <div>{t("super_manager.deleted_ops.col_comment")}</div>
          <div className="text-right">{t("super_manager.deleted_ops.col_sales_count")}</div>
          <div className="text-right">{t("super_manager.deleted_ops.col_sales_total")}</div>
          <div className="text-right">{t("super_manager.deleted_ops.col_restored")}</div>
        </div>

        {q.isLoading ? (
          <div className="text-center text-muted py-12 text-[13px]">
            {t("common.loading")}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center text-muted py-12 text-[13px]">
            {t("super_manager.deleted_ops.empty")}
          </div>
        ) : (
          <div>
            {rows.map((r, i) => (
              <div
                key={r.audit_id}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns:
                    "1.5fr 1fr 1fr .9fr 1.6fr .7fr .9fr .7fr",
                  animationDelay: `${0.02 + i * 0.03}s`,
                  cursor: "pointer",
                }}
                onClick={() => setSelected(r)}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className="grid place-items-center shrink-0"
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 8,
                      background: "rgba(220,60,40,.1)",
                      color: "var(--danger)",
                    }}
                  >
                    <Trash2 className="w-3 h-3" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      {r.snapshot.full_name || `#${r.operator_id}`}
                    </div>
                    {r.snapshot.status && (
                      <div className="text-[11px] text-muted">
                        {r.snapshot.status === "active"
                          ? t("op_detail.status_active_lower") || "активный"
                          : r.snapshot.status === "trainee"
                          ? t("op_detail.status_trainee_lower") || "стажёр"
                          : t("op_detail.status_inactive_lower") || "уволен"}
                      </div>
                    )}
                  </div>
                </div>
                <div className="text-[12.5px] font-mono text-muted">
                  {r.snapshot.phone || "—"}
                </div>
                <div className="text-[12.5px] text-muted">
                  {fmtDateTime(r.deleted_at)}
                </div>
                <div className="text-[12.5px]">{r.deleted_by_username}</div>
                <div className="text-[12.5px] text-muted min-w-0">
                  {r.comment ? (
                    <span className="line-clamp-2">{r.comment}</span>
                  ) : (
                    <span style={{ color: "var(--danger)" }} className="flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3 shrink-0" />
                      {t("super_manager.deleted_ops.no_comment")}
                    </span>
                  )}
                </div>
                <div className="text-right tabular-nums">
                  {r.sales_count}
                </div>
                <div className="text-right tabular-nums">
                  {formatUZS(r.sales_total)}
                </div>
                <div className="text-right">
                  {r.restored_sales_count > 0 ? (
                    <StatusBadge tone="hot">
                      {r.restored_sales_count}
                    </StatusBadge>
                  ) : (
                    <span className="text-muted text-[12px]">—</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Detail modal */}
      <Modal open={!!selected} onClose={() => setSelected(null)} width={640}>
        {selected && (
          <div className="p-7">
            <div className="flex items-center gap-2.5 mb-4">
              <div
                className="grid place-items-center"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 10,
                  background: "rgba(220,60,40,.1)",
                  color: "var(--danger)",
                }}
              >
                <Trash2 className="w-4 h-4" />
              </div>
              <div>
                <div className="text-[16px] font-semibold tracking-tight">
                  {selected.snapshot.full_name || `Operator #${selected.operator_id}`}
                </div>
                <div className="text-[12px] text-muted">
                  {t("super_manager.deleted_ops.deleted_by_at")
                    .replace("{by}", selected.deleted_by_username)
                    .replace("{at}", fmtDateTime(selected.deleted_at))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <InfoTile
                label={t("common.phone")}
                value={selected.snapshot.phone || "—"}
              />
              <InfoTile
                label={t("super_manager.deleted_ops.hired_at")}
                value={selected.snapshot.hired_at || "—"}
              />
              <InfoTile
                label={t("super_manager.deleted_ops.col_sales_count")}
                value={String(selected.sales_count)}
              />
              <InfoTile
                label={t("super_manager.deleted_ops.col_sales_total")}
                value={formatUZS(selected.sales_total)}
              />
            </div>

            <div className="mt-5">
              <div className="nf-col mb-1.5">
                {t("super_manager.deleted_ops.col_comment")}
              </div>
              <div
                className="rounded-xl px-3.5 py-2.5 text-[13px]"
                style={{
                  background: "var(--surface-2, rgba(0,0,0,.03))",
                  border: "1px solid var(--border, rgba(0,0,0,.06))",
                  color: selected.comment ? undefined : "var(--danger)",
                }}
              >
                {selected.comment || t("super_manager.deleted_ops.no_comment_long")}
              </div>
            </div>

            {selected.restored_sales_count > 0 && (
              <div
                className="mt-4 rounded-xl px-3.5 py-2.5 text-[13px]"
                style={{
                  background: "rgba(40,167,69,.08)",
                  color: "rgb(40,120,55)",
                  border: "1px solid rgba(40,167,69,.2)",
                }}
              >
                {t("super_manager.deleted_ops.restored_badge").replace(
                  "{n}",
                  String(selected.restored_sales_count),
                )}
              </div>
            )}

            <div className="mt-5">
              <div className="nf-col mb-2">
                {t("super_manager.deleted_ops.cascade_title")}
              </div>
              <div className="grid grid-cols-2 gap-2 text-[12px]">
                <CascadeRow
                  label={t("super_manager.deleted_ops.cascade_sales_soft_deleted")}
                  value={selected.deleted_related.sales_soft_deleted_count}
                  warning={
                    selected.deleted_related.sales_soft_deleted_count > 0 &&
                    selected.restored_sales_count === 0
                  }
                />
                <CascadeRow
                  label={t("super_manager.deleted_ops.cascade_sales_shrunk")}
                  value={selected.deleted_related.sales_shrunk_count}
                />
                <CascadeRow
                  label={t("super_manager.deleted_ops.cascade_leads_detached")}
                  value={selected.deleted_related.lead_assignments_detached}
                />
                <CascadeRow
                  label={t("super_manager.deleted_ops.cascade_calls_detached")}
                  value={selected.deleted_related.call_attempts_detached}
                />
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-xl px-3 py-2.5"
      style={{
        background: "var(--surface-2, rgba(0,0,0,.03))",
        border: "1px solid var(--border, rgba(0,0,0,.06))",
      }}
    >
      <div className="text-[11px] text-muted uppercase tracking-wide">
        {label}
      </div>
      <div className="text-[13px] font-medium mt-0.5">{value}</div>
    </div>
  );
}

function CascadeRow({
  label,
  value,
  warning = false,
}: {
  label: string;
  value: number;
  warning?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="text-muted">{label}</div>
      <div
        className="tabular-nums font-medium"
        style={{ color: warning && value > 0 ? "var(--danger)" : undefined }}
      >
        {value}
      </div>
    </div>
  );
}
