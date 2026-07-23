/**
 * F3.B — AI marketing analyst dashboard.
 *
 * - Widget: conversion by source (bar chart)
 * - Widget: top products
 * - Section: LLM recommendations
 * - History list (paginated by backend `insights_list`)
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCcw } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../lib/api";
import { apiErrorMessage } from "../lib/api-types";

interface SourceStat {
  sheet_source_id: number;
  source_name: string;
  leads: number;
  converted: number;
  conversion_rate: number;
}

interface Insight {
  id: number;
  period_start: string;
  period_end: string;
  lead_quality_by_source: Record<string, SourceStat>;
  targeting_recommendations: string[];
  top_products: { product: string; mentions: number }[];
  summary: string;
  model_version: string;
  created_at: string;
}

export default function Marketing() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const listQ = useQuery<Insight[]>({
    queryKey: ["marketing", "insights"],
    queryFn: async () => {
      const r = await api.get("/marketing/insights/");
      const data = r.data as Insight[] | { results: Insight[] };
      return Array.isArray(data) ? data : data.results;
    },
  });

  const insights = listQ.data ?? [];
  const latest = insights[0];

  const generateMut = useMutation({
    mutationFn: () => api.post<Insight>("/marketing/insights/generate/", { days: 7 }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marketing", "insights"] });
      setError(null);
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const sourceBars = latest
    ? Object.values(latest.lead_quality_by_source).sort((a, b) => b.leads - a.leads)
    : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Маркетинг-аналитик</h1>
        <button
          className="btn-primary"
          onClick={() => generateMut.mutate()}
          disabled={generateMut.isPending}
        >
          <RefreshCcw className="w-4 h-4" />
          {generateMut.isPending ? "Считаем…" : "Обновить (7 дней)"}
        </button>
      </div>

      {error && <div className="text-sm text-red-500">{error}</div>}

      {!latest && !listQ.isLoading && (
        <div className="card p-6 text-center text-gray-500 dark:text-slate-400">
          Ещё нет ни одного отчёта. Нажмите «Обновить», чтобы сгенерировать первый.
        </div>
      )}

      {latest && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="card p-5 lg:col-span-2">
              <div className="text-sm font-medium mb-1">
                Конверсия по источникам · {latest.period_start} — {latest.period_end}
              </div>
              <div className="text-xs text-gray-500 dark:text-slate-400 mb-4">
                Лиды и конверсия в продажу
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={sourceBars}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                  <XAxis dataKey="source_name" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="l" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar yAxisId="l" dataKey="leads" fill="#94A3B8" name="Лиды" />
                  <Bar yAxisId="l" dataKey="converted" fill="#10B981" name="Продажи" />
                  <Bar yAxisId="r" dataKey="conversion_rate" fill="#F59E0B" name="Конверсия, %" />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="card p-5">
              <div className="text-sm font-medium mb-3">Топ товаров</div>
              <ul className="space-y-1 text-sm">
                {latest.top_products.slice(0, 10).map((p) => (
                  <li key={p.product} className="flex justify-between">
                    <span className="truncate">{p.product}</span>
                    <span className="text-gray-500 dark:text-slate-400 ml-2">
                      {p.mentions}
                    </span>
                  </li>
                ))}
                {latest.top_products.length === 0 && (
                  <li className="text-gray-400 text-sm">Нет данных</li>
                )}
              </ul>
            </div>
          </div>

          <div className="card p-5">
            <div className="text-sm font-medium mb-3">Рекомендации от AI</div>
            <div className="text-sm text-gray-600 dark:text-slate-300 mb-4 italic">
              {latest.summary}
            </div>
            <ul className="space-y-2 text-sm list-disc list-inside">
              {latest.targeting_recommendations.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            <div className="text-xs text-gray-400 mt-3">
              Модель: {latest.model_version}
            </div>
          </div>
        </>
      )}

      {insights.length > 1 && (
        <div className="card">
          <div className="px-5 py-3 border-b text-sm font-medium">История</div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-slate-900 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">Период</th>
                <th className="px-4 py-2 text-left">Резюме</th>
                <th className="px-4 py-2 text-right">Модель</th>
              </tr>
            </thead>
            <tbody>
              {insights.slice(1).map((i) => (
                <tr key={i.id} className="border-t border-gray-100 dark:border-slate-800">
                  <td className="px-4 py-2 whitespace-nowrap">
                    {i.period_start} — {i.period_end}
                  </td>
                  <td className="px-4 py-2 text-gray-600 dark:text-slate-400 truncate max-w-xl">
                    {i.summary}
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-gray-400">
                    {i.model_version}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
