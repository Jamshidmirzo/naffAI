/**
 * v2 data hooks for the super-manager «Моя ветка» zone:
 * Branch (/team/managers), TeamSales (/team/sales), DeletedOperators
 * (/team/deleted-operators). Query keys are the same as the old pages
 * (MyManagers / MyTeamSales / DeletedOperators) so cache and
 * invalidation are shared between v1 and v2.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export interface BranchUser {
  id: number;
  username: string;
  full_name?: string;
  role: string;
  is_active: boolean;
  is_superuser: boolean;
  date_joined: string | null;
  last_login: string | null;
  reports_to_id: number | null;
  operator_id?: number | null;
  operator_name?: string | null;
  operator_phone?: string | null;
}

export interface BranchOperator {
  id: number;
  full_name: string;
  phone: string | null;
  status: string; // active | trainee | inactive
  managed_by_id: number | null;
  is_paused?: boolean;
  avatar_url?: string | null;
  plan_target?: string | number | null;
  plan_actual?: string | number | null;
}

export interface Creds {
  id: number;
  username: string;
  password: string;
}

export type Period = "day" | "week" | "month";

export interface LeaderRow {
  operator_id: number;
  operator_name: string;
  is_trainee: boolean;
  total: number | string;
  count: number | string;
  avg_ticket: number | string;
}

export interface KpiBlock {
  total: string;
  count: number;
}

export interface TeamKpi {
  today: KpiBlock;
  week: KpiBlock;
  month: KpiBlock;
  operators_active: number;
  operators_trainee: number;
}

export interface DeletedRow {
  audit_id: number;
  operator_id: number | null;
  snapshot: {
    full_name: string;
    phone: string;
    status: string;
    hired_at: string | null;
  };
  deleted_at: string;
  deleted_by_user_id: number | null;
  deleted_by_username: string;
  comment: string;
  sales_count: number;
  sales_total: string;
  restored_sales_count: number;
  deleted_related: {
    sales_soft_deleted_count: number;
    sales_shrunk_count: number;
    sales_unlinked: number;
    lead_assignments_detached: number;
    call_attempts_detached: number;
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/** "123.00" | 123 | null → number (0 for empty). */
export function toNum(v: number | string | null | undefined): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

/** True for "endpoint not deployed yet" errors → caller falls back. */
export function isMissingEndpoint(err: unknown): boolean {
  const s = (err as { response?: { status?: number } })?.response?.status;
  return s === 404 || s === 405 || s === 501;
}

/** Server error text (DRF detail / first field error) or fallback. */
export function errText(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data) {
    if (typeof data === "string") return data.length < 300 ? data : fallback;
    if (typeof data === "object") {
      const d = data as Record<string, unknown>;
      if (typeof d.detail === "string") return d.detail;
      for (const v of Object.values(d)) {
        if (typeof v === "string") return v;
        if (Array.isArray(v) && typeof v[0] === "string") return v[0];
      }
    }
  }
  return fallback;
}

/** Display name for a web user: operator name → full name → login. */
export function userDisplayName(u: Pick<BranchUser, "username" | "full_name" | "operator_name">): string {
  return u.operator_name || u.full_name || u.username;
}

export function initials(name: string): string {
  return (
    name
      .replace(/[^\p{L}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || "?"
  );
}

/** Russian plural form key: base + ".one" | ".few" | ".many" (UZ defines all three the same). */
export function pluralKey(base: string, n: number): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return `${base}.many`;
  if (b === 1) return `${base}.one`;
  if (b >= 2 && b <= 4) return `${base}.few`;
  return `${base}.many`;
}

/** Plan progress (current month) for a set of operators; null when no plan is set. */
export function planOf(ops: Pick<BranchOperator, "plan_target" | "plan_actual">[]): { pct: number; target: number; actual: number } | null {
  let target = 0;
  let actual = 0;
  for (const o of ops) {
    const tg = toNum(o.plan_target);
    if (tg > 0) {
      target += tg;
      actual += toNum(o.plan_actual);
    }
  }
  if (target <= 0) return null;
  return { pct: Math.round((actual / target) * 100), target, actual };
}

export const barCls = (pct: number) => (pct >= 85 ? "ok" : pct >= 60 ? "warn" : "bad");

export const isManagerRole =(role: string) => role === "manager" || role === "team_lead";

/* ------------------------------------------------------------------ */
/*  Queries                                                             */
/* ------------------------------------------------------------------ */

/** All web users visible to me (super_manager / superadmin see everyone). Key shared with Users/MyManagers. */
export function useBranchUsers() {
  return useQuery<BranchUser[]>({
    queryKey: ["users"],
    queryFn: () => api.get<BranchUser[]>("/users/").then((r) => r.data),
  });
}

/** Operators in my scope with plan_target / plan_actual. Key shared with MyManagers. */
export function useBranchOperators() {
  return useQuery<BranchOperator[]>({
    queryKey: ["operators"],
    queryFn: () => api.get<BranchOperator[]>("/operators/").then((r) => r.data),
  });
}

/** Same list under MyTeamSales' own key. */
export function useTeamOperators() {
  return useQuery<BranchOperator[]>({
    queryKey: ["my-team-operators"],
    queryFn: () => api.get<BranchOperator[]>("/operators/").then((r) => r.data),
  });
}

export function useTeamKpi(period: Period) {
  return useQuery<TeamKpi>({
    queryKey: ["my-team-kpi", period],
    queryFn: () => api.get<TeamKpi>("/analytics/kpi/", { params: { period } }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
}

export function useTeamLeaderboard(period: Period) {
  return useQuery<LeaderRow[]>({
    queryKey: ["my-team-leaderboard", period],
    queryFn: () => api.get<LeaderRow[]>("/analytics/leaderboard/", { params: { period } }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
}

export function useDeletedOperators() {
  return useQuery<{ results: DeletedRow[]; count: number }>({
    queryKey: ["deleted-operators"],
    queryFn: () => api.get<{ results: DeletedRow[]; count: number }>("/operators/deleted/").then((r) => r.data),
    staleTime: 60_000,
  });
}

/* ------------------------------------------------------------------ */
/*  Mutations (Branch)                                                  */
/* ------------------------------------------------------------------ */

/** Promote an existing staff account to manager (PATCH /users/<id>/ {role}). */
export function usePromoteManager() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) => api.patch(`/users/${userId}/`, { role: "manager" }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

/** Create a new manager by phone; the response carries the one-time password. */
export function useCreateManager() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { username: string; full_name: string }) =>
      api
        .post<Creds & { role: string; is_active: boolean; full_name?: string }>("/users/", {
          username: v.username,
          full_name: v.full_name,
          role: "manager",
        })
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useResetManagerPassword() {
  return useMutation({
    mutationFn: (userId: number) => api.post<Creds>(`/users/${userId}/reset-password/`).then((r) => r.data),
  });
}

/** Soft-delete (deactivate) a manager; their operators become unassigned server-side. */
export function useDeleteManager() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) => api.post(`/users/${userId}/delete/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      qc.invalidateQueries({ queryKey: ["operators"] });
    },
  });
}

function patchOperatorsCache(qc: QueryClient, ids: number[], managerId: number | null) {
  const set = new Set(ids);
  const apply = (rows: BranchOperator[] | undefined) =>
    rows ? rows.map((o) => (set.has(o.id) ? { ...o, managed_by_id: managerId } : o)) : rows;
  qc.setQueryData<BranchOperator[]>(["operators"], apply);
  qc.setQueryData<BranchOperator[]>(["my-team-operators"], apply);
}

function invalidateOperators(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["operators"] });
  qc.invalidateQueries({ queryKey: ["my-team-operators"] });
}

export interface MoveVars {
  opId: number;
  managerId: number | null;
}

/**
 * Move one operator to another owner: PATCH /operators/<id>/ {managed_by_id}.
 * Optimistic: the card jumps at once and returns to its column on error.
 */
export function useMoveOperator() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ opId, managerId }: MoveVars) =>
      api.patch(`/operators/${opId}/`, { managed_by_id: managerId }).then((r) => r.data),
    onMutate: async ({ opId, managerId }: MoveVars) => {
      await qc.cancelQueries({ queryKey: ["operators"] });
      const prev = qc.getQueryData<BranchOperator[]>(["operators"]);
      const prevTeam = qc.getQueryData<BranchOperator[]>(["my-team-operators"]);
      patchOperatorsCache(qc, [opId], managerId);
      return { prev, prevTeam };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["operators"], ctx.prev);
      if (ctx?.prevTeam) qc.setQueryData(["my-team-operators"], ctx.prevTeam);
    },
    onSettled: () => invalidateOperators(qc),
  });
}

export interface BulkResult {
  updated: number[];
  errors: { id: number; detail: string }[];
}

/**
 * Move several operators at once. Uses POST /operators/bulk-set-manager/
 * (BACKEND_V2 §4); when that endpoint is not deployed yet (404/405) falls
 * back to one PATCH per operator via Promise.allSettled.
 */
export function useBulkMoveOperators() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, managerId }: { ids: number[]; managerId: number | null }): Promise<BulkResult> => {
      try {
        const r = await api.post<BulkResult>("/operators/bulk-set-manager/", {
          operator_ids: ids,
          managed_by_id: managerId,
        });
        return { updated: r.data?.updated ?? ids, errors: r.data?.errors ?? [] };
      } catch (e) {
        if (!isMissingEndpoint(e)) throw e;
      }
      const results = await Promise.allSettled(
        ids.map((id) => api.patch(`/operators/${id}/`, { managed_by_id: managerId })),
      );
      const out: BulkResult = { updated: [], errors: [] };
      results.forEach((res, i) => {
        if (res.status === "fulfilled") out.updated.push(ids[i]);
        else out.errors.push({ id: ids[i], detail: errText(res.reason, "") });
      });
      return out;
    },
    onSuccess: (res, { managerId }) => patchOperatorsCache(qc, res.updated, managerId),
    onSettled: () => invalidateOperators(qc),
  });
}
