// v2 data hooks — operatorDetail group (see api/team.ts).
// Query keys are identical to the old src/pages/OperatorDetail.tsx so the
// cache and invalidations stay shared between v1 and v2.
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import {
  tgChats,
  tgInsights,
  tgMessages,
  tgStatus,
  TG_STATUS_KEY,
} from "../../../lib/tgUserclient";

export interface OpDetailAccount {
  has_account: boolean;
  is_active: boolean;
  deleted: boolean;
  username: string | null;
  preferred_language?: "ru" | "uz" | null;
}

export interface OpDetailOperator {
  id: number;
  full_name: string;
  phone: string;
  personal_phone: string;
  status: string;
  hired_at: string | null;
  note?: string;
  account: OpDetailAccount;
  blocking_gate_enabled?: boolean;
  livestream_enabled?: boolean;
  managed_by_id?: number | null;
  avatar_url?: string | null;
  is_paused?: boolean;
}

export interface OpDetailStats {
  operator?: { id: number; full_name: string; phone?: string; status?: string; hired_at?: string | null };
  totals?: { total: string | number; count: number };
  by_model?: { phone_model: string; count: number; total: string | number }[];
  by_partner?: { partner_id: number; partner_name: string; count: number; total: string | number }[];
  by_day?: { day: string; count: number; total: string | number }[];
  payroll?: {
    payout: string | number;
    threshold_reached: boolean;
    total_sales: string | number;
    threshold: string | number;
    progress_percent: number;
  } | null;
}

export interface OpDetailPlan {
  target: string | number | null;
  actual: string | number;
  percent: number;
  achievements?: { slug: string; emoji: string; label: string }[];
}

export interface OpDetailOwner {
  id: number;
  username: string;
  full_name?: string;
  role: string;
  reports_to_id?: number | null;
}

export interface OpDetailAttendanceLog {
  id: number;
  checked_in_at: string;
  checked_out_at: string | null;
  duration_min: number | null;
  was_late: boolean;
  source: "qr" | "tg" | "manual";
  auto_closed: boolean;
  manually_closed?: boolean;
  manually_closed_by_name?: string;
  manual_close_note?: string;
}

export interface OpDetailHeatDay {
  date: string;
  status: "on_time" | "late" | "absent" | "weekend" | "auto_closed" | "manually_closed";
}

export interface OpDetailAttendanceStats {
  days_expected: number;
  days_present: number;
  days_absent: number;
  late_count: number;
  avg_late_minutes: number;
  auto_closed_count: number;
  manually_closed_count: number;
  avg_shift_minutes: number;
  total_worked_hours: number;
  heatmap: OpDetailHeatDay[];
}

export interface OpDetailLessonRow {
  id: number;
  lesson_date: string;
  micro_lesson: string;
  summary: string;
  opened_at: string | null;
}

export interface OpDetailLesson {
  micro_lesson: string;
  summary: string;
  stats_snapshot?: { sales_count?: number; revenue_uzs?: number | string; dialogs_count?: number; avg_quality?: number };
  highlights?: { title: string; evidence: string }[];
  tips?: { title: string; why: string; example: string; action: string }[];
}

export interface OpDetailStickerPalette {
  palette: string[];
  taken: { emoji: string; operator_name: string }[];
  rare: { emoji: string; operator_id: number; operator_name: string } | null;
}

export type OpDetailCreds = { username: string; password: string };

/** YYYY-MM-DD in Asia/Tashkent (avoids the UTC off-by-one of toISOString). */
export function opDetailTashkentDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function useOpDetail(id?: string) {
  return useQuery<OpDetailOperator>({
    queryKey: ["operator-detail", id],
    queryFn: () => api.get<OpDetailOperator>(`/operators/${id}/`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useOpDetailStats(id: string | undefined, params: Record<string, string>) {
  const paramKey = JSON.stringify(params);
  return useQuery<OpDetailStats>({
    queryKey: ["operator-stats", id, paramKey],
    queryFn: () => api.get(`/operators/${id}/stats/`, { params }).then((r) => r.data),
    enabled: !!id,
  });
}

export function useOpDetailSticker(id: string | undefined, enabled: boolean) {
  return useQuery<{ sticker: { emoji: string; is_rare: boolean } | null }>({
    queryKey: ["operator-sticker", id],
    queryFn: () => api.get(`/operators/${id}/sticker/`).then((r) => r.data),
    enabled: !!id && enabled,
  });
}

export function useOpDetailStickerPalette(enabled: boolean) {
  return useQuery<OpDetailStickerPalette>({
    queryKey: ["stickers", "palette"],
    queryFn: () => api.get("/stickers/palette/").then((r) => r.data as OpDetailStickerPalette),
    enabled,
  });
}

/** Same key as the old page (["users"]) — the /users/ list. */
export function useOpDetailOwners(enabled: boolean) {
  return useQuery<OpDetailOwner[]>({
    queryKey: ["users"],
    queryFn: () => api.get<OpDetailOwner[]>("/users/").then((r) => r.data),
    enabled,
    retry: false,
  });
}

export function useOpDetailQrPng(id: string | undefined, ver: number, enabled: boolean) {
  return useQuery({
    queryKey: ["operator-qr-png", id, ver],
    queryFn: async () => {
      const r = await api.get<Blob>(`/attendance/operators/${id}/qr.png`, { responseType: "blob" });
      return URL.createObjectURL(r.data);
    },
    enabled: !!id && enabled,
    staleTime: Infinity,
  });
}

export function useOpDetailPlan(id: string | undefined, year: number, month: number) {
  return useQuery<OpDetailPlan>({
    queryKey: ["operator-plan", id, year, month],
    queryFn: () => api.get(`/operators/${id}/plan/`, { params: { year, month } }).then((r) => r.data),
    enabled: !!id,
  });
}

/** 401 with code `pin_required` — attendance data is behind the manager PIN. */
export function opDetailIsPinRequired(err: unknown): boolean {
  const r = (err as { response?: { status?: number; data?: { code?: string } } })?.response;
  return r?.status === 401 && r?.data?.code === "pin_required";
}
const opDetailRetry = (n: number, err: unknown) => !opDetailIsPinRequired(err) && n < 2;

export function useOpDetailAttendanceReport(id: string | undefined, enabled: boolean) {
  return useQuery<{ rows?: OpDetailAttendanceStats[] }>({
    queryKey: ["operator-attendance-report", id],
    queryFn: () => {
      const to = opDetailTashkentDate();
      const from = opDetailTashkentDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
      return api
        .get(`/attendance/report/`, { params: { date_from: from, date_to: to, operator: id } })
        .then((r) => r.data);
    },
    enabled: !!id && enabled,
    retry: opDetailRetry,
  });
}

export function useOpDetailAttendanceLogs(id: string | undefined, enabled: boolean) {
  return useQuery<OpDetailAttendanceLog[]>({
    queryKey: ["operator-attendance-logs", id],
    queryFn: () => api.get(`/attendance/operators/${id}/logs/`).then((r) => r.data),
    enabled: !!id && enabled,
    retry: opDetailRetry,
  });
}

export function useOpDetailLessons(id: string | undefined, enabled: boolean) {
  return useQuery<OpDetailLessonRow[]>({
    queryKey: ["operator-lessons", id],
    queryFn: () => api.get<OpDetailLessonRow[]>(`/lessons/history/`, { params: { operator: id, limit: 7 } }).then((r) => r.data),
    enabled: !!id && enabled,
  });
}

export function useOpDetailLesson(id: string | undefined, date: string | null) {
  return useQuery<OpDetailLesson>({
    queryKey: ["operator-lesson-detail", id, date],
    queryFn: () => api.get(`/lessons/`, { params: { operator: id, date } }).then((r) => r.data),
    enabled: !!id && !!date,
  });
}

// --- Telegram dialogs (same keys as components/TgDialogsPanel) ---

export function useOpDetailTgStatus(operatorId: number) {
  return useQuery({
    queryKey: TG_STATUS_KEY(operatorId),
    queryFn: () => tgStatus(operatorId).then((r) => r.data),
    refetchInterval: (query) => {
      const job = query.state.data?.latest_backfill_job;
      return job?.status === "running" || job?.status === "pending" ? 3000 : false;
    },
  });
}

export function useOpDetailTgChats(operatorId: number) {
  return useQuery({
    queryKey: ["tg-chats", operatorId],
    queryFn: () => tgChats(operatorId).then((r) => r.data),
  });
}

export function useOpDetailTgMessages(chatId: number | null) {
  return useQuery({
    queryKey: ["tg-messages", chatId],
    queryFn: () => tgMessages(chatId!, 100).then((r) => r.data),
    enabled: !!chatId,
  });
}

export function useOpDetailTgInsights(chatId: number | null) {
  return useQuery({
    queryKey: ["tg-insights", chatId],
    queryFn: () => tgInsights({ chat: chatId! }).then((r) => r.data),
    enabled: !!chatId,
  });
}

/** Mutation endpoints (same URLs/payloads as the old page). */
export const opDetailApi = {
  createAccount: (id: string) => api.post<OpDetailCreds>(`/operators/${id}/account/`, {}).then((r) => r.data),
  resetPassword: (id: string) => api.post<OpDetailCreds>(`/operators/${id}/account/reset-password/`, {}).then((r) => r.data),
  /** Audited on the server: every reveal is written to the audit log. */
  viewPassword: (id: string) => api.get<OpDetailCreds>(`/operators/${id}/account/password/`).then((r) => r.data),
  setAccountActive: (id: string, active: boolean) =>
    api.post(active ? `/operators/${id}/account/activate/` : `/operators/${id}/account/deactivate/`),
  deleteAccount: (id: string, comment: string) => api.post(`/operators/${id}/account/delete/`, { comment }),
  setLanguage: (id: string, preferred_language: "ru" | "uz") =>
    api.patch(`/operators/${id}/account/language/`, { preferred_language }),
  patchOperator: (id: string, payload: Record<string, unknown>) => api.patch(`/operators/${id}/`, payload),
  rotateQr: (id: string) => api.post(`/attendance/operators/${id}/qr/rotate/`),
  setPlan: (id: string, target_amount: string, year: number, month: number) =>
    api.put(`/operators/${id}/plan/`, { target_amount, year, month }),
  closeShift: (logId: number, note: string) => api.post(`/attendance/logs/${logId}/close/`, { note }),
  setSticker: (id: string, payload: { emoji: string; is_rare: boolean }) => api.put(`/operators/${id}/sticker/`, payload),
  clearSticker: (id: string) => api.delete(`/operators/${id}/sticker/`),
};
