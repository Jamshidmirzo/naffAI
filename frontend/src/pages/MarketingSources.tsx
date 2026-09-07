import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { formatUZS } from "../lib/format";
import { SingleSelectCombobox, type ComboboxOption } from "../components/SingleSelectCombobox";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";
import SourceRankingTable from "../components/marketing/SourceRankingTable";
import DemandSupplyGap from "../components/marketing/DemandSupplyGap";
import MarketingSourceDetail from "../components/marketing/MarketingSourceDetail";
import type {
  DemandSupplyPayload,
  FunnelRow,
  RejectionRow,
  SourceRow,
} from "../components/marketing/types";

/* ---- Month picker (mirrors Dashboard.tsx pattern) --------------------- */

const _MONTH_NAMES_RU = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

function _monthList(): { key: string; label: string; range: { from: string; to: string } }[] {
  const out: { key: string; label: string; range: { from: string; to: string } }[] = [];
  const now = new Date();
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth();
    const key = `${y}-${String(m + 1).padStart(2, "0")}`;
    // First and last day of that month (local time — matches server TZ).
    const first = new Date(y, m, 1);
    const last = new Date(y, m + 1, 0);
    const iso = (dt: Date) =>
      `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    out.push({
      key,
      label: `${_MONTH_NAMES_RU[m]} ${y}`,
      range: { from: iso(first), to: iso(last) },
    });
  }
  return out;
}

const _MONTHS = _monthList();
const MONTH_OPTIONS: ComboboxOption[] = _MONTHS.map((m, i) => ({ id: i, label: m.label }));

export default function MarketingSources() {
  const t = useT();
  const nav = useNavigate();

  usePageHeader(
    { title: t("marketing_sources.title"), subtitle: t("marketing_sources.subtitle") },
    [],
  );

  // Default = current calendar month.
  const [monthIdx, setMonthIdx] = useState<number>(0);
  const month = _MONTHS[monthIdx];
  const dateFrom = month.range.from;
  const dateTo = month.range.to;

  // 1) All-source ranking. Backend selector = `marketing_source_breakdown`.
  const breakdown = useQuery<SourceRow[]>({
    queryKey: ["mkt-src", "breakdown", dateFrom, dateTo],
    queryFn: async () =>
      (await api.get<SourceRow[]>("/analytics/marketing-source-breakdown/", {
        params: { date_from: dateFrom, date_to: dateTo },
      })).data,
    staleTime: 60_000,
  });

  // 2) Funnel + rejection — for the expanded detail block.
  //    We pull from `/marketing/dashboard/` since it already aggregates
  //    funnel/rejection with the same window semantics.
  const dashboard = useQuery<{ funnels: FunnelRow[]; rejection_reasons: RejectionRow[] }>({
    queryKey: ["mkt-src", "dashboard", dateFrom, dateTo],
    queryFn: async () =>
      (await api.get("/marketing/dashboard/", {
        params: { date_from: dateFrom, date_to: dateTo },
      })).data,
    staleTime: 60_000,
  });

  // 3) Expanded row state — selected source + its demand/supply payload.
  const [selected, setSelected] = useState<SourceRow | null>(null);

  const gapQuery = useQuery<DemandSupplyPayload>({
    queryKey: ["mkt-src", "gap", dateFrom, dateTo, selected?.sheet_source_id ?? "all"],
    queryFn: async () => {
      const params: Record<string, string> = {
        date_from: dateFrom,
        date_to: dateTo,
      };
      if (selected?.sheet_source_id) {
        params.source_id = String(selected.sheet_source_id);
      }
      return (await api.get<DemandSupplyPayload>(
        "/analytics/product-demand-vs-supply/",
        { params },
      )).data;
    },
    enabled: !!selected,
    staleTime: 60_000,
  });

  const funnels = dashboard.data?.funnels ?? [];
  const rejections = dashboard.data?.rejection_reasons ?? [];

  const totals = useMemo(() => {
    const rows = breakdown.data ?? [];
    return {
      sources: rows.length,
      leads: rows.reduce((s, r) => s + r.leads, 0),
      converted: rows.reduce((s, r) => s + r.converted, 0),
      revenue: rows.reduce((s, r) => s + Number(r.revenue || 0), 0),
    };
  }, [breakdown.data]);

  return (
    <div className="mx-auto max-w-[1240px] flex flex-col gap-5">
      {/* Header row: month picker + summary chips */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-semibold" style={{ fontSize: 24, letterSpacing: "-0.02em" }}>
          {t("marketing_sources.title")}
        </h1>
        <div className="flex items-center gap-2">
          <div style={{ minWidth: 200 }}>
            <SingleSelectCombobox
              options={MONTH_OPTIONS}
              value={monthIdx}
              onChange={(v) => typeof v === "number" && setMonthIdx(v)}
              placeholder={t("dash.month_picker")}
            />
          </div>
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryChip label={t("marketing_sources.summary.sources")} value={String(totals.sources)} />
        <SummaryChip label={t("marketing_sources.summary.leads")} value={String(totals.leads)} />
        <SummaryChip
          label={t("marketing_sources.summary.converted")}
          value={String(totals.converted)}
          hint={
            totals.leads > 0
              ? `${((totals.converted * 100) / totals.leads).toFixed(1)}%`
              : undefined
          }
        />
        <SummaryChip label={t("marketing_sources.summary.revenue")} value={formatUZS(totals.revenue)} />
      </div>

      {/* Ranking table */}
      {breakdown.isLoading && (
        <div className="nf-card p-8 text-center text-[13.5px] text-muted animate-pulse">
          {t("common.loading")}
        </div>
      )}
      {breakdown.isError && (
        <div className="nf-card p-6 text-[13.5px] text-red-600">
          {(breakdown.error as Error).message}
        </div>
      )}
      {breakdown.data && (
        <SourceRankingTable
          sources={breakdown.data}
          onSelect={(row) => setSelected((cur) => (cur?.source_name === row.source_name ? null : row))}
          selectedName={selected?.source_name ?? null}
        />
      )}

      {/* Expanded detail block */}
      {selected && (
        <div className="nf-card p-5 flex flex-col gap-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[11.5px] uppercase tracking-wide text-muted">
                {t("marketing_sources.detail.title")}
              </div>
              <div className="text-[16px] font-semibold">{selected.source_name}</div>
            </div>
            <div className="flex items-center gap-2">
              {selected.sheet_source_id && (
                <button
                  type="button"
                  className="nf-btn nf-btn--ghost text-[12px]"
                  onClick={() =>
                    nav(
                      `/sales?sheet_source_id=${selected.sheet_source_id}&date_from=${dateFrom}&date_to=${dateTo}`,
                    )
                  }
                >
                  {t("marketing_sources.open_sales")} →
                </button>
              )}
              <button
                type="button"
                className="nf-btn nf-btn--ghost text-[12px]"
                onClick={() => setSelected(null)}
              >
                ×
              </button>
            </div>
          </div>

          <MarketingSourceDetail
            source={selected}
            funnel={funnels.find((f) => f.source_name === selected.source_name)}
            rejection={rejections.find((r) => r.source_name === selected.source_name)}
          />

          <div>
            <div className="text-[12px] uppercase tracking-wide text-muted mb-3">
              {t("marketing_sources.demand_vs_supply")}
            </div>
            <DemandSupplyGap data={gapQuery.data} isLoading={gapQuery.isLoading} />
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryChip({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="nf-card p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-[18px] font-semibold tabular-nums">
        {value}
        {hint && <span className="ml-1 text-[12px] text-muted">({hint})</span>}
      </div>
    </div>
  );
}
