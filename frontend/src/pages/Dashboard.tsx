import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { api } from "../lib/api";
import { formatDate, formatNumber, formatUZS } from "../lib/format";
import {
  buildPeriodParams,
  currentPeriodTitle,
  periodTitle,
  type MonthChoice,
  type Period,
} from "../lib/period";
import KpiCard from "../components/KpiCard";
import MonthPicker from "../components/MonthPicker";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "day", label: "День" },
  { value: "month", label: "Месяц" },
];

export default function Dashboard() {
  const nav = useNavigate();
  const [period, setPeriod] = useState<Period>("month");
  const [choice, setChoice] = useState<MonthChoice>({ kind: "current" });

  // Both "specific" (single calendar month) and "range" (arbitrary calendar
  // window) send date_from/date_to and hide the day/week/month tabs — the
  // KPI backend routes both into its "selected" block, so they share the
  // same read-path here.
  const isSpecific = choice.kind === "specific" || choice.kind === "range";
  const params = buildPeriodParams(period, choice);
  // A stable string used as query-key seed; encodes the effective window.
  const paramKey = JSON.stringify(params);
  const title = periodTitle(period, choice);
  const titleLower = title.toLowerCase();

  const kpi = useQuery({
    queryKey: ["kpi", paramKey],
    queryFn: () =>
      api.get("/analytics/kpi/", { params }).then((r) => r.data),
  });
  const ts = useQuery({
    queryKey: ["ts", paramKey],
    queryFn: () =>
      api.get("/analytics/timeseries/", { params }).then((r) => r.data),
  });
  const lb = useQuery({
    queryKey: ["lb-dash", paramKey],
    queryFn: () =>
      api
        .get("/analytics/leaderboard/", { params: { ...params, limit: 6 } })
        .then((r) => r.data),
  });
  const models = useQuery({
    queryKey: ["by-model-dash", paramKey],
    queryFn: () =>
      api
        .get("/analytics/by-model/", { params: { ...params, limit: 6 } })
        .then((r) => r.data),
  });
  const recent = useQuery({
    queryKey: ["recent-sales"],
    queryFn: () => api.get("/sales/?limit=10").then((r) => r.data),
  });

  // Selected-window totals.
  // - specific month → the new `selected` block from the KPI response
  // - current period → today/week/month picked by the tab
  const selectedTotal = isSpecific
    ? kpi.data?.selected?.total
    : period === "day"
    ? kpi.data?.today.total
    : kpi.data?.month.total;
  const selectedCount = isSpecific
    ? kpi.data?.selected?.count
    : period === "day"
    ? kpi.data?.today.count
    : kpi.data?.month.count;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Дашборд</h1>
        <div className="flex flex-wrap items-center gap-3">
          {/* Day/week/month tabs — only meaningful for "current period" */}
          {!isSpecific && (
            <div
              role="tablist"
              aria-label="Период"
              className="inline-flex rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-1"
            >
              {PERIOD_OPTIONS.map((opt) => {
                const active = period === opt.value;
                return (
                  <button
                    key={opt.value}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setPeriod(opt.value)}
                    className={
                      "px-3 py-1.5 text-sm rounded-md transition-colors " +
                      (active
                        ? "bg-blue-600 text-white shadow-sm"
                        : "text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800")
                    }
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}
          <MonthPicker value={choice} onChange={setChoice} />
          <Link to="/sales/new" className="btn-primary">
            <Plus className="w-4 h-4" /> Добавить продажу
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard
          label={title}
          value={formatUZS(selectedTotal || 0)}
          sub={`${selectedCount || 0} продаж`}
        />
        <KpiCard
          label={currentPeriodTitle.day}
          value={formatUZS(kpi.data?.today.total || 0)}
          sub={`${kpi.data?.today.count || 0} продаж`}
        />
        <KpiCard
          label="Операторы"
          value={`${kpi.data?.operators_active || 0}`}
          sub={`+${kpi.data?.operators_trainee || 0} стажёров`}
        />
      </div>

      {kpi.data?.top_of_period && (
        <div className="card p-5">
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400">
            Топ · {title}
          </div>
          <div
            className="mt-1 text-lg font-semibold hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer"
            onClick={() => nav(`/operators/${kpi.data.top_of_period.operator_id}`)}
          >
            {kpi.data.top_of_period.operator_name}
          </div>
          <div className="text-sm text-gray-600 dark:text-slate-400">
            {formatUZS(kpi.data.top_of_period.total)} · {kpi.data.top_of_period.count} продаж
          </div>
        </div>
      )}

      <div className="card p-5">
        <div className="text-sm font-medium mb-4">
          Динамика продаж — {titleLower}
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={ts.data || []}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
            <XAxis dataKey="day" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip
              formatter={(v: any) => formatUZS(v)}
              labelFormatter={(l) => `Дата: ${l}`}
            />
            <Line
              type="monotone"
              dataKey="total"
              stroke="#2563EB"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card p-5">
          <div className="text-sm font-medium mb-4">
            Топ операторов · {titleLower}
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={(lb.data || []).map((r: any) => ({
                name: r.operator_name,
                total: Number(r.total),
              }))}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: any) => formatUZS(v)} />
              <Bar dataKey="total" fill="#2563EB" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-800 text-sm font-medium">
            Топ моделей · {titleLower}
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-slate-900 text-xs uppercase text-gray-600 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left">Модель</th>
                <th className="px-4 py-2 text-right">Кол-во</th>
                <th className="px-4 py-2 text-right">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {(models.data || []).length === 0 && (
                <tr>
                  <td
                    colSpan={3}
                    className="px-4 py-6 text-center text-gray-500 dark:text-slate-400"
                  >
                    Нет данных за период
                  </td>
                </tr>
              )}
              {(models.data || []).map((r: any, i: number) => (
                <tr
                  key={i}
                  className="border-t border-gray-100 dark:border-slate-800"
                >
                  <td className="px-4 py-2">{r.phone_model}</td>
                  <td className="px-4 py-2 text-right">{formatNumber(r.count)}</td>
                  <td className="px-4 py-2 text-right">{formatUZS(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-800 text-sm font-medium">
          Последние продажи
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-slate-900 text-gray-600 dark:text-slate-400 text-xs uppercase">
            <tr>
              <th className="px-5 py-2 text-left">Дата</th>
              <th className="px-5 py-2 text-left">IMEI</th>
              <th className="px-5 py-2 text-left">Модель</th>
              <th className="px-5 py-2 text-left">Оператор</th>
              <th className="px-5 py-2 text-right">Сумма</th>
            </tr>
          </thead>
          <tbody>
            {(recent.data?.results || []).map((s: any) => (
              <tr
                key={s.id}
                className="border-t border-gray-100 dark:border-slate-800 hover:bg-gray-50 dark:hover:bg-slate-800/40 cursor-pointer"
                onClick={() => nav(`/sales/${s.id}`)}
              >
                <td className="px-5 py-2 text-gray-600 dark:text-slate-400">{formatDate(s.sold_at)}</td>
                <td className="px-5 py-2 font-mono text-xs">{s.imei}</td>
                <td className="px-5 py-2">{s.phone_model}</td>
                <td className="px-5 py-2">{s.operator_name}</td>
                <td className="px-5 py-2 text-right">{formatUZS(s.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
