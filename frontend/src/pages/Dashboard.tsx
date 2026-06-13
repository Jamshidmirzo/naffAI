import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { api } from "../lib/api";
import { formatDate, formatUZS } from "../lib/format";
import KpiCard from "../components/KpiCard";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export default function Dashboard() {
  const kpi = useQuery({
    queryKey: ["kpi"],
    queryFn: () => api.get("/analytics/kpi/").then((r) => r.data),
  });
  const ts = useQuery({
    queryKey: ["ts"],
    queryFn: () => api.get("/analytics/timeseries/").then((r) => r.data),
  });
  const recent = useQuery({
    queryKey: ["recent-sales"],
    queryFn: () => api.get("/sales/?limit=10").then((r) => r.data),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Дашборд</h1>
        <Link to="/sales/new" className="btn-primary">
          <Plus className="w-4 h-4" /> Добавить продажу
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="Сегодня"
          value={formatUZS(kpi.data?.today.total || 0)}
          sub={`${kpi.data?.today.count || 0} продаж`}
        />
        <KpiCard
          label="Неделя"
          value={formatUZS(kpi.data?.week.total || 0)}
          sub={`${kpi.data?.week.count || 0} продаж`}
        />
        <KpiCard
          label="Месяц"
          value={formatUZS(kpi.data?.month.total || 0)}
          sub={`${kpi.data?.month.count || 0} продаж`}
        />
        <KpiCard
          label="Операторы"
          value={`${kpi.data?.operators_active || 0}`}
          sub={`+${kpi.data?.operators_trainee || 0} стажёров`}
        />
      </div>

      {kpi.data?.top_of_month && (
        <div className="card p-5">
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400">Топ месяца</div>
          <div className="mt-1 text-lg font-semibold">{kpi.data.top_of_month.operator_name}</div>
          <div className="text-sm text-gray-600 dark:text-slate-400">
            {formatUZS(kpi.data.top_of_month.total)} · {kpi.data.top_of_month.count} продаж
          </div>
        </div>
      )}

      <div className="card p-5">
        <div className="text-sm font-medium mb-4">Динамика продаж — последние 30 дней</div>
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
              <tr key={s.id} className="border-t border-gray-100 dark:border-slate-800 hover:bg-gray-50 dark:hover:bg-slate-800/40">
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
