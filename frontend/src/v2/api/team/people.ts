// v2 data hooks — people group: /users, /operators/day-off, /audit.
// Query keys are the same as the old pages (Users.tsx, DayOffRequests.tsx,
// Audit.tsx) so cache + invalidation are shared between designs.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";

/* ─────────────────────────── Users ─────────────────────────── */

export type UsersLanguage = "ru" | "uz";

export interface UsersRow {
  id: number;
  username: string;
  full_name?: string;
  role: string;
  is_active: boolean;
  is_superuser: boolean;
  date_joined: string | null;
  last_login: string | null;
  preferred_language?: UsersLanguage;
  reports_to_id?: number | null;
  telegram_linked?: boolean;
  operator_id?: number | null;
  operator_name?: string | null;
  operator_phone?: string | null;
}

export interface UsersCreds {
  id: number;
  username: string;
  password: string;
}

export function useUsersList() {
  return useQuery<UsersRow[]>({
    queryKey: ["users"],
    queryFn: () => api.get<UsersRow[]>("/users/").then((r) => r.data),
  });
}

export function useUsersCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { username: string; role: string; reports_to_id?: number }) =>
      api.post<UsersCreds & { role: string; is_active: boolean }>("/users/", payload).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useUsersUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...payload }: { id: number; role?: string; reports_to_id?: number | null; preferred_language?: UsersLanguage }) =>
      api.patch(`/users/${id}/`, payload).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useUsersResetPassword() {
  return useMutation({
    mutationFn: (id: number) => api.post<UsersCreds>(`/users/${id}/reset-password/`).then((r) => r.data),
  });
}

export function useUsersDeactivate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post(`/users/${id}/delete/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

/* ─────────────────────────── Day off ─────────────────────────── */

export interface DayOffRow {
  id: number;
  operator_id: number;
  operator_name: string;
  date: string;
  status: string;
  reason: string;
  created_at: string;
}

export interface DayOffContext extends DayOffRow {
  context: {
    last_day_off: string | null;
    others_on_date: number;
    recent: {
      sales_7d_count: number;
      sales_7d_total: string;
      leads_7d_touched: number;
      calls_7d_total: number;
    };
  };
}

export function useDayOffPending() {
  return useQuery<{ results: DayOffRow[]; count: number }>({
    queryKey: ["day-off-pending"],
    queryFn: () => api.get("/operators/day-off/pending/").then((r) => r.data),
  });
}

export function useDayOffContext(id: number, enabled: boolean) {
  return useQuery<DayOffContext>({
    queryKey: ["day-off-context", id],
    queryFn: () => api.get(`/operators/day-off/${id}/context/`).then((r) => r.data),
    enabled,
  });
}

export function useDayOffDecide(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ decision, note }: { decision: "approve" | "reject"; note: string }) =>
      api.post(`/operators/day-off/${id}/${decision}/`, { note }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["day-off-pending"] }),
  });
}

/* ─────────────────────────── Audit ─────────────────────────── */

export interface AuditRow {
  id: number;
  user?: number | null;
  user_name: string | null;
  action: string;
  entity: string;
  entity_id: number | string;
  changes: unknown;
  comment?: string;
  created_at: string;
}

interface AuditPage {
  count: number;
  next: string | null;
  results: AuditRow[];
}

const AUDIT_PAGE = 50;

/**
 * The old page used ["audit"] for the first server page only. v2 pages
 * through everything (LimitOffset) and filters by entity on the server;
 * the key stays under the ["audit"] prefix so any invalidation still hits.
 */
export function useAuditLog(entity: string) {
  return useInfiniteQuery<AuditPage>({
    queryKey: ["audit", "v2", { entity }],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api
        .get("/audit/", { params: { limit: AUDIT_PAGE, offset: pageParam, ...(entity ? { entity } : {}) } })
        .then((r) => r.data),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + (p.results?.length ?? 0), 0);
      return last.next && loaded < last.count ? loaded : undefined;
    },
  });
}
