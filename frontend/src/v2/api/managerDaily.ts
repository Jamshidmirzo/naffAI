/**
 * Data hooks for the manager's daily pages (v2): Home (пульт), Sales,
 * SaleForm, SalesPending, SalesToday, Leads, Orphans, SystemLost,
 * LeadsStats, Calls. Query keys are the same as on the old pages so the
 * cache and invalidation are shared between v1 and v2.
 *
 * Each page owns one section below (between its markers) so parallel
 * edits never collide.
 */
import { api } from "../../lib/api";

/** True for "endpoint not deployed yet" errors → caller falls back. */
export function isMissingEndpoint(err: unknown): boolean {
  const s = (err as { response?: { status?: number } })?.response?.status;
  return s === 404 || s === 405 || s === 501;
}

/** Server error text (DRF detail / first field error) or fallback. */
export function apiErrorText(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (!data) return fallback;
  if (typeof data === "string") return data.length < 300 ? data : fallback;
  if (typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.detail === "string") return d.detail;
    for (const v of Object.values(d)) {
      if (typeof v === "string") return v;
      if (Array.isArray(v) && typeof v[0] === "string") return v[0];
    }
  }
  return fallback;
}

export { api };

// ── home ─────────────────────────────────────────────────────────────
import * as rqHome from "@tanstack/react-query";

export type DashPeriod = "day" | "week" | "month";

export interface DashboardSummary {
  period: DashPeriod;
  today: { count: number; total: string; pending_count: number };
  turnover: { actual: string; target: string | null; target_period: string };
  conversion: { value_pct: number; delta_pp: number; prev_value_pct: number };
  shift: { on_shift: number; expected: number; late_today: number };
  timeseries: Array<{ day: string; count: number; total: string }>;
  target_daily_count: number | null;
  attention: { to_review: number; orphans: number; stranded_on_inactive?: number; on_review: number; late_today: number };
  top_operators: Array<{ id: number; name: string; count: number; amount: string }>;
}

/** Same key as the old Dashboard (["dashboard-summary", period, month]); manager filter appended only when set. */
export function useDashboardSummary(period: DashPeriod, month: string, managerId: string, enabled = true) {
  const params: Record<string, string> = month ? { month } : { period };
  if (managerId) params.manager_id = managerId;
  return rqHome.useQuery<DashboardSummary>({
    queryKey: managerId ? ["dashboard-summary", period, month, managerId] : ["dashboard-summary", period, month],
    queryFn: () => api.get("/analytics/dashboard-summary/", { params }).then((r) => r.data),
    refetchInterval: 60_000,
    enabled,
  });
}

export interface CallStatsToday {
  total_calls: number;
  avg_duration_seconds: number | null;
}

/** Same key as old Dashboard «Звонков сегодня». */
export function useCallsToday() {
  return rqHome.useQuery<CallStatsToday>({
    queryKey: ["dash-calls-today"],
    queryFn: () => {
      const d = new Date();
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return api.get("/calls/stats/", { params: { date_from: iso, date_to: iso } }).then((r) => r.data);
    },
    refetchInterval: 120_000,
  });
}

export interface LeadHealthPayload {
  generated_at: string;
  sheet_sources: Array<{ id: number; name: string; last_sync_error: string | null }>;
  leaks: {
    system_lost_24h: number;
    system_lost_7d_avg: number;
    stale_no_answer_48h: number;
    high_lost_operators: Array<{ operator_id: number; name: string; closed: number; lost: number; lost_pct: number }>;
    sync_errors: Array<{ source_id: number; source_name: string; error: string }>;
  };
  bottlenecks: Array<{ status: string; count: number; avg_days_in_status: number }>;
}

export function useLeadHealth() {
  return rqHome.useQuery<LeadHealthPayload>({
    queryKey: ["lead-health"],
    queryFn: () => api.get("/analytics/lead-health/").then((r) => r.data),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

export interface BirthdayRow {
  operator_id: number;
  full_name: string;
  phone: string;
  age: number;
  status: string;
}

export function useBirthdaysToday() {
  return rqHome.useQuery<BirthdayRow[]>({
    queryKey: ["birthdays-today"],
    queryFn: () => api.get<BirthdayRow[]>("/operators/birthdays-today/").then((r) => r.data),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
}

export interface SheetSourceStats {
  id: number;
  name: string;
  active: boolean;
  leads_total: number;
  leads_last_24h: number;
  leads_last_7d: number;
  sales_from_source: number;
  last_sync_at: string | null;
  last_sync_error: string | null;
  is_healthy: boolean;
}

export function useSheetSourceStats(sourceId: number) {
  return rqHome.useQuery<SheetSourceStats>({
    queryKey: ["sheet-source-stats", sourceId],
    queryFn: () => api.get<SheetSourceStats>(`/sheet-sources/${sourceId}/stats/`).then((r) => r.data),
    refetchInterval: 60_000,
  });
}

export interface SheetSyncResult {
  read?: number;
  imported?: number;
  created?: number;
  merged?: number;
  resynced?: number;
  skipped?: number;
}

/** POST sync-now (force=true → full rescan). Invalidates like the old SheetSourceHealthCard. */
export function useSheetSync(sourceId: number) {
  const qc = rqHome.useQueryClient();
  return rqHome.useMutation({
    mutationFn: (force: boolean) => api.post<SheetSyncResult>(`/sheet-sources/${sourceId}/sync-now/`, { force }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sheet-source-stats", sourceId] });
      qc.invalidateQueries({ queryKey: ["sheet-sources"] });
      qc.invalidateQueries({ queryKey: ["lead-health"] });
    },
  });
}

/** Seat state on the floor (BACKEND_V2 §1). */
export type SeatState = "call" | "wait" | "pause" | "late" | "absent" | "off" | "dayoff";

export interface FloorOperator {
  id: number;
  full_name: string;
  status: string;
  managed_by_id: number | null;
  avatar_url: string | null;
  state: SeatState;
  call_started_at: string | null;
  call_is_estimate: boolean;
  paused_at: string | null;
  checked_in_at: string | null;
  late_minutes: number | null;
  working_count: number;
  quota: number;
  sales_today: number;
  sales_today_amount: string;
  overdue_callbacks: number;
  plan_target: number | null;
  plan_actual: number;
}

export interface FloorPayload {
  generated_at: string;
  pin_verified: boolean;
  rr_batch_size: number;
  operators: FloorOperator[];
  /** true when built on the client from older endpoints (no check-in / call data). */
  fallback?: boolean;
}

interface OperatorListRow {
  id: number;
  full_name: string;
  status: string;
  is_paused: boolean;
  paused_at: string | null;
  managed_by_id?: number | null;
  avatar_url?: string | null;
  plan_target?: number | null;
  plan_actual?: number | null;
  shift_start?: string | null;
  shift_end?: string | null;
}

interface DistributionStatus {
  auto_distribution_enabled: boolean;
  rr_batch_size: number;
  orphans_count: number;
  orphans_oldest: string | null;
  operators: Array<{ id: number; full_name: string; status: string; working_count: number; postponed_count: number; eligible: boolean; reason: string }>;
}

interface LeaderboardRow {
  operator_id: number;
  operator_name: string;
  is_trainee: boolean;
  total: number | string;
  count: number | string;
  avg_ticket: number | string;
}

export type { OperatorListRow, DistributionStatus, LeaderboardRow };

/** Same key/endpoint as OrphanLeads («operators-active»). */
export function useActiveOperators() {
  return rqHome.useQuery<OperatorListRow[]>({
    queryKey: ["operators-active"],
    queryFn: async () => {
      const { data } = await api.get<{ results?: OperatorListRow[] } | OperatorListRow[]>("/operators/?include_inactive=0");
      return Array.isArray(data) ? data : data.results || [];
    },
    staleTime: 60_000,
  });
}

/** Same key as OrphanLeads. */
export function useDistributionStatus() {
  return rqHome.useQuery<DistributionStatus>({
    queryKey: ["distribution-status"],
    queryFn: () => api.get<DistributionStatus>("/leads/distribution-status/").then((r) => r.data),
    refetchInterval: 60_000,
  });
}

/**
 * Floor tiles. Tries GET /operators/floor/ (refresh 10 s); when the endpoint
 * is not deployed yet (404/405/501) builds tiles from /operators/ +
 * /leads/distribution-status/ + /analytics/leaderboard/?period=day with
 * only wait / pause / off states.
 */
export function useFloor() {
  return rqHome.useQuery<FloorPayload>({
    queryKey: ["operators-floor"],
    queryFn: async () => {
      try {
        const { data } = await api.get<FloorPayload>("/operators/floor/");
        return data;
      } catch (err) {
        if (!isMissingEndpoint(err)) throw err;
      }
      const [ops, dist, lb] = await Promise.all([
        api.get<{ results?: OperatorListRow[] } | OperatorListRow[]>("/operators/?include_inactive=0").then((r) => (Array.isArray(r.data) ? r.data : r.data.results || [])),
        api.get<DistributionStatus>("/leads/distribution-status/").then((r) => r.data).catch(() => null),
        api.get<LeaderboardRow[]>("/analytics/leaderboard/", { params: { period: "day", limit: 0 } }).then((r) => r.data).catch(() => [] as LeaderboardRow[]),
      ]);
      const distById = new Map((dist?.operators ?? []).map((o) => [o.id, o]));
      const lbById = new Map(lb.map((r) => [r.operator_id, r]));
      const batch = dist?.rr_batch_size ?? 0;
      const operators: FloorOperator[] = ops
        .filter((o) => o.status === "active" || o.status === "trainee")
        .map((o) => {
          const d = distById.get(o.id);
          const l = lbById.get(o.id);
          const state: SeatState = o.is_paused ? "pause" : d ? "wait" : "off";
          return {
            id: o.id,
            full_name: o.full_name,
            status: o.status,
            managed_by_id: o.managed_by_id ?? null,
            avatar_url: o.avatar_url ?? null,
            state,
            call_started_at: null,
            call_is_estimate: true,
            paused_at: o.paused_at,
            checked_in_at: null,
            late_minutes: null,
            working_count: d?.working_count ?? 0,
            quota: batch,
            sales_today: Number(l?.count ?? 0) || 0,
            sales_today_amount: String(l?.total ?? "0"),
            overdue_callbacks: 0,
            plan_target: o.plan_target ?? null,
            plan_actual: Number(o.plan_actual ?? 0) || 0,
          };
        });
      return { generated_at: new Date().toISOString(), pin_verified: false, rr_batch_size: batch, operators, fallback: true };
    },
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}

export interface PendingSaleRow {
  id: number;
  imei: string;
  phone_model: string;
  operator_name: string | null;
  channel_name: string | null;
  amount: string;
  client_name: string;
  client_phone: string;
  contract_photo: string | null;
  contract_photos_all?: { id: number; url: string | null; position: number }[];
  partner_lines?: { partner: number; partner_name: string; amount: string }[];
  created_at: string;
}

/** Same key as old SalesPending. */
export function useSalesPendingQueue() {
  return rqHome.useQuery<{ results: PendingSaleRow[]; count: number }>({
    queryKey: ["sales-pending"],
    queryFn: () => api.get<{ results: PendingSaleRow[]; count: number }>("/sales/pending/").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

/** Single approve, same endpoint as SaleDetail; invalidates what SalesPending/SaleDetail do. */
export function useApproveSale() {
  const qc = rqHome.useQueryClient();
  return rqHome.useMutation({
    mutationFn: (id: number) => api.post(`/sales/${id}/confirm/`),
    onSuccess: (_r, id) => {
      qc.invalidateQueries({ queryKey: ["sales-pending"] });
      qc.invalidateQueries({ queryKey: ["sales-pending-count"] });
      qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
      qc.invalidateQueries({ queryKey: ["lead-stats"] });
      qc.invalidateQueries({ queryKey: ["sale", String(id)] });
      qc.invalidateQueries({ queryKey: ["sales"] });
    },
  });
}

/** POST /leads/distribute-now/ — same as OrphanLeads «Раздать сейчас». */
export function useDistributeNow() {
  const qc = rqHome.useQueryClient();
  return rqHome.useMutation({
    mutationFn: () => api.post<{ total: number; assigned: Record<string, number> }>("/leads/distribute-now/").then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orphan-leads"] });
      qc.invalidateQueries({ queryKey: ["orphan-leads-count"] });
      qc.invalidateQueries({ queryKey: ["distribution-status"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["operators-floor"] });
    },
  });
}

export interface DayOffRow {
  id: number;
  operator_id: number;
  operator_name: string;
  date: string;
  status: string;
  reason: string;
  created_at: string;
}

/** Same key as old DayOffRequests. */
export function useDayOffPending() {
  return rqHome.useQuery<{ results: DayOffRow[]; count: number }>({
    queryKey: ["day-off-pending"],
    queryFn: () => api.get("/operators/day-off/pending/").then((r) => r.data),
    refetchInterval: 120_000,
  });
}

export function useDecideDayOff() {
  const qc = rqHome.useQueryClient();
  return rqHome.useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "approve" | "reject" }) => api.post(`/operators/day-off/${id}/${decision}/`, { note: "" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["day-off-pending"] });
      qc.invalidateQueries({ queryKey: ["operators-floor"] });
    },
  });
}

export interface UserRow {
  id: number;
  username: string;
  full_name?: string;
  role: string;
}

/** Managers of the branch (super filter). Same key as old Operators. */
export function useBranchManagers(enabled: boolean) {
  return rqHome.useQuery<UserRow[]>({
    queryKey: ["users", "role=manager"],
    queryFn: () => api.get<UserRow[]>("/users/", { params: { role: "manager" } }).then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

/** Own user row (to label «Мои прямые» operators of a super-manager). */
export function useSelfUser(username: string | null, enabled: boolean) {
  return rqHome.useQuery<UserRow | null>({
    queryKey: ["users", "self", username],
    queryFn: async () => {
      const { data } = await api.get<UserRow[] | { results?: UserRow[] }>("/users/");
      const rows = Array.isArray(data) ? data : data.results || [];
      return rows.find((u) => u.username === username) ?? null;
    },
    enabled: enabled && !!username,
    staleTime: 5 * 60_000,
  });
}

export interface PinStatus {
  has_pin: boolean;
  pin_required: boolean;
  pin_verified: boolean;
  expires_at: string | null;
}

/** Same key as PinGate. */
export function usePinStatus() {
  return rqHome.useQuery<PinStatus>({
    queryKey: ["attendance-pin-status"],
    queryFn: () => api.get<PinStatus>("/attendance/pin/status/").then((r) => r.data),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
}

export interface NotificationRow {
  id: number;
  kind: string;
  title: string;
  body: string;
  link: string;
  read_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** Polling fallback for new-sale popups when SSE is not available. */
export function useUnreadSaleNotifications() {
  return rqHome.useQuery<NotificationRow[]>({
    queryKey: ["notifications", "sale-created-unread"],
    queryFn: () =>
      api
        .get<{ results: NotificationRow[] }>("/notifications/", { params: { kind: "sale_created", unread: 1 } })
        .then((r) => r.data.results ?? []),
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useMarkNotificationRead() {
  const qc = rqHome.useQueryClient();
  return rqHome.useMutation({
    mutationFn: (id: number) => api.post("/notifications/mark-read/", { ids: [id] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}
// <end home>

// ── sales (Sales, SalesPending, SalesToday) ──────────────────────────
import * as rqSales from "@tanstack/react-query";

export type SalePartnerLine = { partner: number; partner_name: string; amount: string };
export type SaleOperatorLine = { operator: number; operator_name?: string; full_name?: string; share?: string };
export type SalePhoto = { id: number; url: string | null; position: number };
export type SaleListRow = {
  id: number;
  imei: string;
  phone_model: string;
  operator: number | null;
  operator_name: string | null;
  channel_name: string | null;
  sheet_source_name: string | null;
  amount: string | number;
  discount?: string | number;
  total_price?: string | number | null;
  client_name?: string;
  client_phone?: string;
  comment?: string;
  operator_lines?: SaleOperatorLine[];
  partner_lines?: SalePartnerLine[];
  contract_photo?: string | null;
  contract_photos_all?: SalePhoto[];
  sold_at: string;
  status?: "pending" | "confirmed" | "rejected" | string;
  is_returned?: boolean;
  rejection_reason?: string;
  created_at?: string;
};
export type SalesPage = { count: number; next: string | null; previous: string | null; results: SaleListRow[] };
export type SalesSummary = {
  total_amount: string | number;
  total_count: number;
  by_operator: { operator_id: number; name: string; count: number; amount: string | number }[];
  by_model: { model: string; count: number; amount: string | number }[];
};
export type SalesOption = { id: number; name: string };
export type SalesBulkResult = {
  processed: { sale_id: number; status: string }[];
  skipped: { sale_id: number; reason: string }[];
  errors: { sale_id: number; detail: string }[];
  counts: { ok: number; skipped: number; errors: number };
};

/** URLSearchParams → plain object (multi-values as arrays) — the old query key shape. */
export function salesParamsToObject(sp: URLSearchParams): Record<string, string | string[]> {
  const obj: Record<string, string | string[]> = {};
  for (const key of new Set(sp.keys())) {
    const all = sp.getAll(key);
    obj[key] = all.length > 1 ? all : all[0] ?? "";
  }
  return obj;
}

const listOf = <T,>(raw: unknown): T[] => (Array.isArray(raw) ? (raw as T[]) : ((raw as { results?: T[] })?.results ?? []));

/** GET /sales/ — key ["sales", params] as on the old Sales page. */
export function useSalesList(apiParams: URLSearchParams) {
  const key = apiParams.toString();
  return rqSales.useQuery<SalesPage>({
    queryKey: ["sales", salesParamsToObject(new URLSearchParams(key))],
    queryFn: () => api.get("/sales/", { params: new URLSearchParams(key) }).then((r) => r.data),
    placeholderData: (prev) => prev,
  });
}

/** GET /sales/summary/ — only when a date is chosen (confirmed sales only). */
export function useSalesSummary(summaryParams: URLSearchParams, enabled: boolean) {
  const key = summaryParams.toString();
  return rqSales.useQuery<SalesSummary>({
    queryKey: ["sales-summary", key],
    queryFn: () => api.get("/sales/summary/", { params: new URLSearchParams(key) }).then((r) => r.data),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function useSalesPartnerOptions() {
  return rqSales.useQuery({
    queryKey: ["partners-list"],
    queryFn: () => api.get("/channels/", { params: { limit: 200 } }).then((r) => r.data),
    select: (raw: unknown) => listOf<{ id: number; name: string }>(raw).map((p) => ({ id: p.id, name: p.name })) as SalesOption[],
  });
}

export function useSalesOperatorOptions() {
  return rqSales.useQuery({
    queryKey: ["operators-list"],
    queryFn: () => api.get("/operators/", { params: { limit: 200 } }).then((r) => r.data),
    select: (raw: unknown) => listOf<{ id: number; full_name: string }>(raw).map((o) => ({ id: o.id, name: o.full_name })) as SalesOption[],
  });
}

export function useSalesSheetSourceOptions() {
  return rqSales.useQuery({
    queryKey: ["sheet-sources-list"],
    queryFn: () => api.get("/sheet-sources/", { params: { limit: 200 } }).then((r) => r.data),
    select: (raw: unknown) =>
      listOf<{ id: number; name: string; active?: boolean }>(raw)
        .filter((s) => s.active !== false)
        .map((s) => ({ id: s.id, name: s.name })) as SalesOption[],
  });
}

/** GET /sales/export.xlsx with the table filters (no pagination) → browser download. */
export async function downloadSalesXlsx(apiParams: URLSearchParams) {
  const p = new URLSearchParams(apiParams);
  p.delete("limit");
  p.delete("offset");
  const r = await api.get("/sales/export.xlsx", { params: p, responseType: "blob" });
  const blob = new Blob([r.data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "naffcrm-savdo.xlsx";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

/** GET /sales/pending/ — key ["sales-pending"], refresh every 30 s. */
export function useSalesPending() {
  return rqSales.useQuery({
    queryKey: ["sales-pending"],
    queryFn: () => api.get<{ results: SaleListRow[]; count: number }>("/sales/pending/").then((r) => r.data),
    refetchInterval: 30_000,
  });
}

/** POST /sales/bulk-confirm/ — mass approve / reject (reason required for reject). */
export function useSalesBulkAction() {
  const qc = rqSales.useQueryClient();
  return rqSales.useMutation({
    mutationFn: (payload: { sale_ids: number[]; mode: "approve" | "reject"; reason?: string }) =>
      api.post<SalesBulkResult>("/sales/bulk-confirm/", payload).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-pending"] });
      qc.invalidateQueries({ queryKey: ["sales-pending-count"] });
      qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
      qc.invalidateQueries({ queryKey: ["lead-stats"] });
      qc.invalidateQueries({ queryKey: ["sales"] });
    },
  });
}

/** POST /sales/:id/confirm/ and /reject/ — the same invalidation as SaleDetail. */
export function useSaleDecision() {
  const qc = rqSales.useQueryClient();
  const after = (id: number) => {
    qc.invalidateQueries({ queryKey: ["sale", String(id)] });
    qc.invalidateQueries({ queryKey: ["sales-pending"] });
    qc.invalidateQueries({ queryKey: ["sales-pending-count"] });
    qc.invalidateQueries({ queryKey: ["sales"] });
  };
  const approve = rqSales.useMutation({
    mutationFn: (id: number) => api.post(`/sales/${id}/confirm/`),
    onSuccess: (_d, id) => after(id),
  });
  const reject = rqSales.useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => api.post(`/sales/${id}/reject/`, { reason }),
    onSuccess: (_d, v) => after(v.id),
  });
  return { approve, reject };
}

export type SalesKpi = { today: { total: number | string; count: number }; month: { total: number | string; count: number }; operators_active: number; operators_trainee: number };
export type SalesByChannel = { channel_name: string; total: number | string; count: number | string };

/** Today's KPI (/analytics/kpi/?period=day) — key ["kpi-today"]. */
export function useSalesKpiToday() {
  return rqSales.useQuery<SalesKpi>({
    queryKey: ["kpi-today"],
    queryFn: () => api.get("/analytics/kpi/", { params: { period: "day" } }).then((r) => r.data),
    refetchInterval: 30_000,
  });
}

/** Today's sales list (limit 100) — key ["sales-today"]. `today` is the local YYYY-MM-DD. */
export function useSalesTodayList(today: string) {
  return rqSales.useQuery<{ results: SaleListRow[]; count?: number }>({
    queryKey: ["sales-today"],
    queryFn: () => api.get("/sales/", { params: { date_from: today, date_to: today, limit: 100 } }).then((r) => r.data),
    refetchInterval: 30_000,
  });
}

/** Revenue split by partner today — key ["channels-today"]. */
export function useSalesChannelsToday() {
  return rqSales.useQuery<SalesByChannel[]>({
    queryKey: ["channels-today"],
    queryFn: () => api.get("/analytics/by-channel/", { params: { period: "day" } }).then((r) => r.data),
  });
}

/** Daily plan (target_daily_count) from dashboard-summary — same key as the dashboard «день». */
export function useSalesDailyTarget() {
  return rqSales.useQuery<{ target_daily_count: number | null }>({
    queryKey: ["dashboard-summary", "day", ""],
    queryFn: () => api.get("/analytics/dashboard-summary/", { params: { period: "day" } }).then((r) => r.data),
    refetchInterval: 60_000,
  });
}
// <end sales>

// ── saleform ─────────────────────────────────────────────────────────
import * as rqForm from "@tanstack/react-query";

export type SaleFormLine = { operator?: number; partner?: number; amount: string };
export type SaleFormSale = {
  id: number;
  imei: string;
  phone_model: string;
  quantity: number;
  amount: string;
  discount: string;
  client_name: string;
  client_phone: string;
  comment: string;
  bonus_note: string;
  status: "pending" | "confirmed" | "rejected" | string;
  sheet_source_name?: string | null;
  operator_lines?: { operator: number; amount: string }[];
  partner_lines?: { partner: number; amount: string }[];
};
export type SaleFormLeadMatch = {
  id: number;
  full_name: string;
  phone: string;
  phone_raw?: string;
  status: string;
  product_hint?: string;
  operator_name?: string;
  sheet_source_id?: number | null;
  sheet_source_name?: string;
  updated_at?: string;
};
export type SaleFormBody = {
  imei: string;
  phone_model: string;
  quantity: number;
  operators: { operator_id?: number; operator_name?: string; amount: string }[];
  partners: { partner_id?: number; partner_name?: string; amount: string }[];
  discount: string;
  client_name: string;
  client_phone: string;
  comment: string;
  allow_duplicate_imei: boolean;
  duplicate_override_comment: string;
  bonus_note: string;
  lead_id: number | null;
};

/** GET /sales/:id/ — key ["sale", id] as on the old SaleCreate/SaleDetail. */
export function useSaleForEdit(id: string | undefined) {
  return rqForm.useQuery<SaleFormSale>({
    queryKey: ["sale", id],
    queryFn: () => api.get(`/sales/${id}/`).then((r) => r.data),
    enabled: !!id,
  });
}

type SaleFormOp = { id: number; full_name: string; status?: string };
type SaleFormPartner = { id: number; name: string; is_active?: boolean };
/** Lists come back either as a plain array or paginated {results} — accept both. */
function asList<T>(raw: T[] | { results?: T[] } | undefined): T[] {
  return Array.isArray(raw) ? raw : raw?.results || [];
}

/** Operators for the line pickers — key ["operators-list-all"]. */
export function useSaleFormOperators() {
  return rqForm.useQuery<SaleFormOp[] | { results?: SaleFormOp[] }, Error, SaleFormOp[]>({
    queryKey: ["operators-list-all"],
    queryFn: () => api.get("/operators/?limit=200").then((r) => r.data),
    select: asList,
  });
}

/** Payment partners (channels) — key ["partners-list-all"]. */
export function useSaleFormPartners() {
  return rqForm.useQuery<SaleFormPartner[] | { results?: SaleFormPartner[] }, Error, SaleFormPartner[]>({
    queryKey: ["partners-list-all"],
    queryFn: () => api.get("/channels/?limit=200").then((r) => r.data),
    select: asList,
  });
}

/** Phone model suggestions — key ["models-suggest", q]. */
export function useModelSuggest(model: string) {
  return rqForm.useQuery<{ results?: string[] }>({
    queryKey: ["models-suggest", model],
    queryFn: () => api.get(`/imei/models/`, { params: model ? { q: model } : undefined }).then((r) => r.data),
    staleTime: 60_000,
  });
}

/** TAC lookup for a full 15-digit IMEI. */
export function lookupImei(imei: string) {
  return api.get<{ brand?: string; model?: string }>(`/imei/${imei}/lookup/`).then((r) => r.data);
}

/** Leads whose phone contains the digits (from 4 digits). */
export function searchLeadsByPhone(digits: string) {
  return api.get<{ results?: SaleFormLeadMatch[] }>(`/leads/phone-search/`, { params: { q: digits } }).then((r) => r.data?.results || []);
}

export function fetchLeadForSale(id: number) {
  return api.get<SaleFormLeadMatch>(`/leads/${id}/`).then((r) => r.data);
}

/** POST /sales/ (new) or PUT /sales/:id/ (edit). */
export function saveSale(id: string | undefined, body: SaleFormBody) {
  return (id ? api.put<SaleFormSale>(`/sales/${id}/`, body) : api.post<SaleFormSale>("/sales/", body)).then((r) => r.data);
}

/** POST /sales/:id/confirm/ — same endpoint as SaleDetail «Одобрить». */
export function confirmSale(id: string | number) {
  return api.post(`/sales/${id}/confirm/`).then((r) => r.data);
}
// <end saleform>

// ── leads (Leads, Orphans, SystemLost) ───────────────────────────────
import * as rqLeads from "@tanstack/react-query";
import type { Lead } from "../../lib/leads";

export type LeadsQuick = "all" | "review";
export type LeadsOperator = { id: number; full_name: string; status: string };
export type LeadsSheetSource = { id: number; name: string; gid?: number; active: boolean };

export interface SheetSourceHealthItem {
  id: number;
  name: string;
  worksheet_name: string;
  spreadsheet_id: string;
  gid: number;
  active: boolean;
  last_synced_at: string | null;
  last_synced_ago_seconds: number | null;
  last_synced_row: number;
  last_sync_error: string | null;
  is_healthy: boolean;
  writeback_enabled: boolean;
  writeback_status_col: string;
  writeback_operator_col: string;
  leads_today: number;
  leads_total: number;
}
export interface SheetHealthOverview {
  overall_healthy: boolean;
  total_active_sources: number;
  latest_sync_at: string | null;
  sources: SheetSourceHealthItem[];
  writeback: {
    is_healthy: boolean;
    pending_count: number;
    failed_count: number;
    done_last_1h: number;
    failed_samples: Array<{ lead_id: number; last_error: string; attempts: number }>;
  };
}

/** GET /sheet-sources/ — key ["sheet-sources"]. */
export function useLeadsSheetSources() {
  return rqLeads.useQuery({
    queryKey: ["sheet-sources"],
    queryFn: async (): Promise<LeadsSheetSource[]> => {
      const { data } = await api.get<{ results?: LeadsSheetSource[] } | LeadsSheetSource[]>("/sheet-sources/");
      return Array.isArray(data) ? data : data.results || [];
    },
  });
}

/** GET /operators/?include_inactive=0 — key ["operators-active"]. */
export function useLeadsActiveOperators() {
  return rqLeads.useQuery({
    queryKey: ["operators-active"],
    queryFn: async (): Promise<LeadsOperator[]> => {
      const { data } = await api.get<{ results?: LeadsOperator[] } | LeadsOperator[]>("/operators/?include_inactive=0");
      return Array.isArray(data) ? data : data.results || [];
    },
  });
}

export const LEADS_PAGE_SIZE = 50;

/**
 * GET /leads/ — key ["leads", quick, search, sheetSource, page] as on the old
 * page; the v2 operator/status filters are appended only when set, so the
 * unfiltered list shares its cache entry with v1.
 */
export function useLeadsList(f: { quick: LeadsQuick; search: string; sheetSourceId: number | null; page: number; operator: string; status: string }) {
  const key: unknown[] = ["leads", f.quick, f.search, f.sheetSourceId, f.page];
  if (f.operator || f.status) key.push(f.operator, f.status);
  return rqLeads.useQuery({
    queryKey: key,
    queryFn: async (): Promise<{ results: Lead[]; count: number }> => {
      const qp = new URLSearchParams();
      if (f.quick === "review") qp.set("needs_review", "1");
      if (f.search) qp.set("search", f.search);
      if (f.sheetSourceId) qp.set("sheet_source", String(f.sheetSourceId));
      if (f.operator) qp.set("operator", f.operator);
      if (f.status) qp.set("status", f.status);
      qp.set("page", String(f.page));
      qp.set("page_size", String(LEADS_PAGE_SIZE));
      const { data } = await api.get<{ results: Lead[]; count?: number } | Lead[]>(`/leads/?${qp.toString()}`);
      if (Array.isArray(data)) return { results: data, count: data.length };
      return { results: data.results || [], count: data.count || (data.results || []).length };
    },
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
}

/** Same key/fn as the side menu badge. */
export function useNeedsReviewCount() {
  return rqLeads.useQuery({
    queryKey: ["needs-review-count"],
    queryFn: async () => {
      const { data } = await api.get<{ count?: number } | unknown[]>("/leads/?needs_review=1&page_size=1");
      return Array.isArray(data) ? data.length : (data as { count?: number }).count || 0;
    },
    refetchInterval: 30_000,
  });
}

/** Same key/fn as the side menu badge. */
export function useOrphansCount() {
  return rqLeads.useQuery({
    queryKey: ["orphan-leads-count"],
    queryFn: async () => {
      const { data } = await api.get<{ count?: number; counts_by_kind?: Record<string, number> }>("/leads/orphans/?limit=1");
      const cbk = data.counts_by_kind || {};
      return cbk.free ?? data.count ?? 0;
    },
    refetchInterval: 60_000,
  });
}

/** Sequential POST /leads/<id>/reassign/ (as the old page). */
export function useLeadsReassign() {
  const qc = rqLeads.useQueryClient();
  return rqLeads.useMutation({
    mutationFn: async ({ ids, operatorId, reason }: { ids: number[]; operatorId: number; reason: string }) => {
      for (const id of ids) {
        await api.post(`/leads/${id}/reassign/`, { operator_id: operatorId, reason });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
}

/** GET /sheet-sources/health-overview/ — key ["sheet-health-overview"]. */
export function useSheetHealthOverview(refetchMs: number | false = 30_000, enabled = true) {
  return rqLeads.useQuery<SheetHealthOverview>({
    queryKey: ["sheet-health-overview"],
    queryFn: () => api.get<SheetHealthOverview>("/sheet-sources/health-overview/").then((r) => r.data),
    refetchInterval: refetchMs,
    enabled,
  });
}

export type SyncAllResult = { total_sources?: number; total_read?: number; total_created?: number };
export type SyncOneResult = { read?: number; created?: number; merged?: number };

export function useSheetSyncAll() {
  const qc = rqLeads.useQueryClient();
  return rqLeads.useMutation({
    mutationFn: () => api.post<SyncAllResult>("/sheet-sources/sync-all/").then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sheet-health-overview"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["sheet-sources"] });
    },
  });
}

export function useSheetFlushWritebacks() {
  const qc = rqLeads.useQueryClient();
  return rqLeads.useMutation({
    mutationFn: () => api.post<{ stats?: { ok?: number }; remaining_pending?: number }>("/sheet-sources/flush-writebacks/").then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sheet-health-overview"] }),
  });
}

export function useSheetSyncOne() {
  const qc = rqLeads.useQueryClient();
  return rqLeads.useMutation({
    mutationFn: (id: number) => api.post<SyncOneResult>(`/sheet-sources/${id}/sync-now/`, { force: true }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sheet-health-overview"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
}

export function useSheetRescan() {
  const qc = rqLeads.useQueryClient();
  return rqLeads.useMutation({
    mutationFn: (id: number) => api.post<SyncOneResult>(`/sheet-sources/${id}/reset-watermark/`, { row: 0 }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sheet-health-overview"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
}

export interface OrphanResponse {
  results: Lead[];
  count: number;
  counts_by_source: Record<string, number>;
  counts_by_status: Record<string, number>;
  counts_by_kind?: Record<string, number>;
  next: string | null;
  previous: string | null;
}
export interface DistributionOperatorRow {
  id: number;
  full_name: string;
  status: string;
  working_count: number;
  postponed_count: number;
  eligible: boolean;
  reason: string;
}
export interface DistributionStatusResponse {
  auto_distribution_enabled: boolean;
  rr_batch_size: number;
  orphans_count: number;
  orphans_oldest: string | null;
  operators: DistributionOperatorRow[];
}

/** GET /leads/orphans/?kind=free — key ["orphan-leads", sheetSource, status, page]. */
export function useOrphanLeads(sheetSourceId: number | null, status: string, page: number) {
  return rqLeads.useQuery({
    queryKey: ["orphan-leads", sheetSourceId, status, page],
    queryFn: async (): Promise<OrphanResponse> => {
      const qp = new URLSearchParams();
      qp.set("kind", "free");
      if (sheetSourceId) qp.set("sheet_source", String(sheetSourceId));
      if (status) qp.set("status", status);
      qp.set("limit", String(LEADS_PAGE_SIZE));
      qp.set("offset", String((page - 1) * LEADS_PAGE_SIZE));
      const { data } = await api.get<OrphanResponse>(`/leads/orphans/?${qp.toString()}`);
      return data;
    },
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
}

/** GET /leads/distribution-status/ — key ["distribution-status"]. */
export function useLeadsDistributionStatus(enabled = true) {
  return rqLeads.useQuery({
    queryKey: ["distribution-status"],
    queryFn: async (): Promise<DistributionStatusResponse> => {
      const { data } = await api.get<DistributionStatusResponse>("/leads/distribution-status/");
      return data;
    },
    refetchInterval: 60_000,
    enabled,
  });
}

function invalidateOrphans(qc: rqLeads.QueryClient) {
  qc.invalidateQueries({ queryKey: ["orphan-leads"] });
  qc.invalidateQueries({ queryKey: ["orphan-leads-count"] });
  qc.invalidateQueries({ queryKey: ["distribution-status"] });
  qc.invalidateQueries({ queryKey: ["leads"] });
}

/** POST /leads/distribute-now/ — RR over the whole free pool. */
export function useLeadsDistributeNow() {
  const qc = rqLeads.useQueryClient();
  return rqLeads.useMutation({
    mutationFn: () => api.post<{ total: number; assigned: Record<string, number> }>("/leads/distribute-now/").then((r) => r.data),
    onSuccess: () => invalidateOrphans(qc),
  });
}

/** POST /leads/bulk-reassign/ — to one operator or mode=round_robin. */
export function useBulkReassign() {
  const qc = rqLeads.useQueryClient();
  return rqLeads.useMutation({
    mutationFn: (payload: { lead_ids: number[]; operator_id?: number; mode?: string }) =>
      api.post<{ total: number; assigned: Record<string, number> }>("/leads/bulk-reassign/", payload).then((r) => r.data),
    onSuccess: () => invalidateOrphans(qc),
  });
}

export interface SystemLostLead {
  id: number;
  full_name: string;
  phone: string;
  phone_raw: string;
  status: string;
  sheet_source_name: string | null;
  sheet_row_index: number | null;
  product_hint: string;
  lost_reason: string;
  lost_comment: string;
  lost_original_operator_name: string;
  lost_original_status: string;
  lost_at: string;
  lost_by: string;
  created_at: string;
  updated_at: string;
}
export interface SystemLostResponse {
  results: SystemLostLead[];
  count: number;
  next: string | null;
  previous: string | null;
  summary: { total: number; by_reason: Record<string, number>; top_original_operators: { name: string; count: number }[] };
  known_reasons: string[];
}

/** GET /leads/system-lost/ — key ["system-lost-leads", reason, days, page]. */
export function useSystemLost(reason: string, days: string, page: number) {
  return rqLeads.useQuery({
    queryKey: ["system-lost-leads", reason, days, page],
    queryFn: async (): Promise<SystemLostResponse> => {
      const qp = new URLSearchParams();
      if (reason) qp.set("reason", reason);
      if (days) qp.set("days", days);
      qp.set("limit", String(LEADS_PAGE_SIZE));
      qp.set("offset", String((page - 1) * LEADS_PAGE_SIZE));
      const { data } = await api.get<SystemLostResponse>(`/leads/system-lost/?${qp.toString()}`);
      return data;
    },
    refetchInterval: 120_000,
    placeholderData: (prev) => prev,
  });
}

/** POST /leads/<id>/recover-from-system-lost/. */
export function useRecoverSystemLost() {
  const qc = rqLeads.useQueryClient();
  return rqLeads.useMutation({
    mutationFn: (id: number) => api.post<SystemLostLead>(`/leads/${id}/recover-from-system-lost/`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["system-lost-leads"] });
      qc.invalidateQueries({ queryKey: ["orphan-leads"] });
      qc.invalidateQueries({ queryKey: ["orphan-leads-count"] });
    },
  });
}
// <end leads>

// ── stats (LeadsStats, Calls) ────────────────────────────────────────
import * as rqStats from "@tanstack/react-query";

export type LeadStatsStatusRow = { code: string; label_ru: string; label_uz: string; tone: string; emoji: string; count: number; pct: number };
export type LeadStatsOperatorRow = {
  operator_id: number;
  operator_name: string;
  total: number;
  won: number;
  lost: number;
  in_progress: number;
  /** Older backends may not send these three — default to 0. */
  sold_total?: number;
  calls_total?: number;
  unique_leads_touched?: number;
  conversion_pct: number;
  by_status?: Record<string, number>;
};
export type LeadStatsDailyRow = { date: string; created: number; won: number; lost: number };
export type LeadStatsResponse = { total: number; by_status: LeadStatsStatusRow[]; by_operator: LeadStatsOperatorRow[]; daily: LeadStatsDailyRow[] };
export type RetryLabel = { code: string; label_ru: string; label_uz: string; tone: string; emoji: string };
export type RetryStatusesResp = { statuses: string[]; available: RetryLabel[] };
export type RetryExportResponse = { count: number; spreadsheet_id: string; tab_name: string; gid: number; url: string; exported_at: string };

/** GET /analytics/lead-stats/ — same key as the old LeadsStats page. */
export function useLeadStats(dateFrom: string, dateTo: string) {
  return rqStats.useQuery<LeadStatsResponse>({
    queryKey: ["lead-stats", dateFrom, dateTo],
    queryFn: () => api.get<LeadStatsResponse>("/analytics/lead-stats/", { params: { date_from: dateFrom, date_to: dateTo } }).then((r) => r.data),
    enabled: !!dateFrom && !!dateTo,
  });
}

/** GET /settings/retry-export/ — statuses selected for the retry export. */
export function useRetryStatuses(enabled = true) {
  return rqStats.useQuery<RetryStatusesResp>({
    queryKey: ["retry-export-statuses"],
    queryFn: () => api.get<RetryStatusesResp>("/settings/retry-export/").then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

export function useSaveRetryStatuses() {
  const qc = rqStats.useQueryClient();
  return rqStats.useMutation({
    mutationFn: (statuses: string[]) => api.patch<RetryStatusesResp>("/settings/retry-export/", { statuses }).then((r) => r.data),
    onSuccess: (d) => {
      qc.setQueryData<RetryStatusesResp>(["retry-export-statuses"], (old) => (old ? { ...old, statuses: d.statuses } : { statuses: d.statuses, available: [] }));
    },
  });
}

/** POST /leads/retry-export/ — snapshot to a Google Sheet tab (409 = already running). */
export function useRetryExport() {
  return rqStats.useMutation({
    mutationFn: () => api.post<RetryExportResponse>("/leads/retry-export/").then((r) => r.data),
  });
}

export type CallRow = {
  id: number;
  lead: number | null;
  lead_name: string;
  lead_phone: string;
  operator: number | null;
  operator_name: string;
  outcome: string;
  comment: string;
  source: string;
  phone_number: string;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  has_recording: boolean;
  recording_url: string;
  created_at: string;
};
export type CallsListResponse = { results: CallRow[]; next_cursor: number | null; total: number };
export type CallsStats = {
  total_calls: number;
  avg_duration_seconds: number | null;
  with_recording: number;
  recording_pct: number;
  answered: number;
  answered_pct: number;
  by_outcome: Record<string, number>;
  top_operators: { operator_id: number; operator_name: string; count: number }[];
};
export type OperatorOption = { id: number; full_name: string };

/** GET /calls/?… with cursor — key ["calls-list", params, cursor] as on the old page. */
export function useCallsList(params: string, cursor: number | null) {
  return rqStats.useQuery<CallsListResponse>({
    queryKey: ["calls-list", params, cursor],
    queryFn: () => {
      const p = new URLSearchParams(params);
      if (cursor != null) p.set("cursor", String(cursor));
      return api.get(`/calls/?${p.toString()}`).then((r) => r.data);
    },
    placeholderData: (prev) => prev,
  });
}

/** GET /calls/stats/?… — key ["calls-stats", params]. */
export function useCallsStats(params: string) {
  return rqStats.useQuery<CallsStats>({
    queryKey: ["calls-stats", params],
    queryFn: () => api.get(`/calls/stats/?${params}`).then((r) => r.data),
    placeholderData: (prev) => prev,
  });
}

/** Operators for the calls filter — key ["operators-list-calls"]. */
export function useCallsOperators() {
  return rqStats.useQuery<{ results?: OperatorOption[] } | OperatorOption[], Error, { id: number; name: string }[]>({
    queryKey: ["operators-list-calls"],
    queryFn: () => api.get("/operators/", { params: { limit: 200 } }).then((r) => r.data),
    select: (raw) => (Array.isArray(raw) ? raw : raw?.results || []).map((o) => ({ id: o.id, name: o.full_name })),
  });
}
// <end stats>
