import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileText, FileType2, XCircle } from "lucide-react";
import { api } from "../lib/api";
import { formatUZS } from "../lib/format";
import { Button, Modal, toast } from "../components/ui";
import { MultiSelectPopover } from "../components/MultiSelectPopover";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

/**
 * Manager-only two-gate payroll report.
 *
 * Читает `/attendance/payroll/?month=YYYY-MM` — на строку 2 бинарных
 * флага (attendance / sales) + итоговая сумма. Клик по строке открывает
 * модалку с полным breakdown обоих блоков + attendance days list +
 * скачиванием per-operator (Excel/PDF).
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
  days?: PayrollDay[];
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

type PayrollRow = {
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
  attendance: Omit<AttendanceBlock, "days">;
  sales: SalesBlock;
  total_earned: string;
  max_possible: string;
};

type PayrollDetail = Omit<PayrollRow, "attendance"> & {
  attendance: AttendanceBlock;
};

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
    () => rowsAll.map((r) => ({ id: r.operator_id, name: r.operator_name })),
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
        .get<PayrollDetail>(`/attendance/payroll/${drillOpId}/?month=${month}`)
        .then((r) => r.data),
  });

  // Оператор | План | Продано | Att. ✓/✗ | Sales ✓/✗ | К выплате
  const gridTpl = "1.4fr 1fr 1fr .8fr .8fr 1.1fr";

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
          <div className="text-right">{t("payroll.plan_col")}</div>
          <div className="text-right">{t("payroll.actual_col")}</div>
          <div className="text-center">{t("payroll.gate_col_att")}</div>
          <div className="text-center">{t("payroll.gate_col_sales")}</div>
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
                  <div className="font-medium truncate">{r.operator_name}</div>
                </div>
                <div className="text-right tabular-nums text-[13px]">
                  {formatUZS(r.sales.plan_amount_uzs)}
                </div>
                <div className="text-right tabular-nums text-[13px]">
                  {formatUZS(r.sales.actual_uzs)}
                </div>
                <div className="text-center flex items-center justify-center gap-2">
                  <GateFlag passed={r.attendance.gate_passed} />
                  <span
                    className="tabular-nums text-[13px] font-medium"
                    style={{
                      color: r.attendance.gate_passed ? "#059669" : "#dc2626",
                    }}
                  >
                    {r.attendance.rate_pct.toFixed(1)}%
                  </span>
                </div>
                <div className="text-center flex items-center justify-center gap-2">
                  <GateFlag passed={r.sales.gate_passed} />
                  <span
                    className="tabular-nums text-[13px] font-medium"
                    style={{
                      color: r.sales.gate_passed ? "#059669" : "#dc2626",
                    }}
                  >
                    {r.sales.rate_pct.toFixed(1)}%
                  </span>
                </div>
                <div
                  className="text-right font-semibold tabular-nums"
                  style={{
                    color:
                      Number(r.total_earned) === 0
                        ? "var(--muted)"
                        : undefined,
                  }}
                >
                  {formatUZS(r.total_earned)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Drilldown modal */}
      <Modal open={drillOpId != null} onClose={() => setDrillOpId(null)} width={780}>
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

function GateFlag({ passed }: { passed: boolean }) {
  if (passed) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[12px] font-semibold"
        style={{ color: "#16a34a" }}
      >
        <CheckCircle2 className="w-4 h-4" />
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[12px] font-semibold"
      style={{ color: "var(--danger)" }}
    >
      <XCircle className="w-4 h-4" />
    </span>
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

  const a = detail.attendance;
  const s = detail.sales;

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

      {/* Total */}
      <div
        className="rounded-2xl p-4 flex items-center justify-between"
        style={{
          background: "var(--faint)",
          border: "1px solid var(--border)",
        }}
      >
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">
            {t("payroll.total_to_pay")}
          </div>
          <div className="text-[24px] font-black tabular-nums">
            {formatUZS(detail.total_earned)}
          </div>
        </div>
        <div className="text-right text-[12px] text-muted tabular-nums">
          {t("payroll.of_max", { max: formatUZS(detail.max_possible) })}
        </div>
      </div>

      {/* Two blocks */}
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}
      >
        <GateBlockCard
          title={t("payroll.gate_attendance_title")}
          bonus={detail.attendance_bonus_uzs}
          earned={a.block_earned}
          gatePct={detail.attendance_gate_pct}
          ratePct={a.rate_pct}
          gatePassed={a.gate_passed}
          shortfallText={a.shortfall.explanation}
          extra={
            <div className="text-[12px] text-muted tabular-nums">
              {a.days_attended} / {a.working_days_planned} дн., опозданий:{" "}
              {a.days_late}
              {a.gate_passed && Number(a.late_penalty_total) > 0 && (
                <>
                  {" "}
                  (−{formatUZS(a.late_penalty_total)})
                </>
              )}
            </div>
          }
        />
        <GateBlockCard
          title={t("payroll.gate_sales_title")}
          bonus={detail.sales_bonus_uzs}
          earned={s.block_earned}
          gatePct={detail.sales_gate_pct}
          ratePct={s.rate_pct}
          gatePassed={s.gate_passed}
          shortfallText={s.shortfall.explanation}
          extra={
            <div className="text-[12px] text-muted tabular-nums">
              {formatUZS(s.actual_uzs)} / {formatUZS(s.plan_amount_uzs)}
            </div>
          }
        />
      </div>

      {/* Personal payroll rule (threshold + payout) */}
      <PayrollRuleSection operatorId={detail.operator_id} />

      {/* Days breakdown */}
      {a.days && a.days.length > 0 && (
        <div>
          <div className="nf-col mb-2">{t("payroll.days_breakdown")}</div>
          <div className="flex flex-col gap-1">
            {a.days.map((d) => (
              <DayRow key={d.date} day={d} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Personal payroll rule (threshold + payout formula) editor.
//
// Показывает effective правило (override оператора > глобальное) и позволяет
// менеджеру задать личный порог/формулу или сбросить override к глобальному.
// -----------------------------------------------------------------------------

type PayrollRuleDto = {
  id: number;
  scope: "global" | "operator";
  operator_id: number | null;
  threshold: string;
  payout_type: "fixed" | "percent" | "tiers";
  payout_value: string;
  tiers: unknown[];
  period: string;
  is_active: boolean;
} | null;

type PayrollRuleResponse = {
  operator_id: number;
  source: "override" | "global" | "none";
  effective: PayrollRuleDto;
  override: PayrollRuleDto;
  global: PayrollRuleDto;
};

function PayrollRuleSection({ operatorId }: { operatorId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  const q = useQuery<PayrollRuleResponse>({
    queryKey: ["payroll-rule-operator", operatorId],
    queryFn: () =>
      api
        .get<PayrollRuleResponse>(`/payroll/rules/operator/${operatorId}/`)
        .then((r) => r.data),
  });

  const invalidateAllPayroll = () => {
    qc.invalidateQueries({ queryKey: ["payroll-rule-operator", operatorId] });
    qc.invalidateQueries({ queryKey: ["payroll-list"] });
    qc.invalidateQueries({ queryKey: ["payroll-detail"] });
    qc.invalidateQueries({ queryKey: ["payroll"] });
  };

  const save = useMutation({
    mutationFn: (body: {
      threshold: string;
      payout_type: "fixed" | "percent" | "tiers";
      payout_value: string;
    }) =>
      api
        .put<PayrollRuleResponse>(`/payroll/rules/operator/${operatorId}/`, body)
        .then((r) => r.data),
    onSuccess: () => {
      toast.success(t("payroll_rule.saved"));
      setEditing(false);
      invalidateAllPayroll();
    },
    onError: () => toast.error(t("payroll_rule.save_failed")),
  });

  const reset = useMutation({
    mutationFn: () =>
      api
        .put<PayrollRuleResponse>(`/payroll/rules/operator/${operatorId}/`, {
          reset: true,
        })
        .then((r) => r.data),
    onSuccess: () => {
      toast.success(t("payroll_rule.reset_done"));
      setEditing(false);
      invalidateAllPayroll();
    },
    onError: () => toast.error(t("payroll_rule.save_failed")),
  });

  if (q.isLoading || !q.data) {
    return (
      <div className="rounded-2xl p-4 text-[13px] text-muted"
        style={{ border: "1px solid var(--border)", background: "var(--faint)" }}
      >
        {t("common.loading")}
      </div>
    );
  }

  const data = q.data;
  const eff = data.effective;
  const isOverride = data.source === "override";

  return (
    <div
      className="rounded-2xl p-4 flex flex-col gap-3"
      style={{ border: "1px solid var(--border)", background: "var(--faint)" }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="text-[13px] font-semibold">
            {t("payroll_rule.section_title")}
          </div>
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide"
            style={{
              background: isOverride
                ? "rgba(37,99,235,0.10)"
                : "rgba(107,114,128,0.10)",
              color: isOverride ? "#2563eb" : "var(--muted)",
              border: `1px solid ${
                isOverride ? "rgba(37,99,235,0.30)" : "var(--border)"
              }`,
            }}
          >
            {isOverride
              ? t("payroll_rule.badge_personal")
              : t("payroll_rule.badge_global")}
          </span>
        </div>
        {!editing && (
          <div className="flex gap-2 shrink-0">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              {t("payroll_rule.edit")}
            </Button>
          </div>
        )}
      </div>

      {!editing && (
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <RuleFact
            label={t("payroll_rule.threshold_label")}
            value={eff ? formatUZS(eff.threshold) : "—"}
          />
          <RuleFact
            label={t("payroll_rule.payout_label")}
            value={eff ? formatPayoutFormula(eff, t) : "—"}
          />
        </div>
      )}

      {editing && (
        <PayrollRuleForm
          operatorId={operatorId}
          initial={eff}
          isOverride={isOverride}
          onCancel={() => setEditing(false)}
          onSubmit={(body) => save.mutate(body)}
          onReset={() => reset.mutate()}
          saving={save.isPending}
          resetting={reset.isPending}
        />
      )}
    </div>
  );
}

function RuleFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted">
        {label}
      </div>
      <div className="text-[16px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function formatPayoutFormula(
  rule: NonNullable<PayrollRuleDto>,
  t: (k: string, p?: Record<string, string | number>) => string,
): string {
  const v = rule.payout_value;
  switch (rule.payout_type) {
    case "percent":
      return t("payroll_rule.formula_percent", { value: v });
    case "fixed":
      return t("payroll_rule.formula_fixed", { value: formatUZS(v) });
    case "tiers":
      return t("payroll_rule.formula_tiers");
  }
}

function PayrollRuleForm({
  operatorId: _operatorId,
  initial,
  isOverride,
  onCancel,
  onSubmit,
  onReset,
  saving,
  resetting,
}: {
  operatorId: number;
  initial: PayrollRuleDto;
  isOverride: boolean;
  onCancel: () => void;
  onSubmit: (body: {
    threshold: string;
    payout_type: "fixed" | "percent" | "tiers";
    payout_value: string;
  }) => void;
  onReset: () => void;
  saving: boolean;
  resetting: boolean;
}) {
  const t = useT();
  // Pre-fill from effective — если override отсутствует, форма стартует со
  // значений глобального правила, чтобы менеджер видел точку отсчёта.
  const [threshold, setThreshold] = useState<string>(
    initial ? String(initial.threshold) : "50000000",
  );
  const [payoutType, setPayoutType] = useState<"fixed" | "percent" | "tiers">(
    initial?.payout_type ?? "percent",
  );
  const [payoutValue, setPayoutValue] = useState<string>(
    initial ? String(initial.payout_value) : "3",
  );

  const submit = () => {
    if (!threshold || Number(threshold) < 0) {
      toast.error(t("payroll_rule.err_threshold"));
      return;
    }
    if (payoutType !== "tiers" && (!payoutValue || Number(payoutValue) < 0)) {
      toast.error(t("payroll_rule.err_payout_value"));
      return;
    }
    onSubmit({
      threshold,
      payout_type: payoutType,
      payout_value: payoutValue,
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-muted">
            {t("payroll_rule.threshold_label")}
          </span>
          <input
            type="number"
            min={0}
            className="nf-input py-2 px-3 text-[13px] tabular-nums"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-muted">
            {t("payroll_rule.payout_type_label")}
          </span>
          <select
            className="nf-input py-2 px-3 text-[13px]"
            value={payoutType}
            onChange={(e) =>
              setPayoutType(e.target.value as "fixed" | "percent" | "tiers")
            }
          >
            <option value="percent">{t("payroll_rule.type_percent")}</option>
            <option value="fixed">{t("payroll_rule.type_fixed")}</option>
            <option value="tiers">{t("payroll_rule.type_tiers")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-muted">
            {payoutType === "percent"
              ? t("payroll_rule.value_percent_label")
              : payoutType === "fixed"
              ? t("payroll_rule.value_fixed_label")
              : t("payroll_rule.value_tiers_label")}
          </span>
          <input
            type="number"
            min={0}
            step={payoutType === "percent" ? "0.1" : "1"}
            disabled={payoutType === "tiers"}
            className="nf-input py-2 px-3 text-[13px] tabular-nums disabled:opacity-50"
            value={payoutValue}
            onChange={(e) => setPayoutValue(e.target.value)}
          />
        </label>
      </div>

      {payoutType === "tiers" && (
        <div className="text-[11.5px] text-muted">
          {t("payroll_rule.tiers_hint")}
        </div>
      )}

      <div className="flex flex-wrap gap-2 justify-end">
        {isOverride && (
          <Button
            variant="secondary"
            disabled={saving || resetting}
            onClick={onReset}
          >
            {resetting
              ? t("common.loading")
              : t("payroll_rule.reset_to_global")}
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={saving || resetting}
          onClick={onCancel}
        >
          {t("payroll_rule.cancel")}
        </Button>
        <Button
          variant="primary"
          disabled={saving || resetting}
          onClick={submit}
        >
          {saving ? t("common.loading") : t("payroll_rule.save")}
        </Button>
      </div>
    </div>
  );
}

function GateBlockCard({
  title,
  bonus,
  earned,
  gatePct,
  ratePct,
  gatePassed,
  shortfallText,
  extra,
}: {
  title: string;
  bonus: string;
  earned: string;
  gatePct: number;
  ratePct: number;
  gatePassed: boolean;
  shortfallText: string;
  extra?: React.ReactNode;
}) {
  const barPct = Math.max(0, Math.min(100, ratePct));
  return (
    <div
      className="rounded-2xl p-4 flex flex-col gap-2"
      style={{
        border: `1.5px solid ${
          gatePassed ? "rgba(22,163,74,0.35)" : "rgba(220,60,40,0.35)"
        }`,
        background: gatePassed
          ? "linear-gradient(180deg, rgba(22,163,74,0.05), rgba(22,163,74,0.01))"
          : "linear-gradient(180deg, rgba(220,60,40,0.05), rgba(220,60,40,0.01))",
      }}
    >
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold">{title}</div>
        {gatePassed ? (
          <CheckCircle2 className="w-4 h-4" style={{ color: "#16a34a" }} />
        ) : (
          <XCircle className="w-4 h-4" style={{ color: "var(--danger)" }} />
        )}
      </div>
      <div
        className="text-[20px] font-black tabular-nums"
        style={{
          color: gatePassed ? "#16a34a" : "var(--muted)",
        }}
      >
        {formatUZS(earned)}
      </div>
      <div className="text-[11px] text-muted">из {formatUZS(bonus)}</div>
      <div>
        <div className="flex items-baseline justify-between text-[11.5px] text-muted">
          <span>
            {ratePct}% / {gatePct}%
          </span>
        </div>
        <div
          className="mt-1 relative rounded-full overflow-hidden"
          style={{ height: 6, background: "var(--faint)" }}
        >
          <div
            style={{
              width: `${barPct}%`,
              height: "100%",
              background: gatePassed ? "#16a34a" : "var(--danger)",
              transition: "width .35s ease",
            }}
          />
          {gatePct > 0 && gatePct < 100 && (
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                top: -2,
                bottom: -2,
                left: `${gatePct}%`,
                width: 2,
                background: "var(--text)",
                opacity: 0.35,
              }}
            />
          )}
        </div>
      </div>
      {extra}
      {!gatePassed && shortfallText && (
        <div
          className="rounded-lg px-2.5 py-2 text-[12px]"
          style={{
            background: "rgba(220,60,40,.08)",
            color: "var(--danger)",
            border: "1px solid rgba(220,60,40,.2)",
          }}
        >
          {shortfallText}
        </div>
      )}
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
