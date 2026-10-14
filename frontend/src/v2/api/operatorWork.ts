/**
 * Data layer for the operator workstation in v2: /my, /my/sale-new,
 * /my/sales (+ activity) and /sales/:id.
 *
 * Query keys are the SAME as the old pages (MyLeads, OperatorSaleCreate,
 * MySales, MyActivity, SaleDetail) so v1 and v2 share cache and
 * invalidation. New keys are only added for data the old pages never read
 * (callbacks list, call history of one lead).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { TG_LINK_FALLBACK, type CallOutcome, type Lead } from "../../lib/leads";

export type { Lead } from "../../lib/leads";
export { useLeadStatuses, useLeadStatusInfo, type LeadStatusRow } from "../../hooks/useLeadStatuses";

/* ── /leads/my/ ─────────────────────────────────────────────────────── */

export type MyLeadsView = "active" | "postponed" | "all" | "closed";

export type MyResponse = {
  operator: {
    id: number;
    full_name: string;
    status: string;
    blocked: boolean;
    overdue_blocked?: boolean;
    open_callbacks?: number;
    yesterday_backlog?: number;
  };
  counts: { active: number; postponed: number };
  results: Lead[];
  count?: number;
};

export function useMyLeads(page: number, view: MyLeadsView, quotaMode: boolean) {
  return useQuery({
    queryKey: ["leads-my", page, view, quotaMode],
    queryFn: () =>
      api.get<MyResponse>(`/leads/my/?page=${page}&view=${view}${quotaMode ? "&quota=1" : ""}`).then((r) => r.data),
    refetchInterval: 60_000,
  });
}

export const PAGE_SIZE = 50;

export function useMyLeadsByStatus(chip: string, page: number, enabled: boolean) {
  return useQuery({
    queryKey: ["leads-my-by-status", chip, page],
    queryFn: () =>
      api
        .get<MyResponse>(
          `/leads/my/?status=${encodeURIComponent(chip)}&limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}`,
        )
        .then((r) => r.data),
    enabled,
    refetchInterval: 60_000,
  });
}

export type BlockingLead = { id: number; full_name: string; phone: string; status: string; updated_at: string | null };
export type OverdueCallback = {
  id: number;
  lead_id: number;
  full_name: string;
  phone: string;
  remind_at: string | null;
  status: string;
};

export type MyStatus = {
  working_count: number;
  quota_limit: number;
  carry_count: number;
  recall_afternoon_count: number;
  today_fresh_count: number;
  postponed_count: number;
  eligible_for_new: boolean;
  reason_ru: string;
  recall_active_now: boolean;
  by_status: Record<string, number>;
  total_leads: number;
  gate_active?: boolean;
  global_gate_on?: boolean;
  operator_gate_flag?: boolean;
  blocking_leads?: BlockingLead[];
  overdue_callbacks?: OverdueCallback[];
  blocking_leads_count?: number;
  overdue_callbacks_count?: number;
  /** BACKEND_V2 §6 — optional until the backend ships it. */
  plan_target?: number | null;
  plan_actual?: number | null;
};

export function useMyStatus() {
  return useQuery({
    queryKey: ["leads-my-status"],
    queryFn: () => api.get<MyStatus>("/leads/my/status/").then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  });
}

/** Same invalidation set as the old page after any lead action. */
export function invalidateLeadQueries(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["leads-my"] });
  qc.invalidateQueries({ queryKey: ["leads-my-status"] });
  qc.invalidateQueries({ queryKey: ["leads-my-by-status"] });
  qc.invalidateQueries({ queryKey: ["callbacks-mine-due"] });
  qc.invalidateQueries({ queryKey: ["callbacks-mine"] });
  qc.invalidateQueries({ queryKey: ["lead-call-attempts"] });
}

/* ── calls / callbacks ──────────────────────────────────────────────── */

export function useCallsMine() {
  return useQuery({
    queryKey: ["calls-mine"],
    queryFn: () =>
      api
        .get<{ total: number; avg_duration_seconds: number | null; by_outcome: Record<string, number> }>(
          "/calls/mine/?days=1",
        )
        .then((r) => r.data),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export type CallbackRow = {
  id: number;
  lead: number;
  lead_name: string;
  lead_phone: string;
  remind_at: string;
  status: "pending" | "done" | "overdue" | "snoozed" | "superseded";
  comment: string;
};

/** Open callbacks of the operator (pending/snoozed/overdue). */
export function useMyCallbacks() {
  return useQuery({
    queryKey: ["callbacks-mine"],
    queryFn: () => api.get<CallbackRow[]>("/callbacks/mine/").then((r) => r.data),
    refetchInterval: 60_000,
    retry: false,
  });
}

export type CallAttemptRow = {
  id: number;
  lead: number;
  operator_name: string;
  outcome: CallOutcome | "";
  comment: string;
  created_at: string;
};

export function useLeadCallAttempts(leadId: number | null | undefined) {
  return useQuery({
    queryKey: ["lead-call-attempts", leadId],
    queryFn: () => api.get<CallAttemptRow[]>(`/leads/${leadId}/call-attempts/`).then((r) => r.data),
    enabled: !!leadId,
    retry: false,
    staleTime: 15_000,
  });
}

export const leadActions = {
  callAttempt: (leadId: number, outcome: CallOutcome, comment?: string) =>
    api.post(`/leads/${leadId}/call-attempts/`, { outcome, comment: comment || "" }),
  status: (leadId: number, status: string, comment?: string) =>
    api.post(`/leads/${leadId}/status/`, { status, comment: comment || "" }),
  postpone: (leadId: number, reason: string) =>
    api.post(`/leads/${leadId}/postpone/`, { reason: reason.trim().slice(0, 280) }),
  unpostpone: (leadId: number) => api.post(`/leads/${leadId}/unpostpone/`),
  callback: (leadId: number, remindAt: Date, comment: string) =>
    api.post(`/leads/${leadId}/callbacks/`, { remind_at: remindAt.toISOString(), comment }),
  callbackDone: (id: number) => api.post(`/callbacks/${id}/done/`),
  callbackSnooze: (id: number, minutes: number) => api.post(`/callbacks/${id}/snooze/`, { minutes }),
};

/** Telegram contact: resolve username first, fall back to tg://resolve. */
export async function openTelegram(phone: string) {
  if (!phone) return;
  try {
    const { data } = await api.get(`/telegram/lookup/?phone=${encodeURIComponent(phone)}`);
    if (data?.username) {
      window.open(`https://t.me/${data.username}`, "_blank", "noopener");
      return;
    }
  } catch {
    /* fall through */
  }
  window.location.href = TG_LINK_FALLBACK(phone);
}

/* ── tracked click-to-call ─────────────────────────────────────────── */

export type TrackedOutcome = CallOutcome;

interface PendingCall {
  callAttemptId: number | null;
  leadId: number;
  leadName: string;
  leadPhone: string;
  startedAtMs: number;
}

const RETURN_DELAY_MS = 15_000;

/**
 * Same lifecycle as hooks/useTrackedCall (POST /calls/start/ → tel: →
 * outcome window on return after ≥15 s → PATCH /calls/:id/finish/),
 * plus `callback_remind_at` for «Перезвон» — the old hook could not send
 * it, so the backend rejected «Просят перезвонить» silently.
 */
export function useTrackedCallV2(onFinished?: () => void) {
  const [pending, setPending] = useState<PendingCall | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const ref = useRef<PendingCall | null>(null);
  ref.current = pending;
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  const startCall = useCallback(async (lead: { id: number; full_name?: string | null; phone: string }) => {
    let id: number | null = null;
    try {
      const { data } = await api.post<{ id: number }>("/calls/start/", { lead_id: lead.id, source: "click_to_call" });
      id = data.id;
    } catch {
      /* still dial: the operator wants to call even if tracking failed */
    }
    setPending({
      callAttemptId: id,
      leadId: lead.id,
      leadName: lead.full_name || lead.phone,
      leadPhone: lead.phone,
      startedAtMs: Date.now(),
    });
    // eslint-disable-next-line no-restricted-syntax
    window.location.href = `tel:${lead.phone}`;
  }, []);

  const finish = useCallback(
    async (
      outcome: TrackedOutcome | "",
      extra?: { comment?: string; callback_remind_at?: string; callback_comment?: string },
    ) => {
      const p = ref.current;
      setModalOpen(false);
      if (!p) return;
      // pending is cleared only after the server accepted the outcome, so a
      // failed save can be retried (and the window reappears on next return).
      if (p.callAttemptId == null) {
        // tracking failed at start — log a plain attempt so the outcome is not lost
        if (outcome) {
          await api.post(`/leads/${p.leadId}/call-attempts/`, {
            outcome,
            comment: extra?.comment || "",
            ...(extra?.callback_remind_at ? { callback_remind_at: extra.callback_remind_at, callback_comment: extra.callback_comment || "" } : {}),
          });
        }
      } else {
        await api.patch(`/calls/${p.callAttemptId}/finish/`, {
          outcome: outcome || "",
          comment: extra?.comment || "",
          duration_seconds: Math.max(0, Math.round((Date.now() - p.startedAtMs) / 1000)),
          ...(extra?.callback_remind_at ? { callback_remind_at: extra.callback_remind_at, callback_comment: extra.callback_comment || "" } : {}),
        });
      }
      ref.current = null;
      setPending(null);
      finishedRef.current?.();
    },
    [],
  );

  const closeModal = useCallback(() => setModalOpen(false), []);
  const reopen = useCallback(() => ref.current && setModalOpen(true), []);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      const p = ref.current;
      if (!p) return;
      if (Date.now() - p.startedAtMs < RETURN_DELAY_MS) return;
      setModalOpen(true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  return { startCall, pending, modalOpen, closeModal, reopen, finish };
}

/* ── attendance (same key/endpoint as AttendanceStatusWidget) ──────── */

export type AttendanceCurrent = {
  open_log: { id: number; checked_in_at: string; was_late: boolean; checkin_photo_url?: string | null } | null;
  today_events: Array<{ id: number; checked_in_at: string; checked_out_at: string | null; was_late: boolean }>;
};

export function useAttendanceCurrent() {
  return useQuery({
    queryKey: ["me-attendance-current"],
    queryFn: () => api.get<AttendanceCurrent>("/attendance/me/current/").then((r) => r.data),
    refetchInterval: 60_000,
    retry: false,
  });
}

/* ── my sales / activity ───────────────────────────────────────────── */

export interface MySaleRow {
  id: number;
  imei: string;
  phone_model: string;
  client_name: string;
  client_phone: string;
  amount_total: string;
  share_amount: string;
  channel_name: string;
  status: string;
  sold_at: string;
}

export function useMySales() {
  return useQuery<{ results: MySaleRow[]; count: number; total_share: string }>({
    queryKey: ["my-sales"],
    queryFn: () => api.get("/sales/mine/").then((r) => r.data),
  });
}

export interface ActivityRow {
  operator_id: number;
  operator_name: string;
  unique_leads_touched: number;
  calls_total: number;
  by_status: Record<string, number>;
}

export function useMyActivity(from: string, to: string, enabled = true) {
  return useQuery<{ period: { from: string; to: string }; rows: ActivityRow[] }>({
    queryKey: ["my-activity", from, to],
    queryFn: () => api.get(`/reports/my-activity/?date_from=${from}&date_to=${to}`).then((r) => r.data),
    enabled,
  });
}

/* ── sale create / detail ──────────────────────────────────────────── */

export function usePaymentChannels() {
  return useQuery({
    queryKey: ["op-partners"],
    queryFn: () => api.get("/channels/?limit=200").then((r) => r.data),
  });
}

export type LeadMatch = {
  id: number;
  full_name: string;
  phone: string;
  status: string;
  sheet_source_name?: string;
  product_hint?: string;
};

export interface SaleOperatorLine {
  operator: number;
  operator_name: string;
  amount: string;
}
export interface SalePartnerLine {
  partner: number;
  partner_name: string;
  amount: string;
}
export interface SaleContractPhoto {
  id: number;
  url: string | null;
  position: number;
  uploaded_at: string;
}
export interface SaleDetailData {
  id: number;
  imei: string;
  phone_model: string;
  quantity?: number;
  operator?: number | null;
  operator_name?: string | null;
  channel?: number | null;
  channel_name?: string | null;
  amount: string;
  discount?: string;
  total_price?: string;
  client_name: string;
  client_phone: string;
  operator_lines?: SaleOperatorLine[];
  partner_lines?: SalePartnerLine[];
  comment?: string;
  bonus_note?: string;
  sheet_source?: number | null;
  sheet_source_name?: string | null;
  sold_at: string;
  status: "pending" | "confirmed" | "rejected" | string;
  is_returned?: boolean;
  returned_at?: string | null;
  return_reason?: string;
  is_deleted?: boolean;
  gifts?: Array<{ id: number; name: string; cost: string | null }>;
  contract_photo?: string | null;
  contract_photos_all?: SaleContractPhoto[];
  rejection_reason?: string;
  rejected_at?: string | null;
  created_at?: string;
  updated_at?: string;
  audit_events?: Array<{ description?: string; actor_name?: string; created_at?: string }>;
}

export function useSale(id: string | undefined) {
  return useQuery({
    queryKey: ["sale", id],
    queryFn: () => api.get<SaleDetailData>(`/sales/${id}/`).then((r) => r.data),
    enabled: !!id,
  });
}

export const saleActions = {
  confirm: (id: string | number) => api.post(`/sales/${id}/confirm/`),
  reject: (id: string | number, reason: string) => api.post(`/sales/${id}/reject/`, { reason }),
  return: (id: string | number, reason: string) => api.post(`/sales/${id}/return/`, { reason }),
  remove: (id: string | number) => api.delete(`/sales/${id}/`),
};
