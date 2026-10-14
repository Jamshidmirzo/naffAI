/**
 * v2 data hooks — admin zone, group «analytics»: /analytics, /reports,
 * /ai-chat, /marketing/sources, /screen. Query keys mirror the old pages
 * so the cache and invalidation stay shared.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import type { DemandSupplyPayload, FunnelRow as MktFunnelRow, RejectionRow, SourceRow } from "../../../components/marketing/types";

/* ---------------- /analytics ---------------- */

export interface AnLeaderboardRow {
  operator_id: number;
  operator_name: string;
  total: number | string;
  count?: number | string;
}
export interface AnChannelRow {
  channel_name: string;
  total: number | string;
  count: number | string;
}
export interface AnModelRow {
  phone_model: string;
  count: number | string;
  total: number | string;
}
export interface AnSourceRow {
  sheet_source_id: number | null;
  sheet_source_name: string;
  total: number | string;
  sales_count: number;
  leads_count: number;
  conversion_pct: number;
}
export interface AnFunnelRow {
  operator_id: number;
  operator_name: string;
  leads_total: number;
  contacted: number;
  callbacks: number;
  sales: number;
}
export interface AnHeatmap {
  operators: { id: number; name: string }[];
  hours: number[];
  matrix: number[][];
}

type Params = Record<string, string>;

export function useAnLeaderboard(params: Params) {
  const key = JSON.stringify(params);
  return useQuery<AnLeaderboardRow[]>({
    queryKey: ["lb", key],
    queryFn: () => api.get<AnLeaderboardRow[]>("/analytics/leaderboard/", { params }).then((r) => r.data),
  });
}
export function useAnByChannel(params: Params) {
  const key = JSON.stringify(params);
  return useQuery<AnChannelRow[]>({
    queryKey: ["by-channel", key],
    queryFn: () => api.get<AnChannelRow[]>("/analytics/by-channel/", { params }).then((r) => r.data),
  });
}
export function useAnByModel(params: Params) {
  const key = JSON.stringify(params);
  return useQuery<AnModelRow[]>({
    queryKey: ["by-model", key],
    queryFn: () => api.get<AnModelRow[]>("/analytics/by-model/", { params }).then((r) => r.data),
  });
}
export function useAnBySource(params: Params) {
  const key = JSON.stringify(params);
  return useQuery<AnSourceRow[]>({
    queryKey: ["by-source", key],
    queryFn: () => api.get<AnSourceRow[]>("/analytics/by-source/", { params }).then((r) => r.data),
  });
}
export function useAnOperatorFunnels() {
  return useQuery<AnFunnelRow[]>({
    queryKey: ["operator-funnels"],
    queryFn: () => api.get<AnFunnelRow[]>("/analytics/operator-funnels/?top_n=20").then((r) => r.data),
  });
}
export function useAnCallbackHeatmap() {
  return useQuery<AnHeatmap>({
    queryKey: ["callback-heatmap"],
    queryFn: () => api.get<AnHeatmap>("/analytics/callback-heatmap/?days_back=30").then((r) => r.data),
  });
}

/* ---------------- xlsx downloads (/analytics Excel, /reports) ---------------- */

export interface AdminXlsxResult {
  size: number;
  filename: string;
}

/** Saves a blob as a file in the browser. */
export function adminSaveBlob(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

/** GET an xlsx endpoint with the Token header and save it. Throws the axios error. */
export async function adminDownloadXlsx(url: string, params: Params, filename: string): Promise<AdminXlsxResult> {
  const r = await api.get(url, { responseType: "blob", params });
  const blob = new Blob([r.data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  adminSaveBlob(blob, filename);
  return { size: blob.size, filename };
}

/**
 * For blob requests the error body is a Blob too — read it and pull out
 * `detail`/`error`/`message` so the user sees the real reason.
 */
export async function adminBlobErrorDetail(err: unknown): Promise<{ status?: number; detail?: string }> {
  const e = err as { response?: { status?: number; data?: unknown }; message?: string };
  const status = e.response?.status;
  const data = e.response?.data;
  let detail: string | undefined;
  try {
    if (data instanceof Blob) {
      const text = await data.text();
      try {
        const j = JSON.parse(text) as Record<string, unknown>;
        const v = j.detail ?? j.error ?? j.message ?? Object.values(j)[0];
        detail = Array.isArray(v) ? String(v[0]) : v != null ? String(v) : undefined;
      } catch {
        detail = text && text.length < 300 && !text.trim().startsWith("<") ? text : undefined;
      }
    } else if (data && typeof data === "object") {
      const j = data as Record<string, unknown>;
      const v = j.detail ?? j.error ?? j.message;
      detail = v != null ? String(v) : undefined;
    }
  } catch {
    /* ignore */
  }
  if (!detail && !e.response && e.message) detail = e.message;
  return { status, detail };
}

/* ---------------- /ai-chat ---------------- */

export interface AiChatSession {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}
export interface AiChatMessage {
  id: number;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls: { name: string; arguments: Record<string, unknown> }[];
  tool_name: string;
  model_used?: string;
  provider_used?: string;
  created_at: string;
}
export interface AiChatProvider {
  key: string;
  label: string;
  model: string;
}
interface AiChatSendResponse {
  messages: AiChatMessage[];
  last_assistant_id: number;
}

export function useAiChatProviders() {
  return useQuery<AiChatProvider[]>({
    queryKey: ["ai-chat", "providers"],
    queryFn: () => api.get<AiChatProvider[]>("/ai-chat/providers/").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function useAiChatSessions() {
  return useQuery<AiChatSession[]>({
    queryKey: ["ai-chat", "sessions"],
    queryFn: async () => {
      const r = await api.get("/ai-chat/sessions/");
      return Array.isArray(r.data) ? (r.data as AiChatSession[]) : ((r.data as { results?: AiChatSession[] }).results ?? []);
    },
  });
}

export function useAiChatMessages(sessionId: number | null) {
  return useQuery<AiChatMessage[]>({
    queryKey: ["ai-chat", "messages", sessionId],
    queryFn: async () => {
      if (sessionId == null) return [];
      return (await api.get<AiChatMessage[]>(`/ai-chat/sessions/${sessionId}/messages/`)).data;
    },
    enabled: sessionId != null,
  });
}

export function useAiChatCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => api.post<AiChatSession>("/ai-chat/sessions/", { title }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai-chat", "sessions"] }),
  });
}

export function useAiChatSend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { sessionId: number; content: string; provider_key?: string; language: string }) => {
      const r = await api.post<AiChatSendResponse>(`/ai-chat/sessions/${v.sessionId}/messages/`, {
        content: v.content,
        provider_key: v.provider_key || undefined,
        language: v.language,
      });
      return { sessionId: v.sessionId, data: r.data };
    },
    onSuccess: ({ sessionId, data }) => {
      qc.setQueryData<AiChatMessage[]>(["ai-chat", "messages", sessionId], data.messages);
      qc.invalidateQueries({ queryKey: ["ai-chat", "sessions"] });
    },
  });
}

/* ---------------- /marketing/sources ---------------- */

export function useMsrcBreakdown(dateFrom: string, dateTo: string) {
  return useQuery<SourceRow[]>({
    queryKey: ["mkt-src", "breakdown", dateFrom, dateTo],
    queryFn: async () =>
      (await api.get<SourceRow[]>("/analytics/marketing-source-breakdown/", { params: { date_from: dateFrom, date_to: dateTo } })).data,
    staleTime: 60_000,
  });
}

export function useMsrcDashboard(dateFrom: string, dateTo: string) {
  return useQuery<{ funnels: MktFunnelRow[]; rejection_reasons: RejectionRow[] }>({
    queryKey: ["mkt-src", "dashboard", dateFrom, dateTo],
    queryFn: async () => (await api.get("/marketing/dashboard/", { params: { date_from: dateFrom, date_to: dateTo } })).data,
    staleTime: 60_000,
  });
}

export function useMsrcGap(dateFrom: string, dateTo: string, selected: SourceRow | null) {
  return useQuery<DemandSupplyPayload>({
    queryKey: ["mkt-src", "gap", dateFrom, dateTo, selected?.sheet_source_id ?? "all"],
    queryFn: async () => {
      const params: Params = { date_from: dateFrom, date_to: dateTo };
      if (selected?.sheet_source_id) params.source_id = String(selected.sheet_source_id);
      return (await api.get<DemandSupplyPayload>("/analytics/product-demand-vs-supply/", { params })).data;
    },
    enabled: !!selected,
    staleTime: 60_000,
  });
}

/* ---------------- /screen ---------------- */

export const SCREEN_REFRESH_SEC = 30;

/** Today's full ranking (limit=0 → every operator with sales), refreshed every 30 s. */
export function useScreenLeaderboard() {
  return useQuery<AnLeaderboardRow[]>({
    queryKey: ["screen-lb-v2", "day"],
    queryFn: () => api.get<AnLeaderboardRow[]>("/analytics/leaderboard/", { params: { period: "day", limit: 0 } }).then((r) => r.data),
    refetchInterval: SCREEN_REFRESH_SEC * 1000,
    refetchIntervalInBackground: true,
  });
}
