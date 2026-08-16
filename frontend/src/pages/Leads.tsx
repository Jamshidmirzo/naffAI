import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Search, Users, X } from "lucide-react";
import { apiErrorMessage } from "../lib/api-types";
import { api } from "../lib/api";
import { type Lead } from "../lib/leads";
import { useLeadStatusInfo } from "../hooks/useLeadStatuses";
import { Paginator } from "../components/Paginator";
import { formatDate } from "../lib/format";
import { Button, Checkbox, Chip, Modal, StatusBadge, toast } from "../components/ui";
import { Select } from "../components/Select";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

type PagedLeads = { results: Lead[]; count?: number } | Lead[];
type Operator = { id: number; full_name: string; status: string };
type SheetSource = { id: number; name: string; gid: number; active: boolean };
type QuickFilter = "all" | "review" | "unassigned";

const PAGE_SIZE = 50;

function isCallbackOverdue(iso: string | null | undefined) {
  if (!iso) return false;
  try {
    return new Date(iso).getTime() < Date.now();
  } catch {
    return false;
  }
}

function fmtCallback(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

export default function Leads() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const t = useT();
  usePageHeader({ title: t("leads.title"), subtitle: t("leads.subtitle") }, [t("leads.title")]);

  const QUICK_FILTERS: { key: QuickFilter; label: string }[] = [
    { key: "all", label: t("leads.tab_all") },
    { key: "review", label: t("leads.tab_review") },
    { key: "unassigned", label: t("leads.tab_unassigned") },
  ];

  const quick: QuickFilter = searchParams.get("needs_review") === "1"
    ? "review"
    : searchParams.get("unassigned") === "1"
      ? "unassigned"
      : "all";
  const search = searchParams.get("search") || "";
  const sheetSourceId = searchParams.get("sheet_source")
    ? Number(searchParams.get("sheet_source"))
    : null;
  const page = Number(searchParams.get("page")) || 1;

  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [assignOpen, setAssignOpen] = useState(false);

  const setQuick = (q: QuickFilter) => {
    const next = new URLSearchParams(searchParams);
    next.delete("needs_review");
    next.delete("unassigned");
    if (q === "review") next.set("needs_review", "1");
    if (q === "unassigned") next.set("unassigned", "1");
    next.delete("page");
    setSearchParams(next);
  };

  const setFilter = (key: string, value: string | number | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null || value === "") next.delete(key);
    else next.set(key, String(value));
    if (key !== "page") next.delete("page");
    setSearchParams(next);
  };

  const sheetSources = useQuery({
    queryKey: ["sheet-sources"],
    queryFn: async (): Promise<SheetSource[]> => {
      const { data } = await api.get<{ results?: SheetSource[] } | SheetSource[]>(
        "/sheet-sources/",
      );
      return Array.isArray(data) ? data : data.results || [];
    },
  });

  const leads = useQuery({
    queryKey: ["leads", quick, search, sheetSourceId, page],
    queryFn: async (): Promise<{ results: Lead[]; count: number }> => {
      const qp = new URLSearchParams();
      if (quick === "review") qp.set("needs_review", "1");
      if (quick === "unassigned") qp.set("unassigned", "1");
      if (search) qp.set("search", search);
      if (sheetSourceId) qp.set("sheet_source", String(sheetSourceId));
      qp.set("page", String(page));
      qp.set("page_size", String(PAGE_SIZE));
      const { data } = await api.get<PagedLeads>(`/leads/?${qp.toString()}`);
      if (Array.isArray(data)) return { results: data, count: data.length };
      return { results: data.results || [], count: data.count || (data.results || []).length };
    },
    refetchInterval: 60_000,
  });

  const operators = useQuery({
    queryKey: ["operators-active"],
    queryFn: async (): Promise<Operator[]> => {
      const { data } = await api.get<{ results?: Operator[] } | Operator[]>(
        "/operators/?include_inactive=0",
      );
      return Array.isArray(data) ? data : data.results || [];
    },
  });

  const rows = leads.data?.results || [];
  const totalCount = leads.data?.count || 0;

  useEffect(() => {
    setPicked(new Set());
  }, [page, quick, search, sheetSourceId]);

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

  const summary = useMemo(() => {
    const overdue = rows.filter((r) => isCallbackOverdue((r as unknown as { callback_at?: string }).callback_at))
      .length;
    return { overdue };
  }, [rows]);

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Sheet-source tabs */}
      {(sheetSources.data?.length ?? 0) > 0 && (
        <section className="flex flex-wrap gap-2 animate-nfFadeUp">
          <Chip active={sheetSourceId === null} onClick={() => setFilter("sheet_source", null)}>
            {t("leads.all_sources")}
          </Chip>
          {(sheetSources.data || []).map((s) => (
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

      {/* Toolbar */}
      <section className="flex flex-wrap items-center gap-3 animate-nfFadeUp">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            className="nf-input pl-11"
            placeholder={t("leads.search_ph")}
            value={search}
            onChange={(e) => setFilter("search", e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {QUICK_FILTERS.map((f) => (
            <Chip key={f.key} active={quick === f.key} onClick={() => setQuick(f.key)}>
              {f.label}
            </Chip>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="text-[13px] text-muted">
            {picked.size > 0 ? (
              <span className="tabular-nums">{t("leads.picked", { n: picked.size })}</span>
            ) : (
              <span>
                {t("common.total")}: <span className="text-text tabular-nums">{totalCount}</span>
                {summary.overdue > 0 && (
                  <>
                    {" · "}
                    <span style={{ color: "var(--accent)" }} className="tabular-nums">
                      {t("leads.overdue", { n: summary.overdue })}
                    </span>
                  </>
                )}
              </span>
            )}
          </div>
          <Button
            disabled={picked.size === 0}
            onClick={() => setAssignOpen(true)}
          >
            <Users className="w-3.5 h-3.5" /> {t("leads.assign")}
          </Button>
          {picked.size > 0 && (
            <button
              className="nf-btn nf-btn--ghost"
              style={{ padding: "9px 14px" }}
              onClick={() => setPicked(new Set())}
            >
              <X className="w-3.5 h-3.5" /> {t("leads.clear_selection")}
            </button>
          )}
        </div>
      </section>

      {/* Table */}
      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col items-center"
          style={{ gridTemplateColumns: "38px 1.2fr 1fr 1fr .9fr .8fr .9fr" }}
        >
          <div>
            <Checkbox
              checked={rows.length > 0 && picked.size === rows.length}
              onChange={toggleAll}
              aria-label={t("leads.select_all")}
            />
          </div>
          <div>{t("leads.col_lead")}</div>
          <div>{t("leads.col_source")}</div>
          <div>{t("common.operator")}</div>
          <div>{t("common.status")}</div>
          <div className="text-right">{t("leads.col_calls")}</div>
          <div className="text-right">{t("leads.col_callback")}</div>
        </div>

        {leads.isLoading ? (
          <div className="text-center text-muted py-16 text-[13px]">{t("common.loading")}</div>
        ) : rows.length === 0 ? (
          <div className="text-center text-muted py-16 text-[13px]">{t("leads.empty")}</div>
        ) : (
          <div>
            {rows.map((lead, i) => {
              const isPicked = picked.has(lead.id);
              const cbAt = (lead as unknown as { callback_at?: string }).callback_at;
              const overdue = isCallbackOverdue(cbAt);
              const calls = (lead as unknown as { calls_count?: number }).calls_count ?? 0;
              const source = (lead as unknown as { source_name?: string }).source_name ?? "—";
              return (
                <div
                  key={lead.id}
                  onClick={() => togglePick(lead.id)}
                  className="nf-row animate-nfFadeUp"
                  style={{
                    gridTemplateColumns: "38px 1.2fr 1fr 1fr .9fr .8fr .9fr",
                    animationDelay: `${0.02 + i * 0.035}s`,
                    background: isPicked ? "var(--faint)" : undefined,
                  }}
                >
                  <div onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={isPicked} onChange={() => togglePick(lead.id)} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium truncate">
                      {lead.needs_review && (
                        <AlertTriangle
                          className="w-3.5 h-3.5 shrink-0"
                          style={{ color: "var(--accent)" }}
                        />
                      )}
                      {lead.full_name || <span className="text-muted">—</span>}
                    </div>
                    <div className="text-[12px] text-muted truncate">
                      {lead.phone || (
                        <span style={{ color: "var(--danger)" }}>{lead.phone_raw || t("leads.no_phone")}</span>
                      )}
                    </div>
                    {lead.product_hint && (
                      <div
                        className="mt-0.5 text-[11.5px] font-medium truncate"
                        style={{ color: "var(--accent)" }}
                        title={lead.product_hint}
                      >
                        📱 {lead.product_hint}
                      </div>
                    )}
                  </div>
                  <div className="text-muted truncate">{source}</div>
                  <div className="truncate">
                    {lead.operator_name || (
                      <span className="text-muted">{t("leads.unassigned_lower")}</span>
                    )}
                  </div>
                  <div>
                    <LeadRowStatus code={lead.status} />
                  </div>
                  <div className="text-right text-muted tabular-nums">{calls}</div>
                  <div
                    className="text-right tabular-nums text-[12.5px]"
                    style={overdue ? { color: "var(--accent)", fontWeight: 600 } : undefined}
                  >
                    {cbAt ? fmtCallback(cbAt) : <span className="text-muted">—</span>}
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
        operators={operators.data || []}
        onDone={() => {
          setAssignOpen(false);
          setPicked(new Set());
          qc.invalidateQueries({ queryKey: ["leads"] });
          toast.success(t("leads.op_assigned"));
        }}
      />
    </div>
  );
}

function AssignModal({
  open,
  onClose,
  pickedIds,
  operators,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  pickedIds: number[];
  operators: Operator[];
  onDone: () => void;
}) {
  const [opId, setOpId] = useState<string>("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const t = useT();

  useEffect(() => {
    if (open) {
      setOpId(operators[0]?.id ? String(operators[0].id) : "");
      setReason("");
      setError("");
    }
  }, [open, operators]);

  const mut = useMutation({
    mutationFn: async () => {
      if (!opId) throw new Error(t("leads.pick_operator"));
      const opNum = Number(opId);
      // Sequential — matches existing single-lead reassign endpoint.
      for (const id of pickedIds) {
        await api.post(`/leads/${id}/reassign/`, { operator_id: opNum, reason });
      }
    },
    onSuccess: onDone,
    onError: (err) => setError(apiErrorMessage(err)),
  });

  return (
    <Modal open={open} onClose={onClose} width={480}>
      <div className="p-7">
        <div className="text-[18px] font-semibold tracking-tight">
          {t("leads.assign")} · {pickedIds.length}
        </div>
        <p className="text-[13px] text-muted mt-1">
          {pickedIds.length === 1
            ? t("leads.reassign_one")
            : t("leads.reassign_many", { n: pickedIds.length })}
        </p>

        <div className="mt-6 flex flex-col gap-4">
          <div>
            <div className="nf-col mb-1.5">{t("common.operator")}</div>
            <Select<string>
              value={opId}
              onChange={(v) => setOpId(v)}
              options={operators.map((o) => ({
                value: String(o.id),
                label: o.full_name,
              }))}
              placeholder={t("common.operator")}
              ariaLabel={t("common.operator")}
              searchable={operators.length > 8}
            />
          </div>
          <div>
            <div className="nf-col mb-1.5">{t("leads.reason_optional")}</div>
            <input
              className="nf-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("leads.reason_ph")}
            />
          </div>
          {error && (
            <div
              className="text-[13px] rounded-xl px-3.5 py-2.5"
              style={{
                background: "rgba(220,60,40,.08)",
                color: "var(--danger)",
                border: "1px solid rgba(220,60,40,.2)",
              }}
            >
              {error}
            </div>
          )}
        </div>

        <div className="mt-7 flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !opId}>
            {mut.isPending ? t("common.saving") : t("leads.assign_short")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function LeadRowStatus({ code }: { code: string }) {
  const info = useLeadStatusInfo(code);
  const tone: "hot" | "danger" | "neutral" =
    info.tone === "danger"
      ? "danger"
      : info.tone === "hot" || info.tone === "success" || info.tone === "info"
      ? "hot"
      : "neutral";
  return (
    <StatusBadge tone={tone}>
      {info.emoji ? `${info.emoji} ${info.label}` : info.label}
    </StatusBadge>
  );
}
