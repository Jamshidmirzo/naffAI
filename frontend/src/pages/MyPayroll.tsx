import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, FileType2 } from "lucide-react";
import { api } from "../lib/api";
import { formatUZS } from "../lib/format";
import { Button } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

/**
 * Operator-only view of the attendance-based payroll for the current
 * month (or any past month via `<input type="month">`). Reads
 * `/attendance/my-payroll/?month=YYYY-MM` — PIN не требуется, только
 * оператору-владельцу.
 *
 * Компоновка:
 *   1. Gradient «summary» карточка сверху — оклад / дней посещал / % /
 *      к выплате. Стиль тот же, что у BirthdayCelebration banner'а,
 *      только тёплее (не режет глаза каждый день).
 *   2. Простой список дней (не accordion) — иконка + время in-out +
 *      вычет. Обозначения: ✓ on_time, ⏰ late (жёлтый), ✕ absent (красный),
 *      ○ weekend (серый), ◐ free_absence (синий).
 *   3. Кнопки Excel / PDF — идут через `/attendance/my-payroll/?export=…`.
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

type MyPayrollResponse = {
  operator_id: number;
  operator_name: string;
  year: number;
  month: number;
  salary_gross: string;
  shift_start: string;
  shift_end: string;
  grace_period_min: number;
  weekly_day_off: number;
  weekly_free_absences: number;
  working_days_planned: number;
  days_attended: number;
  days_absent: number;
  days_late: number;
  avg_late_minutes: number;
  attendance_rate_pct: number;
  gate_pct: number;
  gate_triggered: boolean;
  weekly_free_absences_used: number;
  billable_absences: number;
  daily_rate: string;
  absence_deduction: string;
  late_penalty_per_event: string;
  late_penalty_total: string;
  salary_earned: string;
  days: PayrollDay[];
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

  const q = useQuery<MyPayrollResponse>({
    queryKey: ["my-payroll", month],
    queryFn: () =>
      api
        .get<MyPayrollResponse>(`/attendance/my-payroll/?month=${month}`)
        .then((r) => r.data),
  });

  const data = q.data;

  return (
    <div className="mx-auto max-w-[860px] flex flex-col gap-5">
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
          {/* Gradient summary card */}
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
                  {t("payroll.my_summary_label")}
                </div>
                <div className="text-[22px] font-bold tracking-tight mt-1">
                  {new Date(data.year, data.month - 1, 1).toLocaleDateString(
                    "ru-RU",
                    { month: "long", year: "numeric" },
                  )}
                </div>
                <div className="text-[13px] text-muted mt-1">
                  {t("payroll.shift_hint", {
                    from: data.shift_start,
                    to: data.shift_end,
                    grace: data.grace_period_min,
                  })}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[12px] uppercase tracking-wide text-muted">
                  {t("payroll.salary_earned")}
                </div>
                <div
                  className="text-[30px] font-black tabular-nums leading-tight mt-1"
                  style={{ color: data.gate_triggered ? "var(--danger)" : "var(--accent)" }}
                >
                  {formatUZS(data.salary_earned)}
                </div>
                <div className="text-[12px] text-muted tabular-nums">
                  {t("payroll.of")} {formatUZS(data.salary_gross)}
                </div>
              </div>
            </div>

            <div
              className="grid gap-3 mt-5"
              style={{ gridTemplateColumns: "repeat(3, 1fr)" }}
            >
              <MiniStat
                label={t("payroll.days_col")}
                value={`${data.days_attended} / ${data.working_days_planned}`}
              />
              <MiniStat
                label={t("payroll.attendance_rate")}
                value={`${data.attendance_rate_pct}%`}
                accent={
                  !data.gate_triggered && data.attendance_rate_pct >= 95
                }
                danger={data.gate_triggered}
              />
              <MiniStat
                label={t("payroll.late_count")}
                value={
                  data.days_late === 0
                    ? "0"
                    : `${data.days_late} · Ø${data.avg_late_minutes} мин`
                }
                accent={data.days_late > 0}
              />
            </div>

            {data.gate_triggered && (
              <div
                className="rounded-xl px-4 py-3 text-[13px] mt-4"
                style={{
                  background: "rgba(220,60,40,.1)",
                  color: "var(--danger)",
                  border: "1px solid rgba(220,60,40,.25)",
                }}
              >
                {t("payroll.gate_message_operator", {
                  rate: data.attendance_rate_pct,
                  gate: data.gate_pct,
                })}
              </div>
            )}
          </section>

          {/* Days list */}
          <section className="nf-card p-5">
            <div className="nf-col mb-3">{t("payroll.days_breakdown")}</div>
            <div className="flex flex-col gap-1.5">
              {data.days.map((d, i) => {
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
                    <span
                      aria-hidden="true"
                      style={{ color: cfg.color, fontSize: 16 }}
                    >
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
          </section>
        </>
      )}
    </div>
  );
}

function MiniStat({
  label,
  value,
  accent,
  danger,
}: {
  label: string;
  value: string;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <div
      className="rounded-2xl px-4 py-3"
      style={{
        background: "rgba(255,255,255,0.45)",
        border: "1px solid rgba(255,255,255,0.4)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
    >
      <div className="text-[11px] text-muted uppercase tracking-wide">
        {label}
      </div>
      <div
        className="text-[17px] font-bold tabular-nums mt-1"
        style={{
          color: danger
            ? "var(--danger)"
            : accent
            ? "var(--accent)"
            : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}
