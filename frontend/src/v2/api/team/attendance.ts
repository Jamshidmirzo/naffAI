// v2 data hooks — attendance group: /attendance/today, /report, /photos, /kiosk.
// Query keys are the same as the old pages so cache and invalidation are shared.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, API_BASE_URL } from "../../../lib/api";

/* ── helpers ─────────────────────────────────────────────────────────── */

const TZ = "Asia/Tashkent";

/** Tashkent-local YYYY-MM-DD (the backend counts days in Tashkent, never UTC). */
export function attTashkentDate(d: Date = new Date()): string {
  return d.toLocaleDateString("sv-SE", { timeZone: TZ });
}

/** First day of the current Tashkent month, YYYY-MM-DD. */
export function attTashkentMonthStart(d: Date = new Date()): string {
  return attTashkentDate(d).slice(0, 8) + "01";
}

/** Tashkent-local yesterday, YYYY-MM-DD. */
export function attTashkentYesterday(): string {
  const [y, m, day] = attTashkentDate().split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, day - 1, 12));
  return utc.toISOString().slice(0, 10);
}

/** HH:MM in Tashkent. */
export function attFmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

/** Absolute media URL for photos stored under /media. */
export function attMediaUrl(u?: string | null): string | null {
  if (!u) return null;
  if (u.startsWith("http")) return u;
  return `${API_BASE_URL.replace(/\/api$/, "")}${u}`;
}

function listOf<T>(d: T[] | { results?: T[] }): T[] {
  return Array.isArray(d) ? d : d.results ?? [];
}

/* ── PIN status (same key as PinGate) ────────────────────────────────── */

export interface AttPinStatus {
  role: string;
  has_pin: boolean;
  pin_required: boolean;
  pin_verified: boolean;
  expires_at: string | null;
  ttl_minutes: number;
  updated_at: string | null;
  updated_by: string | null;
}

export function useAttPinStatus() {
  return useQuery<AttPinStatus>({
    queryKey: ["attendance-pin-status"],
    queryFn: () => api.get<AttPinStatus>("/attendance/pin/status/").then((r) => r.data),
    staleTime: 30_000,
  });
}

/* ── settings (read-only here; for the grace-period hint) ───────────── */

export interface AttSettingsLite {
  shift_start: string;
  shift_end: string;
  default_grace_period_min: number;
}

export function useAttSettingsLite() {
  return useQuery<AttSettingsLite>({
    queryKey: ["attendance-settings-full"],
    queryFn: () => api.get<AttSettingsLite>("/attendance/settings/").then((r) => r.data),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/* ── /attendance/today ───────────────────────────────────────────────── */

export interface AttEvent {
  id: number;
  operator_id: number;
  operator_name: string;
  checked_in_at: string;
  checked_out_at: string | null;
  was_late: boolean;
  duration_min: number | null;
  auto_closed: boolean;
  source: "qr" | "tg" | "manual";
  checkin_photo_url?: string | null;
  checkout_photo_url?: string | null;
}

export interface AttAbsent {
  id: number;
  full_name: string;
}

export interface AttDayReport {
  total_active_operators: number;
  present: AttEvent[];
  late: AttEvent[];
  absent: AttAbsent[];
  counts: { present: number; late: number; absent: number };
}

export function useAttDayReport(date: string, opts?: { poll?: boolean }) {
  return useQuery<AttDayReport>({
    queryKey: ["attendance-report", date],
    queryFn: () => api.get<AttDayReport>(`/attendance/report/?date=${date}`).then((r) => r.data),
    refetchInterval: opts?.poll === false ? false : 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useAttCloseShift(date: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) =>
      api.post(`/attendance/logs/${id}/close/`, { note }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attendance-report", date] });
    },
  });
}

/* ── /attendance/report (period statistics) ─────────────────────────── */

export interface AttOperatorLite {
  id: number;
  full_name: string;
  status?: "active" | "trainee" | "inactive";
}

export type AttHeatStatus = "on_time" | "late" | "absent" | "weekend" | "auto_closed" | "manually_closed";

export interface AttPeriodStats {
  operator_id: number;
  operator_name: string;
  days_expected: number;
  days_present: number;
  days_absent: number;
  late_count: number;
  avg_late_minutes: number;
  auto_closed_count: number;
  manually_closed_count: number;
  avg_shift_minutes: number;
  total_worked_hours: number;
  heatmap: Array<{ date: string; status: AttHeatStatus }>;
}

export interface AttPeriodReport {
  period: { from: string; to: string };
  rows: AttPeriodStats[];
}

export function useAttOperatorsList() {
  return useQuery<AttOperatorLite[]>({
    queryKey: ["operators-list"],
    queryFn: () => api.get<AttOperatorLite[] | { results: AttOperatorLite[] }>("/operators/").then((r) => listOf(r.data)),
  });
}

function opsParam(ids: number[]) {
  return ids.length > 0 ? `&operator=${ids.join(",")}` : "";
}

export function useAttPeriodReport(dateFrom: string, dateTo: string, opIds: number[]) {
  return useQuery<AttPeriodReport>({
    queryKey: ["attendance-statistics", dateFrom, dateTo, opIds],
    queryFn: () =>
      api
        .get<AttPeriodReport>(`/attendance/report/?date_from=${dateFrom}&date_to=${dateTo}${opsParam(opIds)}`)
        .then((r) => r.data),
    enabled: !!dateFrom && !!dateTo,
  });
}

/** Downloads the period report as .xlsx with the auth header (old page used window.open without a token). */
export async function attDownloadPeriodXlsx(dateFrom: string, dateTo: string, opIds: number[]) {
  const r = await api.get(`/attendance/report/?date_from=${dateFrom}&date_to=${dateTo}${opsParam(opIds)}&format=xlsx`, {
    responseType: "blob",
  });
  const url = URL.createObjectURL(r.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `attendance_${dateFrom}_to_${dateTo}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ── /attendance/photos ──────────────────────────────────────────────── */

export interface AttPhotoRow {
  log_id: number;
  operator_id: number;
  operator_name: string;
  date: string;
  checked_in_at: string;
  checked_out_at: string | null;
  checkin_photo_url: string | null;
  checkin_photo_thumb: string | null;
  checkout_photo_url: string | null;
  checkout_photo_thumb: string | null;
  was_late: boolean;
  auto_closed: boolean;
  manually_closed: boolean;
  source: "qr" | "tg" | "manual";
  duration_min: number | null;
}

export interface AttPhotosPage {
  count: number;
  next: string | null;
  previous: string | null;
  results: AttPhotoRow[];
}

export const ATT_PHOTOS_PAGE = 24;

export function useAttPhotoOperators() {
  return useQuery<AttOperatorLite[]>({
    queryKey: ["operators-list-for-photos"],
    queryFn: () => api.get<AttOperatorLite[] | { results: AttOperatorLite[] }>("/operators/").then((r) => listOf(r.data)),
    staleTime: 60 * 60_000,
  });
}

export function useAttPhotos(f: { dateFrom: string; dateTo: string; operatorId: number | ""; offset: number }, live: boolean) {
  return useQuery<AttPhotosPage>({
    queryKey: ["attendance-photos", f],
    queryFn: () => {
      const params: Record<string, string | number> = { limit: ATT_PHOTOS_PAGE, offset: f.offset };
      if (f.dateFrom) params.date_from = f.dateFrom;
      if (f.dateTo) params.date_to = f.dateTo;
      if (f.operatorId) params.operator = f.operatorId;
      return api.get<AttPhotosPage>("/attendance/photos/", { params }).then((r) => r.data);
    },
    placeholderData: keepPreviousData,
    refetchInterval: live ? 60_000 : false,
  });
}

/* ── /attendance/kiosk ───────────────────────────────────────────────── */

export interface KioskQrPreview {
  operator: { id: number; full_name: string };
  on_shift: boolean;
  checked_in_at: string | null;
  expected_action: "check_in" | "check_out";
}

export interface KioskQrToken {
  operator_id: number;
  operator_name: string;
  payload: string;
  url: string;
}

export interface KioskScanResult {
  action: "check_in" | "check_out";
  operator: { id: number; full_name: string };
  was_late?: boolean;
  checked_in_at?: string;
  checked_out_at?: string;
  duration_min?: number;
  photo_url?: string;
}

/** Active + trainee operators (inactive hidden so nobody marks a fired operator). */
export function useKioskOperators() {
  return useQuery<AttOperatorLite[]>({
    queryKey: ["kiosk-operators"],
    queryFn: () =>
      api
        .get<AttOperatorLite[] | { results: AttOperatorLite[] }>("/operators/")
        .then((r) => listOf(r.data).filter((o) => o.status !== "inactive")),
    staleTime: 5 * 60_000,
  });
}

export function useKioskQrToken(operatorId: number | null) {
  return useQuery<KioskQrToken>({
    queryKey: ["kiosk-qr-token", operatorId],
    queryFn: () =>
      api
        .get<KioskQrToken>(`/attendance/operators/${operatorId}/qr-token/`, { params: { origin: window.location.origin } })
        .then((r) => r.data),
    enabled: !!operatorId,
    staleTime: 60_000,
  });
}

export function useKioskQrPreview(payload: string | undefined) {
  return useQuery<KioskQrPreview>({
    queryKey: ["kiosk-qr-preview", payload],
    queryFn: () => api.get<KioskQrPreview>(`/attendance/qr-preview/?qr=${encodeURIComponent(payload!)}`).then((r) => r.data),
    enabled: !!payload,
    staleTime: 15_000,
  });
}

export async function kioskScanWithPhoto(payload: string, file: File) {
  const fd = new FormData();
  fd.append("qr_payload", payload);
  fd.append("photo", file);
  const r = await api.post<KioskScanResult>("/attendance/me/scan-with-photo/", fd, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return r.data;
}
