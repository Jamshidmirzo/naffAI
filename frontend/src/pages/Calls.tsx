import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Phone } from "lucide-react";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { MultiSelectPopover } from "../components/MultiSelectPopover";
import { Chip, StatusBadge } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

// --- types ----------------------------------------------------------------

type CallRow = {
  id: number;
  lead: number | null;
  lead_name: string;
  lead_phone: string;
  operator: number | null;
  operator_name: string;
  outcome: string;
  comment: string;
  source: string;
  phone_number: string;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  has_recording: boolean;
  recording_url: string;
  created_at: string;
};

type CallsListResponse = {
  results: CallRow[];
  next_cursor: number | null;
  total: number;
};

type CallsStats = {
  total_calls: number;
  avg_duration_seconds: number | null;
  with_recording: number;
  recording_pct: number;
  answered: number;
  answered_pct: number;
  by_outcome: Record<string, number>;
  top_operators: {
    operator_id: number;
    operator_name: string;
    count: number;
  }[];
};

type Paginated<T> = { count: number; next: string | null; results: T[] };
type OperatorOption = { id: number; full_name: string };

// --- helpers --------------------------------------------------------------

function isoToday(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const DATE_PRESETS: {
  key: string;
  label: string;
  range: () => { from: string; to: string };
}[] = [
  {
    key: "today",
    label: "Сегодня",
    range: () => ({ from: isoToday(), to: isoToday() }),
  },
  {
    key: "yesterday",
    label: "Вчера",
    range: () => ({ from: isoToday(-1), to: isoToday(-1) }),
  },
  {
    key: "week",
    label: "7 дней",
    range: () => ({ from: isoToday(-6), to: isoToday() }),
  },
  {
    key: "month_30",
    label: "30 дней",
    range: () => ({ from: isoToday(-29), to: isoToday() }),
  },
  {
    key: "this_month",
    label: "Этот месяц",
    range: () => {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const y = first.getFullYear();
      const m = String(first.getMonth() + 1).padStart(2, "0");
      return { from: `${y}-${m}-01`, to: isoToday() };
    },
  },
];

const OUTCOME_TABS: {
  key: string;
  labelKey: string;
  outcomes: string[]; // codes to filter with; [] = no filter
}[] = [
  { key: "", labelKey: "calls.filter.outcome_all", outcomes: [] },
  {
    key: "talked",
    labelKey: "calls.filter.outcome_talked",
    outcomes: ["talked_interested", "talked_callback"],
  },
  { key: "no_answer", labelKey: "calls.filter.outcome_no_answer", outcomes: ["no_answer"] },
  { key: "rejected", labelKey: "calls.filter.outcome_rejected", outcomes: ["rejected"] },
  {
    key: "other",
    labelKey: "calls.filter.outcome_other",
    outcomes: ["wrong_number", "tg_only"],
  },
  { key: "empty", labelKey: "calls.filter.outcome_empty", outcomes: ["empty"] },
];

function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

function outcomeBadge(code: string) {
  switch (code) {
    case "talked_interested":
      return <StatusBadge>Разговор, интерес</StatusBadge>;
    case "talked_callback":
      return <StatusBadge>Перезвонить</StatusBadge>;
    case "no_answer":
      return <StatusBadge tone="hot">Не берёт</StatusBadge>;
    case "wrong_number":
      return <StatusBadge tone="danger">Не тот номер</StatusBadge>;
    case "rejected":
      return <StatusBadge tone="danger">Отказ</StatusBadge>;
    case "tg_only":
      return <StatusBadge>TG</StatusBadge>;
    case "":
      return <StatusBadge tone="hot">Без результата</StatusBadge>;
    default:
      return <StatusBadge>{code || "—"}</StatusBadge>;
  }
}

// --- page -----------------------------------------------------------------

export default function Calls() {
  const t = useT();
  usePageHeader({ title: t("calls.title"), subtitle: t("calls.subtitle") }, [t("calls.title")]);

  const [searchParams, setSearchParams] = useSearchParams();
  const dateFrom = searchParams.get("date_from") || "";
  const dateTo = searchParams.get("date_to") || "";
  const outcomeTab = searchParams.get("outcome_tab") || "";
  const operatorIds = searchParams
    .getAll("operator")
    .map(Number)
    .filter(Boolean);

  // Default range to last 7 days on first mount if nothing supplied.
  useEffect(() => {
    if (!dateFrom && !dateTo) {
      const next = new URLSearchParams(searchParams);
      const r = DATE_PRESETS[2].range();
      next.set("date_from", r.from);
      next.set("date_to", r.to);
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (patch: Record<string, string | string[] | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      next.delete(k);
      if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
      if (Array.isArray(v)) v.forEach((val) => next.append(k, String(val)));
      else next.set(k, String(v));
    }
    setSearchParams(next);
  };

  const outcomes = useMemo(() => {
    const tab = OUTCOME_TABS.find((o) => o.key === outcomeTab);
    return tab?.outcomes ?? [];
  }, [outcomeTab]);

  // Build query params for list + stats.
  const listParams = useMemo(() => {
    const p = new URLSearchParams();
    if (dateFrom) p.set("date_from", dateFrom);
    if (dateTo) p.set("date_to", dateTo);
    for (const id of operatorIds) p.append("operator", String(id));
    for (const o of outcomes) p.append("outcome", o);
    p.set("limit", "50");
    return p;
  }, [dateFrom, dateTo, operatorIds.join(","), outcomes.join(",")]);

  const statsParams = useMemo(() => {
    const p = new URLSearchParams();
    if (dateFrom) p.set("date_from", dateFrom);
    if (dateTo) p.set("date_to", dateTo);
    for (const id of operatorIds) p.append("operator", String(id));
    return p;
  }, [dateFrom, dateTo, operatorIds.join(",")]);

  // --- data ----------------------------------------------------------------

  const [cursor, setCursor] = useState<number | null>(null);
  const [accumulated, setAccumulated] = useState<CallRow[]>([]);

  // Reset accumulated list when filters change.
  useEffect(() => {
    setCursor(null);
    setAccumulated([]);
  }, [listParams.toString()]);

  const listQuery = useQuery<CallsListResponse>({
    queryKey: ["calls-list", listParams.toString(), cursor],
    queryFn: () => {
      const p = new URLSearchParams(listParams);
      if (cursor != null) p.set("cursor", String(cursor));
      return api.get(`/calls/?${p.toString()}`).then((r) => r.data);
    },
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    if (!listQuery.data) return;
    setAccumulated((prev) => {
      const seen = new Set(prev.map((r) => r.id));
      const merged = [...prev];
      for (const row of listQuery.data!.results) {
        if (!seen.has(row.id)) merged.push(row);
      }
      return merged;
    });
  }, [listQuery.data]);

  const statsQuery = useQuery<CallsStats>({
    queryKey: ["calls-stats", statsParams.toString()],
    queryFn: () =>
      api.get(`/calls/stats/?${statsParams.toString()}`).then((r) => r.data),
    placeholderData: (prev) => prev,
  });

  const operatorsQuery = useQuery<Paginated<OperatorOption>>({
    queryKey: ["operators-list-calls"],
    queryFn: () => api.get("/operators/", { params: { limit: 200 } }).then((r) => r.data),
  });

  const operatorOptions = useMemo(
    () =>
      (operatorsQuery.data?.results || []).map((o) => ({
        id: o.id,
        name: o.full_name,
      })),
    [operatorsQuery.data],
  );

  const nextCursor = listQuery.data?.next_cursor ?? null;
  const total = listQuery.data?.total ?? 0;

  // --- detail modal --------------------------------------------------------
  const [detailId, setDetailId] = useState<number | null>(null);
  const detailRow = useMemo(
    () => accumulated.find((r) => r.id === detailId) || null,
    [detailId, accumulated],
  );

  // --- render --------------------------------------------------------------

  const stats = statsQuery.data;

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* KPI cards */}
      <section className="grid gap-3 grid-cols-2 md:grid-cols-4 animate-nfFadeUp">
        <div className="nf-card p-5">
          <div className="nf-col mb-1">{t("calls.kpi.total")}</div>
          <div className="text-[22px] font-semibold tabular-nums">
            {stats?.total_calls ?? 0}
          </div>
        </div>
        <div className="nf-card p-5">
          <div className="nf-col mb-1">{t("calls.kpi.avg_duration")}</div>
          <div className="text-[22px] font-semibold tabular-nums">
            {fmtDuration(stats?.avg_duration_seconds ?? null)}
          </div>
        </div>
        <div className="nf-card p-5">
          <div className="nf-col mb-1">{t("calls.kpi.with_recording")}</div>
          <div className="text-[22px] font-semibold tabular-nums">
            {stats ? `${Math.round(stats.recording_pct)}%` : "0%"}
          </div>
          <div className="text-[11px] text-muted mt-1">
            {stats?.with_recording ?? 0} шт
          </div>
        </div>
        <div className="nf-card p-5">
          <div className="nf-col mb-1">{t("calls.kpi.answered")}</div>
          <div className="text-[22px] font-semibold tabular-nums">
            {stats ? `${Math.round(stats.answered_pct)}%` : "0%"}
          </div>
          <div className="text-[11px] text-muted mt-1">
            {stats?.answered ?? 0} шт
          </div>
        </div>
      </section>

      {/* Toolbar */}
      <section className="nf-card p-5 flex flex-col gap-3 animate-nfFadeUp">
        <div className="flex flex-wrap items-center gap-2">
          {DATE_PRESETS.map((p) => {
            const r = p.range();
            const active = dateFrom === r.from && dateTo === r.to;
            return (
              <Chip
                key={p.key}
                active={active}
                onClick={() => update({ date_from: r.from, date_to: r.to })}
              >
                {p.label}
              </Chip>
            );
          })}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <input
              type="date"
              className="nf-input"
              value={dateFrom}
              onChange={(e) => update({ date_from: e.target.value })}
              style={{ padding: "8px 10px", width: 150 }}
            />
            <input
              type="date"
              className="nf-input"
              value={dateTo}
              onChange={(e) => update({ date_to: e.target.value })}
              style={{ padding: "8px 10px", width: 150 }}
            />
            <MultiSelectPopover
              label={t("calls.filter.operators")}
              options={operatorOptions}
              selectedIds={operatorIds}
              onChange={(ids) => update({ operator: ids.map(String) })}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {OUTCOME_TABS.map((o) => (
            <Chip
              key={o.key}
              active={outcomeTab === o.key}
              onClick={() => update({ outcome_tab: o.key || null })}
            >
              {t(o.labelKey)}
            </Chip>
          ))}
        </div>
      </section>

      {/* Table */}
      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{
            gridTemplateColumns: "160px 1.1fr 1.4fr 100px 1fr 100px",
          }}
        >
          <div>{t("calls.col.time")}</div>
          <div>{t("calls.col.operator")}</div>
          <div>{t("calls.col.lead")}</div>
          <div className="text-right">{t("calls.col.duration")}</div>
          <div>{t("calls.col.outcome")}</div>
          <div className="text-center">{t("calls.col.recording")}</div>
        </div>

        {listQuery.isLoading && accumulated.length === 0 ? (
          <div className="text-center text-muted py-16 text-[13px]">Загрузка…</div>
        ) : accumulated.length === 0 ? (
          <div className="text-center text-muted py-16 text-[13px]">
            {t("calls.empty")}
          </div>
        ) : (
          <div>
            {accumulated.map((row, i) => (
              <div
                key={row.id}
                onClick={() => setDetailId(row.id)}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns: "160px 1.1fr 1.4fr 100px 1fr 100px",
                  animationDelay: `${Math.min(0.03 + i * 0.02, 0.6)}s`,
                }}
              >
                <div className="text-muted tabular-nums text-[12px]">
                  {formatDateTime(row.started_at || row.created_at)}
                </div>
                <div className="truncate font-medium">
                  {row.operator_name || "—"}
                </div>
                <div className="truncate">
                  {row.lead ? (
                    <Link
                      to={`/leads/${row.lead}`}
                      onClick={(e) => e.stopPropagation()}
                      className="hover:underline"
                    >
                      {row.lead_name || "—"}
                    </Link>
                  ) : (
                    row.lead_name || "—"
                  )}
                  <div className="text-[11px] text-muted font-mono">
                    {row.phone_number || row.lead_phone || ""}
                  </div>
                </div>
                <div className="text-right tabular-nums">
                  {fmtDuration(row.duration_seconds)}
                </div>
                <div>{outcomeBadge(row.outcome)}</div>
                <div className="text-center">
                  {row.has_recording ? (
                    <audio
                      src={row.recording_url}
                      controls
                      onClick={(e) => e.stopPropagation()}
                      style={{ height: 28, maxWidth: 100 }}
                    />
                  ) : (
                    <span className="text-muted text-[12px]">
                      {t("calls.recording_none")}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {total > 0 && (
          <div
            className="flex items-center justify-between px-6 py-4 text-[13px]"
            style={{ borderTop: "1px solid var(--border)" }}
          >
            <div className="text-muted tabular-nums">
              {accumulated.length} / {total}
            </div>
            {nextCursor != null && (
              <button
                type="button"
                className="nf-btn nf-btn--ghost"
                onClick={() => setCursor(nextCursor)}
                disabled={listQuery.isFetching}
              >
                {listQuery.isFetching ? "…" : t("calls.load_more")}
              </button>
            )}
          </div>
        )}
      </section>

      {/* Detail modal */}
      {detailRow && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{
            background: "rgba(20,12,6,.36)",
            backdropFilter: "blur(14px)",
          }}
          onClick={() => setDetailId(null)}
        >
          <div
            className="nf-card p-6 w-full max-w-[520px] animate-nfPop"
            onClick={(e) => e.stopPropagation()}
            style={{ borderRadius: 24 }}
          >
            <div className="flex items-center gap-2 mb-4">
              <Phone className="w-4 h-4" />
              <h2 className="font-semibold">{t("calls.details")}</h2>
            </div>
            <div className="grid grid-cols-2 gap-3 text-[13px]">
              <div className="text-muted">{t("calls.col.operator")}</div>
              <div>{detailRow.operator_name || "—"}</div>

              <div className="text-muted">{t("calls.col.lead")}</div>
              <div>
                {detailRow.lead ? (
                  <Link
                    to={`/leads/${detailRow.lead}`}
                    className="hover:underline"
                  >
                    {detailRow.lead_name || "—"}
                  </Link>
                ) : (
                  detailRow.lead_name || "—"
                )}
                <div className="text-[11px] text-muted font-mono">
                  {detailRow.phone_number || detailRow.lead_phone || ""}
                </div>
              </div>

              <div className="text-muted">{t("calls.details.started")}</div>
              <div>{formatDateTime(detailRow.started_at)}</div>

              <div className="text-muted">{t("calls.details.ended")}</div>
              <div>{formatDateTime(detailRow.ended_at)}</div>

              <div className="text-muted">{t("calls.details.duration")}</div>
              <div className="tabular-nums">
                {fmtDuration(detailRow.duration_seconds)}
              </div>

              <div className="text-muted">{t("calls.details.outcome")}</div>
              <div>{outcomeBadge(detailRow.outcome)}</div>

              <div className="text-muted">{t("calls.details.comment")}</div>
              <div className="whitespace-pre-wrap">
                {detailRow.comment || t("calls.details.no_comment")}
              </div>

              <div className="text-muted">{t("calls.col.recording")}</div>
              <div>
                {detailRow.has_recording ? (
                  <audio
                    src={detailRow.recording_url}
                    controls
                    style={{ maxWidth: 240 }}
                  />
                ) : (
                  <span className="text-muted text-[12px]">
                    {t("calls.recording_soon")}
                  </span>
                )}
              </div>
            </div>
            <div className="mt-6 flex justify-end">
              <button
                type="button"
                className="nf-btn nf-btn--ghost"
                onClick={() => setDetailId(null)}
              >
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
