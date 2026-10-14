import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CalendarOff,
  Check,
  ChevronRight,
  Clock,
  Gift,
  Inbox,
  Info,
  RefreshCw,
  Sheet,
  SlidersHorizontal,
  Sparkles,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import { useAuth } from "../../store/auth";
import { useLang } from "../../store/lang";
import { useMe } from "../../hooks/useMe";
import { NAFFAI_NOTIF_EVENT, type NaffaiNotificationEventDetail } from "../../hooks/useNotificationStream";
import { isSaleSoundMuted } from "../../store/saleSound";
import { LEAD_STATUS_LABEL } from "../../lib/leads";
import { toast } from "../../components/ui";
import { useT2 } from "../i18n";
import { CountText, CountUp, Dialog, EmptyState, ErrorState, LoadingBlock, cx, fmtMln, fmtNum, useConfirm } from "../ui";
import {
  api,
  apiErrorText,
  useActiveOperators,
  useApproveSale,
  useBirthdaysToday,
  useBranchManagers,
  useCallsToday,
  useDashboardSummary,
  useDayOffPending,
  useDecideDayOff,
  useDistributeNow,
  useDistributionStatus,
  useFloor,
  useLeadHealth,
  useMarkNotificationRead,
  usePinStatus,
  useSalesPendingQueue,
  useSelfUser,
  useSheetSourceStats,
  useSheetSync,
  useUnreadSaleNotifications,
  type DashPeriod,
  type DashboardSummary,
  type FloorOperator,
  type LeadHealthPayload,
  type PendingSaleRow,
  type SeatState,
} from "../api/managerDaily";

type T = ReturnType<typeof useT2>;

const TZ = "Asia/Tashkent";

/* ─────────────────────────── helpers ─────────────────────────── */

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

function locale(lang: string) {
  return lang === "uz" ? "uz-Latn-UZ" : "ru-RU";
}

function hhmm(iso: string | number | Date | null | undefined) {
  if (iso === null || iso === undefined) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

/** Today in Tashkent as YYYY-MM-DD. */
function todayIso(now = Date.now()) {
  return new Date(now).toLocaleDateString("en-CA", { timeZone: TZ });
}

/** Minutes since midnight in Tashkent. */
function tashkentMinutes(now = Date.now()) {
  const [h, m] = new Date(now).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).split(":");
  return Number(h) * 60 + Number(m);
}

function parseHm(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(v);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function fmtHm(mins: number) {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function ago(t: T, iso: string, now: number) {
  const mins = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 1) return t("v2.home.justNow");
  if (mins < 60) return t("v2.home.ago", { t: t("v2.home.agoMin", { n: mins }) });
  if (mins < 24 * 60) return t("v2.home.ago", { t: t("v2.home.agoHour", { h: Math.floor(mins / 60), m: mins % 60 }) });
  return t("v2.home.ago", { t: t("v2.home.agoDays", { n: Math.floor(mins / 1440) }) });
}

/** «Jasur Toshmatov» → «Jasur T.» */
function shortName(full: string) {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return full;
  return `${parts[0]} ${parts[1][0]}.`;
}

function monthList(lang: string) {
  const out: { key: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const name = d.toLocaleDateString(locale(lang), { month: "long" });
    out.push({ key, label: `${name.charAt(0).toUpperCase()}${name.slice(1)} ${d.getFullYear()}` });
  }
  return out;
}

const BOTTLENECK_LABELS: Record<string, string> = {
  in_progress: "В работе",
  no_answer: "Не ответил (1)",
  no_answer_2: "Не ответил (2)",
  phone_on: "Телефон включён",
  callback_scheduled: "Запланирован callback",
  sms_jonatildi: "SMS отправлен",
  waiting_salary: "Ждёт зарплату",
  has_debt: "Есть долг",
  qimmatlik_qildi: "Дорого",
};

function statusLabel(code: string) {
  return BOTTLENECK_LABELS[code] || LEAD_STATUS_LABEL[code] || code;
}

function playSaleChime() {
  if (isSaleSoundMuted()) return;
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const tone = (freq: number, at: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + at);
      o.stop(ctx.currentTime + at + 0.4);
    };
    tone(880, 0);
    tone(1318.5, 0.16);
    window.setTimeout(() => ctx.close().catch(() => undefined), 1200);
  } catch {
    /* autoplay blocked — silent */
  }
}

/* ─────────────────────────── page ─────────────────────────── */

export default function Home() {
  const rawRole = useAuth((s) => s.role);
  if (rawRole === "operator") return <Navigate to="/my" replace />;
  const isSuper = rawRole === "super_manager" || rawRole === "superadmin";
  return <Pult isSuper={isSuper} />;
}

interface ShiftWindow {
  start: number | null;
  end: number | null;
}

function Pult({ isSuper }: { isSuper: boolean }) {
  const t = useT2();
  const nav = useNavigate();
  const lang = useLang((s) => s.lang);
  const username = useAuth((s) => s.username);
  const now = useNow(1000);

  const [period, setPeriod] = useState<DashPeriod>("day");
  const [month, setMonth] = useState("");
  /** "" = all, "none" = without manager, "<id>" = that manager's operators. */
  const [branch, setBranch] = useState("");

  const managersQ = useBranchManagers(isSuper);
  const selfQ = useSelfUser(username, isSuper);
  const selfId = selfQ.data?.id ?? null;

  const summary = useDashboardSummary(period, month, isSuper ? branch : "");
  const calls = useCallsToday();
  const health = useLeadHealth();
  const floor = useFloor();
  const ops = useActiveOperators();
  const dist = useDistributionStatus();
  const pending = useSalesPendingQueue();
  const dayOff = useDayOffPending();
  const bdays = useBirthdaysToday();
  const attSettings = useQuery<{ shift_start?: string | null; shift_end?: string | null }>({
    queryKey: ["attendance-settings-full"],
    queryFn: () => api.get("/attendance/settings/").then((r) => r.data),
    retry: false,
    staleTime: 10 * 60_000,
  });

  const months = useMemo(() => monthList(lang), [lang]);

  // Shift window (earliest start / latest end) for the before-shift and end-of-day states.
  const shift: ShiftWindow = useMemo(() => {
    const starts: number[] = [];
    const ends: number[] = [];
    const gs = parseHm(attSettings.data?.shift_start);
    const ge = parseHm(attSettings.data?.shift_end);
    for (const o of ops.data ?? []) {
      const s = parseHm(o.shift_start) ?? gs;
      const e = parseHm(o.shift_end) ?? ge;
      if (s !== null) starts.push(s);
      if (e !== null) ends.push(e);
    }
    if (!starts.length && gs !== null) starts.push(gs);
    if (!ends.length && ge !== null) ends.push(ge);
    return { start: starts.length ? Math.min(...starts) : null, end: ends.length ? Math.max(...ends) : null };
  }, [ops.data, attSettings.data]);

  const floorOps = useMemo(() => {
    const all = floor.data?.operators ?? [];
    if (!isSuper || !branch) return all;
    if (branch === "none") return all.filter((o) => o.managed_by_id == null);
    return all.filter((o) => o.managed_by_id === Number(branch));
  }, [floor.data, isSuper, branch]);

  const managerName = (id: number) => {
    if (selfId !== null && id === selfId) return t("v2.home.branchMineChip");
    const m = managersQ.data?.find((u) => u.id === id);
    return m ? m.full_name || m.username : t("v2.home.branchOther", { id });
  };

  const branchChips = useMemo(() => {
    if (!isSuper) return [];
    const all = floor.data?.operators ?? [];
    const counts = new Map<string, number>();
    for (const o of all) {
      const k = o.managed_by_id == null ? "none" : String(o.managed_by_id);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const keys = [...counts.keys()].filter((k) => k !== "none");
    keys.sort((a, b) => {
      const sa = selfId !== null && Number(a) === selfId ? 1 : 0;
      const sb = selfId !== null && Number(b) === selfId ? 1 : 0;
      return sa - sb || (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
    });
    const chips = keys.map((k) => ({ key: k, label: managerName(Number(k)), n: counts.get(k) ?? 0 }));
    if (counts.has("none")) chips.push({ key: "none", label: t("v2.home.branchNone"), n: counts.get("none") ?? 0 });
    return chips;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuper, floor.data, managersQ.data, selfId, lang]);

  const title = isSuper ? t("v2.home.titleSuper") : t("v2.home.titleManager");
  const dateLabel = new Date(now).toLocaleDateString(locale(lang), { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
  const periodWord = month ? months.find((m) => m.key === month)?.label ?? month : t(period === "day" ? "v2.home.pDay" : period === "week" ? "v2.home.pWeek" : "v2.home.pMonth");

  return (
    <>
      <header className="top" style={{ flexWrap: "wrap" }}>
        <div className="col" style={{ gap: 0 }}>
          <h1 className="h1">{title}</h1>
          <span className="xs c3">
            {dateLabel} · <span className="num">{hhmm(now)}</span> · {t("v2.home.live")}
          </span>
        </div>
        <span className="grow" />
        {isSuper ? (
          <select className="input" aria-label={t("v2.home.branchLabel")} style={{ width: 190, height: 36 }} value={branch} onChange={(e) => setBranch(e.target.value)}>
            <option value="">{t("v2.home.branchAll")}</option>
            {(managersQ.data ?? []).filter((m) => m.id !== selfId).map((m) => (
              <option key={m.id} value={String(m.id)}>{m.full_name || m.username}</option>
            ))}
            {selfId !== null ? <option value={String(selfId)}>{t("v2.home.branchMine")}</option> : null}
            <option value="none">{t("v2.home.branchNone")}</option>
            {branch && branch !== "none" && !(managersQ.data ?? []).some((m) => String(m.id) === branch) && String(selfId) !== branch ? (
              <option value={branch}>{managerName(Number(branch))}</option>
            ) : null}
          </select>
        ) : null}
        <div className="seg" role="tablist" aria-label={t("v2.home.periodLabel")}>
          {(["day", "week", "month"] as DashPeriod[]).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={!month && period === p}
              className={cx(!month && period === p && "is-on")}
              onClick={() => {
                setPeriod(p);
                setMonth("");
              }}
            >
              {t(p === "day" ? "v2.home.periodDay" : p === "week" ? "v2.home.periodWeek" : "v2.home.periodMonth")}
            </button>
          ))}
        </div>
        <span className="row g4">
          <select className="input" aria-label={t("v2.home.monthPicker")} style={{ width: 260, height: 36 }} value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="">{t("v2.home.monthPicker")}</option>
            {months.map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
          {month ? (
            <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("v2.home.resetMonth")} title={t("v2.home.resetMonth")} onClick={() => setMonth("")}>
              <X className="ic" />
            </button>
          ) : null}
        </span>
        {isSuper ? (
          <button className="btn btn-sq" type="button" aria-label={t("v2.home.askAi")} title={t("v2.home.askAi")} onClick={() => nav("/ai-chat")}>
            <Sparkles className="ic" />
          </button>
        ) : (
          <button className="btn" type="button" onClick={() => nav("/ai-chat")}>
            <Sparkles className="ic" />
            {t("v2.home.askAi")}
          </button>
        )}
      </header>

      <main className="page">
        <PinBanner />

        {summary.isError && !summary.data ? (
          <section className="card">
            <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
          </section>
        ) : (
          <Tablo summary={summary.data} loading={summary.isLoading} calls={calls.data} />
        )}

        <div className="row g20" style={{ alignItems: "stretch", flexWrap: "wrap" }}>
          <FloorCard
            isSuper={isSuper}
            floor={floor}
            ops={floorOps}
            shift={shift}
            now={now}
            chips={branchChips}
            branch={branch}
            setBranch={setBranch}
            summary={summary.data}
            pendingCount={pending.data?.count ?? 0}
          />
          <aside className="col g16" style={{ flex: "1 1 360px", minWidth: 0 }}>
            <TodoCard
              pending={pending.data?.results ?? []}
              pendingCount={pending.data?.count ?? 0}
              loading={pending.isLoading}
              dist={dist.data}
              floorOps={floorOps}
              health={health.data}
              dayOff={dayOff.data?.results ?? []}
              now={now}
            />
            <BirthdaysCard rows={bdays.data ?? []} />
          </aside>
        </div>

        <HealthSection health={health.data} loading={health.isLoading} error={health.isError ? health.error : null} onRetry={() => health.refetch()} />

        <div className="row g20" style={{ alignItems: "stretch", flexWrap: "wrap" }}>
          <LeaksCard data={health.data} />
          <StuckCard data={health.data} />
          <AttentionCard counters={summary.data?.attention} />
        </div>

        <div className="row g20" style={{ alignItems: "stretch", flexWrap: "wrap" }}>
          <SalesChart summary={summary.data} loading={summary.isLoading} />
          <TopOperators summary={summary.data} loading={summary.isLoading} periodWord={periodWord} />
        </div>

        <div className="row between xs c3 wrap g8">
          <span>{t("v2.home.footer", { period: periodWord })}</span>
          {summary.data ? <span>{t("v2.home.footerAuto", { sum: fmtNum(summary.data.turnover.actual) })}</span> : null}
        </div>
      </main>

      <MorningDialog
        isSuper={isSuper}
        branch={isSuper ? branch : ""}
        summary={summary.data}
        pendingCount={pending.data?.count ?? 0}
        orphans={dist.data?.orphans_count ?? 0}
        callbacks={floorOps.reduce((a, o) => a + (o.overdue_callbacks || 0), 0)}
        dayOffCount={dayOff.data?.count ?? dayOff.data?.results?.length ?? 0}
        bdays={bdays.data ?? []}
      />
      <SaleOverlay />
    </>
  );
}

/* ─────────────────────────── tablo ─────────────────────────── */

function Tablo({ summary, loading, calls }: { summary?: DashboardSummary; loading: boolean; calls?: { total_calls: number; avg_duration_seconds: number | null } }) {
  const t = useT2();
  if (loading || !summary) {
    return (
      <section className="card row wrap" style={{ padding: 0, overflow: "hidden" }} aria-busy="true">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="col g8" style={{ flex: "1 1 180px", padding: "16px 20px", borderRight: "1px solid var(--line)" }}>
            <i className="sk" style={{ display: "block", height: 10, width: 110 }} />
            <i className="sk" style={{ display: "block", height: 28, width: 90 }} />
            <i className="sk" style={{ display: "block", height: 12, width: 130 }} />
          </div>
        ))}
      </section>
    );
  }
  const ts = summary.timeseries ?? [];
  const today = ts[ts.length - 1];
  const yesterday = ts[ts.length - 2];
  const doneDelta = today && yesterday ? Number(today.count) - Number(yesterday.count) : null;
  const target = Number(summary.turnover.target ?? 0);
  const actual = Number(summary.turnover.actual ?? 0);
  const planPct = target > 0 ? Math.round((actual / target) * 100) : null;
  const conv = summary.conversion.delta_pp ?? 0;
  const missing = Math.max(0, (summary.shift.expected ?? 0) - (summary.shift.on_shift ?? 0));
  const avg = calls?.avg_duration_seconds;

  const items: Array<{ label: string; value: string; badge?: string; tone?: string; note?: string; to: string }> = [
    {
      label: t("v2.home.kDone"),
      value: String(summary.today.count ?? 0),
      badge: doneDelta !== null ? `${doneDelta > 0 ? "+" : doneDelta < 0 ? "−" : "±"}${Math.abs(doneDelta)}` : undefined,
      tone: doneDelta === null ? "" : doneDelta > 0 ? "b-ok" : doneDelta < 0 ? "b-bad" : "",
      note: summary.today.pending_count > 0 ? t("v2.home.kDoneNote", { n: summary.today.pending_count }) : t("v2.home.kDoneDelta"),
      to: "/sales-today",
    },
    {
      label: t("v2.home.kTurnover"),
      value: fmtMln(actual),
      badge: planPct !== null ? t("v2.home.kPlanPct", { n: planPct }) : undefined,
      tone: planPct === null ? "" : planPct >= 100 ? "b-ok" : "",
      note: target > 0 ? t("v2.home.kTurnoverPlan", { v: fmtMln(target) }) : t("v2.home.kTurnoverNoPlan"),
      to: "/sales",
    },
    {
      label: t("v2.home.kConv"),
      value: `${(summary.conversion.value_pct ?? 0).toFixed(1).replace(".", ",")}%`,
      badge: `${conv > 0 ? "+" : conv < 0 ? "−" : "±"}${Math.abs(conv).toFixed(1).replace(".", ",")} ${t("v2.home.pp")}`,
      tone: conv > 0.01 ? "b-ok" : conv < -0.01 ? "b-bad" : "",
      note: t("v2.home.kConvNote"),
      to: "/leads-stats",
    },
    {
      label: t("v2.home.kShift"),
      value: `${summary.shift.on_shift ?? 0} / ${summary.shift.expected ?? 0}`,
      badge: summary.shift.late_today > 0 ? t("v2.home.kShiftLate", { n: summary.shift.late_today }) : undefined,
      tone: summary.shift.late_today > 0 ? "b-warn" : "",
      note: missing > 0 ? t("v2.home.kShiftMissing", { n: missing }) : undefined,
      to: "/attendance/today",
    },
    {
      label: t("v2.home.kCalls"),
      value: calls ? fmtNum(calls.total_calls) : "—",
      badge: avg ? mmss(avg * 1000).replace(/^0(\d:)/, "$1") : undefined,
      tone: "",
      note: avg ? t("v2.home.kCallsAvg") : undefined,
      to: "/calls",
    },
  ];

  return (
    <section className="card row wrap" style={{ padding: 0, overflow: "hidden" }} aria-label={t("v2.home.tablo")}>
      {items.map((k) => (
        <Link key={k.label} to={k.to} className="col g4" style={{ flex: "1 1 180px", padding: "16px 20px", borderRight: "1px solid var(--line)" }}>
          <span className="lbl">{k.label}</span>
          <span className="kpi"><CountText text={k.value} /></span>
          <span className="row g6 xs">
            {k.badge ? <span className={cx("badge", k.tone)} style={{ height: 20 }}>{k.badge}</span> : null}
            {k.note ? <span className="c3">{k.note}</span> : null}
          </span>
        </Link>
      ))}
    </section>
  );
}

/* ─────────────────────────── floor ─────────────────────────── */

const SEAT_CLS: Record<SeatState, string> = {
  call: "st-call",
  wait: "st-wait",
  pause: "st-pause",
  late: "st-late",
  absent: "st-off",
  off: "st-off",
  dayoff: "st-off",
};
const STATE_TONE: Record<SeatState, string> = {
  call: "c-brand",
  wait: "c-ok",
  pause: "c-warn",
  late: "c-bad",
  absent: "c3",
  off: "c3",
  dayoff: "c3",
};

function FloorCard({
  isSuper,
  floor,
  ops,
  shift,
  now,
  chips,
  branch,
  setBranch,
  summary,
  pendingCount,
}: {
  isSuper: boolean;
  floor: ReturnType<typeof useFloor>;
  ops: FloorOperator[];
  shift: ShiftWindow;
  now: number;
  chips: Array<{ key: string; label: string; n: number }>;
  branch: string;
  setBranch: (v: string) => void;
  summary?: DashboardSummary;
  pendingCount: number;
}) {
  const t = useT2();
  const data = floor.data;
  const stale = !!data && (floor.isError || now - floor.dataUpdatedAt > 35_000);
  const frozenAt = stale ? floor.dataUpdatedAt : now;
  const nowMin = tashkentMinutes(now);
  const beforeShift = !!data && shift.start !== null && nowMin >= 5 * 60 && nowMin < shift.start;
  const afterShift = !!data && shift.end !== null && nowMin >= shift.end;
  const allCount = data?.operators.length ?? 0;

  const counts = useMemo(() => {
    const c: Record<SeatState, number> = { call: 0, wait: 0, pause: 0, late: 0, absent: 0, off: 0, dayoff: 0 };
    for (const o of ops) c[o.state] = (c[o.state] ?? 0) + 1;
    return c;
  }, [ops]);

  let meta: ReactNode = data?.fallback ? t("v2.home.floorFallback", { n: ops.length }) : t("v2.home.floorMeta", { n: ops.length });
  if (stale) meta = t("v2.home.staleMeta", { t: hhmm(floor.dataUpdatedAt) });
  else if (beforeShift && summary) meta = t("v2.home.beforeShiftMeta", { t: fmtHm(shift.start!), a: summary.shift.on_shift ?? 0, b: summary.shift.expected ?? 0 });
  else if (afterShift && summary) meta = t("v2.home.endOfDayMeta", { t: fmtHm(shift.end!), n: summary.today.count ?? 0 });

  const legend: Array<{ k: SeatState; color: string; label: string; always?: boolean }> = [
    { k: "call", color: "var(--brand)", label: t("v2.home.st.call"), always: !data?.fallback },
    { k: "wait", color: "var(--ok-solid)", label: t("v2.home.st.wait"), always: true },
    { k: "pause", color: "var(--warn-solid)", label: t("v2.home.st.pause"), always: true },
    { k: "late", color: "var(--bad-solid)", label: t("v2.home.st.late"), always: !data?.fallback },
    { k: "absent", color: "var(--ink-4)", label: t("v2.home.st.absent"), always: !data?.fallback },
    { k: "off", color: "var(--ink-4)", label: t("v2.home.st.off") },
    { k: "dayoff", color: "var(--ink-4)", label: t("v2.home.st.dayoff") },
  ];

  let body: ReactNode;
  if (floor.isLoading) body = <LoadingBlock rows={4} onRetry={() => floor.refetch()} />;
  else if (!data) body = <ErrorState error={floor.error} onRetry={() => floor.refetch()} />;
  else if (allCount === 0)
    body = (
      <div className="empty" style={{ flex: "1 1 0", justifyContent: "center", minHeight: 360 }}>
        <span className="h3" style={{ color: "var(--ink)" }}>{t("v2.home.emptyTeamTitle")}</span>
        <span className="s" style={{ maxWidth: 380 }}>{isSuper ? t("v2.home.emptyBranchBody") : t("v2.home.emptyTeamBody")}</span>
        <div className="row g8 wrap" style={{ justifyContent: "center" }}>
          <Link className="btn btn-pri" to="/operators">{t("v2.home.addOperator")}</Link>
          {isSuper ? <Link className="btn" to="/team/managers">{t("v2.home.toBoard")}</Link> : <Link className="btn" to="/settings">{t("v2.home.setupAuto")}</Link>}
        </div>
      </div>
    );
  else if (ops.length === 0) body = <EmptyState icon={<Users className="ic ic-l" />} title={t("v2.home.emptyFilter")} action={<Link className="btn" to="/team/managers">{t("v2.home.toBoard")}</Link>} />;
  else
    body = (
      <>
        {stale ? (
          <div className="banner b-bad" style={{ margin: "16px 16px 0" }}>
            <WifiOff className="ic" />
            <span className="col g4">
              <span className="w6">{t("v2.home.staleTitle")}</span>
              <span>{t("v2.home.staleBody", { t: hhmm(floor.dataUpdatedAt) })}</span>
            </span>
          </div>
        ) : beforeShift ? (
          <div className="banner b-info" style={{ margin: "16px 16px 0" }}>
            <Info className="ic" />
            <span>{t("v2.home.beforeShift", { n: Math.max(1, shift.start! - nowMin) })}</span>
          </div>
        ) : null}
        <div className="floor" style={{ padding: 16, flex: "1 1 auto", gridAutoRows: "1fr", gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))" }}>
          {ops.map((o) => (
            <Seat key={o.id} op={o} refNow={frozenAt} beforeShift={beforeShift} dim={stale} />
          ))}
        </div>
        {stale ? (
          <div className="row g8" style={{ padding: "0 16px 16px" }}>
            <button className="btn btn-pri" type="button" onClick={() => floor.refetch()} disabled={floor.isFetching}>
              <RefreshCw className="ic" />
              {t("v2.home.refresh")}
            </button>
            <span className="xs c3">{t("v2.home.staleAuto")}</span>
          </div>
        ) : beforeShift && pendingCount > 0 ? (
          <div className="li" style={{ minHeight: 52 }}>
            <span className="s grow">{t("v2.home.pendingYesterday")}</span>
            <span className="num w6">{pendingCount}</span>
            <Link className="btn btn-sm" to="/sales/pending">{t("v2.home.check")}</Link>
          </div>
        ) : null}
      </>
    );

  return (
    <section className="card col" style={{ flex: "999 1 640px", minWidth: 0 }} aria-label={t("v2.home.floor")}>
      <div className="card-h" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="col">
          <span className="h3">{t("v2.home.floor")}</span>
          <span className="xs c3">{meta}</span>
        </div>
        {data && ops.length > 0 ? (
          <div className="row g12 xs c2 wrap" style={{ justifyContent: "flex-end" }}>
            {legend
              .filter((l) => l.always || counts[l.k] > 0)
              .map((l) => (
                <span key={l.k} className="row g6" title={l.k === "call" && ops.some((o) => o.state === "call" && o.call_is_estimate) ? t("v2.home.st.callApproxHint") : undefined}>
                  <i className="dot" style={{ color: l.color }} />
                  {l.k === "call" && ops.some((o) => o.state === "call" && o.call_is_estimate) ? t("v2.home.st.callApprox") : l.label}{" "}
                  <span className="num w6">{counts[l.k]}</span>
                </span>
              ))}
          </div>
        ) : null}
      </div>
      {isSuper && chips.length > 0 ? (
        <div className="row g8 wrap" style={{ padding: "12px 16px 0" }}>
          <button className={cx("chip", !branch && "is-on")} type="button" onClick={() => setBranch("")}>
            {t("v2.home.chipAll")} <span className="n">{allCount}</span>
          </button>
          {chips.map((c) => (
            <button key={c.key} className={cx("chip", branch === c.key && "is-on")} type="button" onClick={() => setBranch(c.key)}>
              {c.label} <span className="n">{c.n}</span>
            </button>
          ))}
        </div>
      ) : null}
      {body}
    </section>
  );
}

function Seat({ op, refNow, beforeShift, dim }: { op: FloorOperator; refNow: number; beforeShift: boolean; dim: boolean }) {
  const t = useT2();
  let label: string = t(`v2.home.st.${op.state}`);
  let extra = "";
  let hint: string | undefined;
  switch (op.state) {
    case "call":
      if (op.call_started_at) extra = mmss(refNow - new Date(op.call_started_at).getTime());
      if (op.call_is_estimate) {
        label = t("v2.home.st.callApprox");
        hint = t("v2.home.st.callApproxHint");
      }
      break;
    case "pause":
      if (op.paused_at) extra = t("v2.home.min", { n: Math.max(0, Math.floor((refNow - new Date(op.paused_at).getTime()) / 60000)) });
      break;
    case "late":
      if (op.late_minutes) extra = t("v2.home.min", { n: op.late_minutes });
      break;
    case "wait":
      if (beforeShift && op.checked_in_at) label = t("v2.home.st.checkedIn", { t: hhmm(op.checked_in_at) });
      else if (op.quota > 0 && op.working_count >= op.quota) label = t("v2.home.st.busy");
      break;
    case "off":
      if (beforeShift) label = t("v2.home.st.offBefore");
      break;
  }
  const atWork = op.state === "call" || op.state === "wait" || op.state === "pause" || op.state === "late";
  const slots = atWork && op.quota > 0 ? `${op.working_count}/${op.quota}` : "—";
  return (
    <Link
      to={`/operators/${op.id}`}
      className={cx("seat", SEAT_CLS[op.state])}
      style={dim ? { opacity: 0.55 } : undefined}
      title={[op.full_name, hint, t("v2.home.salesToday", { n: op.sales_today }), atWork && op.quota > 0 ? t("v2.home.slots", { a: op.working_count, b: op.quota }) : ""].filter(Boolean).join("\n")}
    >
      <span className="row g6" style={{ minWidth: 0 }}>
        <span className="s w6 trunc">{shortName(op.full_name)}</span>
      </span>
      <span className={cx("xs", STATE_TONE[op.state])}>
        {label}
        {extra ? ` · ${extra}` : ""}
      </span>
      <span className="row between" style={{ marginTop: "auto", alignItems: "baseline" }}>
        <span className="sales">{op.sales_today}</span>
        <span className="num xs c3">{slots}</span>
      </span>
    </Link>
  );
}

/* ─────────────────────────── to-do queue ─────────────────────────── */

function TodoItem({ tile, icon, title, note, children }: { tile: string; icon: ReactNode; title: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="row-item" style={{ alignItems: "flex-start", minHeight: 0, padding: "12px 16px", gap: 12 }}>
      <span className={cx("icon-tile", tile)} style={{ width: 32, height: 32, flex: "none" }}>{icon}</span>
      <span className="col grow" style={{ gap: 6, minWidth: 0 }}>
        <span className="col" style={{ gap: 1 }}>
          <span className="s w6">{title}</span>
          {note ? <span className="xs c3">{note}</span> : null}
        </span>
        {children ? <span className="row g6 wrap">{children}</span> : null}
      </span>
    </div>
  );
}

function TodoCard({
  pending,
  pendingCount,
  loading,
  dist,
  floorOps,
  health,
  dayOff,
  now,
}: {
  pending: PendingSaleRow[];
  pendingCount: number;
  loading: boolean;
  dist?: ReturnType<typeof useDistributionStatus>["data"];
  floorOps: FloorOperator[];
  health?: LeadHealthPayload;
  dayOff: Array<{ id: number; operator_id: number; operator_name: string; date: string; reason: string }>;
  now: number;
}) {
  const t = useT2();
  const lang = useLang((s) => s.lang);
  const confirm = useConfirm();
  const approve = useApproveSale();
  const distribute = useDistributeNow();
  const decide = useDecideDayOff();

  const shown = pending.slice(0, 3);
  const callbacks = floorOps.filter((o) => (o.overdue_callbacks || 0) > 0).sort((a, b) => b.overdue_callbacks - a.overdue_callbacks).slice(0, 3);
  const syncErrs = health?.leaks.sync_errors ?? [];
  const orphans = dist?.orphans_count ?? 0;

  const total = Math.min(pendingCount, 3) + (pendingCount > 3 ? 1 : 0) + (orphans > 0 ? 1 : 0) + callbacks.length + syncErrs.length + Math.min(dayOff.length, 2);

  const onApprove = (id: number) =>
    approve.mutate(id, {
      onSuccess: () => toast.success(t("v2.home.approved")),
      onError: (e) => toast.error(apiErrorText(e, t("v2.home.approveFailed"))),
    });

  const onDistribute = async () => {
    const ok = await confirm({ title: t("v2.home.distConfirmTitle", { n: orphans }), body: t("v2.home.distConfirmBody"), confirm: t("v2.home.distribute") });
    if (!ok) return;
    distribute.mutate(undefined, {
      onSuccess: (d) => (d.total === 0 ? toast(t("v2.home.poolEmpty")) : toast.success(t("v2.home.distributed", { n: d.total }))),
      onError: (e) => toast.error(apiErrorText(e, t("v2.state.errorTitle"))),
    });
  };

  const onDayOff = (id: number) =>
    decide.mutate(
      { id, decision: "approve" },
      {
        onSuccess: () => toast.success(t("v2.home.dayoffApproved")),
        onError: (e) => toast.error(apiErrorText(e, t("v2.home.dayoffFailed"))),
      },
    );

  return (
    <section className="card col" aria-label={t("v2.home.todo")}>
      {confirm.node}
      <div className="card-h">
        <span className="h3">{t("v2.home.todo")}</span>
        {total > 0 ? (
          <span className="badge b-bad"><span className="num">{total}</span></span>
        ) : null}
      </div>
      {loading ? <LoadingBlock rows={3} /> : null}
      {!loading && total === 0 ? <EmptyState icon={<Check className="ic ic-l" />} title={t("v2.home.todoEmpty")} body={t("v2.home.todoEmptyBody")} /> : null}

      {shown.map((s) => {
        const partners = s.partner_lines?.length ? s.partner_lines.map((p) => p.partner_name).join(" + ") : s.channel_name;
        const photos = s.contract_photos_all?.length ?? (s.contract_photo ? 1 : 0);
        const note = [s.operator_name, partners, photos ? t("v2.home.photos", { n: photos }) : null, ago(t, s.created_at, now)].filter(Boolean).join(" · ");
        const busy = approve.isPending && approve.variables === s.id;
        return (
          <TodoItem key={`s${s.id}`} tile="t-warn" icon={<Check className="ic" />} title={t("v2.home.saleWaits", { model: s.phone_model, amount: fmtNum(s.amount) })} note={note}>
            <button className="btn btn-sm btn-ok" type="button" disabled={busy} onClick={() => onApprove(s.id)}>
              {t("v2.home.approve")}
            </button>
            <Link className="btn btn-ghost btn-sm" to={`/sales/${s.id}`}>{t("v2.home.open")}</Link>
          </TodoItem>
        );
      })}
      {pendingCount > 3 ? (
        <TodoItem tile="t-warn" icon={<Check className="ic" />} title={t("v2.home.moreSales", { n: pendingCount - 3 })} note={t("v2.home.moreSalesNote")}>
          <Link className="btn btn-sm" to="/sales/pending">{t("v2.home.check")}</Link>
        </TodoItem>
      ) : null}

      {orphans > 0 ? (
        <TodoItem
          tile="t-info"
          icon={<Inbox className="ic" />}
          title={t("v2.home.orphans", { n: orphans })}
          note={!dist?.auto_distribution_enabled ? t("v2.home.autoOff") : dist?.orphans_oldest ? t("v2.home.orphansOldest", { t: new Date(dist.orphans_oldest).toLocaleString(locale(lang), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ }) }) : undefined}
        >
          {dist?.auto_distribution_enabled ? (
            <button className="btn btn-sm btn-pri" type="button" disabled={distribute.isPending} onClick={onDistribute}>
              {t("v2.home.distribute")}
            </button>
          ) : null}
          <Link className="btn btn-ghost btn-sm" to="/leads/orphans">{t("v2.home.list")}</Link>
        </TodoItem>
      ) : null}

      {callbacks.map((o) => (
        <TodoItem key={`c${o.id}`} tile="t-bad" icon={<Clock className="ic" />} title={t("v2.home.callback", { name: o.full_name })} note={t("v2.home.callbackNote", { n: o.overdue_callbacks })}>
          <Link className="btn btn-ghost btn-sm" to={`/operators/${o.id}`}>{t("v2.home.operatorCard")}</Link>
        </TodoItem>
      ))}

      {syncErrs.map((s) => (
        <SheetErrTodo key={`e${s.source_id}`} id={s.source_id} name={s.source_name} error={s.error} />
      ))}

      {dayOff.slice(0, 2).map((d) => (
        <TodoItem
          key={`d${d.id}`}
          tile="t-info"
          icon={<CalendarOff className="ic" />}
          title={t("v2.home.dayoff", { name: d.operator_name, date: new Date(d.date).toLocaleDateString(locale(lang), { day: "numeric", month: "long" }) })}
          note={d.reason || undefined}
        >
          <button className="btn btn-sm" type="button" disabled={decide.isPending && decide.variables?.id === d.id} onClick={() => onDayOff(d.id)}>
            {t("v2.home.approve")}
          </button>
          <Link className="btn btn-ghost btn-sm" to="/operators/day-off">{t("v2.home.open")}</Link>
        </TodoItem>
      ))}
    </section>
  );
}

function syncToast(t: T, d: { read?: number; created?: number; merged?: number; imported?: number }) {
  toast.success(
    t("sheet_src.health.sync_ok_detailed", { created: String(d.created ?? 0), read: String(d.read ?? 0), merged: String(d.merged ?? 0) }) ||
      t("sheet_src.health.sync_ok", { n: String(d.created ?? d.imported ?? 0) }),
  );
}

function SheetErrTodo({ id, name, error }: { id: number; name: string; error: string }) {
  const t = useT2();
  const sync = useSheetSync(id);
  return (
    <TodoItem tile="t-hot" icon={<Sheet className="ic" />} title={t("v2.home.sheetErr", { name })} note={<span className="trunc" title={error} style={{ display: "block" }}>{error}</span>}>
      <button
        className="btn btn-sm"
        type="button"
        disabled={sync.isPending}
        onClick={() =>
          sync.mutate(false, {
            onSuccess: (d) => syncToast(t, d),
            onError: (e) => toast.error(apiErrorText(e, t("sheet_src.health.sync_failed"))),
          })
        }
      >
        {sync.isPending ? t("sheet_src.health.syncing") : t("sheet_src.health.sync_now")}
      </button>
      <Link className="btn btn-ghost btn-sm" to="/sheet-sources">{t("v2.home.sheets")}</Link>
    </TodoItem>
  );
}

/* ─────────────────────────── birthdays ─────────────────────────── */

function BirthdaysCard({ rows }: { rows: Array<{ operator_id: number; full_name: string; phone: string; age: number }> }) {
  const t = useT2();
  if (!rows.length) return null;
  return (
    <section className="card col" aria-label={t("v2.home.bdTitle")} style={{ borderColor: "var(--hot-solid)" }}>
      <div className="card-h">
        <span className="row g8">
          <span className="icon-tile t-hot" style={{ width: 30, height: 30 }}><Gift className="ic" /></span>
          <span className="h3">{t("v2.home.bdTitle")}</span>
        </span>
        <span className="badge"><span className="num">{rows.length}</span></span>
      </div>
      {rows.map((b) => (
        <div key={b.operator_id} className="li" style={{ minHeight: 46 }}>
          <Link className="s grow trunc" to={`/operators/${b.operator_id}`}>
            <span className="w6">{b.full_name}</span> <span className="c3 num">{t("v2.home.bdAge", { n: b.age })}</span>
          </Link>
          {b.phone ? <a className="num xs c2" href={`tel:${b.phone}`}>{b.phone}</a> : null}
        </div>
      ))}
    </section>
  );
}

/* ─────────────────────────── sheet health ─────────────────────────── */

function HealthSection({ health, loading, error, onRetry }: { health?: LeadHealthPayload; loading: boolean; error: unknown; onRetry: () => void }) {
  const t = useT2();
  const sources = health?.sheet_sources ?? [];
  return (
    <section className="col g12" aria-label={t("v2.home.health")}>
      <div className="row between">
        <span className="lbl">{t("v2.home.health")}</span>
        <Link className="btn btn-ghost btn-sm" to="/sheet-sources">{t("v2.home.allSheets")}</Link>
      </div>
      {loading ? (
        <section className="card"><LoadingBlock rows={2} /></section>
      ) : error && !health ? (
        <section className="card"><ErrorState error={error} onRetry={onRetry} /></section>
      ) : sources.length === 0 ? (
        <section className="card row between g12 wrap" style={{ padding: "14px 16px" }}>
          <span className="s c3">{t("dash.health.no_sheet_sources")}</span>
          <Link className="btn btn-sm" to="/sheet-sources">{t("dash.health.open_sheet_sources")}</Link>
        </section>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12, alignItems: "start" }}>
          {sources.slice(0, 4).map((s) => (
            <SheetCard key={s.id} id={s.id} fallbackName={s.name} />
          ))}
        </div>
      )}
    </section>
  );
}

function SheetCard({ id, fallbackName }: { id: number; fallbackName: string }) {
  const t = useT2();
  const confirm = useConfirm();
  const q = useSheetSourceStats(id);
  const sync = useSheetSync(id);
  const [errOpen, setErrOpen] = useState(false);
  const s = q.data;
  const status: "ok" | "warn" | "bad" = !s ? "warn" : s.last_sync_error ? "bad" : s.is_healthy ? "ok" : "warn";
  const color = { ok: "var(--ok-solid)", warn: "var(--warn-solid)", bad: "var(--bad-solid)" }[status];
  const label = { ok: t("sheet_src.health.ok"), warn: t("sheet_src.health.warn"), bad: t("sheet_src.health.bad") }[status];
  const last = s?.last_sync_at
    ? new Date(s.last_sync_at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TZ }).replace(",", "")
    : "—";
  const run = (force: boolean) =>
    sync.mutate(force, {
      onSuccess: (d) => syncToast(t, d),
      onError: (e) => toast.error(apiErrorText(e, t("sheet_src.health.sync_failed"))),
    });
  const rescan = async () => {
    const ok = await confirm({ title: t("v2.home.rescanTitle"), body: t("v2.home.rescanBody", { name: s?.name || fallbackName }), confirm: t("sheet_src.health.full_rescan_btn") });
    if (ok) run(true);
  };
  return (
    <div className="card col g12" style={{ padding: "14px 16px" }}>
      {confirm.node}
      <div className="row between" style={{ alignItems: "flex-start" }}>
        <span className="col" style={{ gap: 3, minWidth: 0 }}>
          <span className="s w6 trunc">{s?.name || fallbackName}</span>
          <span className="row g6 xs c3">
            <i className="dot" style={{ color, width: 8, height: 8 }} />
            {label}
          </span>
        </span>
        <Link className="btn btn-ghost btn-sq btn-sm" to="/sheet-sources" aria-label={t("sheet_src.health.configure")} title={t("sheet_src.health.configure")}>
          <SlidersHorizontal className="ic" />
        </Link>
      </div>
      <div className="row between" style={{ alignItems: "flex-end" }}>
        <span className="col">
          <span className="display" style={{ fontSize: 22, lineHeight: "26px" }}>{s ? fmtNum(s.leads_last_24h) : "—"}</span>
          <span className="xs c3">{t("sheet_src.health.leads_24h")}</span>
        </span>
        <span className="col xs c3" style={{ textAlign: "right" }}>
          <span>
            {t("sheet_src.health.last_sync")}: <span className="num">{last}</span>
          </span>
          <span>{t("sheet_src.health.leads_total", { n: s ? fmtNum(s.leads_total) : "0" })}</span>
        </span>
      </div>
      <div className="row g6">
        <button className="btn btn-sm grow" type="button" style={{ padding: "0 8px" }} disabled={sync.isPending} title={t("sheet_src.health.sync_now_hint")} onClick={() => run(false)}>
          <RefreshCw className="ic" style={sync.isPending ? { animation: "spin 1s linear infinite" } : undefined} />
          {sync.isPending ? t("sheet_src.health.syncing") : t("sheet_src.health.sync_now")}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" style={{ padding: "0 8px" }} disabled={sync.isPending} title={t("sheet_src.health.full_rescan_title")} onClick={rescan}>
          {t("sheet_src.health.full_rescan_btn")}
        </button>
      </div>
      {status === "bad" && s?.last_sync_error ? (
        <div className="col g6">
          <button className="xs c-bad w6" type="button" style={{ padding: 0, border: 0, background: "none", textAlign: "left", textDecoration: "underline", cursor: "pointer" }} onClick={() => setErrOpen((v) => !v)}>
            {errOpen ? t("sheet_src.health.hide_error") : t("sheet_src.health.show_error")}
          </button>
          {errOpen ? (
            <div className="xs c-bad" style={{ background: "var(--bad-bg)", borderRadius: 8, padding: "8px 10px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {s.last_sync_error}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── leaks / stuck / attention ─────────────────────────── */

function LinkRow({ to, children, style }: { to?: string; children: ReactNode; style?: React.CSSProperties }) {
  if (!to) return <div className="li" style={style}>{children}</div>;
  return (
    <Link className="li" to={to} style={style}>
      {children}
      <ChevronRight className="ic c3" />
    </Link>
  );
}

function LeaksCard({ data }: { data?: LeadHealthPayload }) {
  const t = useT2();
  const leaks = data?.leaks;
  const lost = leaks?.system_lost_24h ?? 0;
  const avg = leaks?.system_lost_7d_avg ?? 0;
  const sky = lost > 0 && avg > 0 && lost > avg * 1.3;
  const hi = leaks?.high_lost_operators ?? [];
  const errs = leaks?.sync_errors ?? [];
  return (
    <section className="card col" style={{ flex: "1 1 300px", minWidth: 0 }} aria-label={t("v2.home.leaks")}>
      <div className="card-h">
        <span className="row g8"><AlertTriangle className="ic c-bad" /><span className="h3">{t("v2.home.leaks")}</span></span>
        <span className="xs c3">{t("v2.home.h24")}</span>
      </div>
      {!data ? <LoadingBlock rows={3} /> : (
        <>
          <LinkRow to="/leads/system-lost" style={{ minHeight: 52 }}>
            <span className="col grow" style={{ minWidth: 0 }}>
              <span className="s c2">{t("v2.home.lostSystem")}</span>
              <span className="xs trunc c3">{t("v2.home.lostAvg", { n: String(avg) })}</span>
            </span>
            <span className={cx("num w6", sky && "c-bad")} style={{ fontSize: 15 }}>{lost}</span>
          </LinkRow>
          <LinkRow to="/leads?status=no_answer" style={{ minHeight: 52 }}>
            <span className="col grow" style={{ minWidth: 0 }}><span className="s c2">{t("v2.home.staleNoAnswer")}</span></span>
            <span className="num w6" style={{ fontSize: 15 }}>{leaks?.stale_no_answer_48h ?? 0}</span>
          </LinkRow>
          <LinkRow to={hi.length ? "/leads-stats" : undefined} style={{ minHeight: 52 }}>
            <span className="col grow" style={{ minWidth: 0 }}>
              <span className="s c2">{t("v2.home.highLost")}</span>
              {hi.length ? <span className="xs trunc c-bad" title={hi.map((o) => `${o.name} (${o.lost_pct}%)`).join(", ")}>{hi.map((o) => `${o.name} (${o.lost_pct}%)`).join(", ")}</span> : null}
            </span>
            <span className="num w6" style={{ fontSize: 15 }}>{hi.length || "—"}</span>
          </LinkRow>
          <LinkRow to="/sheet-sources" style={{ minHeight: 52 }}>
            <span className="col grow" style={{ minWidth: 0 }}>
              <span className="s c2">{t("v2.home.syncErrors")}</span>
              {errs.length ? <span className="xs trunc c-bad">{errs.map((s) => s.source_name).join(", ")}</span> : null}
            </span>
            <span className={cx("num w6", errs.length > 0 && "c-bad")} style={{ fontSize: 15 }}>{errs.length || "—"}</span>
          </LinkRow>
        </>
      )}
    </section>
  );
}

function StuckCard({ data }: { data?: LeadHealthPayload }) {
  const t = useT2();
  const items = data?.bottlenecks ?? [];
  const max = Math.max(1, ...items.map((b) => b.count));
  return (
    <section className="card col" style={{ flex: "1 1 300px", minWidth: 0 }} aria-label={t("v2.home.stuck")}>
      <div className="card-h">
        <span className="row g8"><Activity className="ic c-brand" /><span className="h3">{t("v2.home.stuck")}</span></span>
        <span className="xs c3">{t("v2.home.stuckMeta")}</span>
      </div>
      {!data ? <LoadingBlock rows={3} /> : items.length === 0 ? (
        <div className="s c3" style={{ padding: "20px 16px", textAlign: "center" }}>{t("dash.health.bottleneck_empty")}</div>
      ) : (
        items.map((b) => (
          <LinkRow key={b.status} to={`/leads?status=${encodeURIComponent(b.status)}`} style={{ minHeight: 64 }}>
            <span className="col grow" style={{ minWidth: 0 }}>
              <span className="s w6 trunc">{statusLabel(b.status)}</span>
              <span className="xs c3">{t("v2.home.stuckDays", { n: b.avg_days_in_status.toFixed(1).replace(".", ",") })}</span>
            </span>
            <span className="col" style={{ width: 90, gap: 4 }}>
              <span className="bar"><i className="warn" style={{ width: `${Math.round((b.count / max) * 100)}%` }} /></span>
            </span>
            <span className="num w6" style={{ fontSize: 15, width: 28, textAlign: "right" }}>{b.count}</span>
          </LinkRow>
        ))
      )}
    </section>
  );
}

function AttentionCard({ counters }: { counters?: DashboardSummary["attention"] }) {
  const t = useT2();
  const rows: Array<{ key: keyof DashboardSummary["attention"]; label: string; to: string; urgent: boolean }> = [
    { key: "to_review", label: t("v2.home.attReview"), to: "/sales/pending", urgent: true },
    { key: "orphans", label: t("v2.home.attOrphans"), to: "/leads/orphans", urgent: true },
    { key: "on_review", label: t("v2.home.attOnReview"), to: "/sales/pending", urgent: false },
    { key: "late_today", label: t("v2.home.attLate"), to: "/attendance/today", urgent: false },
  ];
  const allZero = !!counters && rows.every((r) => Number(counters[r.key] ?? 0) === 0);
  return (
    <section className="card col" style={{ flex: "1 1 300px", minWidth: 0 }} aria-label={t("v2.home.attention")}>
      <div className="card-h">
        <span className="h3">{t("v2.home.attention")}</span>
        <span className="xs c3">{allZero ? t("v2.home.attClean") : t("v2.home.attentionHint")}</span>
      </div>
      {!counters ? <LoadingBlock rows={3} /> : rows.map((r) => {
        const n = Number(counters[r.key] ?? 0);
        const hot = r.urgent && n > 0;
        return (
          <LinkRow key={r.key} to={r.to} style={{ minHeight: 48, ...(hot ? { background: "var(--hot-bg)" } : {}) }}>
            <span className={cx("s grow", hot ? "w6" : "c2")}>{r.label}</span>
            <span className={cx("num w6", hot ? "c-hot" : n > 0 ? "" : "c3")} style={{ fontSize: 15 }}>{fmtNum(n)}</span>
          </LinkRow>
        );
      })}
    </section>
  );
}

/* ─────────────────────────── chart & top ─────────────────────────── */

function niceStep(raw: number) {
  if (raw <= 1) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return Math.max(1, Math.round(n * pow));
}

function SalesChart({ summary, loading }: { summary?: DashboardSummary; loading: boolean }) {
  const t = useT2();
  const data = (summary?.timeseries ?? []).map((r) => ({ day: r.day, count: Number(r.count) || 0 }));
  const plan = summary?.target_daily_count && summary.target_daily_count > 0 ? summary.target_daily_count : null;
  const maxVal = Math.max(1, ...data.map((d) => d.count), plan ?? 0);
  const step = niceStep(maxVal / 3);
  const top = step * 3;
  const rec = Math.max(0, ...data.map((d) => d.count));
  const today = todayIso();
  const label = (iso: string) => {
    const p = iso.split("-");
    return p.length === 3 ? `${p[2]}.${p[1]}` : iso;
  };
  return (
    <section className="card col" style={{ flex: "2 1 560px", minWidth: 0 }} aria-label={t("v2.home.chart")}>
      <div className="card-h" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="col">
          <span className="h3">{t("v2.home.chart")}</span>
          <span className="xs c3">{t("v2.home.chartSub")}</span>
        </div>
        <div className="row g12 xs c2 wrap">
          {plan ? (
            <span className="row g6"><i style={{ display: "inline-block", width: 16, borderTop: "2px dashed var(--hot-solid)" }} />{t("v2.home.chartPlan", { n: plan })}</span>
          ) : null}
          <span className="row g6"><i className="dot" style={{ color: "var(--ok-solid)" }} />{t("v2.home.chartRecord")}</span>
          <span className="row g6"><i className="dot" style={{ color: "var(--brand)" }} />{t("v2.home.chartToday")}</span>
        </div>
      </div>
      {loading ? <LoadingBlock rows={4} /> : data.length === 0 ? (
        <div className="s c3" style={{ padding: "40px 16px", textAlign: "center" }}>{t("v2.home.chartEmpty")}</div>
      ) : (
        <div style={{ padding: "18px 20px 14px", overflowX: "auto" }}>
          <div style={{ minWidth: data.length * 30 }}>
            <div className="row" style={{ alignItems: "stretch", gap: 8 }}>
              <div className="col between num xs c3" style={{ height: 170, width: 26, textAlign: "right" }} aria-hidden="true">
                <span>{top}</span>
                <span>{step * 2}</span>
                <span>{step}</span>
                <span>0</span>
              </div>
              <div className="grow" style={{ position: "relative", height: 170, borderBottom: "1px solid var(--line-2)" }}>
                {[0, 33.33, 66.66].map((p) => (
                  <span key={p} style={{ position: "absolute", left: 0, right: 0, top: `${p}%`, borderTop: "1px solid var(--line)" }} />
                ))}
                <div className="row" style={{ position: "absolute", inset: 0, gap: data.length > 20 ? 4 : 10, alignItems: "flex-end", padding: "0 6px" }}>
                  {data.map((d) => {
                    const isToday = d.day === today;
                    const isRec = d.count === rec && rec > 0;
                    const c = isToday ? "var(--brand)" : isRec ? "var(--ok-solid)" : "var(--line-2)";
                    return (
                      <span key={d.day} className="col" style={{ flex: "1 1 0", height: "100%", justifyContent: "flex-end", alignItems: "center", gap: 3, minWidth: 0 }} title={`${label(d.day)}: ${d.count}`}>
                        <span className={cx("num xs w6", isToday ? "c-brand" : isRec ? "c-ok" : "c2")} style={{ position: "relative", zIndex: 2, background: "var(--surface)", padding: "0 3px", borderRadius: 4, visibility: d.count > 0 || isToday ? "visible" : "hidden" }}>{d.count}</span>
                        <i className="grow-y" style={{ display: "block", width: "100%", maxWidth: 34, height: `${((d.count / top) * 100).toFixed(1)}%`, minHeight: d.count > 0 ? 2 : 0, borderRadius: "5px 5px 0 0", background: c }} />
                      </span>
                    );
                  })}
                </div>
                {plan ? <span style={{ position: "absolute", left: 0, right: 0, top: `${(100 - (plan / top) * 100).toFixed(1)}%`, borderTop: "2px dashed var(--hot-solid)", zIndex: 1, pointerEvents: "none" }} /> : null}
              </div>
            </div>
            <div className="row" style={{ gap: data.length > 20 ? 4 : 10, padding: "6px 6px 0 40px" }}>
              {data.map((d) => (
                <span key={d.day} className="num xs c3" style={{ flex: "1 1 0", textAlign: "center", minWidth: 0, overflow: "hidden" }}>{label(d.day)}</span>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function TopOperators({ summary, loading, periodWord }: { summary?: DashboardSummary; loading: boolean; periodWord: string }) {
  const t = useT2();
  const top = (summary?.top_operators ?? []).slice(0, 5);
  const max = Math.max(1, ...top.map((o) => Number(o.amount) || 0));
  return (
    <section className="card col" style={{ flex: "1 1 320px", minWidth: 0 }} aria-label={t("v2.home.top")}>
      <div className="card-h">
        <span className="h3">{t("v2.home.top")}</span>
        <span className="xs c3">{t("v2.home.topMeta", { period: periodWord })}</span>
      </div>
      {loading ? <LoadingBlock rows={4} /> : top.length === 0 ? (
        <div className="s c3" style={{ padding: "32px 16px", textAlign: "center" }}>{t("v2.home.topEmpty")}</div>
      ) : (
        <div className="col g16" style={{ padding: 16 }}>
          {top.map((o, i) => (
            <Link key={o.id} className="row g12" to={`/operators/${o.id}`}>
              <span className={cx("rank", i === 0 && "r1")}>{i + 1}</span>
              <span className="col grow" style={{ gap: 6, minWidth: 0 }}>
                <span className="row between g8">
                  <span className="s w6 trunc">{o.name}</span>
                  <span className="xs c3 num" style={{ flex: "none" }}>{o.count} {t("v2.home.pcs")}</span>
                </span>
                <span className="bar" style={{ height: 6 }}><i style={{ width: `${Math.round(((Number(o.amount) || 0) / max) * 100)}%` }} /></span>
              </span>
              <span className="num s w6" style={{ width: 104, textAlign: "right", flex: "none" }}>{fmtNum(o.amount)}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

/* ─────────────────────────── morning summary ─────────────────────────── */

function morningKey(username: string | null) {
  return `naffai:v2:morning:${username ?? "anon"}`;
}

function MorningDialog({
  isSuper,
  branch,
  summary,
  pendingCount,
  orphans,
  callbacks,
  dayOffCount,
  bdays,
}: {
  isSuper: boolean;
  branch: string;
  summary?: DashboardSummary;
  pendingCount: number;
  orphans: number;
  callbacks: number;
  dayOffCount: number;
  bdays: Array<{ operator_id: number; full_name: string; age: number }>;
}) {
  const t = useT2();
  const nav = useNavigate();
  const lang = useLang((s) => s.lang);
  const username = useAuth((s) => s.username);
  const me = useMe();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open || !summary) return;
    const today = todayIso();
    if (tashkentMinutes() < 7 * 60) return;
    let seen: string | null = null;
    try {
      seen = localStorage.getItem(morningKey(username));
    } catch {
      seen = today; // storage blocked → never nag
    }
    if (seen !== today) setOpen(true);
  }, [summary, username, open]);

  const monthQ = useDashboardSummary("month", "", branch, open);

  const close = () => {
    try {
      localStorage.setItem(morningKey(username), todayIso());
    } catch {
      /* ignore */
    }
    setOpen(false);
  };

  if (!open || !summary) return null;

  const ts = summary.timeseries ?? [];
  const yest = ts[ts.length - 2];
  const before = ts[ts.length - 3];
  const yCount = yest ? Number(yest.count) || 0 : 0;
  const diff = yest && before ? yCount - (Number(before.count) || 0) : null;
  const m = monthQ.data;
  const target = Number(m?.turnover.target ?? 0);
  const planPct = m && target > 0 ? Math.round((Number(m.turnover.actual) / target) * 100) : null;
  const d = new Date();
  const expected = Math.round((d.getDate() / new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()) * 100);
  const name = (me.data?.display_name || me.data?.operator_name || "").split(/\s+/)[0];
  const dateLine = new Date().toLocaleDateString(locale(lang), { weekday: "long", day: "numeric", month: "long", timeZone: TZ });

  const kpis = [
    { label: t("v2.home.mYesterday"), value: String(yCount), note: diff !== null ? t("v2.home.mVsBefore", { d: `${diff > 0 ? "+" : diff < 0 ? "−" : "±"}${Math.abs(diff)}` }) : "", cls: diff === null ? "c3" : diff > 0 ? "c-ok" : diff < 0 ? "c-bad" : "c3" },
    {
      label: t("v2.home.mPlan"),
      value: monthQ.isLoading ? "…" : planPct !== null ? `${planPct}%` : "—",
      note: planPct !== null ? t("v2.home.mExpected", { n: expected }) : monthQ.isLoading ? "" : t("v2.home.mNoPlan"),
      cls: planPct === null ? "c3" : planPct >= expected ? "c-ok" : "c-bad",
    },
    { label: t("v2.home.mCheckedIn"), value: `${summary.shift.on_shift ?? 0}/${summary.shift.expected ?? 0}`, note: summary.shift.late_today ? t("v2.home.kShiftLate", { n: summary.shift.late_today }) : "", cls: summary.shift.late_today ? "c-warn" : "c3" },
  ];

  const todo: Array<{ tile: string; icon: ReactNode; text: string; n: number | string; to: string }> = [];
  if (pendingCount > 0) todo.push({ tile: "t-warn", icon: <Check className="ic" />, text: t("v2.home.mPending"), n: pendingCount, to: "/sales/pending" });
  if (orphans > 0) todo.push({ tile: "t-info", icon: <Inbox className="ic" />, text: t("v2.home.mOrphans"), n: orphans, to: "/leads/orphans" });
  if (callbacks > 0) todo.push({ tile: "t-bad", icon: <Clock className="ic" />, text: t("v2.home.mCallbacks"), n: callbacks, to: "/leads" });
  if (dayOffCount > 0) todo.push({ tile: "t-info", icon: <CalendarOff className="ic" />, text: t("v2.home.mDayOff"), n: dayOffCount, to: "/operators/day-off" });
  for (const b of bdays.slice(0, 2)) todo.push({ tile: "t-hot", icon: <Gift className="ic" />, text: t("v2.home.mBirthday", { name: b.full_name }), n: b.age, to: `/operators/${b.operator_id}` });

  return (
    <Dialog open onClose={close} title={<span className="lbl" style={{ color: "var(--brand-text)" }}>{dateLine}</span>} width={640}>
      <div className="col g16">
        <h2 className="display" style={{ fontSize: 26, lineHeight: "34px", margin: 0 }}>
          {name ? t("v2.home.mHello", { name }) : t("v2.home.mHelloAnon")} {t(isSuper ? "v2.home.mBranch" : "v2.home.mTeam", { n: yCount })}
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
          {kpis.map((k) => (
            <div key={k.label} className="well col g4">
              <span className="lbl">{k.label}</span>
              <span className="kpi"><CountText text={k.value} /></span>
              {k.note ? <span className={cx("xs", k.cls)}>{k.note}</span> : null}
            </div>
          ))}
        </div>
        <div className="col">
          <span className="lbl" style={{ marginBottom: 6 }}>{t("v2.home.mStart")}</span>
          {todo.length === 0 ? <span className="s c3" style={{ padding: "8px 0" }}>{t("v2.home.mNothing")}</span> : null}
          {todo.map((x) => (
            <button
              key={x.text}
              type="button"
              className="li"
              style={{ minHeight: 48, width: "100%", textAlign: "left", background: "none", border: 0, borderBottom: "1px solid var(--line)", cursor: "pointer" }}
              onClick={() => {
                close();
                nav(x.to);
              }}
            >
              <span className={cx("icon-tile", x.tile)} style={{ width: 30, height: 30 }}>{x.icon}</span>
              <span className="s grow">{x.text}</span>
              <span className="num w6">{x.n}</span>
            </button>
          ))}
        </div>
        <button className="btn btn-pri btn-lg btn-block" type="button" onClick={close}>
          {t(isSuper ? "v2.home.mCtaSuper" : "v2.home.mCta")}
        </button>
      </div>
    </Dialog>
  );
}

/* ─────────────────────────── new-sale popups ─────────────────────────── */

interface SalePop {
  saleId: number;
  notifId?: number;
  title: string;
  body: string;
  amount: number | null;
  at: string;
}

function popFrom(detail: { title?: string; body?: string; metadata?: Record<string, unknown>; created_at?: string }, notifId?: number): SalePop | null {
  const sid = Number(detail.metadata?.sale_id);
  if (!Number.isFinite(sid) || sid <= 0) return null;
  const amount = detail.metadata?.amount;
  return {
    saleId: sid,
    notifId,
    title: (detail.title || "").replace(/^\p{Extended_Pictographic}\s*/u, ""),
    body: detail.body || "",
    amount: amount === undefined || amount === null ? null : Number(amount),
    at: detail.created_at || new Date().toISOString(),
  };
}

function SaleOverlay() {
  const t = useT2();
  const qc = useQueryClient();
  const [stack, setStack] = useState<SalePop[]>([]);
  const seen = useRef<Set<number>>(new Set());
  const baselined = useRef(false);
  const poll = useUnreadSaleNotifications();
  const markRead = useMarkNotificationRead();
  const approve = useApproveSale();

  const push = (items: SalePop[]) => {
    const fresh = items.filter((p) => !seen.current.has(p.saleId));
    if (!fresh.length) return;
    fresh.forEach((p) => seen.current.add(p.saleId));
    setStack((s) => [...fresh, ...s].slice(0, 20));
    playSaleChime();
  };

  // SSE events from the shell's notification stream.
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<NaffaiNotificationEventDetail & { id?: number }>).detail;
      if (!d || d.kind !== "sale_created") return;
      const p = popFrom(d, typeof d.id === "number" ? d.id : undefined);
      if (p) push([p]);
      qc.invalidateQueries({ queryKey: ["sales-pending"] });
    };
    window.addEventListener(NAFFAI_NOTIF_EVENT, h);
    return () => window.removeEventListener(NAFFAI_NOTIF_EVENT, h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling fallback: first response is the baseline (old unread are not popped).
  useEffect(() => {
    const rows = poll.data;
    if (!rows) return;
    const pops = rows.map((r) => popFrom(r, r.id)).filter((p): p is SalePop => !!p);
    if (!baselined.current) {
      baselined.current = true;
      pops.forEach((p) => seen.current.add(p.saleId));
      return;
    }
    push(pops);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll.data]);

  const drop = (p: SalePop) => {
    setStack((s) => s.filter((x) => x.saleId !== p.saleId));
    if (p.notifId) markRead.mutate(p.notifId);
  };

  if (!stack.length) return null;
  const cur = stack[0];
  const rest = stack.length - 1;
  const busy = approve.isPending && approve.variables === cur.saleId;

  return (
    <div className="col" style={{ position: "fixed", right: 24, bottom: 24, width: 400, maxWidth: "calc(100vw - 32px)", gap: 10, zIndex: 50 }} aria-live="polite">
      {rest > 0 ? (
        <section className="card" style={{ boxShadow: "var(--shadow)", padding: "10px 14px", opacity: 0.85 }}>
          <span className="s c2">{t("v2.home.moreWaiting", { n: rest })}</span>
        </section>
      ) : null}
      <section className="dlg" role="alertdialog" aria-labelledby="v2-sale-pop" style={{ width: "100%" }}>
        <div className="dlg-h">
          <div className="col g4" style={{ minWidth: 0 }}>
            <span className="lbl" style={{ color: "var(--ok)" }}>{t("v2.home.newSale", { t: hhmm(cur.at) })}</span>
            <h2 className="h3" id="v2-sale-pop">{cur.title}</h2>
          </div>
          <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("v2.home.hide")} onClick={() => drop(cur)}>
            <X className="ic" />
          </button>
        </div>
        <div className="dlg-b" style={{ gap: 8 }}>
          {cur.amount !== null ? (
            <div className="row between">
              <span className="kpi" style={{ fontSize: 22, lineHeight: "28px" }}><CountUp value={cur.amount} /></span>
              <span className="s c3">{t("common.uzs")}</span>
            </div>
          ) : null}
          {cur.body ? <span className="xs c3">{cur.body}</span> : null}
        </div>
        <div className="dlg-f">
          <Link className="btn" to={`/sales/${cur.saleId}`} onClick={() => drop(cur)}>{t("v2.home.open")}</Link>
          <button
            className="btn btn-ok"
            type="button"
            disabled={busy}
            onClick={() =>
              approve.mutate(cur.saleId, {
                onSuccess: () => {
                  toast.success(t("v2.home.approved"));
                  drop(cur);
                },
                onError: (e) => toast.error(apiErrorText(e, t("v2.home.approveFailed"))),
              })
            }
          >
            {t("v2.home.approve")}
          </button>
        </div>
      </section>
    </div>
  );
}

/* ─────────────────────────── PIN expiry ─────────────────────────── */

function PinBanner() {
  const t = useT2();
  const qc = useQueryClient();
  const q = usePinStatus();
  const now = useNow(15_000);
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const s = q.data;
  if (!s || !s.pin_required || !s.pin_verified || !s.expires_at) return null;
  const left = new Date(s.expires_at).getTime() - now;
  if (left <= 0 || left > 2 * 60_000) return null;

  const submit = async () => {
    if (busy) return;
    if (!/^\d{4}$/.test(pin)) {
      setErr(t("v2.home.pinDigits"));
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await api.post("/attendance/pin/verify/", { pin });
      await qc.invalidateQueries({ queryKey: ["attendance-pin-status"] });
      toast.success(t("v2.home.pinOk"));
      setOpen(false);
      setPin("");
    } catch (e) {
      setErr(apiErrorText(e, t("v2.home.pinWrong")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="banner b-warn">
        <Clock className="ic" />
        <span className="s w6 grow">{t("v2.home.pinExpiring", { n: Math.max(1, Math.ceil(left / 60_000)) })}</span>
        <button className="btn btn-sm" type="button" onClick={() => setOpen(true)}>{t("v2.home.pinExtend")}</button>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("v2.home.pinTitle")}
        sub={t("v2.home.pinSub")}
        width={400}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setOpen(false)}>{t("common.cancel")}</button>
            <button className="btn btn-pri" type="button" disabled={busy} onClick={submit}>{t("v2.home.pinExtend")}</button>
          </>
        }
      >
        <div className={cx("field", err && "err")}>
          <label htmlFor="v2-pin">{t("v2.home.pinLabel")}</label>
          <input
            id="v2-pin"
            className="input num"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={4}
            value={pin}
            autoFocus
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          {err ? <span className="xs c-bad">{err}</span> : null}
        </div>
      </Dialog>
    </>
  );
}
