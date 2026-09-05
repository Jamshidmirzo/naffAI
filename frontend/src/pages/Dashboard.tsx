import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { formatNumber, formatUZS } from "../lib/format";
import { TabPill, type TabItem } from "../components/ui";
import { SingleSelectCombobox, type ComboboxOption } from "../components/SingleSelectCombobox";
import { DashKpiCard } from "../components/dashboard/KpiCard";
import { SalesBarChart, type SalesBarPoint } from "../components/dashboard/SalesBarChart";
import {
  RequiresAttentionCard,
  type AttentionCounters,
} from "../components/dashboard/RequiresAttentionCard";
import { TopOperators } from "../components/dashboard/TopOperators";
import BirthdaysTodayCard from "../components/dashboard/BirthdaysTodayCard";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

type Period = "day" | "week" | "month";

interface DashboardSummary {
  period: Period;
  today: { count: number; total: string; pending_count: number };
  turnover: { actual: string; target: string | null; target_period: string };
  conversion: {
    value_pct: number;
    delta_pp: number;
    prev_value_pct: number;
  };
  shift: { on_shift: number; expected: number; late_today: number };
  timeseries: Array<{ day: string; count: number; total: string }>;
  target_daily_count: number | null;
  attention: AttentionCounters;
  top_operators: Array<{
    id: number;
    name: string;
    count: number;
    amount: string;
  }>;
}

// Список месяцев для dropdown: 24 месяца назад до текущего включительно.
// `id` = порядковый номер (0 = самый свежий); маппим в "YYYY-MM" туда-обратно.
const _MONTH_NAMES_RU = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

function _monthList(): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth();
    const key = `${y}-${String(m + 1).padStart(2, "0")}`;
    out.push({ key, label: `${_MONTH_NAMES_RU[m]} ${y}` });
  }
  return out;
}

const _MONTHS = _monthList();
const MONTH_OPTIONS: ComboboxOption[] = _MONTHS.map((m, i) => ({
  id: i,
  label: m.label,
}));

function MONTH_KEY_TO_ID(key: string): number | null {
  const idx = _MONTHS.findIndex((m) => m.key === key);
  return idx >= 0 ? idx : null;
}

function MONTH_ID_TO_KEY(id: number): string {
  return _MONTHS[id]?.key ?? "";
}


function millionsFormat(n: number): string {
  if (Math.abs(n) >= 1_000_000) {
    const v = (n / 1_000_000).toFixed(1).replace(".0", "");
    return `${v} млн`;
  }
  if (Math.abs(n) >= 1_000) {
    return `${Math.round(n / 1_000)} тыс`;
  }
  return Math.round(n).toString();
}

function targetMillionsHint(target: string | null): string | undefined {
  if (!target) return undefined;
  const n = Number(target);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return `план ${millionsFormat(n)}`;
}

export default function Dashboard() {
  const nav = useNavigate();
  const t = useT();
  const [period, setPeriod] = useState<Period>("week");
  // Конкретный календарный месяц ("2026-08") — перекрывает period-табы.
  // Кейс: посмотреть август целиком и посчитать по нему ЗП.
  const [month, setMonth] = useState<string>("");

  usePageHeader(
    {
      title: t("dash.title_today_brief"),
      subtitle: t("dash.subtitle"),
    },
    [t("dash.title_today_brief")],
  );

  const PERIOD_TABS: TabItem<Period>[] = [
    { value: "day", label: t("common.day") },
    { value: "week", label: t("common.week") },
    { value: "month", label: t("common.month") },
  ];

  const summary = useQuery<DashboardSummary>({
    queryKey: ["dashboard-summary", period, month],
    queryFn: () =>
      api
        .get("/analytics/dashboard-summary/", {
          params: month ? { month } : { period },
        })
        .then((r) => r.data),
    refetchInterval: 60000,
  });

  const data = summary.data;

  const barData: SalesBarPoint[] = useMemo(
    () =>
      (data?.timeseries ?? []).map((r) => ({
        day: r.day,
        count: Number(r.count) || 0,
      })),
    [data?.timeseries],
  );

  const topOps = useMemo(
    () =>
      (data?.top_operators ?? []).map((o) => ({
        operator_id: o.id,
        operator_name: o.name,
        total: o.amount,
        count: o.count,
      })),
    [data?.top_operators],
  );

  const convDelta = data?.conversion.delta_pp ?? 0;
  const convDeltaLabel = `${convDelta >= 0 ? "+" : ""}${convDelta.toFixed(1)} ${t("dash.pp")}`;
  const convDeltaColor =
    convDelta > 0.01
      ? "var(--success, #16a34a)"
      : convDelta < -0.01
        ? "var(--danger, #dc2626)"
        : "var(--muted)";

  const shiftHint = data
    ? t("dash.shift_hint_late", { n: data.shift.late_today })
    : "";

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* --- HEADER --- */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1
          className="font-semibold"
          style={{ fontSize: 26, letterSpacing: "-0.02em" }}
        >
          {t("dash.title_today_brief")}
        </h1>
        <div className="flex items-center gap-2 flex-wrap">
          <TabPill<Period>
            value={period}
            onChange={(v) => {
              setPeriod(v);
              setMonth("");
            }}
            items={PERIOD_TABS}
          />
          <div style={{ minWidth: 200 }}>
            <SingleSelectCombobox
              options={MONTH_OPTIONS}
              value={month ? MONTH_KEY_TO_ID(month) : null}
              onChange={(next) => {
                if (typeof next === "number") setMonth(MONTH_ID_TO_KEY(next));
              }}
              placeholder={t("dash.month_picker")}
            />
          </div>
          {month && (
            <button
              type="button"
              className="nf-btn nf-btn--ghost"
              style={{ padding: "7px 10px" }}
              onClick={() => setMonth("")}
              title="Сбросить месяц"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* --- TOP ROW: 4 KPI cards --- */}
      <section className="grid gap-[13px] grid-cols-2 md:grid-cols-4">
        <DashKpiCard
          index={0}
          label={t("dash.kpi_done_today")}
          value={data?.today.count ?? 0}
          format={(n) => `${Math.round(n)}`}
          hint={
            data
              ? t("dash.hint_pending_check", { n: data.today.pending_count })
              : undefined
          }
          onClick={() => nav("/sales-today")}
        />
        <DashKpiCard
          index={1}
          label={t("dash.kpi_turnover_sum")}
          value={Number(data?.turnover.actual ?? 0)}
          format={(n) => millionsFormat(n)}
          hint={targetMillionsHint(data?.turnover.target ?? null) ?? formatUZS(Number(data?.turnover.actual ?? 0))}
          onClick={() => nav("/sales")}
        />
        <DashKpiCard
          index={2}
          label={t("dash.kpi_conversion")}
          value={data?.conversion.value_pct ?? 0}
          format={(n) => `${n.toFixed(1)}%`}
          delta={
            <span style={{ color: convDeltaColor }}>{convDeltaLabel}</span>
          }
          hint={t("dash.vs_prev_period")}
          onClick={() => nav("/leads-stats")}
        />
        <DashKpiCard
          index={3}
          label={t("dash.kpi_on_shift")}
          value={data?.shift.on_shift ?? 0}
          format={(n) =>
            `${Math.round(n)} / ${data?.shift.expected ?? 0}`
          }
          hint={shiftHint}
          onClick={() => nav("/attendance/today")}
        />
      </section>

      {/* --- MIDDLE ROW: bar chart + attention --- */}
      <section className="grid gap-[13px] md:grid-cols-[2fr,1fr]">
        <div
          className="nf-card p-5 animate-nfFadeUp"
          style={{ animationDelay: "0.12s" }}
        >
          <div className="flex items-baseline justify-between mb-1">
            <div className="text-[15px] font-semibold tracking-tight">
              {t("dash.sales_bar_title")}
            </div>
            {typeof data?.target_daily_count === "number" && data.target_daily_count > 0 && (
              <div className="text-[12px] text-muted">
                {t("dash.plan_per_day", { n: data.target_daily_count })}
              </div>
            )}
          </div>
          <div className="text-[12px] text-muted mb-3">
            {t("dash.sales_bar_subtitle_14d")}
          </div>
          <SalesBarChart
            data={barData}
            targetPerDay={data?.target_daily_count ?? null}
          />
        </div>
        <RequiresAttentionCard
          counters={
            data?.attention ?? {
              to_review: 0,
              orphans: 0,
              on_review: 0,
              late_today: 0,
            }
          }
          title={t("dash.attention_title")}
        />
      </section>

      {/* --- Birthdays today (renders only when non-empty) --- */}
      <BirthdaysTodayCard />

      {/* --- BOTTOM ROW: top operators leaderboard --- */}
      <section>
        <TopOperators operators={topOps} />
      </section>

      {/* --- Silent loading / error footer --- */}
      {summary.isLoading && (
        <div className="text-[12px] text-muted text-center pt-2">
          {t("common.loading")}
        </div>
      )}
      {summary.error && (
        <div className="text-[12px] text-center pt-2" style={{ color: "var(--danger, #dc2626)" }}>
          {String((summary.error as Error).message || "load error")} —{" "}
          <button
            className="underline"
            onClick={() => summary.refetch()}
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      {/* Small stat footer — reassuring: подтверждение живой сводки */}
      {data && (
        <div className="text-[11px] text-muted text-right">
          {t("dash.auto_refresh_hint")} · {formatNumber(Number(data.turnover.actual))} {t("common.uzs")}
        </div>
      )}
    </div>
  );
}
