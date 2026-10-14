/**
 * v2 data hooks — admin zone, group «marketing»: /marketing (6 tabs).
 * Query keys match the old page: ["marketing","dashboard",key],
 * ["marketing","insight",id], ["marketing","adspend"], ["sheet-sources","for-adspend"].
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import type { AdSpendRow, DashboardPayload, InsightRecord } from "../../../components/marketing/types";

export type {
  AdSpendRow as MktAdSpendRow,
  DashboardPayload as MktDashboard,
  InsightRecord as MktInsight,
  SourceRow as MktSourceRow,
  FunnelRow as MktFunnelRow,
  RejectionRow as MktRejectionRow,
  TimePatternSource as MktTimePatternSource,
} from "../../../components/marketing/types";

export function useMktDashboard(dateFrom: string, dateTo: string) {
  return useQuery<DashboardPayload>({
    queryKey: ["marketing", "dashboard", `${dateFrom}::${dateTo}`],
    queryFn: async () => (await api.get<DashboardPayload>("/marketing/dashboard/", { params: { date_from: dateFrom, date_to: dateTo } })).data,
    staleTime: 60_000,
  });
}

export function useMktInsight(id: number | null | undefined) {
  return useQuery<InsightRecord | null>({
    queryKey: ["marketing", "insight", id],
    queryFn: async () => (id ? (await api.get<InsightRecord>(`/marketing/insights/${id}/`)).data : null),
    enabled: !!id,
  });
}

export function useMktGenerate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (days: number) => api.post<InsightRecord>(`/marketing/insights/generate/?days=${days}`).then((r) => r.data),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["marketing", "dashboard"] });
      qc.invalidateQueries({ queryKey: ["marketing", "insight"] });
      qc.setQueryData(["marketing", "insight", data.id], data);
    },
  });
}

export function useMktMarkDone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, index }: { id: number; index: number }) =>
      api.post<InsightRecord>(`/marketing/insights/${id}/recommendations/${index}/mark_done/`).then((r) => r.data),
    onSuccess: (data) => qc.setQueryData(["marketing", "insight", data.id], data),
  });
}

/** XLSX export through the authenticated client (old page used a bare link). */
export async function mktExport(dateFrom: string, dateTo: string) {
  const r = await api.get("/marketing/export.xlsx/", { params: { date_from: dateFrom, date_to: dateTo }, responseType: "blob" });
  const url = URL.createObjectURL(r.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `marketing_${dateFrom}_${dateTo}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------------- ad spend ---------------- */

export function useMktAdSpend() {
  return useQuery<AdSpendRow[]>({
    queryKey: ["marketing", "adspend"],
    queryFn: async () => {
      const d = (await api.get("/marketing/adspend/")).data as AdSpendRow[] | { results?: AdSpendRow[] };
      return Array.isArray(d) ? d : d?.results ?? [];
    },
  });
}

export function useMktSheetSources() {
  return useQuery<Array<{ id: number; name: string }>>({
    queryKey: ["sheet-sources", "for-adspend"],
    queryFn: async () => {
      const d = (await api.get("/sheet-sources/")).data as Array<{ id: number; name: string }> | { results?: Array<{ id: number; name: string }> };
      return Array.isArray(d) ? d : d?.results ?? [];
    },
  });
}

function useAdSpendMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marketing", "adspend"] });
      qc.invalidateQueries({ queryKey: ["marketing", "dashboard"] });
    },
  });
}

export const useMktAdSpendCreate = () => useAdSpendMutation((payload: Record<string, unknown>) => api.post("/marketing/adspend/", payload));
export const useMktAdSpendDelete = () => useAdSpendMutation((id: number) => api.delete(`/marketing/adspend/${id}/`));
export const useMktAdSpendPatch = () =>
  useAdSpendMutation(({ id, fields }: { id: number; fields: Record<string, unknown> }) => api.patch(`/marketing/adspend/${id}/`, fields));
