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
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface LeadsDistributionRow {
  operator_id: number;
  operator_name: string;
  new: number;
  assigned: number;
  in_progress: number;
  won: number;
  lost: number;
  needs_review: number;
  total: number;
}

interface FunnelRow {
  operator_id: number;
  operator_name: string;
  leads_total: number;
  contacted: number;
  callbacks: number;
  sales: number;
}

interface HeatmapPayload {
  operators: { id: number; name: string }[];
  hours: number[];
  matrix: number[][];
}

const LEAD_BUCKET_COLORS: Record<string, string> = {
  new: "#94A3B8",
  assigned: "#60A5FA",
  in_progress: "#F59E0B",
  won: "#10B981",
  lost: "#EF4444",
  needs_review: "#A78BFA",
};

const LEAD_BUCKET_LABELS: Record<string, string> = {
  new: "Новые",
  assigned: "Назначены",
  in_progress: "В работе",
  won: "Продажи",
  lost: "Потеряны",
  needs_review: "На проверке",
};

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

  // F3.C — extended charts. These are all live/current (not filtered by
  // the month picker) since they answer "what does the pipeline look like
  // right now?" rather than "what happened in this window?".
  const leadsDist = useQuery<LeadsDistributionRow[]>({
    queryKey: ["leads-distribution"],
    queryFn: () =>
      api.get<LeadsDistributionRow[]>("/analytics/leads-distribution/").then((r) => r.data),
  });
  const funnels = useQuery<FunnelRow[]>({
    queryKey: ["operator-funnels"],
    queryFn: () =>
      api.get<FunnelRow[]>("/analytics/operator-funnels/?top_n=10").then((r) => r.data),
  });
  const heatmap = useQuery<HeatmapPayload>({
    queryKey: ["callback-heatmap"],
    queryFn: () =>
      api.get<HeatmapPayload>("/analytics/callback-heatmap/?days_back=30").then((r) => r.data),
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

      <div className="card p-5">
        <div className="text-sm font-medium mb-1">Распределение лидов по операторам</div>
        <div className="text-xs text-gray-500 dark:text-slate-400 mb-4">
          Активные лиды в разрезе стадий воронки
        </div>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={leadsDist.data ?? []}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
            <XAxis dataKey="operator_name" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Legend />
            {Object.keys(LEAD_BUCKET_COLORS).map((bucket) => (
              <Bar
                key={bucket}
                dataKey={bucket}
                stackId="s"
                fill={LEAD_BUCKET_COLORS[bucket]}
                name={LEAD_BUCKET_LABELS[bucket]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="card p-5">
        <div className="text-sm font-medium mb-1">Воронка по каждому оператору (top 10)</div>
        <div className="text-xs text-gray-500 dark:text-slate-400 mb-4">
          Лиды → контакт → callback → продажа
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {(funnels.data ?? []).map((f) => {
            const maxV = Math.max(f.leads_total, 1);
            const bar = (v: number, color: string) => (
              <div className="mb-1">
                <div className="flex justify-between text-[10px] text-gray-500 dark:text-slate-400">
                  <span>{v}</span>
                </div>
                <div className="h-1.5 rounded-full bg-gray-100 dark:bg-slate-800">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${(v / maxV) * 100}%`, backgroundColor: color }}
                  />
                </div>
              </div>
            );
            return (
              <div key={f.operator_id} className="rounded-lg border border-gray-100 dark:border-slate-800 p-3">
                <div className="text-xs font-medium truncate mb-2">{f.operator_name}</div>
                <div className="text-[10px] uppercase text-gray-400 mt-1">Лиды</div>
                {bar(f.leads_total, "#94A3B8")}
                <div className="text-[10px] uppercase text-gray-400">Контакт</div>
                {bar(f.contacted, "#60A5FA")}
                <div className="text-[10px] uppercase text-gray-400">Callback</div>
                {bar(f.callbacks, "#F59E0B")}
                <div className="text-[10px] uppercase text-gray-400">Продажи</div>
                {bar(f.sales, "#10B981")}
              </div>
            );
          })}
          {(funnels.data ?? []).length === 0 && (
            <div className="col-span-full text-center text-gray-500 py-8 text-sm">
              Нет данных
            </div>
          )}
        </div>
      </div>

      <div className="card p-5 overflow-x-auto">
        <div className="text-sm font-medium mb-1">
          Тепловая карта callback-активности (30 дней)
        </div>
        <div className="text-xs text-gray-500 dark:text-slate-400 mb-4">
          Часы дня — колонки; операторы — строки; интенсивность цвета — количество callback'ов
        </div>
        <HeatmapView payload={heatmap.data} />
      </div>
    </div>
  );
}

function HeatmapView({ payload }: { payload: HeatmapPayload | undefined }) {
  if (!payload || payload.operators.length === 0) {
    return <div className="text-center text-gray-500 py-8 text-sm">Нет данных</div>;
  }
  const maxV = Math.max(1, ...payload.matrix.flat());
  return (
    <table className="text-xs">
      <thead>
        <tr>
          <th className="text-left pr-3 pb-2 font-normal text-gray-500">Оператор \\ час</th>
          {payload.hours.map((h) => (
            <th
              key={h}
              className="w-6 text-center pb-2 font-normal text-gray-400"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {payload.operators.map((op, ri) => (
          <tr key={op.id}>
            <td className="pr-3 py-0.5 whitespace-nowrap truncate max-w-40">{op.name}</td>
            {payload.hours.map((h, hi) => {
              const v = payload.matrix[ri][hi];
              const intensity = v === 0 ? 0 : Math.min(1, v / maxV);
              return (
                <td
                  key={h}
                  className="w-6 h-6 text-center"
                  title={`${op.name}, ${h}:00 → ${v}`}
                  style={{
                    background:
                      v === 0
                        ? "transparent"
                        : `rgba(37, 99, 235, ${0.15 + intensity * 0.75})`,
                  }}
                >
                  {v > 0 ? v : ""}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
