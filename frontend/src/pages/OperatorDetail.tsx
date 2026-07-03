import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { api } from "../lib/api";
import { formatNumber, formatUZS } from "../lib/format";
import {
  buildPeriodParams,
  periodTitle,
  type MonthChoice,
  type Period,
} from "../lib/period";
import KpiCard from "../components/KpiCard";
import MonthPicker from "../components/MonthPicker";
import ProgressBar from "../components/ProgressBar";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "day", label: "День" },
  { value: "week", label: "Неделя" },
  { value: "month", label: "Месяц" },
];

const STATUS_LABEL: Record<string, string> = {
  active: "Активен",
  trainee: "Стажёр",
  inactive: "Неактивен",
};

const STATUS_BADGE: Record<string, string> = {
  active:
    "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
  trainee: "bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300",
  inactive: "bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400",
};

export default function OperatorDetail() {
  const { id } = useParams<{ id: string }>();
  const [period, setPeriod] = useState<Period>("month");
  const [choice, setChoice] = useState<MonthChoice>({ kind: "current" });

  const isSpecific = choice.kind === "specific";
  const params = buildPeriodParams(period, choice);
  const paramKey = JSON.stringify(params);
  const title = periodTitle(period, choice);
  const titleLower = title.toLowerCase();

  const stats = useQuery({
    queryKey: ["operator-stats", id, paramKey],
    queryFn: () =>
      api
        .get(`/operators/${id}/stats/`, { params })
        .then((r) => r.data),
    enabled: !!id,
  });

  if (!id) return null;

  const s = stats.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            to="/operators"
            className="text-gray-500 hover:text-gray-800 dark:text-slate-400 dark:hover:text-slate-100"
            aria-label="Назад к списку операторов"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {s?.operator?.full_name || "Оператор"}
            </h1>
            <div className="flex items-center gap-2 mt-1">
              {s?.operator?.status && (
                <span
                  className={`badge ${STATUS_BADGE[s.operator.status] || ""}`}
                >
                  {STATUS_LABEL[s.operator.status] || s.operator.status}
                </span>
              )}
              {s?.operator?.phone && (
                <span className="text-sm text-gray-600 dark:text-slate-400">
                  {s.operator.phone}
                </span>
              )}
              {s?.operator?.hired_at && (
                <span className="text-sm text-gray-500 dark:text-slate-500">
                  · с {new Date(s.operator.hired_at).toLocaleDateString("ru-RU")}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
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
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard
          label={`Сумма · ${titleLower}`}
          value={formatUZS(s?.totals?.total || 0)}
          sub={`${formatNumber(s?.totals?.count || 0)} продаж`}
        />
        <KpiCard
          label="Средний чек"
          value={
            s && s.totals?.count > 0
              ? formatUZS(Number(s.totals.total) / s.totals.count)
              : formatUZS(0)
          }
          sub="Кредитованная сумма ÷ кол-во"
        />
        {s?.payroll ? (
          <div className="card p-5">
            <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400">
              Зарплата · этот месяц
            </div>
            <div className="mt-2 text-2xl font-semibold text-gray-900 dark:text-slate-100">
              {formatUZS(s.payroll.payout)}
            </div>
            <div className="mt-3">
              <div className="flex justify-between text-xs text-gray-600 dark:text-slate-400 mb-1">
                <span>
                  {formatUZS(s.payroll.total_sales)} /{" "}
                  {formatUZS(s.payroll.threshold)}
                </span>
                <span>{s.payroll.progress_percent}%</span>
              </div>
              <ProgressBar value={s.payroll.progress_percent} />
            </div>
            {s.payroll.threshold_reached && (
              <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
                Порог достигнут — формула: {s.payroll.payout_type} ·{" "}
                {s.payroll.payout_value}
              </div>
            )}
          </div>
        ) : (
          <KpiCard label="Зарплата" value="—" sub="Правило не настроено" />
        )}
      </div>

      <div className="card p-5">
        <div className="text-sm font-medium mb-4">
          Продажи по дням · {titleLower}
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={(s?.by_day || []).map((r: any) => ({
              day: r.day,
              total: Number(r.total),
              count: r.count,
            }))}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
            <XAxis dataKey="day" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip
              formatter={(v: any, name: any) =>
                name === "total" ? formatUZS(v) : formatNumber(v)
              }
              labelFormatter={(l) => `Дата: ${l}`}
            />
            <Bar dataKey="total" fill="#2563EB" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
        {(s?.by_day || []).length === 0 && !stats.isLoading && (
          <div className="text-center text-sm text-gray-500 dark:text-slate-400 py-4">
            Нет продаж за период
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-800 text-sm font-medium">
            По моделям
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
              {(s?.by_model || []).length === 0 && (
                <tr>
                  <td
                    colSpan={3}
                    className="px-4 py-6 text-center text-gray-500 dark:text-slate-400"
                  >
                    Нет данных за период
                  </td>
                </tr>
              )}
              {(s?.by_model || []).map((r: any, i: number) => (
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

        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-200 dark:border-slate-800 text-sm font-medium">
            По партнёрам
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-slate-900 text-xs uppercase text-gray-600 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left">Партнёр</th>
                <th className="px-4 py-2 text-right">Кол-во</th>
                <th className="px-4 py-2 text-right">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {(s?.by_partner || []).length === 0 && (
                <tr>
                  <td
                    colSpan={3}
                    className="px-4 py-6 text-center text-gray-500 dark:text-slate-400"
                  >
                    Нет данных за период
                  </td>
                </tr>
              )}
              {(s?.by_partner || []).map((r: any) => (
                <tr
                  key={r.partner_id}
                  className="border-t border-gray-100 dark:border-slate-800"
                >
                  <td className="px-4 py-2">{r.partner_name}</td>
                  <td className="px-4 py-2 text-right">{formatNumber(r.count)}</td>
                  <td className="px-4 py-2 text-right">{formatUZS(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
