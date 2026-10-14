import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, API_BASE_URL } from "../../lib/api";
import { tgRevoke, tgStatus, TG_STATUS_KEY } from "../../lib/tgUserclient";

/**
 * Data hooks for the personal / operator-facing v2 pages:
 * MyPayroll, MyDayOff, Leaderboard, Calculator, Profile, Notifications,
 * LessonToday, LessonsHistory, Training, TrainingLesson, Catalog, Login, Scan.
 * Query keys match the old pages so cache and invalidation are shared.
 */

/* ------------------------------------------------------------------ */
/* Tashkent-time helpers (the business runs on Asia/Tashkent, UTC+5)  */
/* ------------------------------------------------------------------ */

export const TZ = "Asia/Tashkent";

/** «YYYY-MM-DD» for today in Tashkent, optionally shifted by `addDays`. */
export function tashkentISO(addDays = 0): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  if (!addDays) return today;
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + addDays));
  return dt.toISOString().slice(0, 10);
}

/** «YYYY-MM» of the current month in Tashkent. */
export function tashkentMonth(): string {
  return tashkentISO().slice(0, 7);
}

/** «HH:MM» of an ISO timestamp, in Tashkent time. */
export function tashkentHM(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

/** «YYYY-MM-DD» of an ISO timestamp, in Tashkent time. */
export function tashkentDateOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** Formats a calendar date «YYYY-MM-DD» without any timezone shift. */
export function fmtCalendarDate(ymd: string, lang: "ru" | "uz", opts: Intl.DateTimeFormatOptions): string {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat(lang === "uz" ? "uz-Latn-UZ" : "ru-RU", { ...opts, timeZone: "UTC" }).format(dt);
}

/* ------------------------------------------------------------------ */
/* /my/payroll                                                         */
/* ------------------------------------------------------------------ */

export type PayrollDay = {
  date: string;
  weekday: number;
  is_working_day: boolean;
  checked_in_at: string | null;
  checked_out_at: string | null;
  status: "on_time" | "late" | "absent" | "weekend" | "free_absence";
  minutes_late: number;
  deduction_uzs: string;
  note: string;
};

export type MyPayrollResponse = {
  operator_id: number;
  operator_name: string;
  year: number;
  month: number;
  attendance_bonus_uzs: string;
  sales_bonus_uzs: string;
  attendance_gate_pct: number;
  sales_gate_pct: number;
  shift_start: string;
  shift_end: string;
  grace_period_min: number;
  attendance: {
    working_days_planned: number;
    days_attended: number;
    days_absent: number;
    days_late: number;
    avg_late_minutes: number;
    rate_pct: number;
    gate_passed: boolean;
    late_penalty_per_event: string;
    late_penalty_total: string;
    block_earned: string;
    shortfall: { days_more_needed: number; explanation: string };
    days: PayrollDay[];
  };
  sales: {
    plan_amount_uzs: string;
    plan_source: string;
    actual_uzs: string;
    rate_pct: number;
    gate_passed: boolean;
    block_earned: string;
    shortfall: { amount_more_needed: string; explanation: string };
  };
  total_earned: string;
  max_possible: string;
  both_gates_passed?: boolean;
};

export function useMyPayroll(month: string) {
  return useQuery<MyPayrollResponse>({
    queryKey: ["my-payroll", month],
    queryFn: () => api.get<MyPayrollResponse>(`/attendance/my-payroll/?month=${month}`).then((r) => r.data),
  });
}

export async function downloadMyPayroll(month: string, format: "xlsx" | "pdf") {
  const res = await api.get(`/attendance/my-payroll/?month=${month}&export=${format}`, { responseType: "blob" });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `my_payroll_${month}.${format}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/* /my/day-off                                                         */
/* ------------------------------------------------------------------ */

export interface DayOffRow {
  id: number;
  operator_name: string;
  date: string;
  status: "pending" | "approved" | "rejected";
  reason: string;
  decision_note: string;
  decided_at: string | null;
  decided_by_name: string | null;
  created_at: string;
}

export function useMyDayOffs() {
  return useQuery<{ results: DayOffRow[]; count: number }>({
    queryKey: ["my-day-off"],
    queryFn: () => api.get("/me/day-off/").then((r) => r.data),
  });
}

export function useCreateDayOff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { date: string; reason: string }) => api.post("/operators/day-off/", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["my-day-off"] }),
  });
}

/* ------------------------------------------------------------------ */
/* /leaderboard                                                        */
/* ------------------------------------------------------------------ */

export type LbPeriod = "day" | "week" | "month" | "all";

export interface LbRow {
  operator_id: number;
  operator_name: string;
  is_trainee: boolean;
  total: number | string;
  count: number | string;
  avg_ticket: number | string;
}

export function useLeaderboard(period: LbPeriod, tick: number) {
  return useQuery<LbRow[]>({
    queryKey: ["leaderboard", period, tick],
    queryFn: () =>
      api
        .get<LbRow[]>("/analytics/leaderboard/", { params: period === "all" ? { limit: 0 } : { period, limit: 0 } })
        .then((r) => r.data),
    staleTime: 0,
  });
}

/** Same key as the old Leaderboard page — whose row to highlight. */
export function useLbMe() {
  return useQuery<{ operator_id: number | null; operator_name: string | null; display_name: string | null }>({
    queryKey: ["auth-me-lb"],
    queryFn: () => api.get("/auth/me/").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

/* ------------------------------------------------------------------ */
/* /calculator                                                         */
/* ------------------------------------------------------------------ */

export type CalcPhone = {
  id: number;
  brand: string;
  model_name: string;
  storage_gb: number | null;
  price: string;
  is_active: boolean;
};

export type CalcTierRow = {
  tier_id: number;
  months: number;
  commission_pct: string;
  ariza_narxi: string;
  komissiya_sum: string;
  total: string;
  sum_per_month: string;
  show_in_marketing: boolean;
};

export type CalcResponse = {
  amount: string;
  down_payment: string;
  ariza: string;
  tiers: CalcTierRow[];
  phone?: { id: number; brand: string; model_name: string; price: string };
};

export function useCalcPhones(search: string) {
  return useQuery({
    queryKey: ["calc-phones", search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      params.set("only_active", "1");
      const r = await api.get<{ results?: CalcPhone[] } | CalcPhone[]>(`/catalog/phones/?${params}`);
      const d = r.data as { results?: CalcPhone[] } | CalcPhone[];
      return (Array.isArray(d) ? d : d.results || []) as CalcPhone[];
    },
    staleTime: 15_000,
  });
}

export function useCalculate(amount: string, down: string, phoneId: number | null, enabled = true) {
  return useQuery({
    queryKey: ["calculator", amount, down, phoneId],
    queryFn: () =>
      api
        .post<CalcResponse>("/catalog/calculate/", {
          amount: amount || "0",
          down_payment: down || "0",
          phone_id: phoneId ?? undefined,
        })
        .then((r) => r.data),
    enabled,
  });
}

export type InstallmentRow = {
  bank: string;
  bank_icon: string;
  term_months: number;
  monthly: string;
  total: string;
  overpay: string;
};

/** Same key as components/InstallmentPanel. */
export function usePhoneQuote(phoneId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: ["catalog-phone-quote", phoneId],
    queryFn: () =>
      api
        .get<{ text: string; cover_image_url: string | null; installments: InstallmentRow[] }>(`/catalog/phones/${phoneId}/quote/?lang=ru`)
        .then((r) => r.data),
    enabled: enabled && phoneId != null,
    staleTime: 60_000,
  });
}

/* ------------------------------------------------------------------ */
/* Profile                                                              */
/* ------------------------------------------------------------------ */

export type ProfileMe = {
  username: string;
  role: string;
  is_superuser: boolean;
  operator_id: number | null;
  operator_name: string | null;
  display_name?: string | null;
  telegram_user_id: number | null;
  birth_date: string | null;
  is_birthday_today: boolean;
  avatar_url?: string | null;
};

/** Same key as the old Profile page (["me"]); useMe() uses ["auth","me"]. */
export function useProfileMe() {
  return useQuery<ProfileMe>({
    queryKey: ["me"],
    queryFn: () => api.get("/auth/me/").then((r) => r.data),
  });
}

/** Re-fetch both /auth/me caches (Profile ["me"] + useMe ["auth","me"]). */
export function useInvalidateMe() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["me"] });
    qc.invalidateQueries({ queryKey: ["auth", "me"] });
  };
}

export type MySticker = { sticker: { emoji: string; is_rare: boolean } | null };

export function useMySticker(enabled: boolean) {
  return useQuery<MySticker>({
    queryKey: ["me", "sticker"],
    queryFn: () => api.get("/me/sticker/").then((r) => r.data),
    enabled,
  });
}

export type StickerPalette = {
  palette: string[];
  taken: { emoji: string; operator_name: string }[];
  rare: { emoji: string; operator_id: number; operator_name: string } | null;
};

export function useStickerPalette(enabled: boolean) {
  return useQuery<StickerPalette>({
    queryKey: ["stickers", "palette"],
    queryFn: () => api.get("/stickers/palette/").then((r) => r.data),
    enabled,
  });
}

function useStickerInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["stickers", "palette"] });
    qc.invalidateQueries({ queryKey: ["operators"] });
    qc.invalidateQueries({ queryKey: ["me", "sticker"] });
  };
}

export function useSetMySticker() {
  const inv = useStickerInvalidate();
  return useMutation({
    mutationFn: (emoji: string) => api.put("/me/sticker/", { emoji, is_rare: false }).then((r) => r.data),
    onSuccess: inv,
  });
}

export function useClearMySticker() {
  const inv = useStickerInvalidate();
  return useMutation({
    mutationFn: () => api.delete("/me/sticker/"),
    onSuccess: inv,
  });
}

export type MyPreferences = { daily_lesson_opt_out: boolean };

export function useMyPreferences(enabled: boolean) {
  return useQuery<MyPreferences>({
    queryKey: ["me", "preferences"],
    queryFn: () => api.get("/me/preferences/").then((r) => r.data),
    enabled,
  });
}

export function useUpdateDailyLesson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (nextEnabled: boolean) => api.patch("/me/preferences/", { daily_lesson_opt_out: !nextEnabled }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["me", "preferences"] }),
  });
}

export type MyAttendance = {
  open_log: { id: number; checked_in_at: string; was_late: boolean } | null;
};

export function useMyAttendance(enabled: boolean) {
  return useQuery<MyAttendance>({
    queryKey: ["me", "attendance"],
    queryFn: () => api.get<MyAttendance>("/attendance/me/current/").then((r) => r.data),
    enabled,
    refetchInterval: 60_000,
  });
}

export type AttToggleResult = { action: "check_in" | "check_out"; was_late?: boolean; duration_min?: number };

export function useAttendanceToggle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<AttToggleResult>("/attendance/me/toggle/").then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "attendance"] }),
  });
}

export function useTgUserStatus(enabled: boolean) {
  return useQuery({
    queryKey: TG_STATUS_KEY(),
    queryFn: () => tgStatus().then((r) => r.data),
    enabled,
  });
}

export function useTgUserRevoke() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: number) => tgRevoke(sessionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: TG_STATUS_KEY() }),
  });
}

export type TgLinkCode = { code: string; expires_at: string; bot_username: string };

export function useTgBotLinkCode() {
  return useMutation({
    mutationFn: () => api.post<TgLinkCode>("/me/telegram/link/").then((r) => r.data),
  });
}

export function useTgBotUnlink() {
  const inv = useInvalidateMe();
  return useMutation({
    mutationFn: () => api.delete("/me/telegram/link/"),
    onSuccess: inv,
  });
}

export function useSaveBirthDate() {
  const inv = useInvalidateMe();
  return useMutation({
    mutationFn: (birthDate: string | null) => api.patch("/auth/me/", { birth_date: birthDate }).then((r) => r.data),
    onSuccess: inv,
  });
}

export function useUploadAvatar() {
  const qc = useQueryClient();
  const inv = useInvalidateMe();
  return useMutation({
    mutationFn: (file: Blob) => {
      const fd = new FormData();
      fd.append("avatar", file, file instanceof File ? file.name : `snapshot-${Date.now()}.jpg`);
      return api.post("/operators/me/avatar/", fd, { headers: { "Content-Type": "multipart/form-data" } });
    },
    onSuccess: () => {
      inv();
      qc.invalidateQueries({ queryKey: ["operators"] });
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (p: { old_password: string; new_password: string }) => api.post("/me/change-password/", p),
  });
}

export type PinStatus = {
  role: string;
  has_pin: boolean;
  pin_required: boolean;
  pin_verified: boolean;
  expires_at: string | null;
  ttl_minutes: number;
};

/** Same key/endpoint as PinGate. */
export function usePinStatus(enabled: boolean) {
  return useQuery<PinStatus>({
    queryKey: ["attendance-pin-status"],
    queryFn: () => api.get<PinStatus>("/attendance/pin/status/").then((r) => r.data),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
}

/* ------------------------------------------------------------------ */
/* Notifications                                                        */
/* ------------------------------------------------------------------ */

export interface NotificationRow {
  id: number;
  kind: string;
  title: string;
  body: string;
  link: string;
  read_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface NotifResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: NotificationRow[];
  unread_count: number;
}

/** Page 1 shares the old page's key ["notifications","list"]. */
export function useNotificationsPage(page: number) {
  return useQuery<NotifResponse>({
    queryKey: page === 1 ? ["notifications", "list"] : ["notifications", "list", "page", page],
    queryFn: () =>
      api.get<NotifResponse>("/notifications/", { params: page === 1 ? undefined : { page } }).then((r) => r.data),
    refetchInterval: page === 1 ? 30_000 : undefined,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post("/notifications/mark-read/", { ids: [id] }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/notifications/mark-all-read/"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export type NotifPref = { kind: string; in_app: boolean; telegram: boolean };

function httpStatus(e: unknown): number | undefined {
  return (e as { response?: { status?: number } })?.response?.status;
}

/** New endpoint (BACKEND_V2 §2). 404 on older backends → caller hides the block. */
export function useNotificationPreferences() {
  return useQuery<{ items: NotifPref[] }>({
    queryKey: ["notification-preferences"],
    queryFn: () => api.get<{ items: NotifPref[] }>("/notifications/preferences/").then((r) => r.data),
    retry: (n, e) => httpStatus(e) !== 404 && httpStatus(e) !== 405 && n < 1,
    staleTime: 60_000,
  });
}

export function useUpdateNotificationPreference() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (item: Partial<NotifPref> & { kind: string }) =>
      api.patch<{ items: NotifPref[] }>("/notifications/preferences/", { items: [item] }).then((r) => r.data),
    onMutate: async (item) => {
      await qc.cancelQueries({ queryKey: ["notification-preferences"] });
      const prev = qc.getQueryData<{ items: NotifPref[] }>(["notification-preferences"]);
      if (prev) {
        qc.setQueryData(["notification-preferences"], {
          items: prev.items.map((p) => (p.kind === item.kind ? { ...p, ...item } : p)),
        });
      }
      return { prev };
    },
    onError: (_e, _item, ctx) => {
      if (ctx?.prev) qc.setQueryData(["notification-preferences"], ctx.prev);
    },
    onSuccess: (data) => {
      if (data?.items) qc.setQueryData(["notification-preferences"], data);
    },
  });
}

/** Same key as SalesPending page — used to offer «Одобрить» only for still-pending sales. */
export function usePendingSaleIds(enabled: boolean) {
  return useQuery<{ results: { id: number }[]; count: number }>({
    queryKey: ["sales-pending"],
    queryFn: () => api.get("/sales/pending/").then((r) => r.data),
    enabled,
  });
}

/** Same call + invalidations as SaleDetail's approve. */
export function useApproveSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (saleId: number) => api.post(`/sales/${saleId}/confirm/`),
    onSuccess: (_d, saleId) => {
      qc.invalidateQueries({ queryKey: ["sale", String(saleId)] });
      qc.invalidateQueries({ queryKey: ["sales-pending"] });
      qc.invalidateQueries({ queryKey: ["sales-pending-count"] });
      qc.invalidateQueries({ queryKey: ["sales"] });
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Daily lessons (AI-разбор) — same keys as pages/DailyLesson.tsx and  */
/*  pages/LessonsHistory.tsx                                           */
/* ------------------------------------------------------------------ */

export interface LessonHighlight { title: string; evidence: string }
export interface LessonBlocker { title: string; why: string; example: string }
export interface LessonPracticeStep { step: string; when: string; how: string }
export interface LessonMainInsight { title: string; text: string }

export interface LessonContentV2 {
  greeting_line: string;
  yesterday_summary: string;
  main_insight: LessonMainInsight;
  highlights: LessonHighlight[];
  blockers: LessonBlocker[];
  practice_today: LessonPracticeStep[];
  micro_lesson: string;
  closing_line: string;
}

export interface LessonLegacyTip { title: string; why: string; example: string; action: string }

export interface LessonFeedback {
  id: number;
  rating: "helpful" | "not_helpful";
  comment: string;
}

export interface LessonStats {
  sales_count: number;
  revenue_uzs: number;
  avg_check?: number;
  dialogs_count: number;
  avg_quality: number;
  callbacks_missed?: number;
  leads_won?: number;
  leads_lost?: number;
  month_progress_pct: number;
}

export interface DailyLessonData {
  id: number;
  lesson_date: string;
  language: "ru" | "uz";
  content: LessonContentV2 | Record<string, never>;
  summary: string;
  highlights: LessonHighlight[];
  tips: LessonLegacyTip[];
  micro_lesson: string;
  opened_at?: string | null;
  feedback?: LessonFeedback | null;
  stats_snapshot: LessonStats;
}

export interface LessonHistoryItem {
  id: number;
  lesson_date: string;
  summary: string;
  micro_lesson: string;
  language?: "ru" | "uz";
  opened_at: string | null;
}

/** v2 lessons carry any of these keys in `content`; older rows fall back to flat fields. */
export function lessonContentV2(c: DailyLessonData["content"] | undefined | null): LessonContentV2 | null {
  if (!c || typeof c !== "object") return null;
  const keys = ["greeting_line", "yesterday_summary", "main_insight", "blockers", "practice_today", "closing_line"];
  return keys.some((k) => k in (c as Record<string, unknown>)) ? (c as LessonContentV2) : null;
}

/** 4xx is a final answer (no lesson, no operator link) — don't keep the skeleton up retrying. */
function retryUnless4xx(n: number, e: unknown) {
  const st = (e as { response?: { status?: number } })?.response?.status;
  return !(st && st >= 400 && st < 500) && n < 2;
}

/** GET /lessons/today/ (marks the lesson as opened on the server). */
export function useTodayLesson() {
  const qc = useQueryClient();
  return useQuery<DailyLessonData>({
    queryKey: ["lessons", "today"],
    queryFn: async () => {
      const r = await api.get<DailyLessonData>("/lessons/today/");
      // the GET above marks it opened — refresh the menu badge (peek query)
      qc.invalidateQueries({ queryKey: ["lessons", "today", "peek"], exact: true });
      return r.data;
    },
    retry: false,
  });
}

export function useLessonFeedback(onSaved?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { rating: "helpful" | "not_helpful"; comment?: string }) =>
      api.post("/lessons/today/feedback/", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lessons", "today"] });
      onSaved?.();
    },
  });
}

export function useLessonsHistory(operatorId: string) {
  return useQuery<LessonHistoryItem[]>({
    queryKey: ["lessons", "history", operatorId],
    queryFn: () => {
      const url = operatorId ? `/lessons/history/?operator=${operatorId}` : "/lessons/history/";
      return api.get<LessonHistoryItem[]>(url).then((r) => r.data);
    },
    retry: retryUnless4xx,
  });
}

export function useLessonDetail(operatorId: string, date: string | null) {
  return useQuery<DailyLessonData>({
    queryKey: ["lessons", "detail", operatorId, date],
    queryFn: () => {
      const params = new URLSearchParams({ date: date! });
      if (operatorId) params.set("operator", operatorId);
      return api.get<DailyLessonData>(`/lessons/?${params.toString()}`).then((r) => r.data);
    },
    enabled: !!date,
    retry: retryUnless4xx,
  });
}

/* ------------------------------------------------------------------ */
/*  Training (курсы) — same keys as TrainingList / TrainingLessonView   */
/* ------------------------------------------------------------------ */

export interface TrainingRow {
  id: number;
  title: string;
  description: string;
  has_video: boolean;
  has_file: boolean;
  has_media: boolean;
  questions_count: number;
  comments_count: number;
  created_at: string;
  attempt_completed: boolean;
  score_pct: number | null;
}

export interface TrainingAnswer { id: number; text: string; order: number }
export interface TrainingQuestion { id: number; text: string; order: number; answers: TrainingAnswer[] }
export interface TrainingAttempt {
  completed_at: string;
  score_pct: number;
  per_question: { question_id: number; chosen_answer_id: number | null; is_correct: boolean }[];
}
export interface TrainingLessonDetail {
  id: number;
  title: string;
  description: string;
  video_url: string;
  file_url: string;
  file_name: string;
  created_at: string;
  questions: TrainingQuestion[];
  attempt: TrainingAttempt | null;
}
export interface TrainingComment {
  id: number;
  operator_id: number;
  operator_name: string;
  text: string;
  created_at: string;
}
/** POST submit response: the correct answer is only revealed here. */
export interface TrainingSubmitResult {
  score_pct: number;
  completed_at: string | null;
  per_question: { question_id: number; correct: boolean; correct_answer_id: number | null }[];
}

export function useTrainingList() {
  return useQuery<TrainingRow[]>({
    queryKey: ["training-my-list"],
    queryFn: () => api.get("/training/my-lessons/").then((r) => r.data),
  });
}

export function useTrainingLesson(id: string | undefined) {
  return useQuery<TrainingLessonDetail>({
    queryKey: ["training-my", id],
    queryFn: () => api.get(`/training/my-lessons/${id}/`).then((r) => r.data),
    enabled: !!id,
    // a hidden/missing lesson is a final answer — show «not found» right away
    retry: (n, e) => (e as { response?: { status?: number } })?.response?.status !== 404 && n < 2,
  });
}

export function useTrainingComments(id: string | undefined) {
  return useQuery<TrainingComment[]>({
    queryKey: ["training-comments", id],
    queryFn: () => api.get(`/training/my-lessons/${id}/comments/`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useTrainingSubmit(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (choices: Record<number, number>) =>
      api.post<TrainingSubmitResult>(`/training/my-lessons/${id}/submit/`, { choices }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["training-my", id] });
      qc.invalidateQueries({ queryKey: ["training-my-list"] });
    },
  });
}

export function useTrainingAddComment(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => api.post(`/training/my-lessons/${id}/comments/`, { text }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["training-comments", id] }),
  });
}

/** /media/... → absolute URL next to the API origin (same as the old page). */
export function trainingMediaUrl(pathOrUrl: string): string {
  if (!pathOrUrl) return "";
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  const origin = API_BASE_URL.replace(/\/api\/?$/, "");
  return `${origin}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

export function youTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.replace(/^\//, "").split("/")[0] || null;
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const parts = u.pathname.split("/").filter(Boolean);
      const i = parts.indexOf("embed");
      if (i >= 0 && parts[i + 1]) return parts[i + 1];
    }
    return null;
  } catch {
    return null;
  }
}

export function isDirectVideo(url: string): boolean {
  return /\.(mp4|webm|ogg|mov|m4v)($|\?)/i.test(url);
}

/* ───────────────────────── Catalog (/catalog) ───────────────────────── */

export type StockStatus = "available" | "on_order" | "out";

export type CatalogPhoneColor = {
  id?: number;
  name: string;
  hex_code: string;
  price_override: string | null;
  is_available: boolean;
  sort_order: number;
};

export type CatalogGalleryPhoto = {
  id: number;
  position: number;
  photo_url: string;
  uploaded_at: string;
};

export type CatalogPhone = {
  id: number;
  brand: string;
  model_name: string;
  storage_gb: number | null;
  ram_gb: number | null;
  price: string;
  cover_image_url: string | null;
  description: string;
  tagline: string;
  camera_mp: number | null;
  battery_mah: number | null;
  specs_json: Record<string, string>;
  stock_status: StockStatus;
  is_active: boolean;
  sort_order: number;
  colors: CatalogPhoneColor[];
  gallery: CatalogGalleryPhoto[];
  marketing_text_uz?: string;
  installment_preview?: { months: number; monthly: number }[];
};

/** Editor state — same shape as the old PhoneEditor's PhoneDraft. */
export type CatalogPhoneDraft = {
  brand: string;
  model_name: string;
  storage_gb: number | null;
  ram_gb: number | null;
  price: string;
  description: string;
  tagline: string;
  camera_mp: number | null;
  battery_mah: number | null;
  specs_json: Record<string, string>;
  stock_status: StockStatus;
  is_active: boolean;
  sort_order: number;
  colors: CatalogPhoneColor[];
  gallery: CatalogGalleryPhoto[];
  new_gallery_files: File[];
  gallery_delete_ids?: number[];
  cover_image_file: File | null;
  cover_image_url: string | null;
};

/** Same query key and request as the old Catalog page. */
export function useCatalogPhones(search: string, stock: "" | StockStatus) {
  return useQuery({
    queryKey: ["catalog-phones", search, stock],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (stock) params.set("stock", stock);
      return api.get<{ results?: CatalogPhone[] } | CatalogPhone[]>(`/catalog/phones/?${params}`).then((r) => {
        const d = r.data as { results?: CatalogPhone[] } | CatalogPhone[];
        return (Array.isArray(d) ? d : d.results || []) as CatalogPhone[];
      });
    },
  });
}

export function useSaveCatalogPhone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (draft: CatalogPhoneDraft & { id?: number }) => {
      const body = {
        brand: draft.brand,
        model_name: draft.model_name,
        storage_gb: draft.storage_gb || null,
        ram_gb: draft.ram_gb || null,
        price: draft.price,
        description: draft.description,
        tagline: draft.tagline || "",
        camera_mp: draft.camera_mp || null,
        battery_mah: draft.battery_mah || null,
        specs_json: draft.specs_json || {},
        stock_status: draft.stock_status,
        is_active: draft.is_active,
        sort_order: draft.sort_order,
        colors: draft.colors.map((c) => ({
          name: c.name,
          hex_code: c.hex_code,
          price_override: c.price_override || null,
          is_available: c.is_available,
          sort_order: c.sort_order,
        })),
      };
      const resp = draft.id ? await api.patch(`/catalog/phones/${draft.id}/`, body) : await api.post(`/catalog/phones/`, body);
      const phoneId = (resp.data as { id?: number }).id;
      if (draft.cover_image_file && phoneId) {
        const fd = new FormData();
        fd.append("cover_image", draft.cover_image_file);
        await api.post(`/catalog/phones/${phoneId}/upload_photo/`, fd);
      }
      // Backend appends each upload to the tail of the gallery.
      if (draft.new_gallery_files.length > 0 && phoneId) {
        for (const f of draft.new_gallery_files) {
          const fd = new FormData();
          fd.append("photo", f);
          await api.post(`/catalog/phones/${phoneId}/gallery/upload/`, fd);
        }
      }
      if (draft.gallery_delete_ids && draft.gallery_delete_ids.length > 0 && phoneId) {
        for (const id of draft.gallery_delete_ids) {
          await api.delete(`/catalog/phones/${phoneId}/gallery/${id}/`);
        }
      }
      return resp;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog-phones"] }),
  });
}

export function useDeleteCatalogPhone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/catalog/phones/${id}/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog-phones"] }),
  });
}

export function useToggleCatalogPhone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) => api.patch(`/catalog/phones/${id}/`, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog-phones"] }),
  });
}

export function fetchPhoneQuote(id: number) {
  return api.get<{ text: string; cover_image_url: string | null }>(`/catalog/phones/${id}/quote/?lang=uz`).then((r) => r.data);
}

export function fetchPhoneMarketing(id: number) {
  return api.get<{ text: string }>(`/catalog/phones/${id}/marketing/?lang=uz`).then((r) => r.data);
}

/* ───────────────────────── Login (/login) ───────────────────────── */

export type LoginResponse = { token: string; username: string; role: string };

export function postLogin(username: string, password: string) {
  return api.post<LoginResponse>("/auth/login/", { username, password }).then((r) => r.data);
}

/* ───────────────────────── Scan (/scan?qr=) ───────────────────────── */

export type QrPreview = {
  operator: { id: number; full_name: string };
  on_shift: boolean;
  checked_in_at: string | null;
  expected_action: "check_in" | "check_out";
};

export type ScanResult = {
  action: "check_in" | "check_out";
  operator: { id: number; full_name: string };
  was_late?: boolean;
  checked_in_at?: string;
  checked_out_at?: string;
  duration_min?: number;
  token?: string;
  username?: string;
  role?: string;
  photo_url?: string;
};

export function fetchQrPreview(qr: string) {
  return api.get<QrPreview>(`/attendance/qr-preview/?qr=${encodeURIComponent(qr)}`).then((r) => r.data);
}

export function postScanWithPhoto(qr: string, file: File) {
  const fd = new FormData();
  fd.append("qr_payload", qr);
  fd.append("photo", file);
  return api
    .post<ScanResult>("/attendance/me/scan-with-photo/", fd, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 60_000,
    })
    .then((r) => r.data);
}
