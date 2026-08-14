import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCcw } from "lucide-react";
import { api, API_BASE_URL } from "../lib/api";
import { Button, TabPill, toast, type TabItem } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";
import { toDateInputValue } from "../lib/format";
import MarketingKpiCards from "../components/marketing/MarketingKpiCards";
import MarketingSourceTable from "../components/marketing/MarketingSourceTable";
import MarketingHeatmap from "../components/marketing/MarketingHeatmap";
import MarketingTimeSeries from "../components/marketing/MarketingTimeSeries";
import MarketingCohortTable from "../components/marketing/MarketingCohortTable";
import MarketingRecommendations from "../components/marketing/MarketingRecommendations";
import AdSpendEditor from "../components/marketing/AdSpendEditor";
import type { DashboardPayload, InsightRecord } from "../components/marketing/types";

type Tab = "overview" | "sources" | "patterns" | "dynamics" | "ai" | "spend";

const RANGE_PRESETS: { value: number | "custom"; labelKey: string }[] = [
  { value: 7, labelKey: "marketing.range.7d" },
  { value: 14, labelKey: "marketing.range.14d" },
  { value: 30, labelKey: "marketing.range.30d" },
  { value: 90, labelKey: "marketing.range.90d" },
];

function subtractDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() - days);
  return d;
}

export default function Marketing() {
  const t = useT();
  const qc = useQueryClient();

  usePageHeader({ title: t("marketing.title"), subtitle: t("marketing.subtitle_v2") });

  const [preset, setPreset] = useState<number | "custom">(30);
  const today = useMemo(() => toDateInputValue(new Date()), []);
  const initialFrom = useMemo(
    () => toDateInputValue(subtractDays(new Date(), 29)),
    [],
  );
  const [dateFrom, setDateFrom] = useState<string>(initialFrom);
  const [dateTo, setDateTo] = useState<string>(today);
  const [tab, setTab] = useState<Tab>("overview");

  const applyPreset = (days: number) => {
    const end = new Date();
    const start = subtractDays(end, days - 1);
    setDateFrom(toDateInputValue(start));
    setDateTo(toDateInputValue(end));
    setPreset(days);
  };

  const dashboardParams = { date_from: dateFrom, date_to: dateTo };
  const dashKey = `${dateFrom}::${dateTo}`;

  const dash = useQuery<DashboardPayload>({
    queryKey: ["marketing", "dashboard", dashKey],
    queryFn: async () =>
      (await api.get<DashboardPayload>("/marketing/dashboard/", { params: dashboardParams })).data,
    staleTime: 60_000,
  });

  const insightId = dash.data?.latest_insight_id;
  const insightQ = useQuery<InsightRecord | null>({
    queryKey: ["marketing", "insight", insightId],
    queryFn: async () => {
      if (!insightId) return null;
      return (await api.get<InsightRecord>(`/marketing/insights/${insightId}/`)).data;
    },
    enabled: !!insightId,
  });

  const generateMut = useMutation({
    mutationFn: async () => {
      const days = Math.max(
        1,
        Math.round(
          (new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / (1000 * 60 * 60 * 24),
        ) + 1,
      );
      return api.post<InsightRecord>(`/marketing/insights/generate/?days=${days}`);
    },
    onSuccess: (resp) => {
      qc.invalidateQueries({ queryKey: ["marketing", "dashboard"] });
      qc.invalidateQueries({ queryKey: ["marketing", "insight"] });
      qc.setQueryData(["marketing", "insight", resp.data.id], resp.data);
      toast.success(t("marketing.generated"));
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.detail || t("marketing.generate_failed")),
  });

  const markDoneMut = useMutation({
    mutationFn: async ({ id, index }: { id: number; index: number }) =>
      api.post<InsightRecord>(`/marketing/insights/${id}/recommendations/${index}/mark_done/`),
    onSuccess: (resp) => {
      qc.setQueryData(["marketing", "insight", resp.data.id], resp.data);
    },
  });

  const exportUrl = `${API_BASE_URL}/marketing/export.xlsx/?date_from=${dateFrom}&date_to=${dateTo}`;

  const tabs: TabItem<Tab>[] = [
    { value: "overview", label: t("marketing.tab.overview") },
    { value: "sources", label: t("marketing.tab.sources"), count: dash.data?.sources.length },
    { value: "patterns", label: t("marketing.tab.patterns") },
    { value: "dynamics", label: t("marketing.tab.dynamics") },
    { value: "ai", label: t("marketing.tab.ai") },
    { value: "spend", label: t("marketing.tab.spend") },
  ];

  const dashData = dash.data;

  return (
    <div className="mx-auto max-w-[1240px] flex flex-col gap-5">
      {/* Sticky header — controls */}
      <div className="sticky top-[64px] z-10 bg-[color:var(--bg)] pb-2 pt-1 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="nf-tabs">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => applyPreset(Number(p.value))}
                className={`nf-tab ${preset === p.value ? "nf-tab--active" : ""}`}
              >
                {t(p.labelKey)}
              </button>
            ))}
          </div>
          <input
            type="date"
            value={dateFrom}
            max={dateTo}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPreset("custom");
            }}
            className="text-sm rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5"
          />
          <span className="text-[13px] text-muted">—</span>
          <input
            type="date"
            value={dateTo}
            min={dateFrom}
            max={today}
            onChange={(e) => {
              setDateTo(e.target.value);
              setPreset("custom");
            }}
            className="text-sm rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={() => generateMut.mutate()}
            disabled={generateMut.isPending}
            variant="secondary"
          >
            <RefreshCcw className="w-3.5 h-3.5" />
            {generateMut.isPending
              ? t("marketing.calculating")
              : t("marketing.regenerate_ai")}
          </Button>
          <a href={exportUrl} target="_blank" rel="noopener noreferrer">
            <Button variant="secondary">
              <Download className="w-3.5 h-3.5" /> {t("common.export")}
            </Button>
          </a>
        </div>
      </div>

      {/* Tab strip */}
      <TabPill items={tabs} value={tab} onChange={setTab} />

      {/* Loading */}
      {dash.isLoading && (
        <div className="nf-card p-8 text-center text-[13.5px] text-muted animate-pulse">
          {t("common.loading")}
        </div>
      )}

      {dash.isError && (
        <div className="nf-card p-6 text-[13.5px] text-red-600">
          {(dash.error as Error).message}
        </div>
      )}

      {/* Content */}
      {dashData && (
        <>
          {tab === "overview" && (
            <div className="flex flex-col gap-5">
              <MarketingKpiCards totals={dashData.totals} wow={dashData.wow} />
              <MarketingSourceTable
                sources={dashData.sources.slice(0, 6)}
                funnels={dashData.funnels}
                rejection={dashData.rejection_reasons}
              />
              {dashData.sources.length > 6 && (
                <div className="text-center">
                  <button
                    type="button"
                    className="text-[13px] text-[color:var(--accent)] hover:underline"
                    onClick={() => setTab("sources")}
                  >
                    {t("marketing.see_all_sources")} →
                  </button>
                </div>
              )}
            </div>
          )}

          {tab === "sources" && (
            <MarketingSourceTable
              sources={dashData.sources}
              funnels={dashData.funnels}
              rejection={dashData.rejection_reasons}
            />
          )}

          {tab === "patterns" && (
            <MarketingHeatmap sources={dashData.time_patterns.sources} />
          )}

          {tab === "dynamics" && (
            <div className="flex flex-col gap-5">
              <MarketingTimeSeries sources={dashData.sources} wow={dashData.wow} />
              <MarketingCohortTable cohorts={dashData.cohorts} />
            </div>
          )}

          {tab === "ai" && (
            <MarketingRecommendations
              insight={insightQ.data || null}
              isMarkPending={markDoneMut.isPending}
              onMarkDone={(index) => {
                if (!insightQ.data) return;
                markDoneMut.mutate({ id: insightQ.data.id, index });
              }}
            />
          )}

          {tab === "spend" && <AdSpendEditor />}
        </>
      )}
    </div>
  );
}
