import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { AlertTriangle, ChevronRight, Copy, Download, Eye, EyeOff, History, KeyRound, MessageCircle, Pencil, QrCode, RefreshCw, ShieldOff, ShieldCheck, Target, Trash2, UserPlus } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../store/auth";
import { normaliseRole } from "../components/RoleGate";
import AttendanceStatsCard from "../components/AttendanceStatsCard";
import { formatNumber, formatUZS } from "../lib/format";
import {
  buildPeriodParams,
  periodTitle,
  type MonthChoice,
  type Period,
} from "../lib/period";
import MonthPicker from "../components/MonthPicker";
import NumericInput from "../components/NumericInput";
import ProgressBar from "../components/ProgressBar";
import TgDialogsPanel from "../components/TgDialogsPanel";
import { StickerPicker } from "../components/StickerPicker";
import { Select } from "../components/Select";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Button,
  Chip,
  Eyebrow,
  Modal,
  PhoneInput,
  StatusBadge,
  TabPill,
  normalizeUzPhone,
  toast,
  type TabItem,
} from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

function usePeriodTabs(t: (k: string) => string): TabItem<Period>[] {
  return [
    { value: "day", label: t("op_detail.period_day") },
    { value: "week", label: t("op_detail.period_week") },
    { value: "month", label: t("op_detail.period_month") },
  ];
}

function statusLabel(t: (k: string) => string, status: string): string {
  if (status === "active") return t("op_detail.status_active");
  if (status === "trainee") return t("op_detail.status_trainee");
  if (status === "inactive") return t("op_detail.status_inactive");
  return status;
}

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || "?"
  );
}

function toneForStatus(s: string): "hot" | "neutral" {
  return s === "active" ? "hot" : "neutral";
}

interface AttendanceLog {
  id: number;
  checked_in_at: string;
  checked_out_at: string | null;
  duration_min: number | null;
  was_late: boolean;
  source: "qr" | "tg" | "manual";
  auto_closed: boolean;
  manually_closed?: boolean;
  manually_closed_by_name?: string;
  manual_close_note?: string;
}

interface AccountState {
  has_account: boolean;
  is_active: boolean;
  deleted: boolean;
  username: string | null;
}

interface OperatorDetail {
  id: number;
  full_name: string;
  phone: string;
  personal_phone: string;
  status: string;
  hired_at: string | null;
  note?: string;
  account: AccountState;
}

type OperatorStatusChoice = "active" | "trainee" | "inactive";

interface Lesson {
  id: number;
  lesson_date: string;
  micro_lesson: string;
  summary: string;
  opened_at: string | null;
}

export default function OperatorDetail() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const role = useAuth((s) => s.role);
  const isManager = normaliseRole(role) === "manager";
  const PERIOD_TABS = usePeriodTabs(t);

  const [period, setPeriod] = useState<Period>("month");
  const [choice, setChoice] = useState<MonthChoice>({ kind: "all" });
  const [editPlan, setEditPlan] = useState(false);
  const [planInput, setPlanInput] = useState("");
  const [selectedLessonDate, setSelectedLessonDate] = useState<string | null>(null);
  const [closingLog, setClosingLog] = useState<{ id: number; name: string } | null>(null);
  const [closeNote, setCloseNote] = useState("");
  const [credsModal, setCredsModal] = useState<{
    kind: "created" | "reset" | "view";
    username: string;
    password: string;
  } | null>(null);
  const [confirmDeleteAcc, setConfirmDeleteAcc] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrVer, setQrVer] = useState(0); // cache-buster on rotate
  const [editPhones, setEditPhones] = useState(false);
  const [phoneWork, setPhoneWork] = useState("");
  const [phonePersonal, setPhonePersonal] = useState("");
  const [stickerOpen, setStickerOpen] = useState(false);
  const [editProfile, setEditProfile] = useState(false);
  const [profileForm, setProfileForm] = useState<{
    full_name: string;
    hired_at: string;
    status: OperatorStatusChoice;
    note: string;
  }>({ full_name: "", hired_at: "", status: "active", note: "" });

  const isSpecific = choice.kind !== "current";
  const params = buildPeriodParams(period, choice);
  const paramKey = JSON.stringify(params);
  const title = periodTitle(period, choice);
  const titleLower = title.toLowerCase();

  const today = new Date();
  const planYear = choice.kind === "specific" ? choice.year : today.getFullYear();
  const planMonth = choice.kind === "specific" ? choice.month : today.getMonth() + 1;

  const stats = useQuery({
    queryKey: ["operator-stats", id, paramKey],
    queryFn: () =>
      api.get(`/operators/${id}/stats/`, { params }).then((r) => r.data),
    enabled: !!id,
  });

  const detail = useQuery<OperatorDetail>({
    queryKey: ["operator-detail", id],
    queryFn: () =>
      api.get<OperatorDetail>(`/operators/${id}/`).then((r) => r.data),
    enabled: !!id,
  });
  const stickerQ = useQuery<{ sticker: { emoji: string; is_rare: boolean } | null }>({
    queryKey: ["operator-sticker", id],
    queryFn: () =>
      api.get(`/operators/${id}/sticker/`).then((r) => r.data),
    enabled: !!id && isManager,
  });
  const account: AccountState = detail.data?.account ?? {
    has_account: false,
    is_active: false,
    deleted: false,
    username: null,
  };

  const invalidateAccount = () =>
    qc.invalidateQueries({ queryKey: ["operator-detail", id] });

  type CredsResponse = { username: string; password: string };

  const createAccountMut = useMutation({
    mutationFn: () =>
      api
        .post<CredsResponse>(`/operators/${id}/account/`, {})
        .then((r) => r.data),
    onSuccess: (data) => {
      invalidateAccount();
      setCredsModal({
        kind: "created",
        username: data.username,
        password: data.password,
      });
      toast.success(t("op_detail.account_created"));
    },
    onError: () => toast.error(t("op_detail.account_create_failed")),
  });

  const resetPasswordMut = useMutation({
    mutationFn: () =>
      api
        .post<CredsResponse>(`/operators/${id}/account/reset-password/`, {})
        .then((r) => r.data),
    onSuccess: (data) => {
      invalidateAccount();
      setCredsModal({
        kind: "reset",
        username: data.username,
        password: data.password,
      });
      toast.success(t("op_detail.password_regenerated"));
    },
    onError: () => toast.error(t("op_detail.password_reset_failed")),
  });

  const viewPasswordMut = useMutation({
    mutationFn: () =>
      api
        .get<CredsResponse>(`/operators/${id}/account/password/`)
        .then((r) => r.data),
    onSuccess: (data) => {
      setCredsModal({
        kind: "view",
        username: data.username,
        password: data.password,
      });
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg || t("op_detail.password_fetch_failed"));
    },
  });

  const toggleActiveMut = useMutation({
    mutationFn: () => {
      const url = account.is_active
        ? `/operators/${id}/account/deactivate/`
        : `/operators/${id}/account/activate/`;
      return api.post(url);
    },
    onSuccess: () => {
      invalidateAccount();
      toast.success(account.is_active ? t("op_detail.account_deactivated") : t("op_detail.account_activated"));
    },
    onError: () => toast.error(t("op_detail.account_status_failed")),
  });

  const deleteAccountMut = useMutation({
    mutationFn: () => api.post(`/operators/${id}/account/delete/`),
    onSuccess: () => {
      invalidateAccount();
      setConfirmDeleteAcc(false);
      toast.success(t("op_detail.account_deleted"));
    },
    onError: () => toast.error(t("op_detail.account_delete_failed")),
  });

  const savePhonesMut = useMutation({
    mutationFn: (payload: { phone: string; personal_phone: string }) =>
      api.patch(`/operators/${id}/`, payload),
    onSuccess: () => {
      invalidateAccount();
      qc.invalidateQueries({ queryKey: ["operator-stats", id] });
      setEditPhones(false);
      toast.success(t("op_detail.phones_updated"));
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { detail?: string; phone?: string[] } } })
          ?.response?.data?.detail ||
        (err as { response?: { data?: { phone?: string[] } } })
          ?.response?.data?.phone?.[0] ||
        t("common.save_failed");
      toast.error(msg);
    },
  });

  const openEditPhones = () => {
    setPhoneWork(detail.data?.phone ?? "");
    setPhonePersonal(detail.data?.personal_phone ?? "");
    setEditPhones(true);
  };

  const saveProfileMut = useMutation({
    mutationFn: (payload: {
      full_name: string;
      hired_at: string | null;
      status: OperatorStatusChoice;
      note: string;
    }) => api.patch(`/operators/${id}/`, payload),
    onSuccess: () => {
      invalidateAccount();
      qc.invalidateQueries({ queryKey: ["operator-stats", id] });
      qc.invalidateQueries({ queryKey: ["operators"] });
      setEditProfile(false);
      toast.success(t("op_edit.saved"));
    },
    onError: (err: unknown) => {
      const data = (err as { response?: { data?: Record<string, unknown> } })?.response?.data;
      const detailMsg = typeof data?.detail === "string" ? (data.detail as string) : undefined;
      const firstFieldErr = (() => {
        if (!data) return undefined;
        for (const v of Object.values(data)) {
          if (Array.isArray(v) && typeof v[0] === "string") return v[0] as string;
        }
        return undefined;
      })();
      toast.error(detailMsg || firstFieldErr || t("op_edit.save_failed"));
    },
  });

  const openEditProfile = () => {
    const d = detail.data;
    const s = stats.data;
    const status = (d?.status || s?.operator?.status || "active") as OperatorStatusChoice;
    setProfileForm({
      full_name: d?.full_name || s?.operator?.full_name || "",
      hired_at: (d?.hired_at || s?.operator?.hired_at || "").slice(0, 10),
      status,
      note: d?.note || "",
    });
    setEditProfile(true);
  };

  const rotateQrMut = useMutation({
    mutationFn: () => api.post(`/attendance/operators/${id}/qr/rotate/`),
    onSuccess: () => {
      setQrVer((v) => v + 1);
      qrPngQ.refetch();
      toast.success(t("op_detail.qr_rotated_msg"));
    },
    onError: () => toast.error(t("op_detail.qr_rotate_failed")),
  });

  const qrPngQ = useQuery({
    queryKey: ["operator-qr-png", id, qrVer],
    queryFn: async () => {
      const r = await api.get<Blob>(`/attendance/operators/${id}/qr.png`, {
        responseType: "blob",
      });
      return URL.createObjectURL(r.data);
    },
    enabled: !!id && qrOpen,
    staleTime: Infinity,
  });

  const planQuery = useQuery({
    queryKey: ["operator-plan", id, planYear, planMonth],
    queryFn: () =>
      api
        .get(`/operators/${id}/plan/`, { params: { year: planYear, month: planMonth } })
        .then((r) => r.data),
    enabled: !!id,
  });

  const dateFrom30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const dateToToday = new Date().toISOString().split("T")[0];

  const attendanceReportQ = useQuery({
    queryKey: ["operator-attendance-report", id],
    queryFn: () =>
      api
        .get(
          `/attendance/report/?date_from=${dateFrom30}&date_to=${dateToToday}&operator=${id}`,
        )
        .then((r) => r.data),
    enabled: !!id && isManager,
  });

  const attendanceLogsQ = useQuery<AttendanceLog[]>({
    queryKey: ["operator-attendance-logs", id],
    queryFn: () =>
      api.get(`/attendance/operators/${id}/logs/`).then((r) => r.data),
    enabled: !!id && isManager,
  });

  const lessonsQ = useQuery<Lesson[]>({
    queryKey: ["operator-lessons", id],
    queryFn: () =>
      api
        .get<Lesson[]>(`/lessons/history/?operator=${id}&limit=7`)
        .then((r) => r.data),
    enabled: isManager,
  });

  const lessonDetailQ = useQuery({
    queryKey: ["operator-lesson-detail", id, selectedLessonDate],
    queryFn: () =>
      api
        .get(`/lessons/?operator=${id}&date=${selectedLessonDate}`)
        .then((r) => r.data),
    enabled: !!selectedLessonDate,
  });

  const setPlanMut = useMutation({
    mutationFn: (target_amount: string) =>
      api.put(`/operators/${id}/plan/`, {
        target_amount,
        year: planYear,
        month: planMonth,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operator-plan", id, planYear, planMonth] });
      setEditPlan(false);
      toast.success(t("op_detail.plan_updated"));
    },
    onError: () => toast.error(t("op_detail.plan_save_failed")),
  });

  const handleCloseSubmit = async () => {
    if (!closingLog) return;
    try {
      await api.post(`/attendance/logs/${closingLog.id}/close/`, { note: closeNote });
      toast.success(t("op_detail.shift_closed"));
      setClosingLog(null);
      setCloseNote("");
      attendanceLogsQ.refetch();
      attendanceReportQ.refetch();
    } catch {
      toast.error(t("op_detail.shift_close_failed"));
    }
  };

  const s = stats.data;

  const headerTitle = s?.operator?.full_name || t("op_detail.default_name");
  const headerSubtitle = [
    s?.operator?.phone,
    s?.operator?.hired_at
      ? `${t("profile.joined")} ${new Date(s.operator.hired_at).toLocaleDateString()}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  usePageHeader(
    { title: headerTitle, subtitle: headerSubtitle, back: "/operators" },
    [headerTitle, headerSubtitle],
  );

  const avg = useMemo(() => {
    const total = Number(s?.totals?.total || 0);
    const count = Number(s?.totals?.count || 0);
    return count > 0 ? total / count : 0;
  }, [s?.totals?.total, s?.totals?.count]);

  if (!id) return null;

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* --- HERO --- */}
      <section
        className="nf-card animate-nfFadeUp"
        style={{ padding: "24px 28px" }}
      >
        <div className="flex flex-wrap items-start gap-5">
          <div
            className="grid place-items-center text-white font-semibold text-[18px] shrink-0"
            style={{
              width: 52,
              height: 52,
              borderRadius: 16,
              background: "var(--accent-grad)",
            }}
          >
            {initials(s?.operator?.full_name || "?")}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <div
                className="font-semibold tracking-tight"
                style={{ fontSize: 19, letterSpacing: "-0.02em" }}
              >
                {s?.operator?.full_name || t("op_detail.default_name")}
              </div>
              {isManager && (
                <button
                  type="button"
                  onClick={openEditProfile}
                  className="inline-grid place-items-center rounded-lg text-muted hover:text-text hover:bg-[var(--faint)] transition"
                  style={{ width: 26, height: 26 }}
                  title={t("op_edit.title")}
                  aria-label={t("op_edit.title")}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
              {s?.operator?.status && (
                <StatusBadge tone={toneForStatus(s.operator.status)}>
                  {statusLabel(t, s.operator.status)}
                </StatusBadge>
              )}
            </div>
            <div className="text-[13px] mt-1 flex items-center gap-2 flex-wrap">
              {detail.data?.phone ? (
                <span className="text-muted">
                  <span className="text-[11px] uppercase font-semibold mr-1" style={{ letterSpacing: ".05em" }}>
                    {t("op_detail.phone_work")}:
                  </span>
                  <span className="font-mono text-text">{detail.data.phone}</span>
                </span>
              ) : (
                <button
                  onClick={openEditPhones}
                  className="nf-btn"
                  style={{
                    padding: "4px 12px",
                    fontSize: 12,
                    background: "rgba(242,86,11,.12)",
                    color: "var(--accent)",
                  }}
                >
                  {t("op_detail.add_work_phone")}
                </button>
              )}
              {detail.data?.personal_phone && (
                <span className="text-muted">
                  ·{" "}
                  <span className="text-[11px] uppercase font-semibold mr-1" style={{ letterSpacing: ".05em" }}>
                    {t("op_detail.phone_personal")}:
                  </span>
                  <span className="font-mono text-text">{detail.data.personal_phone}</span>
                </span>
              )}
              {isManager && detail.data?.phone && (
                <button
                  onClick={openEditPhones}
                  className="text-[12px] text-muted hover:text-text transition underline underline-offset-2"
                >
                  {t("op_detail.edit_lower")}
                </button>
              )}
              {s?.operator?.hired_at && (
                <span className="text-muted">
                  · {t("op_detail.since", { date: new Date(s.operator.hired_at).toLocaleDateString() })}
                </span>
              )}
            </div>
            {(planQuery.data?.achievements?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {planQuery.data.achievements.map(
                  (b: { slug: string; emoji: string; label: string }) => (
                    <span
                      key={b.slug}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11.5px] font-semibold"
                      style={{
                        background: "rgba(242,86,11,.12)",
                        color: "var(--accent)",
                      }}
                    >
                      {b.emoji} {b.label}
                    </span>
                  ),
                )}
              </div>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            {isManager && (
              <>
                <Button onClick={() => setStickerOpen(true)}>
                  {stickerQ.data?.sticker?.emoji
                    ? `${stickerQ.data.sticker.emoji}  ${t("common.edit")}`
                    : t("op_detail.assign_sticker")}
                </Button>
                <Button variant="secondary" onClick={() => setQrOpen(true)}>
                  <QrCode className="w-3.5 h-3.5" /> {t("op_detail.login_qr")}
                </Button>
              </>
            )}
            <Button variant="ghost">
              <MessageCircle className="w-3.5 h-3.5" /> {t("op_detail.telegram")}
            </Button>
          </div>
        </div>

        {/* 3 stat tiles */}
        <div
          className="mt-5 grid gap-[13px]"
          style={{ gridTemplateColumns: "repeat(3, 1fr)" }}
        >
          <div className="nf-tile" style={{ padding: "16px 18px" }}>
            <div className="text-[12px] text-muted">{t("op_detail.sum_period", { period: titleLower })}</div>
            <div
              className="mt-1 font-semibold tabular-nums"
              style={{ fontSize: 24, letterSpacing: "-0.025em" }}
            >
              {formatUZS(s?.totals?.total || 0)}
            </div>
            <div className="text-[11.5px] text-muted mt-1 tabular-nums">
              {t("op_detail.sales_count", { n: formatNumber(s?.totals?.count || 0) })}
            </div>
          </div>
          <div className="nf-tile" style={{ padding: "16px 18px" }}>
            <div className="text-[12px] text-muted">{t("op_detail.kpi_avg")}</div>
            <div
              className="mt-1 font-semibold tabular-nums"
              style={{ fontSize: 24, letterSpacing: "-0.025em" }}
            >
              {formatUZS(avg)}
            </div>
            <div className="text-[11.5px] text-muted mt-1">
              {t("op_detail.avg_check_hint")}
            </div>
          </div>
          <div className="nf-tile" style={{ padding: "16px 18px" }}>
            <div className="text-[12px] text-muted">
              {t("op_detail.plan_month", { month: new Date(planYear, planMonth - 1).toLocaleString(undefined, { month: "long" }) })}
            </div>
            {editPlan ? (
              <div className="mt-1 flex items-center gap-2">
                <NumericInput
                  className="nf-input flex-1 !py-2 !text-[13px]"
                  value={planInput}
                  onChange={setPlanInput}
                  placeholder={t("op_detail.plan_placeholder")}
                  autoFocus
                />
                <button
                  className="text-[12px] font-semibold px-3 py-1.5 rounded-full text-white"
                  style={{ background: "var(--accent-grad)" }}
                  disabled={!planInput || setPlanMut.isPending}
                  onClick={() => setPlanMut.mutate(planInput)}
                >
                  {setPlanMut.isPending ? "…" : "OK"}
                </button>
                <button
                  className="text-[12px] px-2 py-1.5 rounded-full text-muted hover:text-text"
                  onClick={() => setEditPlan(false)}
                >
                  ✕
                </button>
              </div>
            ) : planQuery.data?.target ? (
              <>
                <div
                  className="mt-1 font-semibold tabular-nums"
                  style={{ fontSize: 24, letterSpacing: "-0.025em" }}
                >
                  {planQuery.data.percent}%
                </div>
                <div className="mt-1.5">
                  <ProgressBar value={planQuery.data.percent} />
                </div>
                <div className="text-[11.5px] text-muted mt-1.5 tabular-nums">
                  {t("op_detail.plan_of", {
                    actual: formatUZS(Number(planQuery.data.actual)),
                    target: formatUZS(Number(planQuery.data.target)),
                  })}
                  {isManager && (
                    <button
                      className="ml-2 text-[11.5px]"
                      style={{ color: "var(--accent)" }}
                      onClick={() => {
                        setEditPlan(true);
                        setPlanInput(String(Math.round(Number(planQuery.data.target))));
                      }}
                    >
                      {t("op_detail.plan_change")}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="mt-1 text-muted text-[13px]">
                {t("op_detail.plan_none")}
                {isManager && (
                  <button
                    className="ml-2 text-[13px]"
                    style={{ color: "var(--accent)" }}
                    onClick={() => {
                      setEditPlan(true);
                      setPlanInput("");
                    }}
                  >
                    {t("op_detail.plan_set")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Salary block if available */}
        {s?.payroll && (
          <div
            className="mt-4 nf-tile flex items-center flex-wrap gap-4"
            style={{ padding: "14px 18px" }}
          >
            <div className="flex-1 min-w-[220px]">
              <div className="text-[11.5px] text-muted uppercase tracking-wide">
                {t("op_detail.payroll_month")}
              </div>
              <div className="mt-1 flex items-baseline gap-3">
                <div
                  className="font-semibold tabular-nums"
                  style={{ fontSize: 22, letterSpacing: "-0.025em" }}
                >
                  {formatUZS(s.payroll.payout)}
                </div>
                {s.payroll.threshold_reached && (
                  <span
                    className="text-[11.5px] font-semibold"
                    style={{ color: "var(--accent)" }}
                  >
                    {t("op_detail.threshold_reached")}
                  </span>
                )}
              </div>
            </div>
            <div className="flex-1 min-w-[220px]">
              <div className="flex justify-between text-[11.5px] text-muted mb-1">
                <span className="tabular-nums">
                  {formatUZS(s.payroll.total_sales)} / {formatUZS(s.payroll.threshold)}
                </span>
                <span className="tabular-nums">{s.payroll.progress_percent}%</span>
              </div>
              <ProgressBar value={s.payroll.progress_percent} />
            </div>
          </div>
        )}
      </section>

      {/* --- ACCOUNT / LOGIN --- */}
      {isManager && (
        <section
          className="nf-card p-6 animate-nfFadeUp"
          style={{ animationDelay: "0.04s" }}
        >
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="text-[15px] font-semibold tracking-tight flex items-center gap-2">
                <KeyRound className="w-4 h-4" style={{ color: "var(--accent)" }} />
                {t("op_detail.account_section_title")}
              </div>
              <div className="text-[13px] text-muted mt-1">
                {account.has_account
                  ? t("op_detail.account_hint_active")
                  : t("op_detail.account_hint_none")}
              </div>
            </div>
            {account.has_account && (
              <StatusBadge tone={account.is_active ? "hot" : "neutral"}>
                {account.deleted
                  ? t("op_detail.status_deleted_lower")
                  : account.is_active
                    ? t("op_detail.status_active_lower")
                    : t("op_detail.status_deactivated_lower")}
              </StatusBadge>
            )}
          </div>

          {!account.has_account ? (
            <div className="mt-5 flex flex-wrap items-center gap-3">
              {!detail.data?.phone && (
                <div
                  className="text-[12.5px] rounded-xl px-3.5 py-2.5 w-full"
                  style={{
                    background: "rgba(242,86,11,.1)",
                    color: "var(--accent)",
                    border: "1px solid rgba(242,86,11,.25)",
                  }}
                >
                  {t("op_detail.phone_needed_first")}
                </div>
              )}
              <Button
                onClick={() =>
                  detail.data?.phone ? createAccountMut.mutate() : openEditPhones()
                }
                disabled={createAccountMut.isPending}
              >
                <UserPlus className="w-4 h-4" />
                {createAccountMut.isPending
                  ? t("op_detail.creating")
                  : detail.data?.phone
                    ? t("op_detail.create_account")
                    : t("op_detail.enter_phone")}
              </Button>
              <span className="text-[12px] text-muted">
                {t("op_detail.password_one_time_hint")}
              </span>
            </div>
          ) : (
            <div className="mt-5 flex flex-col gap-4">
              <div
                className="nf-tile flex items-center justify-between flex-wrap gap-3"
                style={{ padding: "14px 18px" }}
              >
                <div>
                  <div className="text-[11px] text-muted uppercase tracking-wide font-semibold">
                    {t("common.login")}
                  </div>
                  <div className="mt-1 text-[15px] font-semibold font-mono tabular-nums">
                    {account.username}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => viewPasswordMut.mutate()}
                  disabled={viewPasswordMut.isPending || account.deleted}
                >
                  <Eye className="w-3.5 h-3.5" />
                  {viewPasswordMut.isPending ? "…" : t("account.show_password")}
                </Button>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => resetPasswordMut.mutate()}
                  disabled={resetPasswordMut.isPending || account.deleted}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {resetPasswordMut.isPending ? "…" : t("op_detail.regenerate_password")}
                </Button>
                {!account.deleted && (
                  <Button
                    variant="ghost"
                    onClick={() => toggleActiveMut.mutate()}
                    disabled={toggleActiveMut.isPending}
                  >
                    {account.is_active ? (
                      <>
                        <ShieldOff className="w-3.5 h-3.5" /> {t("op_detail.deactivate")}
                      </>
                    ) : (
                      <>
                        <ShieldCheck className="w-3.5 h-3.5" /> {t("op_detail.activate")}
                      </>
                    )}
                  </Button>
                )}
                {!account.deleted && (
                  <Button
                    variant="danger"
                    onClick={() => setConfirmDeleteAcc(true)}
                  >
                    <Trash2 className="w-3.5 h-3.5" /> {t("op_detail.delete_account")}
                  </Button>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* --- PERIOD FILTER --- */}
      <section className="flex flex-wrap items-center gap-3">
        {!isSpecific && (
          <TabPill value={period} onChange={setPeriod} items={PERIOD_TABS} />
        )}
        <MonthPicker value={choice} onChange={setChoice} />
      </section>

      {/* --- SALES CHART --- */}
      <section className="nf-card p-6">
        <div className="text-[15px] font-semibold tracking-tight mb-4">
          {t("op_detail.sales_by_day", { period: titleLower })}
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={(s?.by_day || []).map((r: { day: string; total: string | number; count: number }) => ({
              day: r.day,
              total: Number(r.total),
              count: r.count,
            }))}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--faint)" />
            <XAxis dataKey="day" tick={{ fontSize: 11, fill: "var(--muted)" }} />
            <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} />
            <Tooltip
              formatter={(v: number, name: string) =>
                name === "total" ? formatUZS(v) : formatNumber(v)
              }
              labelFormatter={(l) => t("op_detail.date_label", { v: String(l) })}
              contentStyle={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                fontSize: 12,
              }}
            />
            <Bar dataKey="total" fill="var(--accent)" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
        {(s?.by_day || []).length === 0 && !stats.isLoading && (
          <div className="text-center text-[13px] text-muted py-4">
            {t("op_detail.no_sales_period")}
          </div>
        )}
      </section>

      {/* --- BY MODEL + BY PARTNER --- */}
      <section className="grid gap-[13px] md:grid-cols-2">
        <div className="nf-card overflow-hidden">
          <div className="px-6 pt-5 pb-3 text-[15px] font-semibold tracking-tight">
            {t("op_detail.by_model")}
          </div>
          <div
            className="grid gap-2 px-6 pb-3 nf-col"
            style={{ gridTemplateColumns: "1.4fr .5fr .8fr" }}
          >
            <div>{t("common.model")}</div>
            <div className="text-right">{t("op_detail.qty")}</div>
            <div className="text-right">{t("common.amount")}</div>
          </div>
          {(s?.by_model || []).length === 0 ? (
            <div className="text-center text-muted py-8 text-[13px]">
              {t("common.no_data")}
            </div>
          ) : (
            (s?.by_model || []).map(
              (r: { phone_model: string; count: number; total: number | string }, i: number) => (
                <div
                  key={i}
                  className="nf-row"
                  style={{
                    gridTemplateColumns: "1.4fr .5fr .8fr",
                    cursor: "default",
                  }}
                >
                  <div className="truncate">{r.phone_model}</div>
                  <div className="text-right tabular-nums text-muted">
                    {formatNumber(r.count)}
                  </div>
                  <div className="text-right tabular-nums font-medium">
                    {formatUZS(r.total)}
                  </div>
                </div>
              ),
            )
          )}
        </div>

        <div className="nf-card overflow-hidden">
          <div className="px-6 pt-5 pb-3 text-[15px] font-semibold tracking-tight">
            {t("op_detail.by_partner")}
          </div>
          <div
            className="grid gap-2 px-6 pb-3 nf-col"
            style={{ gridTemplateColumns: "1.4fr .5fr .8fr" }}
          >
            <div>{t("common.partner")}</div>
            <div className="text-right">{t("op_detail.qty")}</div>
            <div className="text-right">{t("common.amount")}</div>
          </div>
          {(s?.by_partner || []).length === 0 ? (
            <div className="text-center text-muted py-8 text-[13px]">
              {t("common.no_data")}
            </div>
          ) : (
            (s?.by_partner || []).map(
              (r: {
                partner_id: number;
                partner_name: string;
                count: number;
                total: number | string;
              }) => (
                <div
                  key={r.partner_id}
                  className="nf-row"
                  style={{
                    gridTemplateColumns: "1.4fr .5fr .8fr",
                    cursor: "default",
                  }}
                >
                  <div className="truncate">{r.partner_name}</div>
                  <div className="text-right tabular-nums text-muted">
                    {formatNumber(r.count)}
                  </div>
                  <div className="text-right tabular-nums font-medium">
                    {formatUZS(r.total)}
                  </div>
                </div>
              ),
            )
          )}
        </div>
      </section>

      {/* --- ATTENDANCE (manager) --- */}
      {isManager && (
        <>
          <section className="nf-card p-6">
            <div className="text-[15px] font-semibold tracking-tight mb-4 flex items-center gap-2">
              <History className="w-4 h-4 text-muted" />
              {t("op_detail.attendance_30d")}
            </div>
            {attendanceReportQ.isLoading && (
              <div className="text-center py-6 text-muted text-[13px]">{t("common.loading")}</div>
            )}
            {!attendanceReportQ.isLoading && attendanceReportQ.data?.rows?.[0] && (
              <AttendanceStatsCard stats={attendanceReportQ.data.rows[0]} />
            )}
          </section>

          <section className="nf-card overflow-hidden">
            <div className="px-6 pt-5 pb-3 text-[15px] font-semibold tracking-tight">
              {t("op_detail.shifts_history")}
            </div>
            <div
              className="grid gap-2 px-6 pb-3 nf-col"
              style={{ gridTemplateColumns: "1fr .8fr .8fr .8fr .6fr .5fr 1fr .7fr" }}
            >
              <div>{t("op_detail.att_date")}</div>
              <div>{t("op_detail.att_arrived")}</div>
              <div>{t("op_detail.att_left")}</div>
              <div>{t("op_detail.att_duration")}</div>
              <div className="text-center">{t("op_detail.att_late")}</div>
              <div className="text-center">{t("op_detail.att_channel")}</div>
              <div className="text-center">{t("op_detail.att_status")}</div>
              <div className="text-right">{t("op_detail.att_actions")}</div>
            </div>

            {attendanceLogsQ.isLoading && (
              <div className="text-center text-muted py-8 text-[13px]">
                {t("common.loading")}
              </div>
            )}
            {!attendanceLogsQ.isLoading && !attendanceLogsQ.data?.length && (
              <div className="text-center text-muted py-8 text-[13px]">
                {t("op_detail.no_shifts")}
              </div>
            )}
            {attendanceLogsQ.data?.map((l, i) => (
              <div
                key={l.id}
                className="nf-row"
                style={{
                  gridTemplateColumns: "1fr .8fr .8fr .8fr .6fr .5fr 1fr .7fr",
                  cursor: "default",
                  animationDelay: `${0.02 + i * 0.03}s`,
                }}
              >
                <div className="font-medium tabular-nums">
                  {new Date(l.checked_in_at).toLocaleDateString()}
                </div>
                <div className="text-muted tabular-nums">
                  {new Date(l.checked_in_at).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
                <div className="text-muted tabular-nums">
                  {l.checked_out_at
                    ? new Date(l.checked_out_at).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "—"}
                </div>
                <div className="text-muted tabular-nums">
                  {l.duration_min !== null ? t("op_detail.minutes_short", { n: l.duration_min }) : "—"}
                </div>
                <div className="text-center">
                  {l.was_late ? (
                    <span
                      style={{ color: "var(--accent)" }}
                      className="inline-flex items-center gap-0.5 text-[12px] font-semibold"
                    >
                      <AlertTriangle className="w-3 h-3" /> {t("common.yes")}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </div>
                <div className="text-center text-[11px] uppercase text-muted tracking-wide">
                  {l.source}
                </div>
                <div className="text-center">
                  {l.checked_out_at ? (
                    l.manually_closed ? (
                      <StatusBadge>TL: {l.manually_closed_by_name}</StatusBadge>
                    ) : l.auto_closed ? (
                      <StatusBadge tone="hot">{t("op_detail.auto_2300")}</StatusBadge>
                    ) : (
                      <StatusBadge>{t("op_detail.success_lower")}</StatusBadge>
                    )
                  ) : (
                    <StatusBadge tone="hot">{t("op_detail.on_shift")}</StatusBadge>
                  )}
                </div>
                <div className="text-right">
                  {!l.checked_out_at && !l.auto_closed && (
                    <button
                      onClick={() =>
                        setClosingLog({
                          id: l.id,
                          name: s?.operator?.full_name || t("op_detail.default_name"),
                        })
                      }
                      className="text-[12px] font-semibold px-2.5 py-1.5 rounded-full"
                      style={{
                        background: "rgba(220,60,40,.1)",
                        color: "var(--danger)",
                      }}
                    >
                      {t("op_detail.close_shift_btn")}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </section>
        </>
      )}

      {/* --- TG DIALOGS --- */}
      {isManager && (
        <section className="nf-card overflow-hidden">
          <div className="px-6 pt-5 pb-3 text-[15px] font-semibold tracking-tight">
            {t("op_detail.tg_dialogs_title")}
          </div>
          <TgDialogsPanel operatorId={Number(id)} />
        </section>
      )}

      {/* --- LESSONS --- */}
      {isManager && (
        <section className="nf-card overflow-hidden">
          <div className="px-6 pt-5 pb-3 flex items-center justify-between">
            <div className="text-[15px] font-semibold tracking-tight">
              {t("op_detail.lessons_7d")}
            </div>
            <Link
              to={`/lessons/history?operator=${id}`}
              className="text-[12.5px] font-semibold"
              style={{ color: "var(--accent)" }}
            >
              {t("op_detail.lessons_all")}
            </Link>
          </div>
          <div
            className="grid gap-2 px-6 pb-3 nf-col"
            style={{ gridTemplateColumns: "160px 1fr 1.4fr 80px" }}
          >
            <div>{t("op_detail.lesson_date")}</div>
            <div>{t("op_detail.lesson_focus")}</div>
            <div>{t("op_detail.lesson_summary")}</div>
            <div className="text-center">{t("op_detail.lesson_read")}</div>
          </div>
          {lessonsQ.isLoading && (
            <div className="text-center text-muted py-8 text-[13px]">
              {t("common.loading")}
            </div>
          )}
          {!lessonsQ.isLoading && !lessonsQ.data?.length && (
            <div className="text-center text-muted py-8 text-[13px]">
              {t("op_detail.no_lessons")}
            </div>
          )}
          {lessonsQ.data?.map((l, i) => (
            <div
              key={l.id}
              onClick={() => setSelectedLessonDate(l.lesson_date)}
              className="nf-row"
              style={{
                gridTemplateColumns: "160px 1fr 1.4fr 80px",
                animationDelay: `${0.02 + i * 0.03}s`,
              }}
            >
              <div className="font-medium tabular-nums">
                {new Date(l.lesson_date).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </div>
              <div className="truncate font-medium">{l.micro_lesson}</div>
              <div className="text-muted truncate">{l.summary}</div>
              <div className="text-center">
                {l.opened_at ? (
                  <Eye className="w-4 h-4 inline" style={{ color: "var(--accent)" }} />
                ) : (
                  <EyeOff className="w-4 h-4 inline text-muted" />
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* --- Lesson detail modal --- */}
      <Modal
        open={!!selectedLessonDate}
        onClose={() => setSelectedLessonDate(null)}
        width={780}
      >
        <div className="p-7">
          <Eyebrow>{t("op_detail.ai_analysis")}</Eyebrow>
          <div
            className="mt-2 font-semibold"
            style={{ fontSize: 24, letterSpacing: "-0.025em" }}
          >
            {selectedLessonDate &&
              new Date(selectedLessonDate).toLocaleDateString(undefined, {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
          </div>
          {lessonDetailQ.isLoading && (
            <div className="text-center py-8 text-muted text-[13px]">{t("common.loading")}</div>
          )}
          {!lessonDetailQ.isLoading && lessonDetailQ.data && (
            <div className="mt-6 flex flex-col gap-5">
              <div
                className="flex items-start gap-3 rounded-2xl p-4"
                style={{
                  background: "rgba(242,86,11,.08)",
                  border: "1px solid rgba(242,86,11,.2)",
                }}
              >
                <Target
                  className="w-5 h-5 mt-0.5 flex-shrink-0"
                  style={{ color: "var(--accent)" }}
                />
                <div>
                  <div
                    className="text-[10.5px] uppercase tracking-wide font-semibold"
                    style={{ color: "var(--accent)" }}
                  >
                    {t("op_detail.lesson_focus_label")}
                  </div>
                  <div className="text-[14px] font-semibold mt-0.5">
                    {lessonDetailQ.data.micro_lesson}
                  </div>
                </div>
              </div>

              <div
                className="grid gap-[13px]"
                style={{ gridTemplateColumns: "repeat(4, 1fr)" }}
              >
                {[
                  { label: t("op_detail.stat_sales"), value: t("op_detail.lesson_stat_sales", { n: lessonDetailQ.data.stats_snapshot?.sales_count || 0 }) },
                  { label: t("op_detail.stat_sum"), value: formatUZS(lessonDetailQ.data.stats_snapshot?.revenue_uzs || 0) },
                  { label: t("op_detail.stat_dialogs"), value: lessonDetailQ.data.stats_snapshot?.dialogs_count || 0 },
                  {
                    label: t("op_detail.stat_quality"),
                    value: t("op_detail.lesson_quality", { v: lessonDetailQ.data.stats_snapshot?.avg_quality ? Math.round(lessonDetailQ.data.stats_snapshot.avg_quality) : 0 }),
                  },
                ].map((tile) => (
                  <div
                    key={tile.label}
                    className="nf-tile text-center"
                    style={{ padding: "12px 14px" }}
                  >
                    <div className="text-[10.5px] uppercase text-muted tracking-wide">
                      {tile.label}
                    </div>
                    <div className="mt-1 font-semibold text-[16px] tabular-nums">
                      {tile.value}
                    </div>
                  </div>
                ))}
              </div>

              <div>
                <Eyebrow className="mb-1.5">{t("op_detail.day_summary")}</Eyebrow>
                <p className="text-[14px] leading-relaxed">
                  {lessonDetailQ.data.summary}
                </p>
              </div>

              {lessonDetailQ.data.highlights?.length > 0 && (
                <div>
                  <Eyebrow className="mb-2">{t("op_detail.strong_points")}</Eyebrow>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {lessonDetailQ.data.highlights.map(
                      (hl: { title: string; evidence: string }, i: number) => (
                        <div key={i} className="nf-tile" style={{ padding: "12px 14px" }}>
                          <div className="font-semibold text-[13px]">{hl.title}</div>
                          <div className="text-[12px] text-muted mt-1">{hl.evidence}</div>
                        </div>
                      ),
                    )}
                  </div>
                </div>
              )}

              {lessonDetailQ.data.tips?.length > 0 && (
                <div>
                  <Eyebrow className="mb-2">{t("op_detail.recommendations")}</Eyebrow>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {lessonDetailQ.data.tips.map(
                      (
                        tip: { title: string; why: string; example: string; action: string },
                        i: number,
                      ) => (
                        <div key={i} className="nf-card" style={{ padding: "14px 16px" }}>
                          <div className="font-semibold text-[13px]">{tip.title}</div>
                          <div className="text-[11.5px] text-muted mt-1">
                            <span
                              className="font-semibold"
                              style={{ color: "var(--accent)" }}
                            >
                              {t("op_detail.tip_why")}
                            </span>{" "}
                            {tip.why}
                          </div>
                          <div
                            className="mt-2 text-[11px] italic rounded-lg p-2"
                            style={{ background: "var(--faint)" }}
                          >
                            «{tip.example}»
                          </div>
                          <div
                            className="mt-2 text-[11px] font-semibold flex items-center gap-1"
                            style={{ color: "var(--accent)" }}
                          >
                            <ChevronRight className="w-3 h-3" />
                            {tip.action}
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      {/* --- Manual close modal --- */}
      <Modal open={!!closingLog} onClose={() => setClosingLog(null)} width={440}>
        {closingLog && (
          <div className="p-7">
            <div className="text-[18px] font-semibold tracking-tight">
              {t("op_detail.close_shift_title")}
            </div>
            <div className="text-[13px] text-muted mt-1">
              {t("op_detail.close_shift_hint2", { name: closingLog.name })}
            </div>
            <div className="mt-5">
              <div className="nf-col mb-1.5">{t("op_detail.comment_optional")}</div>
              <textarea
                value={closeNote}
                onChange={(e) => setCloseNote(e.target.value)}
                className="nf-input min-h-[80px]"
                placeholder={t("op_detail.close_shift_comment")}
                maxLength={280}
                rows={3}
              />
            </div>
            <div className="mt-6 flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setClosingLog(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" onClick={handleCloseSubmit}>
                {t("op_detail.close_shift_title")}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* --- Credentials modal (created / reset / view) --- */}
      <Modal
        open={!!credsModal}
        onClose={() => setCredsModal(null)}
        width={460}
      >
        {credsModal && (
          <div className="p-7">
            <div className="text-[18px] font-semibold tracking-tight">
              {credsModal.kind === "created"
                ? t("op_detail.creds_created")
                : credsModal.kind === "reset"
                  ? t("op_detail.creds_reset")
                  : t("op_detail.creds_view")}
            </div>
            {credsModal.kind !== "view" && (
              <div
                className="mt-3 rounded-xl px-3.5 py-2.5 text-[12.5px]"
                style={{
                  background: "rgba(242,86,11,.1)",
                  color: "var(--accent)",
                  border: "1px solid rgba(242,86,11,.25)",
                }}
              >
                {t("op_detail.creds_warning")}
              </div>
            )}
            <div className="mt-5 flex flex-col gap-3">
              <div className="nf-tile flex items-center justify-between gap-3" style={{ padding: "12px 14px" }}>
                <div className="min-w-0">
                  <div className="text-[11px] text-muted uppercase tracking-wide font-semibold">{t("common.login")}</div>
                  <div className="mt-1 font-mono text-[14px] font-semibold tabular-nums truncate">
                    {credsModal.username}
                  </div>
                </div>
                <button
                  type="button"
                  className="nf-btn nf-btn--ghost"
                  style={{ padding: "8px 10px" }}
                  onClick={() => {
                    navigator.clipboard?.writeText(credsModal.username);
                    toast.success(t("toast.copied_login"));
                  }}
                  aria-label={t("op_detail.copy_login")}
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="nf-tile flex items-center justify-between gap-3" style={{ padding: "12px 14px" }}>
                <div className="min-w-0">
                  <div className="text-[11px] text-muted uppercase tracking-wide font-semibold">{t("common.password")}</div>
                  <div className="mt-1 font-mono text-[14px] font-semibold tabular-nums truncate">
                    {credsModal.password}
                  </div>
                </div>
                <button
                  type="button"
                  className="nf-btn nf-btn--ghost"
                  style={{ padding: "8px 10px" }}
                  onClick={() => {
                    navigator.clipboard?.writeText(credsModal.password);
                    toast.success(t("toast.copied_password"));
                  }}
                  aria-label={t("op_detail.copy_password")}
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div className="mt-6 flex justify-end">
              <Button onClick={() => setCredsModal(null)}>{t("common.done")}</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* --- Phones edit modal --- */}
      <Modal
        open={editPhones}
        onClose={() => setEditPhones(false)}
        width={460}
      >
        <div className="p-7">
          <div className="text-[18px] font-semibold tracking-tight">
            {t("op_detail.phones_modal_title")}
          </div>
          <div className="text-[13px] text-muted mt-1">
            {s?.operator?.full_name || t("op_detail.default_name")}
          </div>
          <div className="mt-5 flex flex-col gap-4">
            <div>
              <div className="nf-col mb-1.5">
                {t("op_detail.phone_work_full")}
              </div>
              <PhoneInput
                value={phoneWork}
                onChange={setPhoneWork}
                autoFocus
                invalid={phoneWork.length > 0 && !normalizeUzPhone(phoneWork).valid}
              />
              <div className="text-[11.5px] text-muted mt-1">
                {t("op_detail.phone_format_hint")}
              </div>
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("op_detail.personal_optional")}</div>
              <PhoneInput
                value={phonePersonal}
                onChange={setPhonePersonal}
                invalid={
                  phonePersonal.length > 0 && !normalizeUzPhone(phonePersonal).valid
                }
              />
            </div>
          </div>
          <div className="mt-7 flex gap-2 justify-end">
            <Button
              variant="ghost"
              onClick={() => setEditPhones(false)}
              disabled={savePhonesMut.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() =>
                savePhonesMut.mutate({
                  phone: normalizeUzPhone(phoneWork).canonical,
                  personal_phone: phonePersonal
                    ? normalizeUzPhone(phonePersonal).canonical
                    : "",
                })
              }
              disabled={
                savePhonesMut.isPending || !normalizeUzPhone(phoneWork).valid
              }
            >
              {savePhonesMut.isPending ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* --- Edit profile modal (name + hired_at + status + note) --- */}
      <Modal
        open={editProfile}
        onClose={() => setEditProfile(false)}
        width={480}
      >
        <div className="p-7 space-y-4">
          <div className="text-[18px] font-semibold tracking-tight">
            {t("op_edit.title")}
          </div>
          <div>
            <div className="nf-col mb-1.5">{t("op_edit.full_name")}</div>
            <input
              className="nf-input"
              value={profileForm.full_name}
              onChange={(e) =>
                setProfileForm({ ...profileForm, full_name: e.target.value })
              }
              autoFocus
            />
          </div>
          <div>
            <div className="nf-col mb-1.5">{t("op_edit.hired_at")}</div>
            <input
              type="date"
              className="nf-input"
              value={profileForm.hired_at}
              onChange={(e) =>
                setProfileForm({ ...profileForm, hired_at: e.target.value })
              }
            />
          </div>
          <div>
            <div className="nf-col mb-1.5">{t("op_edit.status")}</div>
            <Select<OperatorStatusChoice>
              value={profileForm.status}
              onChange={(v) =>
                setProfileForm({ ...profileForm, status: v })
              }
              options={[
                { value: "active", label: t("op_edit.status_active") },
                { value: "trainee", label: t("op_edit.status_trainee") },
                { value: "inactive", label: t("op_edit.status_inactive") },
              ]}
              ariaLabel={t("op_edit.status")}
            />
          </div>
          <div>
            <div className="nf-col mb-1.5">{t("op_edit.note")}</div>
            <textarea
              className="nf-input"
              rows={2}
              value={profileForm.note}
              onChange={(e) =>
                setProfileForm({ ...profileForm, note: e.target.value })
              }
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              onClick={() => setEditProfile(false)}
              disabled={saveProfileMut.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() =>
                saveProfileMut.mutate({
                  full_name: profileForm.full_name.trim(),
                  hired_at: profileForm.hired_at || null,
                  status: profileForm.status,
                  note: profileForm.note,
                })
              }
              disabled={
                saveProfileMut.isPending || !profileForm.full_name.trim()
              }
            >
              {saveProfileMut.isPending
                ? t("common.saving")
                : t("common.save")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* --- QR-code modal --- */}
      <Modal
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        width={420}
      >
        <div className="p-7 text-center">
          <div className="text-[18px] font-semibold tracking-tight">
            {t("op_detail.qr_modal_title")}
          </div>
          <div className="text-[13px] text-muted mt-1">
            {t("op_detail.qr_scan_by_camera", { name: s?.operator?.full_name || t("op_detail.default_name") })}
          </div>

          <div className="mt-6 grid place-items-center">
            <div
              style={{
                width: 260,
                height: 260,
                borderRadius: 24,
                background: "#fff",
                border: "1px solid var(--border)",
                display: "grid",
                placeItems: "center",
                padding: 14,
              }}
            >
              {qrPngQ.isLoading || !qrPngQ.data ? (
                <div className="text-[12px] text-muted">{t("op_detail.generating")}</div>
              ) : (
                <img
                  src={qrPngQ.data}
                  alt="QR"
                  style={{ width: "100%", height: "100%", objectFit: "contain" }}
                />
              )}
            </div>
          </div>

          <div
            className="mt-4 text-[11.5px] text-muted rounded-xl px-3 py-2"
            style={{ background: "var(--faint)" }}
          >
            {t("op_detail.qr_personal_hint")}
          </div>

          <div className="mt-5 flex flex-wrap gap-2 justify-center">
            <a
              href={qrPngQ.data ?? "#"}
              download={`naff-qr-${s?.operator?.full_name || id}.png`}
              className={`nf-btn nf-btn--secondary ${!qrPngQ.data ? "pointer-events-none opacity-50" : ""}`}
            >
              <Download className="w-3.5 h-3.5" /> {t("op_detail.download_png")}
            </a>
            <Button
              variant="ghost"
              onClick={() => rotateQrMut.mutate()}
              disabled={rotateQrMut.isPending}
            >
              <RefreshCw className="w-3.5 h-3.5" />
              {rotateQrMut.isPending ? "…" : t("op_detail.regenerate")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* --- Delete-account confirm --- */}
      <Modal
        open={confirmDeleteAcc}
        onClose={() => setConfirmDeleteAcc(false)}
        width={420}
      >
        <div className="p-7">
          <div className="text-[18px] font-semibold tracking-tight">
            {t("op_detail.delete_acc_confirm_title")}
          </div>
          <div className="text-[13px] text-muted mt-2">
            {t("op_detail.delete_acc_confirm_body")}
          </div>
          <div className="mt-6 flex gap-2 justify-end">
            <Button
              variant="ghost"
              onClick={() => setConfirmDeleteAcc(false)}
              disabled={deleteAccountMut.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => deleteAccountMut.mutate()}
              disabled={deleteAccountMut.isPending}
            >
              {deleteAccountMut.isPending ? t("op_detail.deleting") : t("common.delete")}
            </Button>
          </div>
        </div>
      </Modal>

      {stickerOpen && (
        <StickerPicker
          operatorId={Number(id)}
          currentEmoji={stickerQ.data?.sticker?.emoji ?? null}
          currentIsRare={stickerQ.data?.sticker?.is_rare ?? false}
          adminMode
          onChanged={() => stickerQ.refetch()}
          onClose={() => setStickerOpen(false)}
        />
      )}
    </div>
  );
}

// Keep Chip import used somewhere to avoid unused warnings (used by future filters)
void Chip;
