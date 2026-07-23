import { api } from "./api";

export type TgSessionStatus =
  | "pending_code"
  | "pending_2fa"
  | "active"
  | "expired"
  | "revoked"
  | "error"
  | null;

export const TG_STATUS_KEY = (operatorId?: number) => ["tg-status", operatorId ?? "me"] as const;

export interface TgBackfillJobItem {
  id: number;
  session_id: number;
  status: "pending" | "running" | "done" | "error";
  since: string;
  chats_scanned: number;
  messages_saved: number;
  started_at?: string;
  finished_at?: string;
  last_error?: string;
}

export interface TgStatusResponse {
  operator_id: number;
  session_id?: number;
  status: TgSessionStatus;
  tg_username?: string;
  last_connected_at?: string;
  last_error?: string;
  latest_backfill_job?: TgBackfillJobItem | null;
}

export interface TgChat {
  id: number;
  tg_chat_id: number;
  kind: string;
  title: string;
  partner_name: string;
  partner_phone: string;
  lead_id: number | null;
  lead_name: string;
  last_message_at: string;
}

export interface TgMessageItem {
  id: number;
  tg_message_id: number;
  direction: "in" | "out";
  kind: string;
  text: string;
  transcript_status: string;
  voice_duration_sec: number | null;
  sent_at: string;
}

export interface TgInsight {
  id: number;
  session_id: number;
  chat_id: number | null;
  since: string;
  until: string;
  model_version: string;
  prompt_version: string;
  summary: string;
  quality_score: number | null;
  red_flags: string[];
  highlights: string[];
  created_at: string;
}

export const tgStart = (phone: string, consent: boolean) =>
  api.post<{ session_id: number; status: string }>("/tg-userclient/start/", {
    phone,
    consent,
  });

export const tgVerifyCode = (session_id: number, code: string) =>
  api.post<{ status: string }>("/tg-userclient/verify-code/", {
    session_id,
    code,
  });

export const tgVerifyPassword = (session_id: number, password: string) =>
  api.post<{ status: string }>("/tg-userclient/verify-password/", {
    session_id,
    password,
  });

export const tgRevoke = (session_id: number) =>
  api.post<{ status: string }>("/tg-userclient/revoke/", { session_id });

export const tgStatus = (operatorId?: number) =>
  api.get<TgStatusResponse>("/tg-userclient/status/", {
    params: operatorId ? { operator: operatorId } : {},
  });

export const tgChats = (operatorId: number) =>
  api.get<TgChat[]>("/tg-userclient/chats/", {
    params: { operator: operatorId },
  });

export const tgMessages = (chatId: number, limit = 50) =>
  api.get<TgMessageItem[]>("/tg-userclient/messages/", {
    params: { chat: chatId, limit },
  });

export const tgInsights = (params: { operator?: number; chat?: number }) =>
  api.get<TgInsight[]>("/tg-userclient/insights/", { params });

export const tgBackfillJobs = (operatorId: number) =>
  api.get<TgBackfillJobItem[]>("/tg-userclient/backfill-jobs/", {
    params: { operator: operatorId },
  });

export const tgRetryBackfill = (params: { operator_id?: number; session_id?: number }) =>
  api.post<{ job_id: number; status: string }>("/tg-userclient/backfill-jobs/retry/", params);
