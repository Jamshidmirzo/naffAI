import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, API_BASE_URL } from "../lib/api";
import { formatUZS } from "../lib/format";
import { Button, StatusBadge } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

const now = new Date();

interface PayrollLine {
  operator_id: number;
  operator_name: string;
  sales_count: number;
  total_sales: number | string;
  payout: number | string;
  threshold: number | string;
  progress_percent: number;
  threshold_reached: boolean;
  is_trainee: boolean;
}

export default function Payroll() {
  const nav = useNavigate();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  usePageHeader({ title: (useT())("payroll.title"), subtitle: "Начисления операторам по месяцам" });

  const q = useQuery({
    queryKey: ["payroll", year, month],
    queryFn: () =>
      api.get(`/payroll/monthly/?year=${year}&month=${month}`).then((r) => r.data),
  });

  const lines: PayrollLine[] = q.data?.lines || [];

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Filters */}
      <section className="flex items-center gap-3 animate-nfFadeUp">
        <select
          className="nf-input py-2 px-3.5 w-auto text-[13px]"
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
          className="nf-input py-2 px-3.5 w-24 text-[13px] tabular-nums"
          type="number"
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        />
        <div className="ml-auto">
          <a
            href={`${API_BASE_URL}/payroll/monthly/export.xlsx?year=${year}&month=${month}`}
            className="nf-btn nf-btn--secondary"
          >
            <Download className="w-3.5 h-3.5" /> Excel
          </a>
        </div>
      </section>

      {/* Table */}
      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{ gridTemplateColumns: "1.4fr .8fr 1.6fr .8fr" }}
        >
          <div>Оператор</div>
          <div className="text-right">Продажи</div>
          <div>Прогресс к порогу</div>
          <div className="text-right">Премия</div>
        </div>
        {q.isLoading ? (
          <div className="text-center text-muted py-12 text-[13px]">Загрузка…</div>
        ) : lines.length === 0 ? (
          <div className="text-center text-muted py-12 text-[13px]">
            Нет данных за выбранный месяц
          </div>
        ) : (
          <div>
            {lines.map((l, i) => (
              <div
                key={l.operator_id}
                onClick={() => nav(`/operators/${l.operator_id}`)}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns: "1.4fr .8fr 1.6fr .8fr",
                  animationDelay: `${0.02 + i * 0.035}s`,
                }}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 truncate">
                    <span className="font-medium truncate">{l.operator_name}</span>
                    {l.is_trainee && (
                      <StatusBadge tone="neutral">стажёр</StatusBadge>
                    )}
                    {l.threshold_reached && (
                      <StatusBadge tone="hot">порог достигнут</StatusBadge>
                    )}
                  </div>
                </div>
                <div className="text-right text-muted tabular-nums text-[12.5px]">
                  {l.sales_count} шт · {formatUZS(l.total_sales)}
                </div>
                <div>
                  <div className="flex items-center justify-between text-[11.5px] text-muted mb-1">
                    <span className="tabular-nums">из {formatUZS(l.threshold)}</span>
                    <span
                      className="tabular-nums font-semibold"
                      style={{
                        color: l.threshold_reached ? "var(--accent)" : undefined,
                      }}
                    >
                      {l.progress_percent}%
                    </span>
                  </div>
                  <div
                    className="h-[5px] rounded-full overflow-hidden"
                    style={{ background: "var(--faint)" }}
                  >
                    <div
                      className="h-full rounded-full transition-all duration-700 ease-nf"
                      style={{
                        width: `${Math.min(100, l.progress_percent)}%`,
                        background: "var(--accent-grad)",
                      }}
                    />
                  </div>
                </div>
                <div className="text-right font-semibold tabular-nums">
                  {formatUZS(l.payout)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
