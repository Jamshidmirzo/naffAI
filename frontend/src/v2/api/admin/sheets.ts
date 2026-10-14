/**
 * v2 data hooks — admin zone, group «sheets»: /sheet-sources (sources,
 * aliases, wizard, health cards, sync bar, diagnostics).
 * Query keys match the old page and components.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";

function unwrap<T>(d: unknown): T[] {
  const x = d as { results?: T[] } | T[];
  return (Array.isArray(x) ? x : x?.results) ?? [];
}

export type SheetDistributionMode = "alias_only" | "alias_or_default" | "default_only" | "alias_or_rr";
export const SHEET_MODES: SheetDistributionMode[] = ["alias_only", "alias_or_default", "default_only", "alias_or_rr"];

export interface SheetWriteback {
  enabled?: boolean;
  status_col?: string;
  operator_col?: string;
  updated_col?: string;
  comment_col?: string;
}

export interface SheetSource {
  id: number;
  name: string;
  spreadsheet_id: string;
  gid: number;
  worksheet_name: string;
  column_map: Record<string, unknown>;
  default_status: string;
  active: boolean;
  last_synced_at: string | null;
  last_synced_row: number;
  default_operator: number | null;
  default_operator_name: string | null;
  distribution_mode: SheetDistributionMode;
  writeback_columns: SheetWriteback;
  allowed_operator_ids?: number[];
  is_hot?: boolean;
  hot_sla_minutes?: number;
}

export type SheetSourceBody = Omit<SheetSource, "id" | "last_synced_at" | "last_synced_row" | "default_operator_name">;

export interface SheetOperator {
  id: number;
  full_name: string;
  status: string;
}

export interface SheetAlias {
  id: number;
  alias_name: string;
  operator: number | null;
  operator_name: string | null;
}

export interface SheetStats {
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

export interface SheetHealthItem {
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
  sources: SheetHealthItem[];
  writeback: {
    is_healthy: boolean;
    pending_count: number;
    failed_count: number;
    done_last_1h: number;
    failed_samples: Array<{ lead_id: number; last_error: string; attempts: number }>;
  };
}

export interface SheetSyncResult {
  read?: number;
  imported?: number;
  created?: number;
  merged?: number;
  resynced?: number;
  skipped?: number;
}

export interface SheetPreview {
  spreadsheet_id: string;
  gid: number;
  sheet_title: string;
  headers: string[];
  sample_rows: string[][];
  total_rows: number;
  suggested_column_map: Record<"phone" | "full_name" | "product_hint" | "has_card" | "extra_phone", string | null>;
  suggested_writeback: { status_col: string | null; operator_col: string | null; updated_at_col: string | null; comment_col: string | null };
  already_connected: { id: number; name: string } | null;
}

/* ---------------- queries ---------------- */

export function useSheetSources() {
  return useQuery({
    queryKey: ["sheet-sources"],
    queryFn: () => api.get("/sheet-sources/").then((r) => unwrap<SheetSource>(r.data)),
  });
}

export function useSheetOperators() {
  return useQuery({
    queryKey: ["operators-active"],
    queryFn: () => api.get("/operators/?include_inactive=0").then((r) => unwrap<SheetOperator>(r.data)),
  });
}

export function useSheetAliases() {
  return useQuery({
    queryKey: ["operator-sheet-aliases"],
    queryFn: () => api.get("/operator-sheet-aliases/").then((r) => unwrap<SheetAlias>(r.data)),
  });
}

export function useSheetStats(id: number) {
  return useQuery({
    queryKey: ["sheet-source-stats", id],
    queryFn: () => api.get<SheetStats>(`/sheet-sources/${id}/stats/`).then((r) => r.data),
    refetchInterval: 60_000,
  });
}

/** Bar polls every 30 s; the diagnostics window every 10 s while open. */
export function useSheetHealthOverview(intervalMs: number) {
  return useQuery<SheetHealthOverview>({
    queryKey: ["sheet-health-overview"],
    queryFn: () => api.get<SheetHealthOverview>("/sheet-sources/health-overview/").then((r) => r.data),
    refetchInterval: intervalMs,
  });
}

/* ---------------- mutations ---------------- */

export function useSheetSourceSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: number | null; body: SheetSourceBody }) =>
      (id ? api.patch<SheetSource>(`/sheet-sources/${id}/`, body) : api.post<SheetSource>("/sheet-sources/", body)).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sheet-sources"] }),
  });
}

export function useSheetPreview() {
  return useMutation({
    mutationFn: (url: string) => api.post<SheetPreview>("/sheet-sources/preview/", { spreadsheet_url: url }).then((r) => r.data),
  });
}

/** sync-now for one source (force=true = full rescan from row 1). */
export function useSheetSyncNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, force }: { id: number; force?: boolean }) => api.post<SheetSyncResult>(`/sheet-sources/${id}/sync-now/`, { force }).then((r) => r.data),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["sheet-source-stats", v.id] });
      qc.invalidateQueries({ queryKey: ["sheet-sources"] });
      qc.invalidateQueries({ queryKey: ["sheet-health-overview"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
}

export function useSheetSyncAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ total_sources?: number; total_read?: number; total_created?: number }>("/sheet-sources/sync-all/").then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sheet-health-overview"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["sheet-sources"] });
    },
  });
}

export function useSheetFlushWritebacks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ stats?: { ok?: number }; remaining_pending?: number }>("/sheet-sources/flush-writebacks/").then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sheet-health-overview"] }),
  });
}

/** Re-read the sheet from row 1 (reset watermark). */
export function useSheetRescan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<SheetSyncResult>(`/sheet-sources/${id}/reset-watermark/`, { row: 0 }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sheet-health-overview"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["sheet-sources"] });
    },
  });
}

export function useSheetAliasBind() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, operator }: { id: number; operator: number | null }) => api.patch(`/operator-sheet-aliases/${id}/`, { operator }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["operator-sheet-aliases"] }),
  });
}

export function useSheetAliasCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (alias_name: string) => api.post("/operator-sheet-aliases/", { alias_name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["operator-sheet-aliases"] }),
  });
}

/** DRF error → one readable line (detail, or the first field error). */
export function sheetErrMsg(err: unknown): string | undefined {
  const e = err as { response?: { data?: unknown }; message?: string };
  const data = e?.response?.data as Record<string, unknown> | undefined;
  if (data && typeof data === "object") {
    if (typeof data.detail === "string") return data.detail;
    const first = Object.entries(data)[0];
    if (first) {
      const [field, val] = first;
      return `${field}: ${Array.isArray(val) ? val.join(", ") : String(val)}`;
    }
  }
  return e?.message;
}
