import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/**
 * Meta Ads (Marketing API + лид-формы) — настройки подключения.
 * Backend: apps/marketing/smm_apis.py (/marketing/meta/*, /marketing/smm/).
 * Токен уходит на сервер один раз и обратно не отдаётся.
 */

export interface MetaAdAccountRow {
  id: number;
  connection_id?: number;
  account_id: string;
  name: string;
  currency: string;
  timezone_name?: string;
  account_status?: number | null;
  smm_id?: number | null;
  smm_name?: string | null;
  is_active: boolean;
  last_synced_at: string | null;
  last_sync_error: string;
  synced_since?: string | null;
}

export interface MetaLeadFormRow {
  id: number;
  form_id: string;
  name: string;
  status: string;
  last_lead_at: string | null;
  leads_imported: number;
}

export interface MetaPageRow {
  id: number;
  connection_id: number;
  page_id: string;
  name: string;
  tasks: string[];
  smm_id: number | null;
  smm_name: string | null;
  leads_enabled: boolean;
  leads_since: string | null;
  source_id: number | null;
  source_name: string | null;
  source_active: boolean | null;
  last_polled_at: string | null;
  last_poll_error: string;
  forms: MetaLeadFormRow[];
}

export interface MetaConnectionRow {
  id: number;
  name: string;
  meta_user_id: string;
  meta_user_name: string;
  token_expires_at: string | null;
  last_checked_at: string | null;
  last_error: string;
  created_at: string | null;
  accounts: MetaAdAccountRow[];
  pages: MetaPageRow[];
}

export interface SmmOption {
  id: number;
  name: string;
}

export function useSmmOptions() {
  return useQuery<SmmOption[]>({
    queryKey: ["smm", "list"],
    queryFn: async () => (await api.get<SmmOption[]>("/marketing/smm/")).data,
    staleTime: 60_000,
  });
}

export function useMetaConnections() {
  return useQuery<MetaConnectionRow[]>({
    queryKey: ["meta", "connections"],
    queryFn: async () => (await api.get<MetaConnectionRow[]>("/marketing/meta/connections/")).data,
  });
}

function useMetaInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["meta"] });
    qc.invalidateQueries({ queryKey: ["smm"] });
  };
}

export function useMetaConnectionCreate() {
  const inv = useMetaInvalidate();
  return useMutation({
    mutationFn: (body: { token: string; name?: string }) =>
      api.post<MetaConnectionRow>("/marketing/meta/connections/", body).then((r) => r.data),
    onSuccess: inv,
  });
}

export function useMetaConnectionUpdate() {
  const inv = useMetaInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; token?: string; name?: string }) =>
      api.patch<MetaConnectionRow>(`/marketing/meta/connections/${id}/`, body).then((r) => r.data),
    onSuccess: inv,
  });
}

export function useMetaConnectionCheck() {
  const inv = useMetaInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      api.post<MetaConnectionRow>(`/marketing/meta/connections/${id}/check/`).then((r) => r.data),
    onSuccess: inv,
  });
}

export function useMetaConnectionDelete() {
  const inv = useMetaInvalidate();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/marketing/meta/connections/${id}/`),
    onSuccess: inv,
  });
}

export function useMetaAccountUpdate() {
  const inv = useMetaInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; smm_id?: number | null; is_active?: boolean }) =>
      api.patch<MetaAdAccountRow>(`/marketing/meta/ad-accounts/${id}/`, body).then((r) => r.data),
    onSuccess: inv,
  });
}

export function useMetaAccountSync() {
  const inv = useMetaInvalidate();
  return useMutation({
    mutationFn: ({ id }: { id: number }) =>
      api
        .post<{ result: { ads: number; insight_rows: number; since: string; until: string }; account: MetaAdAccountRow }>(
          `/marketing/meta/ad-accounts/${id}/sync/`,
          {},
          { timeout: 180_000 },
        )
        .then((r) => r.data),
    onSettled: inv,
  });
}

export function useMetaPageUpdate() {
  const inv = useMetaInvalidate();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: { id: number; smm_id?: number | null; leads_enabled?: boolean; backfill_hours?: number }) =>
      api.patch<MetaPageRow>(`/marketing/meta/pages/${id}/`, body).then((r) => r.data),
    onSuccess: inv,
  });
}

export function useMetaPageSync() {
  const inv = useMetaInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      api
        .post<{ result: { created?: number; seen?: number; forms?: number }; page: MetaPageRow }>(
          `/marketing/meta/pages/${id}/sync/`,
          {},
          { timeout: 120_000 },
        )
        .then((r) => r.data),
    onSettled: inv,
  });
}

/** ISO → «dd.mm hh:mm» (локальное время). */
export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
