import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { api, API_BASE_URL } from "../lib/api";
import { formatUZS } from "../lib/format";
import ProgressBar from "../components/ProgressBar";

const now = new Date();

export default function Payroll() {
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const q = useQuery({
    queryKey: ["payroll", year, month],
    queryFn: () =>
      api.get(`/payroll/monthly/?year=${year}&month=${month}`).then((r) => r.data),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Зарплата</h1>
        <div className="flex items-center gap-2">
          <select
            className="input max-w-[120px]"
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
          >
            {[...Array(12)].map((_, i) => (
              <option key={i + 1} value={i + 1}>
                {new Date(2000, i).toLocaleString("ru", { month: "long" })}
              </option>
            ))}
          </select>
          <input
            className="input max-w-[100px]"
            type="number"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
          />
          <a
            href={`${API_BASE_URL}/payroll/monthly/export.xlsx?year=${year}&month=${month}`}
            className="btn-ghost"
          >
            <Download className="w-4 h-4" /> Excel
          </a>
        </div>
      </div>

      <div className="space-y-3">
        {(q.data?.lines || []).map((l: any) => (
          <div key={l.operator_id} className="card p-5">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <div className="text-sm font-medium flex items-center gap-2">
                  {l.operator_name}
                  {l.is_trainee && (
                    <span className="badge bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300">стажёр</span>
                  )}
                  {l.threshold_reached && (
                    <span className="badge bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300">порог достигнут</span>
                  )}
                </div>
                <div className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                  {l.sales_count} продаж · {formatUZS(l.total_sales)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-gray-500 dark:text-slate-400">Премия</div>
                <div className="text-lg font-semibold">{formatUZS(l.payout)}</div>
              </div>
            </div>
            <div className="mt-4">
              <div className="flex justify-between text-xs text-gray-500 dark:text-slate-400 mb-1">
                <span>Прогресс к порогу {formatUZS(l.threshold)}</span>
                <span>{l.progress_percent}%</span>
              </div>
              <ProgressBar value={l.progress_percent} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
