import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { formatUZS } from "../lib/format";
import { Button, Eyebrow, TabPill, type TabItem } from "../components/ui";
import { DashKpiCard } from "../components/dashboard/KpiCard";
import { DashChart } from "../components/dashboard/DashChart";
import { TopOperators } from "../components/dashboard/TopOperators";
import { SalesFeed } from "../components/dashboard/SalesFeed";
import { SalesFormModal } from "../components/sales/SalesFormModal";
import { BarsScene } from "../components/three/BarsScene";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

type Range = "week" | "month" | "quarter";

function millionsFormat(n: number) {
  if (Math.abs(n) >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(".0", "")} млн`;
  }
  if (Math.abs(n) >= 1_000) {
    return `${Math.round(n / 1_000)} тыс`;
  }
  return Math.round(n).toString();
}

export default function Dashboard() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const t = useT();
  const [range, setRange] = useState<Range>("week");
  const [createOpen, setCreateOpen] = useState(false);

  usePageHeader(
    {
      title: t("nav.dashboard"),
      subtitle: t("dash.subtitle"),
    },
    // Re-run when language changes so the header string updates live.
    [t("nav.dashboard")],
  );

  const RANGE_TABS: TabItem<Range>[] = [
    { value: "week", label: t("common.week") },
    { value: "month", label: t("common.month") },
    { value: "quarter", label: t("common.quarter") },
  ];

  const rangeParams = useMemo(() => {
    if (range === "week") return { period: "week" };
    if (range === "quarter") return { period: "quarter" };
    return { period: "month" };
  }, [range]);

  const kpi = useQuery({
    queryKey: ["kpi-dash"],
    queryFn: () => api.get("/analytics/kpi/").then((r) => r.data),
  });
  const ts = useQuery({
    queryKey: ["ts-dash", range],
    queryFn: () =>
      api.get("/analytics/timeseries/", { params: rangeParams }).then((r) => r.data),
  });
  const lb = useQuery({
    queryKey: ["lb-dash"],
    queryFn: () =>
      api
        .get("/analytics/leaderboard/", { params: { period: "month", limit: 5 } })
        .then((r) => r.data),
  });
  const recent = useQuery({
    queryKey: ["recent-sales-dash"],
    queryFn: () => api.get("/sales/?limit=8").then((r) => r.data),
    refetchInterval: 30000,
  });

  const today = kpi.data?.today ?? { total: 0, count: 0 };
  const month = kpi.data?.month ?? { total: 0, count: 0 };
  const operatorsActive = kpi.data?.operators_active ?? 0;
  const operatorsTrainee = kpi.data?.operators_trainee ?? 0;

  const chartPoints = useMemo(
    () =>
      (ts.data || []).map((r: { day?: string; label?: string; total: number | string }) => ({
        label: (r.day ?? r.label ?? "").toString(),
        value: Number(r.total),
      })),
    [ts.data],
  );

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* --- HERO --- */}
      <section
        className="nf-hero animate-nfFadeUp"
        style={{
          borderRadius: 30,
          padding: "42px 44px",
          border: "1px solid var(--border)",
        }}
      >
        <div className="grid gap-6 md:grid-cols-[1.4fr,1fr] items-center">
          <div>
            <Eyebrow>{t("dash.eyebrow")}</Eyebrow>
            <h1
              className="font-semibold mt-3"
              style={{ fontSize: 44, letterSpacing: "-0.035em", lineHeight: 1.05 }}
            >
              {t("dash.greeting")}
              <br />
              {today.count > 0 ? (
                <>
                  {t("dash.today_some_prefix")}{" "}
                  <span style={{ color: "var(--accent)" }}>{today.count}</span>{" "}
                  {t("dash.today_some_suffix")}
                </>
              ) : (
                <>{t("dash.today_zero")}</>
              )}
            </h1>
            <p className="mt-3 text-[16px] text-muted max-w-md">
              {t("dash.operators_online", { n: operatorsActive })}
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button size="lg" onClick={() => setCreateOpen(true)}>
                {t("dash.new_sale")}
              </Button>
              <Button variant="secondary" size="lg" onClick={() => window.open("/screen", "_blank")}>
                {t("dash.open_screen")}
              </Button>
            </div>
          </div>
          <div
            className="hidden md:block rounded-2xl relative overflow-hidden"
            style={{
              height: 260,
              background: "var(--surface)",
              border: "1px solid var(--border)",
            }}
          >
            <BarsScene
              values={(lb.data || []).slice(0, 6).map((r: { total: number | string }) => Number(r.total))}
              className="absolute inset-0"
              style={{ pointerEvents: "none" }}
            />
            <div className="absolute left-4 bottom-3 right-4">
              <div className="text-[12.5px] font-medium">Продажи по операторам</div>
              <div className="text-[11.5px] text-muted">
                топ {Math.min(6, (lb.data || []).length)} · за месяц
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* --- KPI --- */}
      <section className="grid gap-[13px] grid-cols-2 md:grid-cols-4">
        <DashKpiCard
          index={0}
          label={t("dash.kpi_sales_today")}
          value={today.count}
          format={(n) => `${Math.round(n)}`}
          hint={`${t("common.of")} ${month.count} ${t("common.month").toLowerCase()}`}
          onClick={() => nav("/sales-today")}
        />
        <DashKpiCard
          index={1}
          label={t("dash.kpi_sum_today")}
          value={Number(today.total)}
          format={(n) => millionsFormat(n)}
          hint={formatUZS(Number(today.total))}
          onClick={() => nav("/sales-today")}
        />
        <DashKpiCard
          index={2}
          label={t("dash.kpi_month")}
          value={month.count}
          format={(n) => `${Math.round(n)}`}
          hint={formatUZS(Number(month.total))}
          onClick={() => nav("/sales")}
        />
        <DashKpiCard
          index={3}
          label={t("dash.kpi_online")}
          value={operatorsActive}
          format={(n) => `${Math.round(n)}`}
          hint={`+${operatorsTrainee}`}
          onClick={() => nav("/attendance/today")}
        />
      </section>

      {/* --- CHART + TOP OPERATORS --- */}
      <section className="grid gap-[13px] md:grid-cols-[2fr,1fr]">
        <div className="nf-card p-6 animate-nfFadeUp" style={{ animationDelay: "0.1s" }}>
          <div className="flex items-center justify-between mb-4">
            <div className="text-[15px] font-semibold tracking-tight">{t("dash.chart_title")}</div>
            <TabPill value={range} onChange={setRange} items={RANGE_TABS} />
          </div>
          <DashChart points={chartPoints} />
        </div>
        <TopOperators operators={lb.data || []} />
      </section>

      {/* --- SALES FEED --- */}
      <SalesFeed sales={recent.data?.results || []} />

      <SalesFormModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={(newId) => {
          qc.invalidateQueries({ queryKey: ["kpi-dash"] });
          qc.invalidateQueries({ queryKey: ["ts-dash"] });
          qc.invalidateQueries({ queryKey: ["lb-dash"] });
          qc.invalidateQueries({ queryKey: ["recent-sales-dash"] });
          if (newId) nav(`/sales/${newId}`);
        }}
      />
    </div>
  );
}
