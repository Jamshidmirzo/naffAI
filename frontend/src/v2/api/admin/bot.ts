/**
 * v2 data hooks — admin zone, group «bot»: /bot, /bot-subscribers, /tg-queue.
 * Query keys match the old pages (bot-chats, bot-reports, bot-blocks,
 * bot-audit, bot-templates, bot-subscribers, tg-queue).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";

function unwrap<T>(d: unknown): T[] {
  const x = d as { results?: T[] } | T[];
  return (Array.isArray(x) ? x : x?.results) ?? [];
}

/* ------------------------------ /bot ------------------------------ */

export type BotChatKind = "private" | "group" | "supergroup" | "channel";

export interface BotChat {
  id: number;
  chat_id: number;
  kind: BotChatKind | string;
  title: string;
  language: string;
  is_active: boolean;
  linked_profile_name: string;
  last_seen_at: string;
}

export interface BotReport {
  id: number;
  name: string;
  enabled: boolean;
  schedule_time: string;
  schedule_days: string[];
  recipients: BotChat[];
  blocks: string[];
  language: string;
  period: string;
  include_header: boolean;
  last_sent_at: string | null;
  last_send_error: string;
}

export interface BotReportDraftV2 {
  name: string;
  enabled: boolean;
  schedule_time: string;
  schedule_days: string[];
  recipient_ids: number[];
  blocks: string[];
  language: string;
  period: string;
  include_header: boolean;
}

export interface BotBlockMeta {
  slug: string;
  label_ru: string;
  label_uz: string;
  category: string;
  sensitive: boolean;
}
export interface BotPeriodMeta {
  slug: string;
  label: string;
}

export interface BotAuditRow {
  id: number;
  at: string;
  chat_id: number | string;
  username?: string;
  tg_user_id?: number | string;
  command: string;
  outcome: string;
}

export interface BotTemplate {
  id: number;
  slug: string;
  name: string;
  description: string;
  category: string;
  blocks: string[];
  schedule_defaults: {
    schedule_time?: string;
    schedule_days?: string[];
    period?: string;
    include_header?: boolean;
    language?: string;
  };
}

export function useBotChats() {
  return useQuery({
    queryKey: ["bot-chats"],
    queryFn: () => api.get("/bot/chats/").then((r) => unwrap<BotChat>(r.data)),
  });
}

export function useBotReports() {
  return useQuery({
    queryKey: ["bot-reports"],
    queryFn: () => api.get("/bot/reports/").then((r) => unwrap<BotReport>(r.data)),
  });
}

export function useBotBlocks() {
  return useQuery({
    queryKey: ["bot-blocks"],
    queryFn: () => api.get<{ blocks: BotBlockMeta[]; periods: BotPeriodMeta[] }>("/bot/blocks/").then((r) => r.data),
  });
}

export function useBotAudit(enabled: boolean) {
  return useQuery({
    queryKey: ["bot-audit"],
    queryFn: () => api.get("/bot/audit/?days=7").then((r) => unwrap<BotAuditRow>(r.data)),
    enabled,
  });
}

export function useBotTemplates(enabled: boolean) {
  return useQuery({
    queryKey: ["bot-templates"],
    queryFn: () => api.get("/bot/templates/").then((r) => unwrap<BotTemplate>(r.data)),
    enabled,
  });
}

export function useBotReportSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, draft }: { id: number | null; draft: BotReportDraftV2 }) =>
      (id ? api.patch<BotReport>(`/bot/reports/${id}/`, draft) : api.post<BotReport>(`/bot/reports/`, draft)).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-reports"] }),
  });
}

export function useBotReportDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/bot/reports/${id}/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-reports"] }),
  });
}

export function useBotReportSendNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<{ sent?: number; failed?: number }>(`/bot/reports/${id}/send_now/`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-reports"] }),
  });
}

export function useBotReportTestSend() {
  return useMutation({
    mutationFn: ({ reportId, chatId }: { reportId: number; chatId: number }) =>
      api.post(`/bot/reports/${reportId}/test_send/`, { chat_id: chatId }),
  });
}

export interface BotPreview {
  html: string;
  buttons: Array<{ text: string; url: string }>;
  chat_kind?: string;
}

/** Live preview of a draft (not cached — called debounced from the editor). */
export function botPreviewAs(draft: BotReportDraftV2, chatId: number | null) {
  return api.post<BotPreview>(`/bot/reports/preview_as/`, { draft, chat_id: chatId }).then((r) => r.data);
}

/* -------------------------- /bot-subscribers -------------------------- */

export interface BotSubscriber {
  id: number;
  chat_id: number;
  chat_title: string;
  phone: string;
  language: string;
  is_active: boolean;
  receives_broadcasts: boolean;
  blocked_at: string | null;
  linked_operator: { id: number; full_name: string; status: string; phone: string } | null;
  linked_profile: { id: number; username: string; full_name: string; role: string } | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export function useBotSubscribers() {
  return useQuery({
    queryKey: ["bot-subscribers"],
    queryFn: () => api.get("/bot/subscribers/").then((r) => unwrap<BotSubscriber>(r.data)),
  });
}

/** Optimistic toggle of receives_broadcasts, same as the old page. */
export function useBotSubscriberToggle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { id: number; receives_broadcasts: boolean }) =>
      api.patch<BotSubscriber>(`/bot/subscribers/${p.id}/`, { receives_broadcasts: p.receives_broadcasts }),
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: ["bot-subscribers"] });
      const prev = qc.getQueryData<BotSubscriber[]>(["bot-subscribers"]);
      if (prev) qc.setQueryData<BotSubscriber[]>(["bot-subscribers"], prev.map((r) => (r.id === p.id ? { ...r, receives_broadcasts: p.receives_broadcasts } : r)));
      return { prev };
    },
    onError: (_e, _p, ctx) => {
      if (ctx?.prev) qc.setQueryData(["bot-subscribers"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["bot-subscribers"] }),
  });
}

/* ------------------------------ /tg-queue ------------------------------ */

export interface TgqJob {
  id: number;
  status: "pending" | "running" | "done" | "error";
  since: string | null;
  started_at: string | null;
  finished_at: string | null;
  chats_scanned: number;
  messages_saved: number;
  last_error: string;
}

export type TgqSessionStatus = "active" | "pending_code" | "pending_2fa" | "expired" | "revoked" | "error" | "none";

export interface TgqRow {
  operator_id: number;
  operator_name: string;
  session_id: number | null;
  session_status: TgqSessionStatus;
  tg_username: string;
  last_connected_at: string | null;
  last_error: string;
  chats_count: number;
  messages_count: number;
  insights_count: number;
  latest_job: TgqJob | null;
}

export function useTgqQueue() {
  return useQuery({
    queryKey: ["tg-queue"],
    queryFn: () => api.get<{ queue: TgqRow[]; total: number }>("/tg-userclient/queue/").then((r) => r.data),
    refetchInterval: 5000,
  });
}

export function useTgqRetry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (operator_id: number) => api.post("/tg-userclient/backfill-jobs/retry/", { operator_id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tg-queue"] }),
  });
}
