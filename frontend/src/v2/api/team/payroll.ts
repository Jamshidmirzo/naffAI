// v2 data hooks — payroll group (/attendance/payroll, /settings/attendance).
// Query keys are the same as the old pages (PayrollReport.tsx, AttendanceSettings.tsx).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";

/* ------------------------------------------------------------------ */
/* /attendance/payroll                                                 */
/* ------------------------------------------------------------------ */

export type PayrollDayStatus = "on_time" | "late" | "absent" | "weekend" | "free_absence";

export type PayrollDay = {
  date: string;
  weekday: number;
  is_working_day: boolean;
  checked_in_at: string | null;
  checked_out_at: string | null;
  status: PayrollDayStatus;
  minutes_late: number;
  deduction_uzs: string;
  note: string;
};

export type PayrollAttendanceBlock = {
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
  shortfall: { days_more_needed: number; explanation: string };
  days?: PayrollDay[];
};

export type PayrollSalesBlock = {
  plan_amount_uzs: string;
  plan_source: string;
  actual_uzs: string;
  rate_pct: number;
  gate_passed: boolean;
  block_earned: string;
  shortfall: { amount_more_needed: string; explanation: string };
};

export type PayrollRow = {
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
  attendance: Omit<PayrollAttendanceBlock, "days">;
  sales: PayrollSalesBlock;
  total_earned: string;
  max_possible: string;
};

export type PayrollDetail = Omit<PayrollRow, "attendance"> & { attendance: PayrollAttendanceBlock };

export type PayrollListResponse = { period: { year: number; month: number }; rows: PayrollRow[] };

export function usePayrollList(month: string) {
  return useQuery<PayrollListResponse>({
    queryKey: ["payroll-list", month],
    queryFn: () => api.get<PayrollListResponse>(`/attendance/payroll/?month=${month}`).then((r) => r.data),
  });
}

export function usePayrollDetail(operatorId: number | null, month: string) {
  return useQuery<PayrollDetail>({
    queryKey: ["payroll-detail", operatorId, month],
    enabled: operatorId != null,
    queryFn: () => api.get<PayrollDetail>(`/attendance/payroll/${operatorId}/?month=${month}`).then((r) => r.data),
  });
}

/** Per-operator Excel/PDF download (same endpoint as the old page). */
export async function payrollDownload(operatorId: number, month: string, format: "xlsx" | "pdf") {
  const res = await api.get(`/attendance/payroll/${operatorId}/?month=${month}&export=${format}`, { responseType: "blob" });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `payroll_${operatorId}_${month}.${format}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/* Personal payroll rule                                               */
/* ------------------------------------------------------------------ */

export type PayrollPayoutType = "fixed" | "percent" | "tiers";

export type PayrollRuleDto = {
  id: number;
  scope: "global" | "operator";
  operator_id: number | null;
  threshold: string;
  payout_type: PayrollPayoutType;
  payout_value: string;
  tiers: unknown[];
  period: string;
  is_active: boolean;
} | null;

export type PayrollRuleResponse = {
  operator_id: number;
  source: "override" | "global" | "none";
  effective: PayrollRuleDto;
  override: PayrollRuleDto;
  global: PayrollRuleDto;
};

export function usePayrollRule(operatorId: number) {
  return useQuery<PayrollRuleResponse>({
    queryKey: ["payroll-rule-operator", operatorId],
    queryFn: () => api.get<PayrollRuleResponse>(`/payroll/rules/operator/${operatorId}/`).then((r) => r.data),
  });
}

function usePayrollInvalidate(operatorId: number) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["payroll-rule-operator", operatorId] });
    qc.invalidateQueries({ queryKey: ["payroll-list"] });
    qc.invalidateQueries({ queryKey: ["payroll-detail"] });
    qc.invalidateQueries({ queryKey: ["payroll"] });
  };
}

export function usePayrollRuleSave(operatorId: number) {
  const inv = usePayrollInvalidate(operatorId);
  return useMutation({
    mutationFn: (body: { threshold: string; payout_type: PayrollPayoutType; payout_value: string }) =>
      api.put<PayrollRuleResponse>(`/payroll/rules/operator/${operatorId}/`, body).then((r) => r.data),
    onSuccess: inv,
  });
}

export function usePayrollRuleReset(operatorId: number) {
  const inv = usePayrollInvalidate(operatorId);
  return useMutation({
    mutationFn: () => api.put<PayrollRuleResponse>(`/payroll/rules/operator/${operatorId}/`, { reset: true }).then((r) => r.data),
    onSuccess: inv,
  });
}

/* ------------------------------------------------------------------ */
/* /attendance/settings                                                */
/* ------------------------------------------------------------------ */

export type AttSettings = {
  shift_start: string;
  shift_end: string;
  late_threshold_min: number;
  auto_close_at: string;
  checkout_reminder_after_hours: number;
  max_backfill_hours: number;
  default_salary_uzs: string;
  default_grace_period_min: number;
  default_late_penalty_uzs: string;
  default_weekly_day_off: number;
  default_attendance_gate_pct: number;
  default_weekly_free_absences: number;
  default_attendance_bonus_uzs: string;
  default_sales_bonus_uzs: string;
  default_sales_gate_pct: number;
  default_monthly_plan_uzs: string;
  enforce_daily_checkin: boolean;
  nine_hour_reminder_hours: number;
};

export function useAttSettings() {
  return useQuery<AttSettings>({
    queryKey: ["attendance-settings-full"],
    queryFn: () => api.get<AttSettings>("/attendance/settings/").then((r) => r.data),
  });
}

export function useAttSettingsSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: Partial<AttSettings>) => api.patch<AttSettings>("/attendance/settings/", payload).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["attendance-settings-full"] }),
  });
}
