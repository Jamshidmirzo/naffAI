import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shuffle, Split, Users, X } from "lucide-react";
import { api } from "../lib/api";
import { apiErrorMessage } from "../lib/api-types";
import { type Lead } from "../lib/leads";
import { Button, Checkbox, Chip, Modal, StatusBadge, toast } from "../components/ui";
import { Paginator } from "../components/Paginator";
import { Select } from "../components/Select";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

type OrphanKind = "free" | "needs_review" | "stranded";

interface OrphanResponse {
  results: Lead[];
  count: number;
  kind?: OrphanKind;
  counts_by_source: Record<string, number>;
  counts_by_status: Record<string, number>;
  counts_by_kind?: Record<OrphanKind, number>;
  next: string | null;
  previous: string | null;
}

interface Operator {
  id: number;
  full_name: string;
  status: string;
}

interface SheetSource {
  id: number;
  name: string;
  active: boolean;
}

interface DistributionOperatorRow {
  id: number;
  full_name: string;
  status: string;
  working_count: number;
  postponed_count: number;
  eligible: boolean;
  reason: string;
}

interface DistributionStatusResponse {
  auto_distribution_enabled: boolean;
  rr_batch_size: number;
  orphans_count: number;
  orphans_oldest: string | null;
  operators: DistributionOperatorRow[];
}

const PAGE_SIZE = 50;

function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export default function OrphanLeads() {
  const t = useT();
  usePageHeader(
    { title: t("orphans.title"), subtitle: t("orphans.subtitle") },
    ["orphan-leads"],
  );

  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const sheetSourceId = searchParams.get("sheet_source")
    ? Number(searchParams.get("sheet_source"))
    : null;
  const statusFilter = searchParams.get("status") || "";
  const page = Number(searchParams.get("page")) || 1;
  const kindParam = (searchParams.get("kind") as OrphanKind | null) || "free";
  const kind: OrphanKind = ["free", "needs_review", "stranded"].includes(
    kindParam,
  )
    ? kindParam
    : "free";

  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [assignOpen, setAssignOpen] = useState(false);

  const setFilter = (key: string, value: string | number | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null || value === "") next.delete(key);
    else next.set(key, String(value));
    if (key !== "page") next.delete("page");
    setSearchParams(next);
  };

  const sheetSourcesQ = useQuery({
    queryKey: ["sheet-sources"],
    queryFn: async (): Promise<SheetSource[]> => {
      const { data } = await api.get<{ results?: SheetSource[] } | SheetSource[]>(
        "/sheet-sources/",
      );
      return Array.isArray(data) ? data : data.results || [];
    },
  });

  const operatorsQ = useQuery({
    queryKey: ["operators-active"],
    queryFn: async (): Promise<Operator[]> => {
      const { data } = await api.get<{ results?: Operator[] } | Operator[]>(
        "/operators/?include_inactive=0",
      );
      return Array.isArray(data) ? data : data.results || [];
    },
  });

  const orphansQ = useQuery({
    queryKey: ["orphan-leads", kind, sheetSourceId, statusFilter, page],
    queryFn: async (): Promise<OrphanResponse> => {
      const qp = new URLSearchParams();
      qp.set("kind", kind);
      // sheet_source / status фильтры имеют смысл только для kind=free
      if (kind === "free") {
        if (sheetSourceId) qp.set("sheet_source", String(sheetSourceId));
        if (statusFilter) qp.set("status", statusFilter);
      }
      qp.set("limit", String(PAGE_SIZE));
      qp.set("offset", String((page - 1) * PAGE_SIZE));
      const { data } = await api.get<OrphanResponse>(`/leads/orphans/?${qp.toString()}`);
      return data;
    },
    refetchInterval: 60_000,
  });

  const distStatusQ = useQuery({
    queryKey: ["distribution-status"],
    queryFn: async (): Promise<DistributionStatusResponse> => {
      const { data } = await api.get<DistributionStatusResponse>(
        "/leads/distribution-status/",
      );
      return data;
    },
    refetchInterval: 60_000,
  });

  const distributeNowMut = useMutation({
    mutationFn: () =>
      api.post<{ total: number; assigned: Record<string, number> }>(
        "/leads/distribute-now/",
      ),
    onSuccess: (r) => {
      const total = r.data.total;
      qc.invalidateQueries({ queryKey: ["orphan-leads"] });
      qc.invalidateQueries({ queryKey: ["orphan-leads-count"] });
      qc.invalidateQueries({ queryKey: ["distribution-status"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      if (total === 0) {
        toast(t("orphans.toast.pool_empty"));
      } else {
        toast.success(t("orphans.toast.distributed", { n: total }));
      }
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err)),
  });

  const rows = orphansQ.data?.results || [];
  const totalCount = orphansQ.data?.count || 0;
  const countsBySource = orphansQ.data?.counts_by_source || {};
  const countsByKind = orphansQ.data?.counts_by_kind || {
    free: 0,
    needs_review: 0,
    stranded: 0,
  };

  // Мутация для inline-правки телефона в needs_review — сервис
  // lead_update_phone re-normalize'ит и снимает needs_review если получилось.
  const phoneMut = useMutation({
    mutationFn: (payload: { id: number; phone_raw: string }) =>
      api.patch<Lead>(`/leads/${payload.id}/phone/`, {
        phone_raw: payload.phone_raw,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orphan-leads"] });
      qc.invalidateQueries({ queryKey: ["orphan-leads-count"] });
      toast.success("Телефон обновлён");
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err)),
  });

  useEffect(() => {
    setPicked(new Set());
  }, [kind, page, sheetSourceId, statusFilter]);

  const togglePick = (id: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (picked.size === rows.length) setPicked(new Set());
    else setPicked(new Set(rows.map((r) => r.id)));
  };

  const bulkMut = useMutation({
    mutationFn: (payload: { lead_ids: number[]; operator_id?: number; mode?: string }) =>
      api.post<{ total: number; assigned: Record<string, number> }>(
        "/leads/bulk-reassign/",
        payload,
      ),
    onSuccess: (r) => {
      const total = r.data.total;
      setPicked(new Set());
      setAssignOpen(false);
      qc.invalidateQueries({ queryKey: ["orphan-leads"] });
      qc.invalidateQueries({ queryKey: ["orphan-leads-count"] });
      qc.invalidateQueries({ queryKey: ["distribution-status"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      toast.success(t("orphans.toast.assigned", { n: total }));
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err)),
  });

  const distributeEvenly = () => {
    if (picked.size === 0) return;
    bulkMut.mutate({ lead_ids: Array.from(picked), mode: "round_robin" });
  };

  const sourceChips = useMemo(() => sheetSourcesQ.data ?? [], [sheetSourcesQ.data]);

  const distData = distStatusQ.data;
  const canDistributeNow =
    !!distData &&
    distData.auto_distribution_enabled &&
    distData.orphans_count > 0 &&
    !distributeNowMut.isPending;

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Диагностическая панель: статус распределения */}
      <DistributionStatusPanel
        data={distData}
        loading={distStatusQ.isLoading}
        canDistribute={canDistributeNow}
        onDistribute={() => distributeNowMut.mutate()}
        distributing={distributeNowMut.isPending}
      />

      {/* Kind-чипы: свободные / нужно ревью / зависли на уволенных */}
      <section className="flex flex-wrap gap-2 animate-nfFadeUp">
        <Chip
          active={kind === "free"}
          onClick={() => setFilter("kind", null)}
        >
          Свободные{" "}
          <span className="tabular-nums opacity-70">
            {countsByKind.free ?? 0}
          </span>
        </Chip>
        <Chip
          active={kind === "needs_review"}
          onClick={() => setFilter("kind", "needs_review")}
        >
          Требуют пересмотра{" "}
          <span className="tabular-nums opacity-70">
            {countsByKind.needs_review ?? 0}
          </span>
        </Chip>
        <Chip
          active={kind === "stranded"}
          onClick={() => setFilter("kind", "stranded")}
        >
          Зависли на уволенных{" "}
          <span className="tabular-nums opacity-70">
            {countsByKind.stranded ?? 0}
          </span>
        </Chip>
      </section>

      {/* Топ-бар: метрики */}
      <section className="nf-card p-5 animate-nfFadeUp">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <div>
            <div className="text-[11px] text-muted uppercase tracking-wide font-semibold">
              {t("orphans.metrics.total_label")}
            </div>
            <div className="text-[22px] font-semibold tabular-nums mt-0.5">
              {totalCount}
            </div>
          </div>
          {Object.entries(countsBySource).length > 0 && (
            <div className="flex-1 min-w-[240px]">
              <div className="text-[11px] text-muted uppercase tracking-wide font-semibold">
                {t("orphans.metrics.by_source")}
              </div>
              <div className="mt-1 flex flex-wrap gap-2 text-[12.5px]">
                {Object.entries(countsBySource).map(([name, n]) => (
                  <span key={name} className="text-muted">
                    {name}{" "}
                    <span className="text-text tabular-nums font-medium">{n}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Фильтры + toolbar (только для kind=free — иначе они бессмыслены) */}
      {kind === "free" && sourceChips.length > 0 && (
        <section className="flex flex-wrap gap-2 animate-nfFadeUp">
          <Chip
            active={sheetSourceId === null}
            onClick={() => setFilter("sheet_source", null)}
          >
            {t("orphans.chip.all_sources")}
          </Chip>
          {sourceChips.map((s) => (
            <Chip
              key={s.id}
              active={sheetSourceId === s.id}
              onClick={() => setFilter("sheet_source", s.id)}
            >
              {s.name}
            </Chip>
          ))}
        </section>
      )}

      <section className="flex flex-wrap items-center gap-3 animate-nfFadeUp">
        <div className="text-[13px] text-muted">
          {picked.size > 0 ? (
            <span className="tabular-nums">
              {t("orphans.toolbar.picked", { picked: picked.size, rows: rows.length })}
            </span>
          ) : (
            <span>
              {t("orphans.toolbar.total_prefix")}{" "}
              <span className="text-text tabular-nums">{totalCount}</span>
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            disabled={picked.size === 0 || bulkMut.isPending}
            onClick={distributeEvenly}
            variant="secondary"
          >
            <Shuffle className="w-3.5 h-3.5" /> {t("orphans.toolbar.distribute_selected")}
          </Button>
          <Button
            disabled={picked.size === 0}
            onClick={() => setAssignOpen(true)}
          >
            <Users className="w-3.5 h-3.5" /> {t("orphans.toolbar.assign_op")}
          </Button>
          {picked.size > 0 && (
            <button
              className="nf-btn nf-btn--ghost"
              style={{ padding: "9px 14px" }}
              onClick={() => setPicked(new Set())}
            >
              <X className="w-3.5 h-3.5" /> {t("orphans.toolbar.clear_selection")}
            </button>
          )}
        </div>
      </section>

      {/* Таблица */}
      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col items-center"
          style={{ gridTemplateColumns: "38px 1.3fr 1fr .8fr .8fr .8fr" }}
        >
          <div>
            <Checkbox
              checked={rows.length > 0 && picked.size === rows.length}
              onChange={toggleAll}
              aria-label={t("orphans.table.select_all_aria")}
            />
          </div>
          <div>{t("orphans.table.col.lead")}</div>
          <div>{t("orphans.table.col.source")}</div>
          <div>{t("orphans.table.col.status")}</div>
          <div>{t("orphans.table.col.product")}</div>
          <div className="text-right">{t("orphans.table.col.created")}</div>
        </div>

        {orphansQ.isLoading ? (
          <div className="text-center text-muted py-16 text-[13px]">{t("orphans.loading")}</div>
        ) : rows.length === 0 ? (
          <div className="text-center text-muted py-16 text-[13px]">
            {t("orphans.empty")}
          </div>
        ) : (
          <div>
            {rows.map((lead, i) => {
              const isPicked = picked.has(lead.id);
              return (
                <div
                  key={lead.id}
                  onClick={() => togglePick(lead.id)}
                  className="nf-row animate-nfFadeUp"
                  style={{
                    gridTemplateColumns: "38px 1.3fr 1fr .8fr .8fr .8fr",
                    animationDelay: `${0.02 + i * 0.03}s`,
                    background: isPicked ? "var(--faint)" : undefined,
                  }}
                >
                  <div onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={isPicked}
                      onChange={() => togglePick(lead.id)}
                    />
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      {lead.full_name || <span className="text-muted">—</span>}
                    </div>
                    {kind === "needs_review" ? (
                      <PhoneInlineEdit
                        lead={lead}
                        saving={phoneMut.isPending}
                        onSave={(phone_raw) =>
                          phoneMut.mutate({ id: lead.id, phone_raw })
                        }
                      />
                    ) : (
                      <div className="text-[12px] text-muted truncate">
                        {lead.phone || (
                          <span style={{ color: "var(--danger)" }}>
                            {lead.phone_raw || t("orphans.table.no_phone")}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="text-muted truncate">
                    {lead.sheet_source_name || "—"}
                  </div>
                  <div>
                    <StatusBadge tone="neutral">{lead.status}</StatusBadge>
                  </div>
                  <div className="truncate text-[12.5px]">
                    {lead.product_hint || (
                      <span className="text-muted">—</span>
                    )}
                  </div>
                  <div className="text-right text-muted tabular-nums text-[12.5px]">
                    {fmtDateTime(lead.created_at)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="flex justify-center">
        <Paginator
          page={page}
          total={totalCount}
          pageSize={PAGE_SIZE}
          onChange={(p) => setFilter("page", p > 1 ? p : null)}
        />
      </div>

      <AssignModal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        pickedIds={Array.from(picked)}
        operators={operatorsQ.data || []}
        onSubmit={(operatorId) =>
          bulkMut.mutate({
            lead_ids: Array.from(picked),
            operator_id: operatorId,
          })
        }
        submitting={bulkMut.isPending}
      />
    </div>
  );
}

function DistributionStatusPanel({
  data,
  loading,
  canDistribute,
  onDistribute,
  distributing,
}: {
  data: DistributionStatusResponse | undefined;
  loading: boolean;
  canDistribute: boolean;
  onDistribute: () => void;
  distributing: boolean;
}) {
  const t = useT();
  if (loading && !data) {
    return (
      <section className="nf-card p-5 animate-nfFadeUp text-[13px] text-muted">
        {t("orphans.dist.loading")}
      </section>
    );
  }
  if (!data) return null;

  const eligibleCount = data.operators.filter((o) => o.eligible).length;
  const totalOps = data.operators.length;

  const badgeFor = (row: DistributionOperatorRow) => {
    if (row.eligible) return { tone: "hot" as const, label: t("orphans.dist.badge.ok") };
    if (row.reason.startsWith("Квота"))
      return { tone: "neutral" as const, label: t("orphans.dist.badge.quota") };
    if (row.reason.includes("morning-gate"))
      return { tone: "danger" as const, label: t("orphans.dist.badge.gate") };
    if (row.reason.includes("не в статусе"))
      return { tone: "danger" as const, label: t("orphans.dist.badge.disabled") };
    return { tone: "neutral" as const, label: t("orphans.dist.badge.dash") };
  };

  return (
    <section className="nf-card p-5 animate-nfFadeUp">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold tracking-tight">
            {t("orphans.dist.title")}
          </div>
          <div className="text-[12.5px] text-muted mt-1">
            {(() => {
              const stateStr = data.auto_distribution_enabled
                ? t("orphans.dist.state_on")
                : t("orphans.dist.state_off");
              const meta = t("orphans.dist.meta", {
                batch: data.rr_batch_size,
                state: stateStr,
                eligible: eligibleCount,
                total: totalOps,
              });
              // Emphasize the on/off state with color while preserving translated meta.
              const parts = meta.split(stateStr);
              return (
                <>
                  {parts[0]}
                  <b
                    className="text-text"
                    style={{
                      color: data.auto_distribution_enabled
                        ? "var(--accent, #16a34a)"
                        : "var(--danger)",
                    }}
                  >
                    {stateStr}
                  </b>
                  {parts.slice(1).join(stateStr)}
                </>
              );
            })()}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <Button
            variant="secondary"
            disabled={!canDistribute}
            onClick={onDistribute}
            title={
              !data.auto_distribution_enabled
                ? t("orphans.dist.tooltip_disabled")
                : data.orphans_count === 0
                ? t("orphans.dist.tooltip_empty")
                : t("orphans.dist.tooltip_action")
            }
          >
            <Split className="w-3.5 h-3.5" />
            {distributing
              ? t("orphans.dist.distributing")
              : t("orphans.dist.distribute_all", { n: data.orphans_count })}
          </Button>
        </div>
      </div>

      {!data.auto_distribution_enabled && (
        <div
          className="mt-4 rounded-xl px-3.5 py-2.5 text-[12.5px]"
          style={{
            background: "rgba(220,60,40,.08)",
            color: "var(--danger)",
            border: "1px solid rgba(220,60,40,.2)",
          }}
        >
          {t("orphans.dist.auto_off_warning")}
        </div>
      )}

      {totalOps === 0 ? (
        <div className="mt-4 text-[13px] text-muted">
          {t("orphans.dist.no_operators")}
        </div>
      ) : (
        <div className="mt-4 overflow-hidden">
          <div
            className="grid gap-2 px-3 pb-2 nf-col items-center text-[11px] uppercase tracking-wide"
            style={{ gridTemplateColumns: "1.4fr .5fr .5fr .6fr 1.5fr" }}
          >
            <div>{t("orphans.dist.col.operator")}</div>
            <div className="text-right">{t("orphans.dist.col.working")}</div>
            <div className="text-right">{t("orphans.dist.col.postponed")}</div>
            <div>{t("orphans.dist.col.status")}</div>
            <div>{t("orphans.dist.col.reason")}</div>
          </div>
          <div>
            {data.operators.map((row) => {
              const b = badgeFor(row);
              return (
                <div
                  key={row.id}
                  className="grid gap-2 items-center py-2.5 px-3 border-t text-[13px]"
                  style={{
                    gridTemplateColumns: "1.4fr .5fr .5fr .6fr 1.5fr",
                    borderColor: "var(--border, rgba(0,0,0,.06))",
                    background: row.eligible ? undefined : "var(--faint, rgba(0,0,0,.02))",
                  }}
                >
                  <div className="font-medium truncate">{row.full_name}</div>
                  <div className="text-right tabular-nums">{row.working_count}</div>
                  <div
                    className="text-right tabular-nums"
                    style={{ color: row.postponed_count ? undefined : "var(--muted)" }}
                  >
                    {row.postponed_count || "—"}
                  </div>
                  <div>
                    <StatusBadge tone={b.tone}>{b.label}</StatusBadge>
                  </div>
                  <div
                    className="text-[12.5px] truncate"
                    style={{ color: row.eligible ? "var(--muted)" : "var(--text)" }}
                    title={row.reason}
                  >
                    {row.reason}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}


function AssignModal({
  open,
  onClose,
  pickedIds,
  operators,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onClose: () => void;
  pickedIds: number[];
  operators: Operator[];
  onSubmit: (operatorId: number) => void;
  submitting: boolean;
}) {
  const t = useT();
  const [opId, setOpId] = useState<string>("");

  useEffect(() => {
    if (open) setOpId(operators[0]?.id ? String(operators[0].id) : "");
  }, [open, operators]);

  return (
    <Modal open={open} onClose={onClose} width={460}>
      <div className="p-7">
        <div className="text-[18px] font-semibold tracking-tight">
          {t("orphans.assign_modal.title", { n: pickedIds.length })}
        </div>
        <p className="text-[13px] text-muted mt-1">
          {t("orphans.assign_modal.hint")}
        </p>
        <div className="mt-6 flex flex-col gap-4">
          <div>
            <div className="nf-col mb-1.5">{t("orphans.assign_modal.op_label")}</div>
            <Select<string>
              value={opId}
              onChange={(v) => setOpId(v)}
              options={operators.map((o) => ({
                value: String(o.id),
                label: o.full_name,
              }))}
              placeholder={t("orphans.assign_modal.op_label")}
              ariaLabel={t("orphans.assign_modal.op_label")}
              searchable={operators.length > 8}
            />
          </div>
        </div>
        <div className="mt-7 flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t("orphans.assign_modal.cancel")}
          </Button>
          <Button
            onClick={() => opId && onSubmit(Number(opId))}
            disabled={submitting || !opId}
          >
            {submitting ? t("orphans.assign_modal.saving") : t("orphans.assign_modal.submit")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}


/**
 * Inline-редактор телефона на строке сироты с needs_review=True.
 * Мини-паттерн «показать текущее значение → клик → input с save/cancel».
 * PATCH /leads/{id}/phone/ — backend re-normalize'ит и снимает needs_review
 * если получилось.
 */
function PhoneInlineEdit({
  lead,
  saving,
  onSave,
}: {
  lead: Lead;
  saving: boolean;
  onSave: (phone_raw: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(lead.phone_raw || lead.phone || "");

  useEffect(() => {
    setValue(lead.phone_raw || lead.phone || "");
  }, [lead.id, lead.phone_raw, lead.phone]);

  if (!editing) {
    return (
      <div
        className="text-[12px] truncate cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        title="Клик — исправить телефон"
      >
        {lead.phone ? (
          <span className="text-muted">{lead.phone}</span>
        ) : (
          <span style={{ color: "var(--danger)" }}>
            {lead.phone_raw || "нет телефона"} · клик для правки
          </span>
        )}
      </div>
    );
  }
  return (
    <div
      className="flex items-center gap-1.5 mt-0.5"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        className="nf-input"
        style={{ padding: "4px 8px", fontSize: 12, width: 160 }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="+998..."
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onSave(value);
            setEditing(false);
          } else if (e.key === "Escape") {
            setEditing(false);
            setValue(lead.phone_raw || lead.phone || "");
          }
        }}
      />
      <button
        className="nf-btn"
        style={{ padding: "4px 8px", fontSize: 11 }}
        disabled={saving || !value.trim()}
        onClick={() => {
          onSave(value);
          setEditing(false);
        }}
      >
        OK
      </button>
      <button
        className="nf-btn nf-btn--ghost"
        style={{ padding: "4px 8px", fontSize: 11 }}
        onClick={() => {
          setEditing(false);
          setValue(lead.phone_raw || lead.phone || "");
        }}
      >
        ×
      </button>
    </div>
  );
}
