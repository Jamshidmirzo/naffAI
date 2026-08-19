import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import type { Period } from "../lib/period";

type StatusRow = {
  code: string;
  label_ru: string;
  label_uz: string;
  tone: string;
  emoji: string;
  count: number;
  pct: number;
};

type OperatorRow = {
  operator_id: number;
  operator_name: string;
  total: number;
  won: number;
  lost: number;
  in_progress: number;
  // Backend may not send this field on older deploys — treat as optional
  // and default to 0 in the render step so the UI stays graceful.
  sold_total?: number;
  conversion_pct: number;
};

type DailyRow = { date: string; created: number; won: number; lost: number };

type StatsResponse = {
  total: number;
  by_status: StatusRow[];
  by_operator: OperatorRow[];
  daily: DailyRow[];
};

// Solid accent used for the top stripe of each chip. Kept saturated
// so it reads at a glance without staining the whole card.
const TONE_ACCENT: Record<string, string> = {
  neutral: "#94a3b8", // slate-400
  info: "#3b82f6",    // blue-500
  hot: "#f97316",     // orange-500
  danger: "#ef4444",  // red-500
  success: "#10b981", // emerald-500
};

export default function LeadsStats() {
  const t = useT();
  const [period, setPeriod] = useState<Period>("day");

  const q = useQuery<StatsResponse>({
    queryKey: ["lead-stats", period],
    queryFn: () =>
      api
        .get<StatsResponse>("/analytics/lead-stats/", { params: { period } })
        .then((r) => r.data),
  });

  const data = q.data;

  const statusChartData = useMemo(
    () =>
      (data?.by_status || []).map((s) => ({
        name: s.label_ru || s.code,
        count: s.count,
        pct: s.pct,
        tone: s.tone,
      })),
    [data],
  );

  const dailyChartData = useMemo(() => data?.daily || [], [data]);

  return (
    <div className="mx-auto max-w-[1100px] flex flex-col gap-5">
      {/* Header + period tabs */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-[22px] font-semibold">{t("leads_stats.title")}</h1>
          <div className="text-[13px] text-muted mt-0.5">
            {t("leads_stats.subtitle")}
          </div>
        </div>
        <div className="inline-flex rounded-full border" style={{ borderColor: "var(--border)" }}>
          {(["day", "week", "month"] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className="px-4 py-2 text-[13px] font-medium first:rounded-l-full last:rounded-r-full"
              style={{
                background: period === p ? "var(--accent)" : "transparent",
                color: period === p ? "#fff" : "var(--fg)",
              }}
            >
              {t(`leads_stats.period_${p}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Total card */}
      <div
        className="rounded-[20px] px-6 py-5 flex items-center gap-4"
        style={{
          background: "linear-gradient(100deg, var(--accent), var(--accent2))",
          color: "#fff",
        }}
      >
        <div className="flex-1">
          <div className="text-[13px] opacity-90">{t("leads_stats.total_label")}</div>
          <div className="text-[36px] font-semibold leading-tight tabular-nums">
            {q.isLoading ? "…" : (data?.total ?? 0)}
          </div>
        </div>
      </div>

      {/* By status */}
      <section className="rounded-[16px] border p-5" style={{ borderColor: "var(--border)" }}>
        <h2 className="text-[16px] font-semibold mb-3">
          {t("leads_stats.by_status")}
        </h2>
        {statusChartData.length === 0 ? (
          <div className="text-[13px] text-muted">{t("leads_stats.no_data")}</div>
        ) : (
          <>
            {/* Horizontal bars — vertical layout would clip long uz labels
                like «TG'га боғланди» when the pool grows past ~7 statuses.
                Height auto-scales with row count so every status is legible. */}
            <div
              style={{
                width: "100%",
                height: Math.max(180, statusChartData.length * 30 + 24),
              }}
            >
              <ResponsiveContainer>
                <BarChart
                  data={statusChartData}
                  layout="vertical"
                  margin={{ top: 4, right: 24, bottom: 4, left: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                  <YAxis
                    dataKey="name"
                    type="category"
                    tick={{ fontSize: 12 }}
                    width={140}
                    interval={0}
                  />
                  <Tooltip
                    formatter={(value: number, _n, entry) => [
                      `${value} · ${(entry.payload as { pct: number }).pct}%`,
                      "лидов",
                    ]}
                  />
                  <Bar dataKey="count" radius={[0, 6, 6, 0]}>
                    {statusChartData.map((s, i) => (
                      <Cell
                        key={i}
                        fill={TONE_ACCENT[s.tone] || TONE_ACCENT.neutral}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {(data?.by_status || []).map((s) => {
                const accent = TONE_ACCENT[s.tone] || TONE_ACCENT.neutral;
                return (
                  <div
                    key={s.code}
                    className="relative rounded-lg border px-3 pt-3 pb-2 text-[12.5px] overflow-hidden"
                    style={{
                      background: "var(--surface)",
                      borderColor: "var(--border)",
                    }}
                  >
                    {/* colour cue as a thin top stripe — cheap-to-scan, keeps
                        the card body high-contrast for the number + label. */}
                    <span
                      className="absolute top-0 left-0 right-0"
                      style={{ height: 3, background: accent }}
                    />
                    <div
                      className="font-medium truncate flex items-center gap-1.5"
                      style={{ color: "var(--fg)" }}
                    >
                      {s.emoji && <span>{s.emoji}</span>}
                      <span className="truncate">{s.label_ru || s.code}</span>
                    </div>
                    <div className="flex items-baseline gap-1.5 mt-0.5">
                      <span
                        className="text-[18px] font-semibold tabular-nums leading-none"
                        style={{ color: accent }}
                      >
                        {s.count}
                      </span>
                      <span className="text-[11px] text-muted tabular-nums">
                        {s.pct}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>

      {/* By operator */}
      <section className="rounded-[16px] border p-5" style={{ borderColor: "var(--border)" }}>
        <h2 className="text-[16px] font-semibold mb-3">
          {t("leads_stats.by_operator")}
        </h2>
        {(data?.by_operator || []).length === 0 ? (
          <div className="text-[13px] text-muted">{t("leads_stats.no_data")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left border-b" style={{ borderColor: "var(--border)" }}>
                  <th className="py-2 pr-3">{t("leads_stats.op_name")}</th>
                  <th className="py-2 px-3 text-right">{t("leads_stats.op_total")}</th>
                  <th
                    className="py-2 px-3 text-right"
                    title={t("leads_stats.op_won_hint")}
                  >
                    {t("leads_stats.op_won")}
                  </th>
                  <th
                    className="py-2 px-3 text-right"
                    title={t("leads_stats.op_sold_total_hint")}
                  >
                    {t("leads_stats.op_sold_total")}
                  </th>
                  <th className="py-2 px-3 text-right">{t("leads_stats.op_in_progress")}</th>
                  <th className="py-2 px-3 text-right">{t("leads_stats.op_lost")}</th>
                  <th className="py-2 pl-3 text-right">{t("leads_stats.op_conversion")}</th>
                </tr>
              </thead>
              <tbody>
                {(data?.by_operator || []).map((r) => (
                  <tr key={r.operator_id} className="border-b" style={{ borderColor: "var(--border)" }}>
                    <td className="py-2 pr-3">{r.operator_name}</td>
                    <td className="py-2 px-3 text-right tabular-nums font-medium">{r.total}</td>
                    <td className="py-2 px-3 text-right tabular-nums" style={{ color: "#059669" }}>
                      {r.won}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums font-medium" style={{ color: "#059669" }}>
                      {r.sold_total ?? 0}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">{r.in_progress}</td>
                    <td className="py-2 px-3 text-right tabular-nums" style={{ color: "#dc2626" }}>
                      {r.lost}
                    </td>
                    <td className="py-2 pl-3 text-right tabular-nums font-medium">
                      {r.conversion_pct}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Daily */}
      {dailyChartData.length > 1 && (
        <section className="rounded-[16px] border p-5" style={{ borderColor: "var(--border)" }}>
          <h2 className="text-[16px] font-semibold mb-3">
            {t("leads_stats.daily")}
          </h2>
          <div style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer>
              <LineChart data={dailyChartData} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="created"
                  name={t("leads_stats.d_created")}
                  stroke="#f97316"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="won"
                  name={t("leads_stats.d_won")}
                  stroke="#059669"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="lost"
                  name={t("leads_stats.d_lost")}
                  stroke="#dc2626"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}
    </div>
  );
}
