import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronDown, ChevronRight, DollarSign, FileText, FileType2 } from "lucide-react";
import { api } from "../lib/api";
import { formatUZS } from "../lib/format";
import { Button } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

/**
 * Operator-only view of the 2-gate payroll (attendance + sales).
 *
 * Layout:
 *   1. Крупная summary-карточка «К выплате X UZS / max» — цветная,
 *      с общим прогресс-баром total_earned / max_possible.
 *   2. Ряд из 2 больших карточек: Attendance / Sales.
 *      Каждая — заголовок + сумма (или 0 если гейт провален), rate + progress
 *      bar до гейта, поясняющие метрики, при провале — shortfall
 *      сообщение.
 *   3. Кнопки Excel / PDF.
 *   4. Collapsible «Детально по дням» (attendance days).
 */

type PayrollDay = {
  date: string;
  weekday: number;
  is_working_day: boolean;
  checked_in_at: string | null;
  checked_out_at: string | null;
  status: "on_time" | "late" | "absent" | "weekend" | "free_absence";
  minutes_late: number;
  deduction_uzs: string;
  note: string;
};

type AttendanceBlock = {
  working_days_planned: number;
  days_attended: number;
  days_absent: number;
  days_late: number;
  avg_late_minutes: number;
  rate_pct: number;
  gate_passed: boolean;
  late_penalty_per_event: string;
  late_penalty_total: string;
  block_earned: string;
  shortfall: {
    days_more_needed: number;
    explanation: string;
  };
  days: PayrollDay[];
};

type SalesBlock = {
  plan_amount_uzs: string;
  plan_source: string;
  actual_uzs: string;
  rate_pct: number;
  gate_passed: boolean;
  block_earned: string;
  shortfall: {
    amount_more_needed: string;
    explanation: string;
  };
};

type MyPayrollResponse = {
  operator_id: number;
  operator_name: string;
  year: number;
  month: number;
  attendance_bonus_uzs: string;
  sales_bonus_uzs: string;
  attendance_gate_pct: number;
  sales_gate_pct: number;
  shift_start: string;
  shift_end: string;
  grace_period_min: number;
  attendance: AttendanceBlock;
  sales: SalesBlock;
  total_earned: string;
  max_possible: string;
};

function currentMonthValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function fmtHM(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function fmtDayRu(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "short",
    weekday: "short",
  });
}

async function downloadMyPayroll(month: string, format: "xlsx" | "pdf") {
  const res = await api.get(
    `/attendance/my-payroll/?month=${month}&export=${format}`,
    { responseType: "blob" },
  );
  const blob = res.data as Blob;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `my_payroll_${month}.${format}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function statusConfig(
  status: PayrollDay["status"],
  t: (k: string, p?: Record<string, string | number>) => string,
): { icon: string; label: string; color: string; bg: string } {
  switch (status) {
    case "on_time":
      return {
        icon: "✓",
        label: t("payroll.day.on_time"),
        color: "#16a34a",
        bg: "rgba(22,163,74,.06)",
      };
    case "late":
      return {
        icon: "⏰",
        label: t("payroll.day.late"),
        color: "#d97706",
        bg: "rgba(245,158,11,.07)",
      };
    case "absent":
      return {
        icon: "✕",
        label: t("payroll.day.absent"),
        color: "var(--danger)",
        bg: "rgba(220,60,40,.06)",
      };
    case "weekend":
      return {
        icon: "○",
        label: t("payroll.day.weekend"),
        color: "var(--muted)",
        bg: "var(--faint)",
      };
    case "free_absence":
      return {
        icon: "◐",
        label: t("payroll.day.free_absence"),
        color: "#2563eb",
        bg: "rgba(59,130,246,.06)",
      };
  }
}

export default function MyPayroll() {
  const t = useT();
  usePageHeader({
    title: t("payroll.my_title"),
    subtitle: t("payroll.my_subtitle"),
  });

  const [month, setMonth] = useState<string>(currentMonthValue());
  const [downloading, setDownloading] = useState<"xlsx" | "pdf" | null>(null);
  const [daysOpen, setDaysOpen] = useState(false);

  const q = useQuery<MyPayrollResponse>({
    queryKey: ["my-payroll", month],
    queryFn: () =>
      api
        .get<MyPayrollResponse>(`/attendance/my-payroll/?month=${month}`)
        .then((r) => r.data),
  });

  const data = q.data;
  const totalEarned = data ? Number(data.total_earned) : 0;
  const maxPossible = data ? Number(data.max_possible) : 0;
  const totalPct = maxPossible > 0 ? Math.round((totalEarned / maxPossible) * 100) : 0;

  return (
    <div className="mx-auto max-w-[900px] flex flex-col gap-5">
      <section className="flex flex-wrap items-center gap-3 animate-nfFadeUp">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-muted">{t("payroll.month")}</span>
          <input
            type="month"
            className="nf-input py-2 px-3 w-auto text-[13px]"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            max={currentMonthValue()}
          />
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            variant="secondary"
            disabled={!data || downloading != null}
            onClick={async () => {
              setDownloading("xlsx");
              try {
                await downloadMyPayroll(month, "xlsx");
              } finally {
                setDownloading(null);
              }
            }}
          >
            <FileText className="w-3.5 h-3.5" />{" "}
            {downloading === "xlsx"
              ? t("common.loading")
              : t("payroll.download_xlsx")}
          </Button>
          <Button
            variant="secondary"
            disabled={!data || downloading != null}
            onClick={async () => {
              setDownloading("pdf");
              try {
                await downloadMyPayroll(month, "pdf");
              } finally {
                setDownloading(null);
              }
            }}
          >
            <FileType2 className="w-3.5 h-3.5" />{" "}
            {downloading === "pdf"
              ? t("common.loading")
              : t("payroll.download_pdf")}
          </Button>
        </div>
      </section>

      {q.isLoading ? (
        <div className="nf-card p-10 text-center text-muted text-[13px]">
          {t("common.loading")}
        </div>
      ) : !data ? (
        <div className="nf-card p-10 text-center text-muted text-[13px]">
          {t("attendance.report.no_data_range")}
        </div>
      ) : (
        <>
          {/* Total-earned summary card */}
          <section
            className="animate-nfFadeUp rounded-3xl p-6"
            style={{
              background:
                "linear-gradient(135deg, rgba(56,189,248,0.14), rgba(168,85,247,0.14), rgba(251,113,133,0.14))",
              border: "1px solid rgba(168,85,247,0.25)",
            }}
          >
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="text-[12.5px] uppercase tracking-wide text-muted">
                  {t("payroll.total_to_pay")}
                </div>
                <div className="text-[22px] font-bold tracking-tight mt-1">
                  {new Date(data.year, data.month - 1, 1).toLocaleDateString(
                    "ru-RU",
                    { month: "long", year: "numeric" },
                  )}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div
                  className="text-[32px] font-black tabular-nums leading-tight"
                  style={{
                    color:
                      totalEarned === 0 ? "var(--muted)" : "var(--accent)",
                  }}
                >
                  {formatUZS(data.total_earned)}
                </div>
                <div className="text-[12px] text-muted tabular-nums">
                  {t("payroll.of_max", { max: formatUZS(data.max_possible) })}
                </div>
              </div>
            </div>
            <ProgressBar pct={totalPct} tone={totalPct >= 50 ? "green" : "amber"} />
          </section>

          {/* Two gate cards: attendance / sales */}
          <section
            className="grid gap-4 animate-nfFadeUp"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}
          >
            <AttendanceCard data={data} />
            <SalesCard data={data} />
          </section>

          {/* Days breakdown (collapsible) */}
          <section className="nf-card p-5">
            <button
              type="button"
              onClick={() => setDaysOpen((s) => !s)}
              className="flex items-center gap-2 w-full text-left"
            >
              {daysOpen ? (
                <ChevronDown className="w-4 h-4 text-muted" />
              ) : (
                <ChevronRight className="w-4 h-4 text-muted" />
              )}
              <span className="nf-col">{t("payroll.days_breakdown")}</span>
            </button>
            {daysOpen && (
              <div className="flex flex-col gap-1.5 mt-3">
                {data.attendance.days.map((d, i) => {
                  const cfg = statusConfig(d.status, t);
                  const deduction = Number(d.deduction_uzs);
                  return (
                    <div
                      key={d.date}
                      className="grid gap-3 items-center px-3 py-2.5 rounded-lg text-[13px] animate-nfFadeUp"
                      style={{
                        gridTemplateColumns: "24px 1fr auto auto",
                        background: cfg.bg,
                        border: "1px solid var(--border)",
                        animationDelay: `${0.01 + i * 0.012}s`,
                      }}
                    >
                      <span aria-hidden="true" style={{ color: cfg.color, fontSize: 16 }}>
                        {cfg.icon}
                      </span>
                      <div className="min-w-0">
                        <div className="font-medium truncate">
                          {fmtDayRu(d.date)}
                          <span
                            className="ml-2 text-[11.5px] font-normal"
                            style={{ color: cfg.color }}
                          >
                            {cfg.label}
                          </span>
                        </div>
                        {d.note && (
                          <div className="text-[11.5px] text-muted truncate">
                            {d.note}
                          </div>
                        )}
                      </div>
                      <div className="text-[12px] text-muted tabular-nums text-right">
                        {d.checked_in_at || d.checked_out_at ? (
                          <>
                            {fmtHM(d.checked_in_at)}
                            {d.checked_out_at && (
                              <> → {fmtHM(d.checked_out_at)}</>
                            )}
                          </>
                        ) : (
                          "—"
                        )}
                      </div>
                      <div
                        className="tabular-nums text-[12.5px] font-semibold text-right min-w-[92px]"
                        style={{
                          color:
                            deduction > 0 ? "var(--danger)" : "var(--muted)",
                        }}
                      >
                        {deduction > 0
                          ? "−" + formatUZS(d.deduction_uzs)
                          : "—"}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/* ----------------------------- Cards ---------------------------------- */

function AttendanceCard({ data }: { data: MyPayrollResponse }) {
  const t = useT();
  const a = data.attendance;
  const passed = a.gate_passed;
  const earned = Number(a.block_earned);
  const rate = a.rate_pct;
  const gate = data.attendance_gate_pct;
  // Progress bar заполняем rate; при 100% гейт-риска (85%) визуально
  // упирается в зону «безопасно»: rate/max(rate, gate*1.18) — плавнее.
  const barPct = Math.max(0, Math.min(100, rate));

  return (
    <div
      className="rounded-3xl p-5 flex flex-col gap-3"
      style={{
        border: `1.5px solid ${passed ? "rgba(22,163,74,0.35)" : "rgba(220,60,40,0.35)"}`,
        background: passed
          ? "linear-gradient(180deg, rgba(22,163,74,0.05), rgba(22,163,74,0.01))"
          : "linear-gradient(180deg, rgba(220,60,40,0.05), rgba(220,60,40,0.01))",
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <CalendarDays className="w-4 h-4" style={{ color: passed ? "#16a34a" : "var(--danger)" }} />
          <div className="text-[14px] font-semibold tracking-tight truncate">
            {t("payroll.gate_attendance_title")}
          </div>
        </div>
        <GateBadge passed={passed} t={t} />
      </div>
      <div>
        <div
          className="text-[26px] font-black tabular-nums leading-none"
          style={{ color: passed ? "#16a34a" : "var(--muted)" }}
        >
          {formatUZS(earned)}
        </div>
        <div className="text-[11.5px] text-muted mt-1">
          {t("payroll.attendance_bonus_label")}: {formatUZS(data.attendance_bonus_uzs)}
        </div>
      </div>
      <div>
        <div className="flex items-baseline justify-between text-[12px] text-muted">
          <span>
            {rate}% / {gate}%
          </span>
          <span className="tabular-nums">
            {t("payroll.attendance_summary_line", {
              attended: a.days_attended,
              planned: a.working_days_planned,
            })}
          </span>
        </div>
        <ProgressBar pct={barPct} tone={passed ? "green" : "red"} threshold={gate} />
      </div>
      {a.days_late > 0 && passed && (
        <div className="text-[12px]" style={{ color: "#d97706" }}>
          {t("payroll.late_deduction_line", {
            n: a.days_late,
            amount: formatUZS(a.late_penalty_total),
          })}
        </div>
      )}
      {!passed && (
        <div
          className="rounded-xl px-3 py-2 text-[12.5px]"
          style={{
            background: "rgba(220,60,40,.08)",
            color: "var(--danger)",
            border: "1px solid rgba(220,60,40,.2)",
          }}
        >
          {t("payroll.shortfall_attendance_days", { n: a.shortfall.days_more_needed })}
        </div>
      )}
    </div>
  );
}

function SalesCard({ data }: { data: MyPayrollResponse }) {
  const t = useT();
  const s = data.sales;
  const passed = s.gate_passed;
  const earned = Number(s.block_earned);
  const rate = s.rate_pct;
  const gate = data.sales_gate_pct;
  const barPct = Math.max(0, Math.min(100, rate));

  return (
    <div
      className="rounded-3xl p-5 flex flex-col gap-3"
      style={{
        border: `1.5px solid ${passed ? "rgba(22,163,74,0.35)" : "rgba(220,60,40,0.35)"}`,
        background: passed
          ? "linear-gradient(180deg, rgba(22,163,74,0.05), rgba(22,163,74,0.01))"
          : "linear-gradient(180deg, rgba(220,60,40,0.05), rgba(220,60,40,0.01))",
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <DollarSign className="w-4 h-4" style={{ color: passed ? "#16a34a" : "var(--danger)" }} />
          <div className="text-[14px] font-semibold tracking-tight truncate">
            {t("payroll.gate_sales_title")}
          </div>
        </div>
        <GateBadge passed={passed} t={t} />
      </div>
      <div>
        <div
          className="text-[26px] font-black tabular-nums leading-none"
          style={{ color: passed ? "#16a34a" : "var(--muted)" }}
        >
          {formatUZS(earned)}
        </div>
        <div className="text-[11.5px] text-muted mt-1">
          {t("payroll.sales_bonus_label")}: {formatUZS(data.sales_bonus_uzs)}
        </div>
      </div>
      <div>
        <div className="flex items-baseline justify-between text-[12px] text-muted">
          <span>
            {rate}% / {gate}%
          </span>
          <span className="tabular-nums">
            {t("payroll.sales_summary_line", {
              actual: formatUZS(s.actual_uzs),
              plan: formatUZS(s.plan_amount_uzs),
            })}
          </span>
        </div>
        <ProgressBar pct={barPct} tone={passed ? "green" : "red"} threshold={gate} />
      </div>
      {!passed && Number(s.shortfall.amount_more_needed) > 0 && (
        <div
          className="rounded-xl px-3 py-2 text-[12.5px]"
          style={{
            background: "rgba(220,60,40,.08)",
            color: "var(--danger)",
            border: "1px solid rgba(220,60,40,.2)",
          }}
        >
          {t("payroll.shortfall_sales_amount", {
            amount: formatUZS(s.shortfall.amount_more_needed),
          })}
        </div>
      )}
    </div>
  );
}

function GateBadge({
  passed,
  t,
}: {
  passed: boolean;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  return (
    <span
      className="text-[11px] uppercase tracking-wide font-semibold rounded-full px-2.5 py-1"
      style={{
        background: passed ? "rgba(22,163,74,0.15)" : "rgba(220,60,40,0.15)",
        color: passed ? "#16a34a" : "var(--danger)",
      }}
    >
      {passed ? t("payroll.gate_passed_badge") : t("payroll.gate_failed_badge")}
    </span>
  );
}

function ProgressBar({
  pct,
  tone,
  threshold,
}: {
  pct: number;
  tone: "green" | "amber" | "red";
  threshold?: number;
}) {
  const color =
    tone === "green" ? "#16a34a" : tone === "amber" ? "#d97706" : "var(--danger)";
  return (
    <div
      className="mt-2 relative rounded-full overflow-hidden"
      style={{
        height: 8,
        background: "var(--faint)",
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          background: color,
          transition: "width .35s ease",
        }}
      />
      {threshold != null && threshold > 0 && threshold < 100 && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -2,
            bottom: -2,
            left: `${threshold}%`,
            width: 2,
            background: "var(--text)",
            opacity: 0.35,
          }}
          title={`${threshold}%`}
        />
      )}
    </div>
  );
}
