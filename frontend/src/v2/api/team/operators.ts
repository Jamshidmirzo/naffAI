/**
 * v2 data hooks — Operators list (/operators, /team/operators).
 * Query keys are the same as the old src/pages/Operators.tsx and its
 * OperatorDiagnosticsModal / StickerPicker, so cache and invalidation are
 * shared between v1 and v2.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";

export type OpStatus = "active" | "trainee" | "inactive";

export interface OpAccountState {
  has_account: boolean;
  is_active: boolean;
  deleted: boolean;
  username: string | null;
}

export interface OperatorListRow {
  id: number;
  full_name: string;
  phone: string | null;
  status: OpStatus;
  hired_at: string | null;
  birth_date: string | null;
  note?: string | null;
  plan_target: string | null;
  plan_actual: string | null;
  sticker?: { emoji: string | null; is_rare: boolean } | null;
  account?: OpAccountState | null;
  month_total?: string | number | null;
  month_count?: number | null;
  blocking_gate_enabled?: boolean;
  require_checkin_enabled?: boolean;
  livestream_enabled?: boolean;
  is_paused?: boolean;
  paused_at?: string | null;
  forgotten_checkouts_count?: number;
  salary_uzs?: string | null;
  shift_start?: string | null;
  shift_end?: string | null;
  grace_period_min?: number | null;
  late_penalty_uzs?: string | null;
  weekly_day_off?: number | null;
  weekly_free_absences?: number | null;
  attendance_bonus_uzs?: string | null;
  sales_bonus_uzs?: string | null;
  sales_gate_pct?: number | null;
  avatar_url?: string | null;
  managed_by_id?: number | null;
}

export interface OpManagerUser {
  id: number;
  username: string;
  full_name?: string;
  role: string;
}

/** Row of GET /operators/floor/ (BACKEND_V2 §1) — may be missing on old backends. */
export interface OpFloorRow {
  id: number;
  state: "call" | "wait" | "pause" | "late" | "absent" | "off" | "dayoff";
  call_started_at: string | null;
  paused_at: string | null;
  checked_in_at: string | null;
  late_minutes: number | null;
  working_count: number;
  quota: number;
  sales_today: number;
  sales_today_amount: string;
  overdue_callbacks: number;
}
export interface OpFloorResponse {
  generated_at: string;
  pin_verified: boolean;
  operators: OpFloorRow[];
}

/** "Endpoint not deployed" → caller falls back silently. */
export function opIsMissingEndpoint(err: unknown): boolean {
  const s = (err as { response?: { status?: number } })?.response?.status;
  return s === 404 || s === 405 || s === 501;
}

/** Server error text (DRF detail / first field error) or fallback. */
export function opErrorText(err: unknown, fallback: string): string {
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

export function opIsPinRequired(err: unknown): boolean {
  const e = err as { response?: { status?: number; data?: { code?: string } } };
  return e.response?.status === 401 && e.response?.data?.code === "pin_required";
}

// ── queries ─────────────────────────────────────────────────────────

/** GET /operators/?include_inactive=1 — key ["operators", true] as on the old page. */
export function useOperatorsList() {
  return useQuery({
    queryKey: ["operators", true],
    queryFn: () =>
      api
        .get<OperatorListRow[] | { results: OperatorListRow[] }>("/operators/", { params: { include_inactive: 1 } })
        .then((r) => (Array.isArray(r.data) ? r.data : r.data?.results ?? [])),
  });
}

/** Managers for the super-manager filter / «Назначить менеджеру». */
export function useOpManagers(enabled: boolean) {
  return useQuery<OpManagerUser[]>({
    queryKey: ["users", "role=manager"],
    queryFn: () => api.get<OpManagerUser[]>("/users/", { params: { role: "manager" } }).then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Live floor state (shift, quota, today's sales). New endpoint — null when
 * the backend doesn't have it yet, so the page just hides those bits.
 */
export function useOperatorsFloor(enabled = true) {
  return useQuery<OpFloorResponse | null>({
    queryKey: ["operators", "floor"],
    queryFn: async () => {
      try {
        return (await api.get<OpFloorResponse>("/operators/floor/")).data;
      } catch (e) {
        if (opIsMissingEndpoint(e)) return null;
        throw e;
      }
    },
    enabled,
    retry: false,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

// ── mutations ───────────────────────────────────────────────────────

export interface OpCreatePayload {
  full_name: string;
  phone: string;
  status: OpStatus;
  note: string;
  managed_by_id?: number | null;
}

export function useOpCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: OpCreatePayload) => api.post("/operators/", payload).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["operators"] }),
  });
}

/** Activate / deactivate (rescue cascade on the server; may answer 401 pin_required). */
export function useOpToggleActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      api
        .post<{ rebalanced_count?: number; callbacks_moved?: number }>(`/operators/${id}/${active ? "reactivate" : "deactivate"}/`)
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      qc.invalidateQueries({ queryKey: ["leads-my"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
}

export function useOpPause() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, paused }: { id: number; paused: boolean }) =>
      api.post(`/operators/${id}/${paused ? "pause" : "unpause"}/`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      qc.invalidateQueries({ queryKey: ["distribution-diagnostics"] });
      qc.invalidateQueries({ queryKey: ["distribution-status"] });
    },
  });
}

export function useOpSnapshotRequest() {
  return useMutation({
    mutationFn: (id: number) => api.post(`/operators/${id}/snapshot/request/`).then((r) => r.data),
  });
}

export function useOpAvatarUpload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: number; file: File }) => {
      const fd = new FormData();
      fd.append("avatar", file);
      return api.post(`/operators/${id}/avatar/`, fd, { headers: { "Content-Type": "multipart/form-data" } }).then((r) => r.data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["operators"] }),
  });
}

/** DELETE with audit comment (min 10 chars). */
export function useOpDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, comment }: { id: number; comment: string }) => api.delete(`/operators/${id}/delete/`, { data: { comment } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      qc.invalidateQueries({ queryKey: ["operators-list-all"] });
    },
  });
}

/** PATCH /operators/:id/ — edit form, toggles (gate, check-in, livestream). */
export function useOpPatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) => api.patch(`/operators/${id}/`, body).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operators"] });
      qc.invalidateQueries({ queryKey: ["operators-list-all"] });
      qc.invalidateQueries({ queryKey: ["distribution-diagnostics"] });
    },
  });
}

export function useOpSetPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, target_amount }: { id: number; target_amount: string }) => api.put(`/operators/${id}/plan/`, { target_amount }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["operators"] }),
  });
}

/** Attendance PIN verify (deactivation asks for it on 401 pin_required). */
export function useOpVerifyPin() {
  return useMutation({
    mutationFn: (pin: string) => api.post("/attendance/pin/verify/", { pin }),
  });
}

// ── account (login) ─────────────────────────────────────────────────

/** Audited reveal of the current password. */
export function useOpRevealPassword() {
  return useMutation({
    mutationFn: (id: number) => api.get<{ password: string }>(`/operators/${id}/account/password/`).then((r) => r.data),
  });
}

export function useOpResetPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<{ password: string }>(`/operators/${id}/account/reset-password/`, {}).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["operators"] }),
  });
}

// ── stickers ────────────────────────────────────────────────────────

export interface OpStickerPalette {
  palette: string[];
  taken: { emoji: string; operator_name: string }[];
  rare: { emoji: string; operator_id: number; operator_name: string } | null;
}

export function useOpStickerPalette(enabled: boolean) {
  return useQuery<OpStickerPalette>({
    queryKey: ["stickers", "palette"],
    queryFn: () => api.get<OpStickerPalette>("/stickers/palette/").then((r) => r.data),
    enabled,
  });
}

function useStickerInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["stickers", "palette"] });
    qc.invalidateQueries({ queryKey: ["operators"] });
    qc.invalidateQueries({ queryKey: ["me", "sticker"] });
  };
}

export function useOpSetSticker() {
  const inv = useStickerInvalidate();
  return useMutation({
    mutationFn: ({ id, emoji, is_rare }: { id: number; emoji: string; is_rare: boolean }) =>
      api.put(`/operators/${id}/sticker/`, { emoji, is_rare }).then((r) => r.data),
    onSuccess: inv,
  });
}

export function useOpClearSticker() {
  const inv = useStickerInvalidate();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/operators/${id}/sticker/`),
    onSuccess: inv,
  });
}

// ── distribution diagnostics ────────────────────────────────────────

export interface OpDiagRow {
  id: number;
  full_name: string;
  phone: string;
  status: string;
  is_paused: boolean;
  paused_at: string | null;
  blocking_gate_enabled: boolean;
  require_checkin_enabled: boolean;
  checked_in_today: boolean;
  has_open_shift: boolean;
  working_count: number;
  quota_limit: number;
  postponed_count: number;
  carry_count: number;
  yesterday_unclosed_count: number;
  open_callbacks_count: number;
  blocking_leads_count: number;
  today_received_count: number;
  today_calls_count: number;
  last_lead_assigned_at: string | null;
  allowed_sheets: string[];
  has_sheet_restrictions: boolean;
  eligible: boolean;
  primary_blocker: string;
  primary_blocker_title_uz: string;
  primary_blocker_title_ru: string;
  reasons_uz: string[];
  reasons_ru: string[];
}

export interface OpDiagSummary {
  total_operators: number;
  eligible_count: number;
  blocked_count: number;
  paused_count: number;
  quota_full_count: number;
  yesterday_backlog_count: number;
  gate_blocked_count: number;
  not_checked_in_count: number;
  orphans_count: number;
  auto_distribution_enabled: boolean;
  rr_batch_size: number;
}

export interface OpDiagLead {
  id: number;
  full_name: string;
  phone: string;
  status: string;
  status_label_uz: string;
  status_label_ru: string;
  updated_at: string | null;
  created_at: string | null;
  hours_since_update?: number;
  days_ago?: number;
}

export interface OpDiagResponse {
  summary: OpDiagSummary;
  operators: OpDiagRow[];
  selected_detail: {
    operator: OpDiagRow;
    working_leads: OpDiagLead[];
    yesterday_leads: OpDiagLead[];
    recent_assignments: Array<{ assignment_id: number; lead_id: number; lead_name: string; source: string; created_at: string | null }>;
  } | null;
}

export type OpDiagFilter = "all" | "blocked" | "paused" | "eligible";

export function useOpDiagnostics(open: boolean, selectedId: number | null, search: string, filter: OpDiagFilter) {
  return useQuery<OpDiagResponse>({
    queryKey: ["distribution-diagnostics", selectedId, search, filter],
    queryFn: () =>
      api
        .get<OpDiagResponse>("/leads/distribution-diagnostics/", {
          params: {
            operator_id: selectedId ?? undefined,
            search: search || undefined,
            filter_status: filter !== "all" ? filter : undefined,
          },
        })
        .then((r) => r.data),
    enabled: open,
    refetchInterval: open ? 15_000 : false,
  });
}

export function useOpBulkReassign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ leadIds, operatorId }: { leadIds: number[]; operatorId?: number }) =>
      api
        .post<{ total: number }>("/leads/bulk-reassign/", {
          lead_ids: leadIds,
          operator_id: operatorId,
          mode: operatorId ? undefined : "round_robin",
        })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["distribution-diagnostics"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
}
