import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { api, API_BASE_URL } from "../lib/api";
import { formatNumber, formatUZS } from "../lib/format";
import { buildPeriodParams, periodTitle, type MonthChoice } from "../lib/period";
import MonthPicker from "../components/MonthPicker";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const PIE_COLORS = ["#2563EB", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899"];

export default function Analytics() {
  const [choice, setChoice] = useState<MonthChoice>({ kind: "current" });

  const params = buildPeriodParams("month", choice);
  const paramKey = JSON.stringify(params);
  const title = periodTitle("month", choice);

  const exportParams = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null) as [string, string][]
  ).toString();

  const lb = useQuery({
    queryKey: ["lb", paramKey],
    queryFn: () => api.get("/analytics/leaderboard/", { params }).then((r) => r.data),
  });
  const ch = useQuery({
    queryKey: ["by-channel", paramKey],
    queryFn: () => api.get("/analytics/by-channel/", { params }).then((r) => r.data),
  });
  const md = useQuery({
    queryKey: ["by-model", paramKey],
    queryFn: () => api.get("/analytics/by-model/", { params }).then((r) => r.data),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">Аналитика</h1>
        <div className="flex items-center gap-2">
          <MonthPicker value={choice} onChange={setChoice} />
          <a
            href={`${API_BASE_URL}/analytics/export.xlsx${exportParams ? "?" + exportParams : ""}`}
            className="btn-ghost"
          >
            <Download className="w-4 h-4" /> Excel
          </a>
        </div>
      </div>

      <div className="card p-5">
        <div className="text-sm font-medium mb-4">Лидерборд операторов · {title}</div>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart
            data={(lb.data || []).map((r: any) => ({ name: r.operator_name, total: Number(r.total) }))}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v: any) => formatUZS(v)} />
            <Bar dataKey="total" fill="#2563EB" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card p-5">
          <div className="text-sm font-medium mb-4">По партнёрам · {title}</div>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie
                data={(ch.data || []).map((r: any) => ({ name: r.channel_name, value: Number(r.total) }))}
                dataKey="value"
                nameKey="name"
                outerRadius={90}
              >
                {(ch.data || []).map((_: any, i: number) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(v: any) => formatUZS(v)} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b text-sm font-medium">Топ моделей · {title}</div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-slate-900 text-xs uppercase text-gray-600 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left">Модель</th>
                <th className="px-4 py-2 text-right">Кол-во</th>
                <th className="px-4 py-2 text-right">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {(md.data || []).length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-gray-500 dark:text-slate-400">
                    Нет данных за период
                  </td>
                </tr>
              )}
              {(md.data || []).slice(0, 12).map((r: any, i: number) => (
                <tr key={i} className="border-t border-gray-100 dark:border-slate-800">
                  <td className="px-4 py-2">{r.phone_model}</td>
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
