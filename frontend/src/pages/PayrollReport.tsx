import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText, FileType2 } from "lucide-react";
import { api } from "../lib/api";
import { formatUZS } from "../lib/format";
import { Button, Modal, StatusBadge } from "../components/ui";
import { MultiSelectPopover } from "../components/MultiSelectPopover";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

/**
 * Manager-only attendance-based payroll report.
 *
 * Читает `/attendance/payroll/?month=YYYY-MM` (список всех активных
 * операторов + агрегированные показатели), плюс детальный breakdown
 * по кликну на строку — `/attendance/payroll/{id}/?month=YYYY-MM`
 * (с массивом `days[]`). Скачивания per-operator (Excel/PDF) идут через
 * `?export=xlsx|pdf` на detail-endpoint'e (там формируется файл).
 *
 * NB: экспорт «на весь список» backend не поддерживает — только per-operator,
 * поэтому кнопки Excel/PDF доступны только внутри модалки drilldown'а.
 */

type PayrollRow = {
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
};

type PayrollDay = {
  date: string;
  weekday: number;
  is_working_day: boolean;
  checked_in_at: string | null;
  checked_out_at: string | null;
  status:
    | "on_time"
    | "late"
    | "absent"
    | "weekend"
    | "free_absence";
  minutes_late: number;
  deduction_uzs: string;
  note: string;
};

type PayrollDetail = PayrollRow & { days: PayrollDay[] };

type PayrollListResponse = {
  period: { year: number; month: number };
  rows: PayrollRow[];
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

/**
 * Скачивание blob'а — тот же приём, что и в AttendanceReport (см. строки
 * 101–105 оригинала): fetch через axios с responseType=blob, потом
 * URL.createObjectURL + click. Не открываем в новой вкладке, чтобы
 * файл всегда попал в «Загрузки», а не в PDF-viewer браузера.
 */
async function downloadPayroll(
  operatorId: number,
  month: string,
  format: "xlsx" | "pdf",
) {
  const res = await api.get(
    `/attendance/payroll/${operatorId}/?month=${month}&export=${format}`,
    { responseType: "blob" },
  );
  const blob = res.data as Blob;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `payroll_${operatorId}_${month}.${format}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function PayrollReport() {
  const t = useT();
  usePageHeader({
    title: t("payroll.title"),
    subtitle: t("payroll.subtitle"),
  });

  const [month, setMonth] = useState<string>(currentMonthValue());
  const [selectedOpIds, setSelectedOpIds] = useState<number[]>([]);
  const [drillOpId, setDrillOpId] = useState<number | null>(null);

  const listQuery = useQuery<PayrollListResponse>({
    queryKey: ["payroll-list", month],
    queryFn: () =>
      api
        .get<PayrollListResponse>(`/attendance/payroll/?month=${month}`)
        .then((r) => r.data),
  });

  const rowsAll = listQuery.data?.rows ?? [];

  const popoverOptions = useMemo(
    () =>
      rowsAll.map((r) => ({ id: r.operator_id, name: r.operator_name })),
    [rowsAll],
  );

  const rows = useMemo(() => {
    if (selectedOpIds.length === 0) return rowsAll;
    const set = new Set(selectedOpIds);
    return rowsAll.filter((r) => set.has(r.operator_id));
  }, [rowsAll, selectedOpIds]);

  const drilldownQuery = useQuery<PayrollDetail>({
    queryKey: ["payroll-detail", drillOpId, month],
    enabled: drillOpId != null,
    queryFn: () =>
      api
        .get<PayrollDetail>(
          `/attendance/payroll/${drillOpId}/?month=${month}`,
        )
        .then((r) => r.data),
  });

  const gridTpl =
    "1.4fr .7fr .9fr .8fr .7fr 1fr 1fr 1fr";

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      <section className="nf-card p-4 flex flex-wrap items-center gap-4 animate-nfFadeUp">
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
        <div className="flex items-center gap-2">
          <MultiSelectPopover
            label={t("nav.operators")}
            options={popoverOptions}
            selectedIds={selectedOpIds}
            onChange={setSelectedOpIds}
          />
        </div>
      </section>

      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{ gridTemplateColumns: gridTpl }}
        >
          <div>{t("payroll.operator_col")}</div>
          <div className="text-right">{t("payroll.salary_gross")}</div>
          <div className="text-center">{t("payroll.days_col")}</div>
          <div className="text-center">{t("payroll.attendance_rate")}</div>
          <div className="text-center">{t("payroll.late_count")}</div>
          <div className="text-right">{t("payroll.absence_deduction")}</div>
          <div className="text-right">{t("payroll.late_penalty_total")}</div>
          <div className="text-right">{t("payroll.salary_earned")}</div>
        </div>
        {listQuery.isLoading ? (
          <div className="text-center text-muted py-12 text-[13px]">
            {t("common.loading")}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center text-muted py-12 text-[13px]">
            {t("attendance.report.no_data_range")}
          </div>
        ) : (
          <div>
            {rows.map((r, i) => (
              <div
                key={r.operator_id}
                onClick={() => setDrillOpId(r.operator_id)}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns: gridTpl,
                  animationDelay: `${0.02 + i * 0.035}s`,
                }}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 truncate">
                    <span className="font-medium truncate">
                      {r.operator_name}
                    </span>
                    {r.gate_triggered && (
                      <StatusBadge tone="hot">
                        {t("payroll.gate_badge", { pct: r.gate_pct })}
                      </StatusBadge>
                    )}
                  </div>
                </div>
                <div className="text-right tabular-nums text-[13px]">
                  {formatUZS(r.salary_gross)}
                </div>
                <div className="text-center tabular-nums text-[13px]">
                  {r.days_attended} / {r.working_days_planned}
                </div>
                <div
                  className="text-center tabular-nums font-semibold text-[13px]"
                  style={{
                    color: r.gate_triggered
                      ? "var(--danger)"
                      : r.attendance_rate_pct >= 95
                      ? "var(--accent)"
                      : undefined,
                  }}
                >
                  {r.attendance_rate_pct}%
                </div>
                <div className="text-center tabular-nums text-[13px]">
                  {r.days_late > 0 ? (
                    <span
                      className="font-semibold"
                      style={{ color: "var(--accent)" }}
                    >
                      {r.days_late}
                    </span>
                  ) : (
                    <span className="text-muted">0</span>
                  )}
                </div>
                <div className="text-right tabular-nums text-[13px] text-muted">
                  {Number(r.absence_deduction) > 0
                    ? "−" + formatUZS(r.absence_deduction)
                    : "—"}
                </div>
                <div className="text-right tabular-nums text-[13px] text-muted">
                  {Number(r.late_penalty_total) > 0
                    ? "−" + formatUZS(r.late_penalty_total)
                    : "—"}
                </div>
                <div className="text-right font-semibold tabular-nums">
                  {formatUZS(r.salary_earned)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Drilldown modal */}
      <Modal open={drillOpId != null} onClose={() => setDrillOpId(null)} width={720}>
        {drillOpId != null && (
          <PayrollDrilldown
            detail={drilldownQuery.data}
            loading={drilldownQuery.isLoading}
            month={month}
          />
        )}
      </Modal>
    </div>
  );
}

function PayrollDrilldown({
  detail,
  loading,
  month,
}: {
  detail: PayrollDetail | undefined;
  loading: boolean;
  month: string;
}) {
  const t = useT();
  const [downloading, setDownloading] = useState<"xlsx" | "pdf" | null>(null);

  if (loading || !detail) {
    return (
      <div className="p-8 text-center text-muted text-[13px]">
        {t("common.loading")}
      </div>
    );
  }

  const dailyRateNum = Number(detail.daily_rate);

  return (
    <div className="p-7 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[18px] font-semibold tracking-tight">
            {detail.operator_name}
          </div>
          <div className="text-[12.5px] text-muted mt-0.5">
            {t("payroll.shift_hint", {
              from: detail.shift_start,
              to: detail.shift_end,
              grace: detail.grace_period_min,
            })}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            variant="secondary"
            disabled={downloading != null}
            onClick={async () => {
              setDownloading("xlsx");
              try {
                await downloadPayroll(detail.operator_id, month, "xlsx");
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
            disabled={downloading != null}
            onClick={async () => {
              setDownloading("pdf");
              try {
                await downloadPayroll(detail.operator_id, month, "pdf");
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
      </div>

      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: "repeat(4, 1fr)" }}
      >
        <StatTile
          label={t("payroll.salary_gross")}
          value={formatUZS(detail.salary_gross)}
        />
        <StatTile
          label={t("payroll.daily_rate")}
          value={formatUZS(dailyRateNum)}
        />
        <StatTile
          label={t("payroll.absence_deduction")}
          value={"−" + formatUZS(detail.absence_deduction)}
          muted={Number(detail.absence_deduction) === 0}
        />
        <StatTile
          label={t("payroll.late_penalty_total")}
          value={"−" + formatUZS(detail.late_penalty_total)}
          muted={Number(detail.late_penalty_total) === 0}
        />
        <StatTile
          label={t("payroll.days_col")}
          value={`${detail.days_attended} / ${detail.working_days_planned}`}
        />
        <StatTile
          label={t("payroll.attendance_rate")}
          value={`${detail.attendance_rate_pct}%`}
          accent={!detail.gate_triggered && detail.attendance_rate_pct >= 95}
          danger={detail.gate_triggered}
        />
        <StatTile
          label={t("payroll.late_count")}
          value={String(detail.days_late)}
          accent={detail.days_late > 0}
        />
        <StatTile
          label={t("payroll.salary_earned")}
          value={formatUZS(detail.salary_earned)}
          big
        />
      </div>

      {detail.gate_triggered && (
        <div
          className="rounded-xl px-4 py-3 text-[13px]"
          style={{
            background: "rgba(220,60,40,.08)",
            color: "var(--danger)",
            border: "1px solid rgba(220,60,40,.2)",
          }}
        >
          {t("payroll.gate_message", {
            rate: detail.attendance_rate_pct,
            gate: detail.gate_pct,
          })}
        </div>
      )}

      <div>
        <div className="nf-col mb-2">{t("payroll.days_breakdown")}</div>
        <div className="flex flex-col gap-1">
          {detail.days.map((d) => (
            <DayRow key={d.date} day={d} />
          ))}
        </div>
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  accent,
  danger,
  muted,
  big,
}: {
  label: string;
  value: string;
  accent?: boolean;
  danger?: boolean;
  muted?: boolean;
  big?: boolean;
}) {
  return (
    <div className="nf-tile" style={{ padding: "12px 14px" }}>
      <div className="text-[10.5px] text-muted uppercase tracking-wide">
        {label}
      </div>
      <div
        className={
          "tabular-nums mt-1 " +
          (big ? "text-[18px] font-bold" : "text-[15px] font-semibold")
        }
        style={{
          color: danger
            ? "var(--danger)"
            : accent
            ? "var(--accent)"
            : muted
            ? "var(--muted)"
            : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function DayRow({ day }: { day: PayrollDay }) {
  const t = useT();
  const cfg = statusConfig(day.status, t);
  const deduction = Number(day.deduction_uzs);
  return (
    <div
      className="grid gap-3 items-center px-3 py-2 rounded-lg text-[13px]"
      style={{
        gridTemplateColumns: "20px 1fr auto auto",
        background:
          day.status === "on_time"
            ? "rgba(22,163,74,.05)"
            : day.status === "late"
            ? "rgba(245,158,11,.06)"
            : day.status === "absent"
            ? "rgba(220,60,40,.05)"
            : day.status === "free_absence"
            ? "rgba(59,130,246,.05)"
            : "var(--faint)",
        border: "1px solid var(--border)",
      }}
    >
      <span aria-hidden="true">{cfg.icon}</span>
      <div className="min-w-0">
        <div className="font-medium truncate">
          {fmtDayRu(day.date)}
          <span
            className="ml-2 text-[11.5px] font-normal"
            style={{ color: cfg.color }}
          >
            {cfg.label}
          </span>
        </div>
        {day.note && (
          <div className="text-[11.5px] text-muted truncate">{day.note}</div>
        )}
      </div>
      <div className="text-[12px] text-muted tabular-nums text-right">
        {day.checked_in_at || day.checked_out_at ? (
          <>
            {fmtHM(day.checked_in_at)}
            {day.checked_out_at && <> → {fmtHM(day.checked_out_at)}</>}
          </>
        ) : (
          "—"
        )}
      </div>
      <div
        className="tabular-nums text-[12.5px] font-semibold text-right min-w-[92px]"
        style={{ color: deduction > 0 ? "var(--danger)" : "var(--muted)" }}
      >
        {deduction > 0 ? "−" + formatUZS(day.deduction_uzs) : "—"}
      </div>
    </div>
  );
}

function statusConfig(
  status: PayrollDay["status"],
  t: (k: string, p?: Record<string, string | number>) => string,
): { icon: string; label: string; color: string } {
  switch (status) {
    case "on_time":
      return {
        icon: "✓",
        label: t("payroll.day.on_time"),
        color: "#16a34a",
      };
    case "late":
      return { icon: "⏰", label: t("payroll.day.late"), color: "#d97706" };
    case "absent":
      return {
        icon: "✕",
        label: t("payroll.day.absent"),
        color: "var(--danger)",
      };
    case "weekend":
      return {
        icon: "○",
        label: t("payroll.day.weekend"),
        color: "var(--muted)",
      };
    case "free_absence":
      return {
        icon: "◐",
        label: t("payroll.day.free_absence"),
        color: "#2563eb",
      };
  }
}

