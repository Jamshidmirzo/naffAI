import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  AlertTriangle,
  Award,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Eye,
  Lock,
  EyeOff,
  Mic,
  Pencil,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { useAuth } from "../../store/auth";
import { useLang } from "../../store/lang";
import { isManagerLevel } from "../../components/RoleGate";
import { normalizeUzPhone, toast } from "../../components/ui";
import { apiErrorMessage } from "../../lib/api-types";
import { buildPeriodParams, recentMonths, type MonthChoice, type Period } from "../../lib/period";
import {
  tgCoaching,
  tgRetryBackfill,
  type TgCoachingIssue,
  type TgCoachingResult,
  type TgMessageItem,
} from "../../lib/tgUserclient";
import { useT2 } from "../i18n";
import { Dialog, EmptyState, ErrorState, LoadingBlock, PageHeader, PageSkeleton, cx, fmtNum, useConfirm } from "../ui";
import {
  opDetailApi,
  opDetailTashkentDate,
  useOpDetail,
  useOpDetailAttendanceLogs,
  useOpDetailAttendanceReport,
  useOpDetailLesson,
  useOpDetailLessons,
  useOpDetailOwners,
  useOpDetailPlan,
  useOpDetailQrPng,
  useOpDetailStats,
  useOpDetailSticker,
  useOpDetailStickerPalette,
  useOpDetailTgChats,
  useOpDetailTgInsights,
  useOpDetailTgMessages,
  useOpDetailTgStatus,
  opDetailIsPinRequired,
  type OpDetailAttendanceStats,
  type OpDetailCreds,
  type OpDetailHeatDay,
  type OpDetailOperator,
} from "../api/team/operatorDetail";

type T = ReturnType<typeof useT2>;
type StatusChoice = "active" | "trainee" | "inactive";

const TZ = "Asia/Tashkent";
const P = "v2.team.operatorDetail.";
const TG_MAX = 30;

// ---------- formatting ----------
function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}
function fmtTime(iso?: string | null) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
function fmtShort(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (opDetailTashkentDate(d) === opDetailTashkentDate()) return fmtTime(iso);
  return new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit" }).format(d);
}
function locale(lang: string) {
  return lang === "uz" ? "uz-Latn" : "ru-RU";
}
function monthName(lang: string, year: number, month: number, withYear = false) {
  return new Intl.DateTimeFormat(locale(lang), { month: "long", ...(withYear ? { year: "numeric" } : {}) })
    .format(new Date(year, month - 1, 15))
    .replace(/\s*г\.$/, "");
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
function digits(v: string) {
  return v.replace(/\D+/g, "");
}
function local9(phone: string) {
  const d = digits(phone);
  return (d.startsWith("998") ? d.slice(3) : d).slice(0, 9);
}
function fmtLocal9(d: string) {
  return [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)].filter(Boolean).join(" ");
}
function errDetail(err: unknown, fallback: string) {
  const data = (err as { response?: { data?: Record<string, unknown> } })?.response?.data;
  if (typeof data?.detail === "string") return data.detail;
  if (data) {
    for (const v of Object.values(data)) if (Array.isArray(v) && typeof v[0] === "string") return v[0] as string;
  }
  return fallback;
}
function copy(text: string, msg: string) {
  navigator.clipboard?.writeText(text);
  toast.success(msg);
}

function statusBadge(t: T, status?: string) {
  if (!status) return null;
  if (status === "active") return <span className="badge b-ok">{t("op_edit.status_active")}</span>;
  if (status === "trainee") return <span className="badge b-info">{t("op_edit.status_trainee")}</span>;
  if (status === "inactive") return <span className="badge">{t("op_edit.status_inactive")}</span>;
  return <span className="badge">{status}</span>;
}

function roleLabel(t: T, role: string) {
  if (role === "super_manager") return t(P + "roleSuper");
  if (role === "superadmin") return t(P + "roleSuperadmin");
  return t(P + "roleManager"); // manager & team_lead (team_lead is not shown in UI)
}

/** Period select value: current | all | range | YYYY-MM */
function choiceValue(c: MonthChoice) {
  if (c.kind === "specific") return `${c.year}-${String(c.month).padStart(2, "0")}`;
  return c.kind;
}

export default function OperatorDetail() {
  const t = useT2();
  const lang = useLang((s) => s.lang);
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const role = useAuth((s) => s.role);
  const isManager = isManagerLevel(role);
  const confirm = useConfirm();

  // --- period ---
  const [period, setPeriod] = useState<Period>("month");
  const [choice, setChoice] = useState<MonthChoice>({ kind: "current" });
  const params = buildPeriodParams(period, choice);

  const now = new Date();
  const todayTk = opDetailTashkentDate(now);
  const [curY, curM] = todayTk.split("-").map(Number);
  const planYear = choice.kind === "specific" ? choice.year : curY;
  const planMonth = choice.kind === "specific" ? choice.month : curM;

  // --- UI state ---
  const [editPlan, setEditPlan] = useState(false);
  const [planInput, setPlanInput] = useState("");
  const [lessonDate, setLessonDate] = useState<string | null>(null);
  const [closing, setClosing] = useState<{ id: number; name: string } | null>(null);
  const [closeNote, setCloseNote] = useState("");
  const [creds, setCreds] = useState<(OpDetailCreds & { kind: "created" | "reset" | "view" }) | null>(null);
  const [handedOver, setHandedOver] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrVer, setQrVer] = useState(0);
  const [phonesOpen, setPhonesOpen] = useState(false);
  const [phoneWork, setPhoneWork] = useState("");
  const [phonePersonal, setPhonePersonal] = useState("");
  const [stickerOpen, setStickerOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<{
    full_name: string;
    hired_at: string;
    status: StatusChoice;
    note: string;
    blocking_gate_enabled: boolean;
    livestream_enabled: boolean;
    // null = not touched, "" = unassign (NULL), number = owner id
    managed_by_id: number | null | "";
  }>({ full_name: "", hired_at: "", status: "active", note: "", blocking_gate_enabled: false, livestream_enabled: false, managed_by_id: null });

  // --- data ---
  const detail = useOpDetail(id);
  const stats = useOpDetailStats(id, params);
  const stickerQ = useOpDetailSticker(id, isManager);
  const planQ = useOpDetailPlan(id, planYear, planMonth);
  const reportQ = useOpDetailAttendanceReport(id, isManager);
  const logsQ = useOpDetailAttendanceLogs(id, isManager);
  const lessonsQ = useOpDetailLessons(id, isManager);
  const lessonQ = useOpDetailLesson(id, lessonDate);
  const qrQ = useOpDetailQrPng(id, qrVer, qrOpen);
  const ownersQ = useOpDetailOwners(isManager && (editOpen || detail.data?.managed_by_id != null));

  const d = detail.data;
  const s = stats.data;
  const account = d?.account ?? { has_account: false, is_active: false, deleted: false, username: null, preferred_language: "uz" as const };
  const name = d?.full_name || s?.operator?.full_name || t("op_detail.default_name");
  const hiredAt = d?.hired_at || s?.operator?.hired_at || null;
  const owner = ownersQ.data?.find((u) => u.id === d?.managed_by_id);
  const onShift = !!logsQ.data?.some((l) => !l.checked_out_at && !l.auto_closed);

  const invalidateAccount = () => qc.invalidateQueries({ queryKey: ["operator-detail", id] });

  // --- mutations (same endpoints / toasts / invalidations as the old page) ---
  const createAccountMut = useMutation({
    mutationFn: () => opDetailApi.createAccount(id!),
    onSuccess: (data) => {
      invalidateAccount();
      setHandedOver(false);
      setCreds({ kind: "created", ...data });
      toast.success(t("op_detail.account_created"));
    },
    onError: () => toast.error(t("op_detail.account_create_failed")),
  });
  const resetPasswordMut = useMutation({
    mutationFn: () => opDetailApi.resetPassword(id!),
    onSuccess: (data) => {
      invalidateAccount();
      setHandedOver(false);
      setCreds({ kind: "reset", ...data });
      toast.success(t("op_detail.password_regenerated"));
    },
    onError: () => toast.error(t("op_detail.password_reset_failed")),
  });
  const viewPasswordMut = useMutation({
    mutationFn: () => opDetailApi.viewPassword(id!),
    onSuccess: (data) => setCreds({ kind: "view", ...data }),
    onError: (err) => toast.error(errDetail(err, t("op_detail.password_fetch_failed"))),
  });
  const toggleActiveMut = useMutation({
    mutationFn: (active: boolean) => opDetailApi.setAccountActive(id!, active),
    onSuccess: (_r, active) => {
      invalidateAccount();
      toast.success(active ? t("op_detail.account_activated") : t("op_detail.account_deactivated"));
    },
    onError: () => toast.error(t("op_detail.account_status_failed")),
  });
  const deleteAccountMut = useMutation({
    mutationFn: (comment: string) => opDetailApi.deleteAccount(id!, comment),
    onSuccess: () => {
      invalidateAccount();
      toast.success(t("op_detail.account_deleted"));
    },
    onError: (err) => toast.error(errDetail(err, t("op_detail.account_delete_failed"))),
  });
  const languageMut = useMutation({
    mutationFn: (l: "ru" | "uz") => opDetailApi.setLanguage(id!, l),
    onSuccess: () => {
      invalidateAccount();
      toast.success(t("users.language_saved"));
    },
    onError: (err) => toast.error(errDetail(err, t("common.error"))),
  });
  const phonesMut = useMutation({
    mutationFn: (payload: { phone: string; personal_phone: string }) => opDetailApi.patchOperator(id!, payload),
    onSuccess: () => {
      invalidateAccount();
      qc.invalidateQueries({ queryKey: ["operator-stats", id] });
      setPhonesOpen(false);
      toast.success(t("op_detail.phones_updated"));
    },
    onError: (err) => toast.error(errDetail(err, t("common.save_failed"))),
  });
  const profileMut = useMutation({
    mutationFn: (payload: Record<string, unknown>) => opDetailApi.patchOperator(id!, payload),
    onSuccess: () => {
      invalidateAccount();
      qc.invalidateQueries({ queryKey: ["operator-stats", id] });
      qc.invalidateQueries({ queryKey: ["operators"] });
      setEditOpen(false);
      toast.success(t("op_edit.saved"));
    },
    onError: (err) => toast.error(errDetail(err, t("op_edit.save_failed"))),
  });
  const rotateQrMut = useMutation({
    mutationFn: () => opDetailApi.rotateQr(id!),
    onSuccess: () => {
      setQrVer((v) => v + 1);
      toast.success(t("op_detail.qr_rotated_msg"));
    },
    onError: () => toast.error(t("op_detail.qr_rotate_failed")),
  });
  const planMut = useMutation({
    mutationFn: (target: string) => opDetailApi.setPlan(id!, target, planYear, planMonth),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operator-plan", id, planYear, planMonth] });
      setEditPlan(false);
      toast.success(t("op_detail.plan_updated"));
    },
    onError: () => toast.error(t("op_detail.plan_save_failed")),
  });
  const closeShiftMut = useMutation({
    mutationFn: (v: { id: number; note: string }) => opDetailApi.closeShift(v.id, v.note),
    onSuccess: () => {
      toast.success(t("op_detail.shift_closed"));
      setClosing(null);
      setCloseNote("");
      logsQ.refetch();
      reportQ.refetch();
    },
    onError: () => toast.error(t("op_detail.shift_close_failed")),
  });

  // --- actions ---
  const openPhones = () => {
    setPhoneWork(local9(d?.phone ?? ""));
    setPhonePersonal(local9(d?.personal_phone ?? ""));
    setPhonesOpen(true);
  };
  const openEdit = () => {
    setForm({
      full_name: d?.full_name || s?.operator?.full_name || "",
      hired_at: (hiredAt || "").slice(0, 10),
      status: ((d?.status || s?.operator?.status || "active") as StatusChoice),
      note: d?.note || "",
      blocking_gate_enabled: !!d?.blocking_gate_enabled,
      livestream_enabled: !!d?.livestream_enabled,
      managed_by_id: d?.managed_by_id ?? null,
    });
    setEditOpen(true);
  };
  const saveEdit = () => {
    const payload: Record<string, unknown> = {
      full_name: form.full_name.trim(),
      hired_at: form.hired_at || null,
      status: form.status,
      note: form.note,
      blocking_gate_enabled: form.blocking_gate_enabled,
      livestream_enabled: form.livestream_enabled,
    };
    if (form.managed_by_id !== null) payload.managed_by_id = form.managed_by_id === "" ? null : form.managed_by_id;
    profileMut.mutate(payload);
  };
  const askReset = async () => {
    const ok = await confirm({ title: t(P + "resetTitle"), body: t(P + "resetBody", { name }), confirm: t(P + "resetConfirm") });
    if (ok) resetPasswordMut.mutate();
  };
  const askToggleActive = async () => {
    if (!account.is_active) return toggleActiveMut.mutate(true);
    const ok = await confirm({ title: t(P + "deactTitle"), body: t(P + "deactBody", { name }), confirm: t("op_detail.deactivate"), danger: true });
    if (ok) toggleActiveMut.mutate(false);
  };
  const askDeleteAccount = async () => {
    const reason = await confirm({
      title: t("op_detail.delete_acc_confirm_title"),
      body: t("op_detail.delete_acc_confirm_body"),
      confirm: t("op_detail.delete_account"),
      danger: true,
      reason: { label: t(P + "deleteAccReason"), minLength: 10, placeholder: t("op_detail.delete_comment_placeholder") },
    });
    if (typeof reason === "string" && reason.length >= 10) deleteAccountMut.mutate(reason);
  };
  const askRotateQr = async () => {
    const ok = await confirm({ title: t(P + "qrNewTitle"), body: t(P + "qrNewBody"), confirm: t(P + "qrNewConfirm") });
    if (ok) rotateQrMut.mutate();
  };
  const scrollTo = (elId: string) => document.getElementById(elId)?.scrollIntoView({ behavior: "smooth", block: "start" });

  // --- period title (lower-case, for KPI labels) ---
  const periodLower = useMemo(() => {
    if (choice.kind === "all") return t(P + "periodAllLower");
    if (choice.kind === "specific") return monthName(lang, choice.year, choice.month, true);
    if (choice.kind === "range") return `${fmtDate(choice.from)} – ${fmtDate(choice.to)}`;
    if (period === "day") return t(P + "periodToday");
    if (period === "week") return t(P + "periodWeek");
    return monthName(lang, curY, curM);
  }, [choice, period, lang, curY, curM, t]);

  // --- chart bars ---
  const bars = useMemo(() => {
    const rows = s?.by_day ?? [];
    const byDay = new Map(rows.map((r) => [r.day, r]));
    let days: string[] = [];
    const monthWindow =
      choice.kind === "specific" ? { y: choice.year, m: choice.month } : choice.kind === "current" && period === "month" ? { y: curY, m: curM } : null;
    if (monthWindow) {
      const last = new Date(monthWindow.y, monthWindow.m, 0).getDate();
      for (let i = 1; i <= last; i++) {
        const key = `${monthWindow.y}-${String(monthWindow.m).padStart(2, "0")}-${String(i).padStart(2, "0")}`;
        if (key > todayTk) break;
        days.push(key);
      }
    } else {
      days = rows.map((r) => r.day);
    }
    const truncated = days.length > 31;
    days = days.slice(-31);
    const max = Math.max(1, ...days.map((k) => byDay.get(k)?.count ?? 0));
    return {
      truncated,
      list: days.map((k) => {
        const r = byDay.get(k);
        const count = r?.count ?? 0;
        return { key: k, d: k.slice(8, 10), count, total: r?.total ?? 0, h: Math.round((count / max) * 100), now: k === todayTk };
      }),
    };
  }, [s?.by_day, choice, period, curY, curM, todayTk]);

  if (!id) return null;

  if (detail.isLoading) {
    return (
      <>
        <PageHeader title={t("op_detail.default_name")} back="/operators" />
        <PageSkeleton />
      </>
    );
  }
  if (detail.isError) {
    const status = (detail.error as { response?: { status?: number } })?.response?.status;
    return (
      <>
        <PageHeader title={t("op_detail.default_name")} back="/operators" />
        <main className="page">
          <section className="card">
            {status === 404 ? (
              <EmptyState
                title={t(P + "notFound")}
                body={t(P + "notFoundBody")}
                action={<Link className="btn btn-pri" to="/operators">{t(P + "toList")}</Link>}
              />
            ) : (
              <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
            )}
          </section>
        </main>
      </>
    );
  }

  const avg = Number(s?.totals?.count || 0) > 0 ? Number(s?.totals?.total || 0) / Number(s?.totals?.count) : 0;
  const plan = planQ.data;
  const planPct = plan?.percent ?? 0;
  const achievements = plan?.achievements ?? [];
  const metaParts = [t(P + "role"), owner ? owner.full_name || owner.username : null, hiredAt ? t(P + "since", { date: fmtDate(hiredAt) }) : null].filter(Boolean);
  const sk = (w: number, h = 28) => <i className="sk" style={{ display: "block", width: w, height: h }} />;

  const title = (
    <span className="row g12" style={{ minWidth: 0 }}>
      <span className="ava ava-l" data-s={d?.is_paused ? "pause" : onShift ? "on" : undefined} aria-hidden="true" style={{ overflow: d?.avatar_url ? "hidden" : undefined }}>
        {d?.avatar_url ? <img src={d.avatar_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} /> : initials(name)}
      </span>
      <span className="col" style={{ minWidth: 0 }}>
        <span className="trunc" style={{ fontSize: 20, lineHeight: "26px" }}>{name}</span>
        <span className="s c3 trunc" style={{ fontFamily: "var(--font)", fontWeight: 400, letterSpacing: 0, lineHeight: "18px" }}>{metaParts.join(" · ")}</span>
      </span>
      <span className="row g8" style={{ fontFamily: "var(--font)", letterSpacing: 0 }}>
        {statusBadge(t, d?.status || s?.operator?.status)}
        {d?.is_paused ? <span className="badge b-warn">{t(P + "paused")}</span> : null}
      </span>
    </span>
  );

  return (
    <>
      <PageHeader title={title} back="/operators">
        {isManager ? (
          <>
            <button className="btn" type="button" onClick={() => setStickerOpen(true)}>
              {stickerQ.data?.sticker?.emoji ? (
                <>
                  <span aria-hidden="true">{stickerQ.data.sticker.emoji}</span>
                  {t(P + "sticker")}
                </>
              ) : (
                t("op_detail.assign_sticker")
              )}
            </button>
            <button className="btn" type="button" onClick={() => setQrOpen(true)}>
              <QrCode className="ic" />
              {t("op_detail.login_qr")}
            </button>
          </>
        ) : null}
        <button className="btn" type="button" onClick={() => scrollTo("op-tg")}>
          <Send className="ic" />
          {t("op_detail.telegram")}
        </button>
        {isManager ? (
          <button className="btn btn-pri" type="button" onClick={openEdit}>
            <Pencil className="ic" />
            {t(P + "edit")}
          </button>
        ) : null}
      </PageHeader>

      <main className="page">
        {/* phones + achievements */}
        <div className="row between wrap g12">
          <div className="row g12 wrap">
            {d?.phone ? (
              <span className="s c3">
                {t("op_detail.phone_work")}: <span className="num c2">{d.phone}</span>
                {d.personal_phone ? (
                  <>
                    {" · "}
                    {t("op_detail.phone_personal")}: <span className="num c2">{d.personal_phone}</span>
                  </>
                ) : null}
              </span>
            ) : (
              <button className="btn btn-sm" type="button" onClick={openPhones}>
                <Plus className="ic ic-s" />
                {t("op_detail.add_work_phone").replace(/^\+\s*/, "")}
              </button>
            )}
            {isManager && d?.phone ? (
              <button className="btn btn-ghost btn-sm" type="button" onClick={openPhones}>
                {t("op_detail.edit_lower")}
              </button>
            ) : null}
          </div>
          {achievements.length ? (
            <div className="row g6 wrap" aria-label={t(P + "achievements")}>
              {achievements.map((a) => (
                <span key={a.slug} className="badge b-hot">
                  <Award className="ic ic-s" />
                  {a.label}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {/* period */}
        <div className="row between wrap g12">
          <div className="row g12 wrap">
            {choice.kind === "current" ? (
              <div className="seg" role="tablist">
                {(["day", "week", "month"] as Period[]).map((p) => (
                  <button key={p} type="button" className={cx(period === p && "is-on")} onClick={() => setPeriod(p)}>
                    {t(`op_detail.period_${p}`)}
                  </button>
                ))}
              </div>
            ) : null}
            <select
              className="input"
              aria-label={t(P + "periodAria")}
              style={{ width: 210 }}
              value={choiceValue(choice)}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "current" || v === "all") setChoice({ kind: v });
                else if (v === "range") setChoice({ kind: "range", from: `${todayTk.slice(0, 8)}01`, to: todayTk });
                else {
                  const [y, m] = v.split("-").map(Number);
                  setChoice({ kind: "specific", year: y, month: m });
                }
              }}
            >
              <option value="current">{t(P + "periodCurrent")}</option>
              {recentMonths(12).map((m) => (
                <option key={`${m.year}-${m.month}`} value={`${m.year}-${String(m.month).padStart(2, "0")}`}>
                  {monthName(lang, m.year, m.month, true)}
                </option>
              ))}
              <option value="all">{t(P + "periodAll")}</option>
              <option value="range">{t(P + "periodRange")}</option>
            </select>
            {choice.kind === "range" ? (
              <span className="row g8">
                <input className="input num" type="date" aria-label={t(P + "rangeFrom")} value={choice.from} max={choice.to} onChange={(e) => e.target.value && setChoice({ ...choice, from: e.target.value })} style={{ width: 160 }} />
                <span className="c3">–</span>
                <input className="input num" type="date" aria-label={t(P + "rangeTo")} value={choice.to} min={choice.from} onChange={(e) => e.target.value && setChoice({ ...choice, to: e.target.value })} style={{ width: 160 }} />
              </span>
            ) : null}
          </div>
          <button className="btn btn-ghost btn-sm c-brand" type="button" onClick={() => scrollTo("op-more")}>
            {t(P + "jumpMore")}
            <ChevronRight className="ic ic-s" />
          </button>
        </div>

        {/* KPIs */}
        {stats.isError ? (
          <section className="card">
            <ErrorState error={stats.error} onRetry={() => stats.refetch()} />
          </section>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
            <section className="card col g4 pad">
              <span className="lbl">{t("op_detail.sum_period", { period: periodLower })}</span>
              {stats.isLoading ? sk(160, 34) : <span className="kpi">{fmtNum(s?.totals?.total || 0)}</span>}
              <span className="s c3">{stats.isLoading ? "" : t("op_detail.sales_count", { n: fmtNum(s?.totals?.count || 0) })}</span>
            </section>
            <section className="card col g4 pad">
              <span className="lbl">{t("op_detail.kpi_avg")}</span>
              {stats.isLoading ? sk(140, 34) : <span className="kpi">{avg ? fmtNum(avg) : "—"}</span>}
              <span className="s c3">{t("op_detail.avg_check_hint")}</span>
            </section>
            <section className="card col g6 pad">
              <span className="row between">
                <span className="lbl">{t("op_detail.plan_month", { month: monthName(lang, planYear, planMonth) })}</span>
                {isManager && plan?.target && !editPlan ? (
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    onClick={() => {
                      setPlanInput(String(Math.round(Number(plan.target))));
                      setEditPlan(true);
                    }}
                  >
                    <Pencil className="ic ic-s" />
                    {t("op_detail.plan_change")}
                  </button>
                ) : null}
              </span>
              {planQ.isLoading ? (
                sk(160, 34)
              ) : planQ.isError ? (
                <span className="row g8 s c-bad">
                  {t("v2.state.errorTitle")}
                  <button className="btn btn-sm" type="button" onClick={() => planQ.refetch()}>{t("v2.state.retry")}</button>
                </span>
              ) : editPlan ? (
                <span className="row g8 wrap">
                  <input
                    className="input num"
                    type="text"
                    inputMode="numeric"
                    autoFocus
                    aria-label={t(P + "planTarget")}
                    placeholder={t(P + "planTarget")}
                    value={planInput ? fmtNum(planInput) : ""}
                    onChange={(e) => setPlanInput(digits(e.target.value))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && planInput) planMut.mutate(planInput);
                      if (e.key === "Escape") setEditPlan(false);
                    }}
                    style={{ width: 150, height: 32 }}
                  />
                  <button className="btn btn-sm btn-pri" type="button" disabled={!planInput || planMut.isPending} onClick={() => planMut.mutate(planInput)}>
                    {t("common.save")}
                  </button>
                  <button className="btn btn-sm btn-ghost" type="button" onClick={() => setEditPlan(false)}>
                    {t("common.cancel")}
                  </button>
                </span>
              ) : plan?.target ? (
                <>
                  <span className="row g8 wrap" style={{ alignItems: "baseline" }}>
                    <span className="kpi" style={{ color: planPct >= 100 ? "var(--ok)" : "var(--warn)" }}>{planPct}%</span>
                    <span className="num s c2">{t("op_detail.plan_of", { actual: fmtNum(plan.actual), target: fmtNum(plan.target) })}</span>
                  </span>
                  <div className="bar">
                    <i className={planPct >= 100 ? "ok" : "warn"} style={{ width: `${Math.min(100, planPct)}%` }} />
                  </div>
                </>
              ) : (
                <span className="row g12 wrap">
                  <span className="s c3">{t("op_detail.plan_none")}</span>
                  {isManager ? (
                    <button
                      className="btn btn-sm"
                      type="button"
                      onClick={() => {
                        setPlanInput("");
                        setEditPlan(true);
                      }}
                    >
                      <Plus className="ic ic-s" />
                      {t("op_detail.plan_set")}
                    </button>
                  ) : null}
                </span>
              )}
            </section>
          </div>
        )}

        {/* payroll */}
        {s?.payroll ? (
          <section className="card row g24 wrap" style={{ padding: "16px 20px" }}>
            <div className="col g4" style={{ flex: "1 1 260px" }}>
              <span className="lbl">{t("op_detail.payroll_month")}</span>
              <span className="row g12" style={{ alignItems: "baseline" }}>
                <span className="kpi">{fmtNum(s.payroll.payout)}</span>
                <span className={cx("s", s.payroll.threshold_reached ? "c-ok w6" : "c3")}>
                  {s.payroll.threshold_reached ? t("op_detail.threshold_reached") : t(P + "payrollNotReached")}
                </span>
              </span>
            </div>
            <div className="col g6" style={{ flex: "2 1 420px" }}>
              <div className="row between xs c3">
                <span className="num">{fmtNum(s.payroll.total_sales)} / {fmtNum(s.payroll.threshold)}</span>
                <span className="num w6">{s.payroll.progress_percent}%</span>
              </div>
              <span className="bar" style={{ height: 10 }}>
                <i className={s.payroll.threshold_reached ? "ok" : "warn"} style={{ width: `${Math.min(100, s.payroll.progress_percent)}%` }} />
              </span>
              <span className="xs c3">
                {t(P + "payrollHint")} ·{" "}
                <Link className="c-brand" to="/attendance/payroll">{t(P + "teamPayroll")}</Link>
              </span>
            </div>
          </section>
        ) : null}

        {/* chart + account */}
        <div style={{ display: "grid", gridTemplateColumns: isManager ? "repeat(auto-fit, minmax(min(100%, 420px), 1fr))" : "1fr", gap: 16, alignItems: "start" }}>
          <section className="card col">
            <div className="card-h">
              <span className="h3">{t("op_detail.sales_by_day", { period: periodLower })}</span>
              <span className="xs c3">{bars.truncated ? t(P + "lastDays", { n: bars.list.length }) : t(P + "pieces")}</span>
            </div>
            {stats.isLoading ? (
              <LoadingBlock rows={3} onRetry={() => stats.refetch()} />
            ) : bars.list.length === 0 || bars.list.every((b) => b.count === 0) ? (
              <EmptyState title={t("op_detail.no_sales_period")} />
            ) : (
              <div style={{ overflowX: "auto" }}>
                <div style={{ minWidth: Math.max(320, bars.list.length * 22), padding: "18px 20px 14px" }}>
                  <div className="chart" style={{ height: 150, gap: 6 }}>
                    {bars.list.map((b) => (
                      <span key={b.key} className={cx(b.now && "is-now")} title={t(P + "barTitle", { day: fmtDate(b.key), count: b.count, sum: fmtNum(b.total) })}>
                        <span className="num xs c3" style={{ marginBottom: 4 }}>{b.count}</span>
                        <i style={{ height: `${Math.max(b.count ? 4 : 1, b.h)}%` }} />
                      </span>
                    ))}
                  </div>
                  <div className="row num xs c3" style={{ gap: 6, marginTop: 8 }}>
                    {bars.list.map((b) => (
                      <span key={b.key} className="grow" style={{ flex: "1 1 0", textAlign: "center", minWidth: 0 }}>{b.d}</span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>

          {isManager ? (
            <AccountCard
              t={t}
              d={d}
              onPhones={openPhones}
              onCreate={() => createAccountMut.mutate()}
              creating={createAccountMut.isPending}
              onView={() => viewPasswordMut.mutate()}
              viewing={viewPasswordMut.isPending}
              onReset={askReset}
              resetting={resetPasswordMut.isPending}
              onToggle={askToggleActive}
              toggling={toggleActiveMut.isPending}
              onDelete={askDeleteAccount}
              deleting={deleteAccountMut.isPending}
              onLanguage={(l) => languageMut.mutate(l)}
              langPending={languageMut.isPending}
            />
          ) : null}
        </div>

        {/* shifts history */}
        {isManager ? (
          <section className="card tbl">
            <div className="card-h">
              <span className="h3">{t("op_detail.shifts_history")}</span>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => scrollTo("op-att")}>{t("op_detail.attendance_30d")}</button>
            </div>
            {logsQ.isLoading ? (
              <LoadingBlock rows={4} onRetry={() => logsQ.refetch()} />
            ) : logsQ.isError && opDetailIsPinRequired(logsQ.error) ? (
              <OpDetailPinNotice />
            ) : logsQ.isError ? (
              <ErrorState error={logsQ.error} onRetry={() => logsQ.refetch()} />
            ) : !logsQ.data?.length ? (
              <EmptyState title={t("op_detail.no_shifts")} />
            ) : (
              <div style={{ overflowX: "auto" }}>
                <div style={{ minWidth: 860 }}>
                  {(() => {
                    const cols = "1.1fr 80px 80px 90px 80px 80px 1.4fr 140px";
                    return (
                      <>
                        <div className="tr th" style={{ gridTemplateColumns: cols }}>
                          <span>{t("op_detail.att_date")}</span>
                          <span>{t("op_detail.att_arrived")}</span>
                          <span>{t("op_detail.att_left")}</span>
                          <span>{t("op_detail.att_duration")}</span>
                          <span>{t("op_detail.att_late")}</span>
                          <span>{t("op_detail.att_channel")}</span>
                          <span>{t("op_detail.att_status")}</span>
                          <span className="r">{t("op_detail.att_actions")}</span>
                        </div>
                        {logsQ.data.map((l) => {
                          const open = !l.checked_out_at && !l.auto_closed;
                          let st: ReactNode;
                          if (!l.checked_out_at) st = <span className="badge b-hot">{t("op_detail.on_shift")}</span>;
                          else if (l.manually_closed) st = <span className="badge" title={l.manual_close_note || undefined}>{t(P + "closedBy", { name: l.manually_closed_by_name || "—" })}</span>;
                          else if (l.auto_closed) st = <span className="badge b-hot">{t("op_detail.auto_2300")}</span>;
                          else st = <span className="badge">{t("op_detail.success_lower")}</span>;
                          return (
                            <div key={l.id} className="tr" style={{ gridTemplateColumns: cols }}>
                              <span className="s w5 num">{fmtDate(l.checked_in_at)}</span>
                              <span className="num s">{fmtTime(l.checked_in_at)}</span>
                              <span className="num s">{l.checked_out_at ? fmtTime(l.checked_out_at) : "—"}</span>
                              <span className="num s c2">{l.duration_min !== null ? t("op_detail.minutes_short", { n: l.duration_min }) : "—"}</span>
                              <span className={cx("s", l.was_late ? "c-hot w6" : "c3")}>{l.was_late ? t("common.yes").toLowerCase() : "—"}</span>
                              <span className="num xs c3" style={{ textTransform: "uppercase", letterSpacing: ".06em" }}>{l.source}</span>
                              <span>{st}</span>
                              <span className="r">
                                {open ? (
                                  <button className="btn btn-sm" type="button" onClick={() => setClosing({ id: l.id, name })}>
                                    {t("op_detail.close_shift_title")}
                                  </button>
                                ) : null}
                              </span>
                            </div>
                          );
                        })}
                      </>
                    );
                  })()}
                </div>
              </div>
            )}
          </section>
        ) : null}

        {/* models + partners */}
        <div id="op-more" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", gap: 16, alignItems: "start", scrollMarginTop: 16 }}>
          <BreakdownCard
            t={t}
            title={t("op_detail.by_model")}
            sub={periodLower}
            colLabel={t("common.model")}
            loading={stats.isLoading}
            rows={(s?.by_model ?? []).map((r, i) => ({ key: String(i), name: r.phone_model, count: r.count, total: r.total }))}
          />
          <BreakdownCard
            t={t}
            title={t("op_detail.by_partner")}
            sub={periodLower}
            colLabel={t("common.partner")}
            loading={stats.isLoading}
            avatars
            rows={(s?.by_partner ?? []).map((r) => ({ key: String(r.partner_id), name: r.partner_name, count: r.count, total: r.total }))}
          />
        </div>

        {isManager ? (
          <>
            {/* attendance 30 days */}
            <section id="op-att" className="card col" style={{ scrollMarginTop: 16 }}>
              <div className="card-h">
                <span className="h3">{t("op_detail.attendance_30d")}</span>
                <span className="xs c3 num">
                  {fmtDate(opDetailTashkentDate(new Date(Date.now() - 30 * 864e5)))} – {fmtDate(todayTk)}
                </span>
              </div>
              {reportQ.isLoading ? (
                <LoadingBlock rows={3} onRetry={() => reportQ.refetch()} />
              ) : reportQ.isError && opDetailIsPinRequired(reportQ.error) ? (
                <OpDetailPinNotice />
              ) : reportQ.isError ? (
                <ErrorState error={reportQ.error} onRetry={() => reportQ.refetch()} />
              ) : reportQ.data?.rows?.[0] ? (
                <AttendanceBlock t={t} stats={reportQ.data.rows[0]} />
              ) : (
                <EmptyState title={t(P + "heatEmpty")} />
              )}
            </section>

            {/* lessons */}
            <section className="card tbl">
              <div className="card-h">
                <span className="h3">{t("op_detail.lessons_7d")}</span>
                <Link className="btn btn-ghost btn-sm" to={`/lessons/history?operator=${id}`}>{t("op_detail.lessons_all")}</Link>
              </div>
              {lessonsQ.isLoading ? (
                <LoadingBlock rows={3} onRetry={() => lessonsQ.refetch()} />
              ) : lessonsQ.isError ? (
                <ErrorState error={lessonsQ.error} onRetry={() => lessonsQ.refetch()} />
              ) : !lessonsQ.data?.length ? (
                <EmptyState title={t("op_detail.no_lessons")} />
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <div style={{ minWidth: 560 }}>
                    <div className="tr th" style={{ gridTemplateColumns: "110px 1fr 1.2fr 60px" }}>
                      <span>{t("op_detail.lesson_date")}</span>
                      <span>{t("op_detail.lesson_focus")}</span>
                      <span>{t("op_detail.lesson_summary")}</span>
                      <span className="r">{t("op_detail.lesson_read")}</span>
                    </div>
                    {lessonsQ.data.map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        className={cx("tr", lessonDate === l.lesson_date && "is-sel")}
                        style={{ gridTemplateColumns: "110px 1fr 1.2fr 60px", minHeight: 52, width: "100%", textAlign: "left", background: lessonDate === l.lesson_date ? undefined : "transparent", border: 0, borderBottom: "1px solid var(--line)", cursor: "pointer", font: "inherit", color: "inherit" }}
                        onClick={() => setLessonDate(l.lesson_date)}
                      >
                        <span className="num s w5">{fmtDate(l.lesson_date)}</span>
                        <span className="s w6 trunc">{l.micro_lesson}</span>
                        <span className="s c3 trunc">{l.summary}</span>
                        <span className="r">
                          {l.opened_at ? <Eye className="ic c-brand" aria-label="✓" /> : <EyeOff className="ic c3" />}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>

            {/* telegram dialogs */}
            <TgDialogs t={t} operatorId={Number(id)} name={name} />
          </>
        ) : null}
      </main>

      {/* ---------- dialogs ---------- */}
      {confirm.node}

      <LessonDialog t={t} lang={lang} date={lessonDate} q={lessonQ} onClose={() => setLessonDate(null)} />

      <Dialog
        open={!!closing}
        onClose={() => setClosing(null)}
        title={t("op_detail.close_shift_title")}
        sub={closing ? t("op_detail.close_shift_hint2", { name: closing.name }) : undefined}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setClosing(null)}>{t("common.cancel")}</button>
            <button className="btn btn-danger" type="button" disabled={closeShiftMut.isPending} onClick={() => closing && closeShiftMut.mutate({ id: closing.id, note: closeNote })}>
              {t("op_detail.close_shift_title")}
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="op-close-note">{t("op_detail.comment_optional")}</label>
          <textarea id="op-close-note" className="input" rows={3} maxLength={280} value={closeNote} placeholder={t("op_detail.close_shift_comment")} onChange={(e) => setCloseNote(e.target.value)} />
          <span className="hint" style={{ textAlign: "right" }}>{t(P + "closeCounter", { n: closeNote.length })}</span>
        </div>
      </Dialog>

      {/* credentials: created/reset are one-time → locked */}
      <Dialog
        open={!!creds}
        locked={creds?.kind !== "view"}
        onClose={() => setCreds(null)}
        title={creds?.kind === "created" ? t("op_detail.creds_created") : creds?.kind === "reset" ? t("op_detail.creds_reset") : t("op_detail.creds_view")}
        sub={creds?.kind === "view" ? t(P + "viewAudited") : undefined}
        footer={
          <button className="btn btn-pri" type="button" disabled={creds?.kind !== "view" && !handedOver} onClick={() => setCreds(null)}>
            {t("common.done")}
          </button>
        }
      >
        {creds ? (
          <>
            {creds.kind !== "view" ? <div className="banner b-warn"><AlertTriangle className="ic" /><span>{t("op_detail.creds_warning")}</span></div> : null}
            <div className="well row between g12">
              <span className="col g4" style={{ minWidth: 0 }}>
                <span className="lbl">{t("common.login")}</span>
                <span className="num w6 trunc" style={{ fontSize: 15 }}>{creds.username}</span>
              </span>
              <button className="btn btn-sm" type="button" aria-label={t("op_detail.copy_login")} onClick={() => copy(creds.username, t("toast.copied_login"))}>
                <Copy className="ic ic-s" />
                {t(P + "copy")}
              </button>
            </div>
            <div className="well row between g12">
              <span className="col g4" style={{ minWidth: 0 }}>
                <span className="lbl">{t("common.password")}</span>
                <span className="num w6 trunc" style={{ fontSize: 17 }}>{creds.password}</span>
              </span>
              <button className="btn btn-sm" type="button" aria-label={t("op_detail.copy_password")} onClick={() => copy(creds.password, t("toast.copied_password"))}>
                <Copy className="ic ic-s" />
                {t(P + "copy")}
              </button>
            </div>
            {creds.kind !== "view" ? (
              <label className="row g8 s">
                <input className="check" type="checkbox" checked={handedOver} onChange={(e) => setHandedOver(e.target.checked)} />
                {t(P + "handedOver")}
              </label>
            ) : null}
          </>
        ) : null}
      </Dialog>

      {/* phones */}
      <Dialog
        open={phonesOpen}
        onClose={() => setPhonesOpen(false)}
        title={t("op_detail.phones_modal_title")}
        sub={name}
        footer={
          <>
            <button className="btn" type="button" disabled={phonesMut.isPending} onClick={() => setPhonesOpen(false)}>{t("common.cancel")}</button>
            <button
              className="btn btn-pri"
              type="button"
              disabled={phonesMut.isPending || phoneWork.length !== 9 || (phonePersonal.length > 0 && phonePersonal.length !== 9)}
              onClick={() =>
                phonesMut.mutate({
                  phone: normalizeUzPhone(phoneWork).canonical,
                  personal_phone: phonePersonal ? normalizeUzPhone(phonePersonal).canonical : "",
                })
              }
            >
              {phonesMut.isPending ? t("common.saving") : t("common.save")}
            </button>
          </>
        }
      >
        <PhoneField id="op-ph-work" label={t("op_detail.phone_work_full")} value={phoneWork} onChange={setPhoneWork} error={t(P + "workPhoneErr")} autoFocus hint={t("op_detail.phone_format_hint")} />
        <PhoneField id="op-ph-pers" label={t("op_detail.personal_optional")} value={phonePersonal} onChange={setPhonePersonal} error={t(P + "workPhoneErr")} />
      </Dialog>

      {/* edit profile */}
      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={t("op_edit.title")}
        sub={name}
        width={540}
        footer={
          <>
            <button className="btn btn-ghost" type="button" disabled={profileMut.isPending} onClick={() => setEditOpen(false)}>{t("common.cancel")}</button>
            <button className="btn btn-pri" type="button" disabled={profileMut.isPending || !form.full_name.trim()} onClick={saveEdit}>
              {profileMut.isPending ? t("common.saving") : t("common.save")}
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="op-e-name">{t("op_edit.full_name")} *</label>
          <input id="op-e-name" className={cx("input", !form.full_name.trim() && "is-bad")} autoFocus value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </div>
        <div className="row g8 wrap" style={{ alignItems: "flex-start" }}>
          <div className="field grow" style={{ minWidth: 180 }}>
            <label htmlFor="op-e-hired">{t("op_edit.hired_at")}</label>
            <input id="op-e-hired" className="input num" type="date" value={form.hired_at} onChange={(e) => setForm({ ...form, hired_at: e.target.value })} />
          </div>
          <div className="field grow" style={{ minWidth: 180 }}>
            <label htmlFor="op-e-status">{t("op_edit.status")}</label>
            <select id="op-e-status" className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as StatusChoice })}>
              <option value="active">{t("op_edit.status_active")}</option>
              <option value="trainee">{t("op_edit.status_trainee")}</option>
              <option value="inactive">{t("op_edit.status_inactive")}</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="op-e-note">{t("op_edit.note")}</label>
          <textarea id="op-e-note" className="input" rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </div>
        <SwitchRow
          on={form.blocking_gate_enabled}
          onToggle={() => setForm({ ...form, blocking_gate_enabled: !form.blocking_gate_enabled })}
          title={t("op_edit.blocking_gate")}
          hint={t("op_edit.blocking_gate_hint")}
        />
        <SwitchRow
          on={form.livestream_enabled}
          onToggle={() => setForm({ ...form, livestream_enabled: !form.livestream_enabled })}
          title={t(P + "livestream")}
          hint={t(P + "livestreamHint")}
        />
        <div className="field">
          <label htmlFor="op-e-owner">{t("op_edit.managed_by")}</label>
          <select
            id="op-e-owner"
            className="input"
            value={form.managed_by_id === null ? "" : String(form.managed_by_id)}
            onChange={(e) => setForm({ ...form, managed_by_id: e.target.value === "" ? "" : Number(e.target.value) })}
          >
            <option value="">{t("op_edit.managed_by_unassigned")}</option>
            {(ownersQ.data ?? [])
              .filter((u) => ["manager", "team_lead", "super_manager", "superadmin"].includes(u.role))
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {(u.full_name || u.username) + " · " + roleLabel(t, u.role)}
                </option>
              ))}
          </select>
          <span className="hint">{t("op_edit.managed_by_hint")}</span>
        </div>
      </Dialog>

      {/* QR */}
      <Dialog
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        title={t("op_detail.qr_modal_title")}
        sub={t("op_detail.qr_scan_by_camera", { name })}
        width={420}
        footer={
          <>
            <button className="btn btn-ghost" type="button" disabled={rotateQrMut.isPending} onClick={askRotateQr}>
              <RefreshCw className="ic" />
              {t(P + "qrNew")}
            </button>
            <span className="grow" />
            <a
              className={cx("btn btn-pri")}
              href={qrQ.data ?? undefined}
              download={`naff-qr-${name || id}.png`}
              aria-disabled={!qrQ.data}
              style={!qrQ.data ? { pointerEvents: "none", opacity: 0.5 } : undefined}
            >
              <Download className="ic" />
              {t("op_detail.download_png")}
            </a>
          </>
        }
      >
        <div style={{ alignSelf: "center", width: 220, height: 220, borderRadius: 14, background: "#FFFFFF", border: "1px solid var(--line)", display: "grid", placeItems: "center", padding: 12 }}>
          {qrQ.isError ? (
            <span className="col g8" style={{ alignItems: "center" }}>
              <span className="xs c-bad">{t(P + "qrFailed")}</span>
              <button className="btn btn-sm" type="button" onClick={() => qrQ.refetch()}>{t("v2.state.retry")}</button>
            </span>
          ) : qrQ.data ? (
            <img src={qrQ.data} alt="QR" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          ) : (
            <span className="xs" style={{ color: "var(--ink-3)" }}>{t("op_detail.generating")}</span>
          )}
        </div>
        <p className="xs c3" style={{ textAlign: "center", margin: 0 }}>{t("op_detail.qr_personal_hint")}</p>
      </Dialog>

      {stickerOpen ? (
        <StickerDialog
          t={t}
          operatorId={id}
          currentEmoji={stickerQ.data?.sticker?.emoji ?? null}
          currentIsRare={stickerQ.data?.sticker?.is_rare ?? false}
          onChanged={() => stickerQ.refetch()}
          onClose={() => setStickerOpen(false)}
        />
      ) : null}
    </>
  );
}

// ======================================================================
// sub-components
// ======================================================================

function SwitchRow({ on, onToggle, title, hint }: { on: boolean; onToggle: () => void; title: string; hint: string }) {
  return (
    <div className="well row g12" style={{ alignItems: "flex-start" }}>
      <button className={cx("switch", on && "is-on")} type="button" role="switch" aria-checked={on} aria-label={title} onClick={onToggle} style={{ marginTop: 2 }}>
        <i />
      </button>
      <div className="col g4">
        <span className="s w6">{title}</span>
        <span className="hint">{hint}</span>
      </div>
    </div>
  );
}

function PhoneField({ id, label, value, onChange, error, hint, autoFocus }: { id: string; label: string; value: string; onChange: (v: string) => void; error: string; hint?: string; autoFocus?: boolean }) {
  const bad = value.length > 0 && value.length !== 9;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="row g8">
        <span className="pfx" style={{ height: 40, fontSize: 14, borderRadius: 9 }} aria-hidden="true">+998</span>
        <input
          id={id}
          className={cx("input num grow", bad && "is-bad")}
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          autoFocus={autoFocus}
          placeholder="90 123 45 67"
          value={fmtLocal9(value)}
          onChange={(e) => onChange(local9(e.target.value))}
        />
      </div>
      {bad ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

function AccountCard(props: {
  t: T;
  d?: OpDetailOperator;
  onPhones: () => void;
  onCreate: () => void;
  creating: boolean;
  onView: () => void;
  viewing: boolean;
  onReset: () => void;
  resetting: boolean;
  onToggle: () => void;
  toggling: boolean;
  onDelete: () => void;
  deleting: boolean;
  onLanguage: (l: "ru" | "uz") => void;
  langPending: boolean;
}) {
  const { t, d } = props;
  const acc = d?.account;
  const badge = !acc?.has_account ? (
    <span className="badge">{t(P + "noLogin")}</span>
  ) : acc.deleted ? (
    <span className="badge b-bad">{t("op_detail.status_deleted_lower")}</span>
  ) : acc.is_active ? (
    <span className="badge b-ok"><i className="dot" />{t("op_detail.status_active_lower")}</span>
  ) : (
    <span className="badge b-warn">{t("op_detail.status_deactivated_lower")}</span>
  );
  const current = acc?.preferred_language ?? "uz";
  return (
    <section className="card col">
      <div className="card-h">
        <span className="h3">{t("op_detail.account_section_title")}</span>
        {badge}
      </div>
      <div className="col g12" style={{ padding: "16px 20px" }}>
        {!acc?.has_account ? (
          <>
            <span className="s c3">{t("op_detail.account_hint_none")}</span>
            {!d?.phone ? <div className="banner b-warn"><span>{t("op_detail.phone_needed_first")}</span></div> : null}
            <div className="row g12 wrap">
              <button className="btn btn-pri" type="button" disabled={props.creating} onClick={() => (d?.phone ? props.onCreate() : props.onPhones())}>
                <UserPlus className="ic" />
                {props.creating ? t("op_detail.creating") : d?.phone ? t("op_detail.create_account") : t("op_detail.enter_phone")}
              </button>
              <span className="xs c3">{t("op_detail.password_one_time_hint")}</span>
            </div>
          </>
        ) : (
          <>
            <div className="row between s g12">
              <span className="c3">{t("common.login")}</span>
              <span className="num trunc">{acc.username}</span>
            </div>
            <div className="row g8 wrap">
              <button className="btn btn-sm grow" type="button" disabled={props.viewing || acc.deleted} onClick={props.onView}>
                <Eye className="ic ic-s" />
                {t("account.show_password")}
              </button>
              <button className="btn btn-sm grow" type="button" disabled={props.resetting || acc.deleted} onClick={props.onReset}>
                <RefreshCw className="ic ic-s" />
                {t("op_detail.regenerate_password")}
              </button>
            </div>
            {!acc.deleted ? (
              <div className="row g8 wrap">
                <button className="btn btn-sm btn-ghost grow" type="button" disabled={props.toggling} onClick={props.onToggle}>
                  {acc.is_active ? <ShieldOff className="ic ic-s" /> : <ShieldCheck className="ic ic-s" />}
                  {acc.is_active ? t("op_detail.deactivate") : t("op_detail.activate")}
                </button>
                <button className="btn btn-sm btn-bad grow" type="button" disabled={props.deleting} onClick={props.onDelete}>
                  <Trash2 className="ic ic-s" />
                  {props.deleting ? t("op_detail.deleting") : t("op_detail.delete_account")}
                </button>
              </div>
            ) : null}
            {!acc.deleted ? (
              <>
                <hr className="hr" />
                <div className="row between s g12 wrap">
                  <span className="col" style={{ minWidth: 0, flex: "1 1 200px" }}>
                    <span className="w6">{t("op_detail.language")}</span>
                    <span className="xs c3">{t("op_detail.language_hint")}</span>
                  </span>
                  <div className="seg">
                    {(["uz", "ru"] as const).map((l) => (
                      <button key={l} type="button" className={cx(current === l && "is-on")} disabled={props.langPending} onClick={() => current !== l && props.onLanguage(l)} aria-pressed={current === l}>
                        {l.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function BreakdownCard({ t, title, sub, colLabel, rows, loading, avatars }: { t: T; title: string; sub: string; colLabel: string; rows: { key: string; name: string; count: number; total: string | number }[]; loading: boolean; avatars?: boolean }) {
  const cols = "1fr 80px 140px";
  return (
    <section className="card tbl">
      <div className="card-h">
        <span className="h3">{title}</span>
        <span className="xs c3">{sub}</span>
      </div>
      {loading ? (
        <LoadingBlock rows={3} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("common.no_data")} />
      ) : (
        <>
          <div className="tr th" style={{ gridTemplateColumns: cols }}>
            <span>{colLabel}</span>
            <span className="r">{t("op_detail.qty")}</span>
            <span className="r">{t("common.amount")}</span>
          </div>
          {rows.map((r) => (
            <div key={r.key} className="tr" style={{ gridTemplateColumns: cols, minHeight: 44 }}>
              <span className="row g8 s w5" style={{ minWidth: 0 }}>
                {avatars ? <span className="ava ava-s">{initials(r.name || "?")}</span> : null}
                <span className="trunc">{r.name}</span>
              </span>
              <span className="r num s">{fmtNum(r.count)}</span>
              <span className="r num s w6">{fmtNum(r.total)}</span>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

const HEAT: Record<OpDetailHeatDay["status"], { bg: string; fg: string; key: string }> = {
  on_time: { bg: "var(--ok-solid)", fg: "#FFFFFF", key: "attendance.stats.status_on_time" },
  late: { bg: "var(--warn-solid)", fg: "#1D1D1F", key: "attendance.stats.status_late" },
  absent: { bg: "var(--bad-solid)", fg: "#FFFFFF", key: "attendance.stats.legend_absent_short" },
  weekend: { bg: "var(--line-2)", fg: "var(--ink-3)", key: "attendance.stats.status_weekend" },
  auto_closed: { bg: "repeating-linear-gradient(45deg, #D97706, #D97706 4px, #F59E0B 4px, #F59E0B 8px)", fg: "#FFFFFF", key: "attendance.stats.status_auto_closed" },
  manually_closed: { bg: "var(--brand)", fg: "#FFFFFF", key: "attendance.stats.legend_closed_by_tl" },
};

function AttendanceBlock({ t, stats }: { t: T; stats: OpDetailAttendanceStats }) {
  const tiles: { label: string; value: string; cls: string }[] = [
    { label: t("attendance.stats.presence"), value: `${stats.days_present} / ${stats.days_expected} ${t("tg.attendance_days")}`, cls: "" },
    { label: t("attendance.stats.absences"), value: `${stats.days_absent} ${t("tg.attendance_days")}`, cls: "c-bad" },
    { label: t("attendance.stats.late_avg"), value: `${stats.late_count} (${t("attendance.stats.min_short", { n: stats.avg_late_minutes })})`, cls: "c-warn" },
    { label: t("attendance.stats.avg_shift"), value: t("attendance.stats.min_short", { n: stats.avg_shift_minutes }), cls: "c-brand" },
    { label: t("attendance.stats.total_hours"), value: t("attendance.stats.hours_short", { n: stats.total_worked_hours }), cls: "c-ok" },
  ];
  return (
    <div className="col g20" style={{ padding: 20 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
        {tiles.map((x) => (
          <div key={x.label} className="well col g4" style={{ textAlign: "center" }}>
            <span className="xs c3">{x.label}</span>
            <span className={cx("num w7", x.cls)} style={{ fontSize: 18 }}>{x.value}</span>
          </div>
        ))}
      </div>
      <div className="col g12">
        <span className="h3" style={{ fontSize: 14 }}>{t(P + "heatTitle")}</span>
        <div className="row g6 wrap well" style={{ padding: 12 }}>
          {stats.heatmap.map((day) => {
            const c = HEAT[day.status] ?? HEAT.weekend;
            return (
              <span
                key={day.date}
                className="num"
                title={`${fmtDate(day.date)}: ${t(c.key)}`}
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 6, fontSize: 10, fontWeight: 700, background: c.bg, color: c.fg }}
              >
                {day.date.slice(8, 10)}
              </span>
            );
          })}
        </div>
        <div className="row g16 wrap xs c3">
          {(Object.keys(HEAT) as OpDetailHeatDay["status"][]).map((k) => (
            <span key={k} className="row g6">
              <i style={{ display: "inline-block", width: 14, height: 14, borderRadius: 4, background: HEAT[k].bg }} />
              {t(HEAT[k].key)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function LessonDialog({ t, lang, date, q, onClose }: { t: T; lang: string; date: string | null; q: ReturnType<typeof useOpDetailLesson>; onClose: () => void }) {
  const l = q.data;
  const snap = l?.stats_snapshot;
  return (
    <Dialog
      open={!!date}
      onClose={onClose}
      width={720}
      title={
        <span className="col g4">
          <span className="lbl c-brand">{t(P + "lessonTitle")}</span>
          <span>{date ? new Intl.DateTimeFormat(locale(lang), { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${date}T12:00:00`)) : ""}</span>
        </span>
      }
      footer={<button className="btn" type="button" onClick={onClose}>{t("common.close")}</button>}
    >
      {q.isLoading ? (
        <LoadingBlock rows={3} onRetry={() => q.refetch()} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !l ? (
        <EmptyState title={t("op_detail.lesson_no_data")} />
      ) : (
        <>
          <div className="well col g4" style={{ borderColor: "var(--brand)", background: "var(--brand-soft)" }}>
            <span className="lbl c-brand">{t("op_detail.lesson_focus_label")}</span>
            <span className="s w6">{l.micro_lesson}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
            {[
              { label: t("op_detail.stat_sales"), value: t("op_detail.lesson_stat_sales", { n: snap?.sales_count || 0 }) },
              { label: t("op_detail.stat_sum"), value: fmtNum(snap?.revenue_uzs || 0) },
              { label: t("op_detail.stat_dialogs"), value: String(snap?.dialogs_count || 0) },
              { label: t("op_detail.stat_quality"), value: t("op_detail.lesson_quality", { v: snap?.avg_quality ? Math.round(snap.avg_quality) : 0 }) },
            ].map((x) => (
              <div key={x.label} className="well col g4" style={{ padding: "8px 10px" }}>
                <span className="xs c3">{x.label}</span>
                <span className="num w6 trunc">{x.value}</span>
              </div>
            ))}
          </div>
          <div className="col g4">
            <span className="lbl">{t("op_detail.day_summary")}</span>
            <span className="s c2">{l.summary}</span>
          </div>
          {l.highlights?.length ? (
            <div className="col g6">
              <span className="lbl">{t("op_detail.strong_points")}</span>
              {l.highlights.map((h, i) => (
                <span key={i} className="row g8 s" style={{ alignItems: "flex-start" }}>
                  <CheckCircle2 className="ic ic-s c-ok" style={{ marginTop: 2 }} />
                  <span className="col g4">
                    <span className="w6">{h.title}</span>
                    {h.evidence ? <span className="xs c3">{h.evidence}</span> : null}
                  </span>
                </span>
              ))}
            </div>
          ) : null}
          {l.tips?.length ? (
            <div className="col g8">
              <span className="lbl">{t("op_detail.recommendations")}</span>
              {l.tips.map((tip, i) => (
                <div key={i} className="well col g4" style={{ padding: "10px 12px" }}>
                  <span className="s w6">{tip.title}</span>
                  <span className="xs c3">
                    <span className="w6">{t("op_detail.tip_why")}</span> {tip.why}
                  </span>
                  {tip.example ? <span className="xs c2" style={{ fontStyle: "italic" }}>«{tip.example}»</span> : null}
                  {tip.action ? (
                    <span className="xs c-brand w6 row g4">
                      <ChevronRight className="ic ic-s" />
                      {tip.action}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </Dialog>
  );
}

function StickerDialog({ t, operatorId, currentEmoji, currentIsRare, onChanged, onClose }: { t: T; operatorId: string; currentEmoji: string | null; currentIsRare: boolean; onChanged: () => void; onClose: () => void }) {
  const qc = useQueryClient();
  const palette = useOpDetailStickerPalette(true);
  const [rareMode, setRareMode] = useState(currentIsRare);
  const [rareEmoji, setRareEmoji] = useState(currentIsRare && currentEmoji ? currentEmoji : "");
  const [error, setError] = useState<string | null>(null);
  const taken = new Map<string, string>();
  (palette.data?.taken ?? []).forEach((x) => taken.set(x.emoji, x.operator_name));

  const after = () => {
    qc.invalidateQueries({ queryKey: ["stickers", "palette"] });
    qc.invalidateQueries({ queryKey: ["operators"] });
    qc.invalidateQueries({ queryKey: ["me", "sticker"] });
    onChanged();
    onClose();
  };
  const setMut = useMutation({
    mutationFn: (payload: { emoji: string; is_rare: boolean }) => opDetailApi.setSticker(operatorId, payload),
    onSuccess: () => {
      toast.success(t("op_detail.sticker_saved"));
      after();
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const clearMut = useMutation({
    mutationFn: () => opDetailApi.clearSticker(operatorId),
    onSuccess: () => {
      toast.success(t(P + "stickerCleared"));
      after();
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={t(P + "stickerTitle")}
      width={520}
      footer={
        <>
          {currentEmoji && !rareMode ? (
            <button className="btn btn-bad" type="button" disabled={clearMut.isPending} onClick={() => clearMut.mutate()}>
              <X className="ic" />
              {t(P + "stickerClear")}
            </button>
          ) : null}
          <span className="grow" />
          <button className="btn" type="button" onClick={onClose}>{t("common.close")}</button>
          {rareMode ? (
            <button className="btn btn-pri" type="button" disabled={!rareEmoji || setMut.isPending} onClick={() => setMut.mutate({ emoji: rareEmoji, is_rare: true })}>
              {t(P + "stickerRareGive")}
            </button>
          ) : null}
        </>
      }
    >
      <div className="seg seg-lg">
        <button type="button" className={cx(!rareMode && "is-on")} onClick={() => setRareMode(false)}>{t(P + "stickerRegular")}</button>
        <button type="button" className={cx(rareMode && "is-on")} onClick={() => setRareMode(true)}>{t(P + "stickerRare")}</button>
      </div>
      {palette.isLoading ? (
        <LoadingBlock rows={2} onRetry={() => palette.refetch()} />
      ) : palette.isError ? (
        <ErrorState error={palette.error} onRetry={() => palette.refetch()} />
      ) : rareMode ? (
        <div className="col g8">
          <div className="field">
            <label htmlFor="op-rare">{t(P + "stickerRareLabel")}</label>
            <input id="op-rare" className="input input-lg" style={{ textAlign: "center", fontSize: 24 }} autoFocus value={rareEmoji} onChange={(e) => setRareEmoji(e.target.value.slice(0, 4))} />
          </div>
          {palette.data?.rare && String(palette.data.rare.operator_id) !== operatorId ? (
            <div className="banner b-warn"><span>{t(P + "stickerRareNow", { emoji: palette.data.rare.emoji, name: palette.data.rare.operator_name })}</span></div>
          ) : null}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(40px, 1fr))", gap: 6, maxHeight: 320, overflowY: "auto", padding: 2 }}>
          {(palette.data?.palette ?? []).map((emoji) => {
            const ownerName = taken.get(emoji);
            const isCurrent = emoji === currentEmoji;
            const disabled = !!ownerName && !isCurrent;
            return (
              <button
                key={emoji}
                type="button"
                className="btn"
                title={disabled ? t(P + "stickerTaken", { name: ownerName! }) : isCurrent ? t(P + "stickerCurrent") : t(P + "stickerPick")}
                disabled={disabled || setMut.isPending}
                onClick={() => {
                  setError(null);
                  if (!disabled) setMut.mutate({ emoji, is_rare: false });
                }}
                style={{ height: 40, padding: 0, fontSize: 22, borderColor: isCurrent ? "var(--brand)" : undefined, background: isCurrent ? "var(--brand-soft)" : undefined, opacity: disabled ? 0.3 : 1 }}
              >
                {emoji}
              </button>
            );
          })}
        </div>
      )}
      {error ? <span className="err">{error}</span> : null}
    </Dialog>
  );
}

// ---------- Telegram dialogs (v2 redraw of components/TgDialogsPanel) ----------

function severityBadge(s: TgCoachingIssue["severity"]) {
  return s === "high" ? "b-bad" : s === "mid" ? "b-warn" : "";
}

function TgDialogs({ t, operatorId, name }: { t: T; operatorId: number; name: string }) {
  const lang = useLang((s) => s.lang);
  const [chatId, setChatId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<TgCoachingResult | null>(null);

  const statusQ = useOpDetailTgStatus(operatorId);
  const chatsQ = useOpDetailTgChats(operatorId);
  const messagesQ = useOpDetailTgMessages(chatId);
  const insightsQ = useOpDetailTgInsights(chatId);

  const retryMut = useMutation({
    mutationFn: () => tgRetryBackfill({ operator_id: operatorId }),
    onSuccess: () => statusQ.refetch(),
  });
  const coachingMut = useMutation({
    mutationFn: () => tgCoaching(chatId!, Array.from(selected), lang).then((r) => r.data),
    onSuccess: (data) => setResult(data),
    onError: () => toast.error(t("tg.coaching_error_generic")),
  });

  const job = statusQ.data?.latest_backfill_job;
  const tgUser = statusQ.data?.tg_username;
  const insight = insightsQ.data?.[0];
  const msgs = useMemo(() => (messagesQ.data ? [...messagesQ.data].reverse() : []), [messagesQ.data]);
  const chats = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = chatsQ.data ?? [];
    if (!q) return all;
    return all.filter((c) => [c.partner_name, c.title, c.lead_name, c.partner_phone].some((v) => (v || "").toLowerCase().includes(q)));
  }, [chatsQ.data, search]);

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < TG_MAX) next.add(id);
      else toast.error(t("tg.coaching_max_selection", { n: TG_MAX }));
      return next;
    });

  const notConnected = !statusQ.isLoading && !statusQ.data?.status && !chatsQ.isLoading && !(chatsQ.data?.length);

  let jobBadge: ReactNode = null;
  if (job?.status === "running") jobBadge = <span className="badge b-info">{t(P + "tgRunning")}</span>;
  else if (job?.status === "pending") jobBadge = <span className="badge">{t(P + "tgQueued")}</span>;
  else if (job?.status === "error") jobBadge = <span className="badge b-bad">{t(P + "tgError")}</span>;
  else if (job?.status === "done") jobBadge = <span className="badge b-ok"><CheckCircle2 className="ic ic-s" />{t("tg.backfill_done", { chats: job.chats_scanned, msgs: job.messages_saved })}</span>;

  const msgLabel = (m: TgMessageItem) =>
    m.text || (m.kind === "voice" ? t("tg.msg_voice_short", { sec: m.voice_duration_sec ?? "?" }) : `[${m.kind}]`);

  return (
    <section id="op-tg" className="card col" style={{ overflow: "hidden", scrollMarginTop: 16 }}>
      <div className="card-h" style={{ flexWrap: "wrap" }}>
        <span className="h3">{t("op_detail.tg_dialogs_title")}</span>
        <span className="row g8 wrap">
          {jobBadge}
          {tgUser ? (
            <a className="btn btn-ghost btn-sm" href={`https://t.me/${tgUser.replace(/^@/, "")}`} target="_blank" rel="noreferrer">
              <ExternalLink className="ic ic-s" />
              {t(P + "tgOpen")}
            </a>
          ) : null}
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            onClick={() => {
              chatsQ.refetch();
              statusQ.refetch();
            }}
          >
            <RefreshCw className="ic ic-s" />
            {t("tg.dialogs_reload")}
          </button>
        </span>
      </div>

      {job && job.status !== "done" ? (
        <div className="row g8 s wrap" style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)" }}>
          {job.status === "running" ? t("tg.backfill_running", { chats: job.chats_scanned, msgs: job.messages_saved }) : null}
          {job.status === "pending" ? t("tg.backfill_pending") : null}
          {job.status === "error" ? (
            <>
              <span className="c-bad">{t("tg.backfill_error", { err: job.last_error ?? "" })}</span>
              <button className="btn btn-sm" type="button" disabled={retryMut.isPending} onClick={() => retryMut.mutate()}>{t("common.retry")}</button>
            </>
          ) : null}
        </div>
      ) : null}

      {chatsQ.isError ? (
        <ErrorState error={chatsQ.error} onRetry={() => chatsQ.refetch()} />
      ) : notConnected ? (
        <EmptyState icon={<Send className="ic ic-l" />} title={t(P + "tgNotConnected")} body={t(P + "tgNotConnectedBody")} />
      ) : !chatsQ.isLoading && !search && !(chatsQ.data?.length) ? (
        <EmptyState icon={<Send className="ic ic-l" />} title={t("tg.dialogs_no_chats")} body={t(P + "tgNoChatsBody")} />
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "290px minmax(0, 1fr)", minWidth: 680, height: 620 }}>
            {/* chats */}
            <div className="col" style={{ borderRight: "1px solid var(--line)", minHeight: 0 }}>
              <div style={{ padding: 12 }}>
                <div className="inwrap">
                  <Search className="ic" />
                  <input className="input" type="search" placeholder={t("tg.dialogs_search_ph")} aria-label={t("tg.dialogs_search_ph")} value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
              </div>
              <div style={{ overflowY: "auto", flex: "1 1 auto" }}>
                {chatsQ.isLoading ? (
                  <LoadingBlock rows={5} onRetry={() => chatsQ.refetch()} />
                ) : !chats.length ? (
                  <div className="s c3" style={{ padding: 16 }}>{search ? t(P + "tgNothingFound") : t("tg.dialogs_no_chats")}</div>
                ) : (
                  chats.map((c) => {
                    const title = c.partner_name || c.title || t("tg.chat_untitled");
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className="li"
                        onClick={() => {
                          setChatId(c.id);
                          setSelected(new Set());
                        }}
                        style={{ minHeight: 60, padding: "8px 12px", width: "100%", textAlign: "left", border: 0, borderBottom: "1px solid var(--line)", background: chatId === c.id ? "var(--brand-soft)" : "transparent", font: "inherit", color: "inherit", cursor: "pointer" }}
                      >
                        <span className="ava ava-s">{initials(title)}</span>
                        <span className="col grow" style={{ minWidth: 0 }}>
                          <span className="row between g8">
                            <span className="s w6 trunc">{title}</span>
                            <span className="num xs c3">{fmtShort(c.last_message_at)}</span>
                          </span>
                          {c.lead_name || c.partner_phone ? <span className="xs c3 trunc">{c.lead_name || c.partner_phone}</span> : null}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* messages */}
            <div className="col" style={{ position: "relative", minWidth: 0, minHeight: 0 }}>
              {!chatId ? (
                <div className="col" style={{ flex: "1 1 auto", alignItems: "center", justifyContent: "center", background: "var(--surface-2)" }}>
                  <span className="s c3">{t("tg.dialogs_select_chat")}</span>
                  <span className="xs c3" style={{ marginTop: 6 }}>{t(P + "tgMaxHint", { n: TG_MAX })}</span>
                </div>
              ) : (
                <>
                  {insight ? (
                    <div className="col g8" style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)", background: "var(--surface)" }}>
                      <div className="row g8">
                        <span className="s w6">{t("tg.insight_title")}</span>
                        <span className={cx("badge num", (insight.quality_score ?? 0) >= 80 ? "b-ok" : (insight.quality_score ?? 0) >= 50 ? "b-hot" : "b-bad")}>{insight.quality_score ?? 0}/100</span>
                      </div>
                      <span className="s c2">{insight.summary}</span>
                      {insight.red_flags?.length || insight.highlights?.length ? (
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                          <div className="col g4">
                            {insight.red_flags?.length ? <span className="xs w6 c-bad">{t("tg.insight_risks")}:</span> : null}
                            {insight.red_flags?.map((x, i) => <span key={i} className="xs c-bad">· {x}</span>)}
                          </div>
                          <div className="col g4">
                            {insight.highlights?.length ? <span className="xs w6 c-brand">{t("tg.insight_pros")}:</span> : null}
                            {insight.highlights?.map((x, i) => <span key={i} className="xs c-brand">· {x}</span>)}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="col g8" style={{ padding: `16px 18px ${selected.size ? 76 : 16}px`, background: "var(--surface-2)", flex: "1 1 auto", overflowY: "auto" }}>
                    {messagesQ.isLoading ? (
                      <LoadingBlock rows={4} onRetry={() => messagesQ.refetch()} />
                    ) : messagesQ.isError ? (
                      <ErrorState error={messagesQ.error} onRetry={() => messagesQ.refetch()} />
                    ) : (
                      msgs.map((m) => {
                        const out = m.direction === "out";
                        const sel = selected.has(m.id);
                        return (
                          <div key={m.id} className="row g8" style={{ justifyContent: out ? "flex-end" : "flex-start", alignItems: "flex-start" }}>
                            {out ? (
                              <input className="check" type="checkbox" checked={sel} onChange={() => toggle(m.id)} aria-label={t("tg.msg_select_aria")} style={{ marginTop: 8 }} />
                            ) : null}
                            <span
                              className="col g4"
                              onClick={out ? () => toggle(m.id) : undefined}
                              style={{ maxWidth: "70%", padding: "8px 12px", borderRadius: 12, background: out ? "var(--brand-soft)" : "var(--surface)", border: `1px solid ${sel ? "var(--brand)" : "var(--line)"}`, cursor: out ? "pointer" : "default" }}
                            >
                              {m.kind === "voice" ? (
                                <span className="row g6 s" style={{ fontStyle: "italic" }}>
                                  <Mic className="ic ic-s" />
                                  {t("tg.msg_voice_long", { sec: m.voice_duration_sec ?? "?" })}
                                </span>
                              ) : (
                                <span className="s" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.text || <span className="c3" style={{ fontStyle: "italic" }}>[{m.kind}]</span>}</span>
                              )}
                              <span className="num xs c3" style={{ textAlign: "right" }}>{fmtTime(m.sent_at)}</span>
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>
                  {selected.size ? (
                    <div className="row g12" style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "12px 18px", background: "var(--surface)", borderTop: "1px solid var(--line)" }}>
                      <span className="s">
                        {t("tg.selection_label")}: <span className="num w6">{t(P + "selectedOf", { n: selected.size, max: TG_MAX })}</span>
                      </span>
                      <button className="btn btn-ghost btn-sm" type="button" onClick={() => setSelected(new Set())}>
                        <X className="ic ic-s" />
                        {t("tg.selection_clear")}
                      </button>
                      <span className="grow" />
                      <button className="btn btn-pri btn-sm" type="button" disabled={coachingMut.isPending} onClick={() => coachingMut.mutate()}>
                        <Sparkles className="ic ic-s" />
                        {coachingMut.isPending ? t("tg.coaching_running") : t("tg.coaching_cta")}
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <Dialog
        open={!!result}
        onClose={() => setResult(null)}
        width={640}
        title={t("tg.coaching_modal_title")}
        sub={result ? `${name} · ${t("tg.coaching_issues_count", { n: result.issues.length })}` : undefined}
        footer={<button className="btn" type="button" onClick={() => setResult(null)}>{t("common.close")}</button>}
      >
        {result ? (
          <>
            {result.summary ? <div className="well s">{result.summary}</div> : null}
            {result.has_voice_selected ? (
              <div className="banner b-info">
                <Mic className="ic" />
                <span>
                  <span className="w6">{t("tg.coaching_demo_label")}:</span> {t("tg.coaching_voice_note")}
                </span>
              </div>
            ) : null}
            {result.error ? <div className="banner b-bad"><AlertTriangle className="ic" /><span>{result.error}</span></div> : null}
            {result.issues.length === 0 && !result.error ? (
              <EmptyState icon={<CheckCircle2 className="ic ic-l" />} title={t("tg.coaching_no_issues_title")} body={t("tg.coaching_no_issues_hint")} />
            ) : null}
            {result.issues.map((iss) => {
              const src = messagesQ.data?.find((m) => m.id === iss.message_id);
              return (
                <div key={iss.message_id} className="well col g8">
                  <div className="row between g8">
                    <span className="s c2" style={{ fontStyle: "italic", minWidth: 0 }}>{src ? `«${msgLabel(src)}»` : ""}</span>
                    <span className="row g8">
                      {src ? <span className="num xs c3">{fmtTime(src.sent_at)}</span> : null}
                      <span className={cx("badge", severityBadge(iss.severity))}>{t(`tg.coaching_severity_${iss.severity}`)}</span>
                    </span>
                  </div>
                  <div className="col g4">
                    <span className="lbl c-bad">{t("tg.coaching_problem_label")}</span>
                    <span className="s">{iss.problem}</span>
                  </div>
                  <div className="col g4">
                    <span className="lbl c-ok">{t("tg.coaching_suggestion_label")}</span>
                    <span className="s">{iss.suggestion}</span>
                  </div>
                </div>
              );
            })}
          </>
        ) : null}
      </Dialog>
    </section>
  );
}

/** Attendance data is behind the manager PIN (PinGate lives on /attendance/*). */
function OpDetailPinNotice() {
  const t = useT2();
  return (
    <div className="col g12" style={{ padding: 20 }}>
      <div className="banner b-info">
        <Lock className="ic" />
        <span className="col g4 grow">
          <span className="w6">{t("v2.team.operatorDetail.pinTitle")}</span>
          <span>{t("v2.team.operatorDetail.pinBody")}</span>
        </span>
        <Link className="btn btn-sm" to="/attendance/today">{t("v2.team.operatorDetail.pinAction")}</Link>
      </div>
    </div>
  );
}
