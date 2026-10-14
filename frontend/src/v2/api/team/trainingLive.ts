// v2 data hooks — training (manager side) + live wall / archive.
// Query keys are the same as the old pages (TrainingManage, TrainingLessonForm,
// LiveWall, LiveArchive) so cache and invalidation are shared.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { fetchLiveNow, fetchRecordings, type LiveNowResponse } from "../../../lib/liveRoom";

/* ───────────── Training ───────────── */

export interface TrainingRow {
  id: number;
  title: string;
  description: string;
  video_url: string;
  file_url: string;
  file_name: string;
  is_active: boolean;
  questions_count: number;
  attempts_count: number;
  comments_count: number;
  created_at: string;
}

export interface TrainingLessonDetail {
  id: number;
  title: string;
  description: string;
  video_url: string;
  file_url: string;
  file_name: string;
  is_active: boolean;
  questions: {
    id: number;
    text: string;
    order: number;
    answers: { id: number; text: string; is_correct: boolean; order: number }[];
  }[];
}

export interface TrainingStatsRow {
  id: number;
  text: string;
  order: number;
  attempts: number;
  correct: number;
  wrong: number;
  error_pct: number;
  wrong_operators: { id: number; full_name: string }[];
}

export interface TrainingStats {
  lesson_id: number;
  attempts_count: number;
  avg_score: number | null;
  questions: TrainingStatsRow[];
}

export function useTrainingManageList() {
  return useQuery<TrainingRow[]>({
    queryKey: ["training-manage"],
    queryFn: () => api.get("/training/lessons/").then((r) => r.data),
  });
}

/** Soft delete = hide (backend sets is_active=false; attempts are kept). */
export function useTrainingHide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/training/lessons/${id}/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["training-manage"] }),
  });
}

export function useTrainingToggleActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { id: number; is_active: boolean }) =>
      api.patch(`/training/lessons/${p.id}/`, { is_active: p.is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["training-manage"] }),
  });
}

export function useTrainingLessonDetail(id: string | undefined) {
  return useQuery<TrainingLessonDetail>({
    queryKey: ["training-manage-detail", id],
    queryFn: () => api.get(`/training/lessons/${id}/`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useTrainingLessonStats(id: string | undefined, enabled = true) {
  return useQuery<TrainingStats>({
    queryKey: ["training-manage-stats", id],
    queryFn: () => api.get(`/training/lessons/${id}/stats/`).then((r) => r.data),
    enabled: !!id && enabled,
  });
}

export function useTrainingLessonSave(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (form: FormData) =>
      id
        ? api.patch(`/training/lessons/${id}/`, form, { headers: { "Content-Type": "multipart/form-data" } })
        : api.post("/training/lessons/", form, { headers: { "Content-Type": "multipart/form-data" } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["training-manage"] });
      qc.invalidateQueries({ queryKey: ["training-manage-detail", id] });
      qc.invalidateQueries({ queryKey: ["training-manage-stats", id] });
    },
  });
}

/* ───────────── Live ───────────── */

export function useLiveNow() {
  return useQuery<LiveNowResponse>({
    queryKey: ["live-now"],
    queryFn: fetchLiveNow,
    refetchInterval: 5000,
    staleTime: 2000,
  });
}

export function useLiveGlobalStatus() {
  return useQuery({
    queryKey: ["live-global-status"],
    queryFn: () => api.get<{ enabled: boolean }>("/live/global-status/").then((r) => r.data),
    refetchInterval: 5000,
    staleTime: 2000,
  });
}

export function useLiveGlobalToggle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch<{ enabled: boolean }>("/live/global-status/", { enabled }).then((r) => r.data),
    onSuccess: (d) => {
      qc.setQueryData(["live-global-status"], d);
      qc.invalidateQueries({ queryKey: ["live-now"] });
    },
  });
}

export interface LiveOperatorOption {
  id: number;
  full_name: string;
}

/** Same key/queryFn as the old archive page; `select` tolerates a paginated reply. */
export function useLiveOperatorOptions() {
  return useQuery({
    queryKey: ["operators", "simple"],
    queryFn: () => api.get("/operators/").then((r) => r.data),
    staleTime: 5 * 60_000,
    select: (d: unknown): LiveOperatorOption[] => {
      const arr = Array.isArray(d) ? d : ((d as { results?: unknown[] })?.results ?? []);
      return (arr as LiveOperatorOption[]).filter((o) => o && typeof o.id === "number");
    },
  });
}

export function useLiveRecordings(p: { operatorId: number | null; dateFrom: string; dateTo: string }) {
  return useQuery({
    queryKey: ["live-recordings", p.operatorId, p.dateFrom, p.dateTo],
    queryFn: () =>
      fetchRecordings({
        operator_id: p.operatorId,
        date_from: p.dateFrom || null,
        date_to: p.dateTo || null,
        page_size: 100,
      }),
  });
}
