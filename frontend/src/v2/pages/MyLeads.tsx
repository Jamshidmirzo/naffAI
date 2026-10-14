import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  AlarmClock,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Flame,
  Lightbulb,
  Lock,
  MessageCircle,
  Phone,
  CheckCircle2,
  Plus,
  RotateCcw,
  Search,
} from "lucide-react";
import { toast } from "../../components/ui";
import AttendanceStatusV2 from "../overlays/AttendanceStatusV2";
import { useCallbackWatcher } from "../../hooks/useCallbackWatcher";
import { useLang } from "../../store/lang";
import { useT2 } from "../i18n";
import { Dialog, EmptyState, ErrorState, LoadingBlock, cx } from "../ui";
import {
  PAGE_SIZE,
  invalidateLeadQueries,
  leadActions,
  openTelegram,
  useAttendanceCurrent,
  useCallsMine,
  useLeadCallAttempts,
  useLeadStatuses,
  useMyCallbacks,
  useMyLeads,
  useMyLeadsByStatus,
  useMySales,
  useMyStatus,
  useTrackedCallV2,
  type CallbackRow,
  type Lead,
  type LeadStatusRow,
  type MyLeadsView,
  type MyResponse,
  type MyStatus,
} from "../api/operatorWork";

/* ═════════════════════════ helpers ═════════════════════════ */

type TFn = (key: string, params?: Record<string, string | number>) => string;
type Mode = "focus" | "list";
type ListTab = MyLeadsView | "quota";

const TZ = "Asia/Tashkent";
const TZ_OFFSET_MS = 5 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const MODE_KEY = "naffai_v2_my_mode";

const CARRY_STATUSES = new Set(["no_answer", "no_answer_2", "phone_on", "callback_scheduled", "contacted_telegram", "dokonga_keladi"]);
const RECALL_STATUSES = new Set(["no_answer", "phone_on"]);
const HINT_STATUS_KEY: Record<string, string> = {
  no_answer: "my.hint.no_answer",
  no_answer_2: "my.hint.no_answer_2",
  phone_on: "my.hint.phone_on",
  callback_scheduled: "my.hint.callback_scheduled",
  contacted_telegram: "my.hint.contacted_telegram",
  dokonga_keladi: "my.hint.dokonga_keladi",
};

function tzParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (k: string) => parts.find((p) => p.type === k)?.value ?? "0";
  const hh = g("hour") === "24" ? "00" : g("hour");
  return { y: Number(g("year")), m: Number(g("month")), day: Number(g("day")), hh, mm: g("minute") };
}

/** Tashkent midnight of `d` as UTC ms (UTC+5, no DST). */
function dayStartMs(d = new Date()) {
  const p = tzParts(d);
  return Date.UTC(p.y, p.m - 1, p.day) - TZ_OFFSET_MS;
}

function hm(iso: string | number | Date | null | undefined): string {
  if (iso == null || iso === "") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = tzParts(d);
  return `${p.hh}:${p.mm}`;
}

function ddmm(iso: string | number | Date) {
  const p = tzParts(new Date(iso));
  return `${String(p.day).padStart(2, "0")}.${String(p.m).padStart(2, "0")}`;
}

/** «сегодня 14:02» / «вчера 10:00» / «12.10 09:15». */
function whenLabel(iso: string | null | undefined, t: TFn): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!ms) return "";
  const today0 = dayStartMs();
  if (ms >= today0) return t("v2.op.when.today", { time: hm(ms) });
  if (ms >= today0 - DAY_MS) return t("v2.op.when.yesterday", { time: hm(ms) });
  return t("v2.op.when.date", { date: ddmm(ms), time: hm(ms) });
}

function durText(ms: number, t: TFn): string {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return t("v2.op.dur.min", { m: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("v2.op.dur.hm", { h, m: min % 60 });
  return t("v2.op.dur.days", { d: Math.floor(h / 24) });
}

function pluralForm(n: number): "one" | "few" | "many" {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "one";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "few";
  return "many";
}

const TONE_CLASS: Record<string, string> = { neutral: "", hot: "b-hot", danger: "b-bad", success: "b-ok", info: "b-info" };

function isTypingTarget(el: EventTarget | null) {
  const n = el as HTMLElement | null;
  if (!n) return false;
  return n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.tagName === "SELECT" || n.isContentEditable;
}

function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "list" ? "list" : "focus";
  } catch {
    return "focus";
  }
}
function saveMode(m: Mode) {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* private mode */
  }
}

/** carry = carry-status touched before today; recall = no_answer/phone_on before 13:00 today, shown after 13:00. */
function leadFlags(l: Lead, today0: number, nowMs: number) {
  const upd = l.updated_at ? Date.parse(l.updated_at) : 0;
  const lunch = today0 + 13 * 3600 * 1000;
  const carry = CARRY_STATUSES.has(l.status) && upd < today0;
  const recall = nowMs >= lunch && RECALL_STATUSES.has(l.status) && upd >= today0 && upd < lunch;
  return { carry, recall };
}

/* ═════════════════════════ small pieces ═════════════════════════ */

function useStatusCatalog() {
  const q = useLeadStatuses();
  const lang = useLang((s) => s.lang);
  return useMemo(() => {
    const rows = q.data ?? [];
    const byCode = new Map<string, LeadStatusRow>();
    rows.forEach((r) => byCode.set(r.code, r));
    const label = (code: string) => {
      const r = byCode.get(code);
      if (!r) return code || "—";
      return lang === "uz" && r.label_uz ? r.label_uz : r.label_ru;
    };
    const tone = (code: string) => TONE_CLASS[byCode.get(code)?.tone ?? "neutral"] ?? "";
    const has = (code: string) => !!byCode.get(code)?.is_active;
    const chips = rows.filter((s) => s.is_active && s.show_in_chip).sort((a, b) => a.sort_order - b.sort_order);
    const buttons = rows.filter((s) => s.is_active && s.show_in_button).sort((a, b) => a.sort_order - b.sort_order);
    return { rows, byCode, label, tone, has, chips, buttons, loaded: !!q.data };
  }, [q.data, lang]);
}
type Catalog = ReturnType<typeof useStatusCatalog>;

function StatusBadge({ code, cat, overdue }: { code: string; cat: Catalog; overdue?: boolean }) {
  return (
    <span className={cx("badge", overdue ? "b-bad" : cat.tone(code))}>
      <i className="dot" />
      {cat.label(code)}
    </span>
  );
}

function HotBadge({ until }: { until?: string | null }) {
  const t = useT2();
  const deadline = until ? Date.parse(until) : NaN;
  const [left, setLeft] = useState(() => (Number.isFinite(deadline) ? deadline - Date.now() : 0));
  useEffect(() => {
    if (!Number.isFinite(deadline)) return;
    setLeft(deadline - Date.now());
    const id = window.setInterval(() => setLeft(deadline - Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [deadline]);
  if (!Number.isFinite(deadline)) return null;
  if (left <= 0) return <span className="badge">{t("v2.op.hot.cold")}</span>;
  const sec = Math.ceil(left / 1000);
  const time = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  return (
    <span className="badge b-hot" style={sec <= 60 ? { animation: "pulse 1s infinite" } : undefined}>
      <Flame className="ic ic-s" />
      {t("v2.op.hot.tez", { time })}
    </span>
  );
}

async function copyPhone(phone: string, t: TFn) {
  try {
    await navigator.clipboard.writeText(phone);
    toast.success(t("v2.op.copied"));
  } catch {
    toast.error(t("v2.op.copyFailed"));
  }
}

/* ═════════════════════════ page ═════════════════════════ */

type SheetState =
  | { kind: "callback"; lead: Lead; tracked?: boolean }
  | { kind: "noanswer"; lead: Lead; tracked?: boolean }
  | { kind: "reject"; lead: Lead; tracked?: boolean }
  | { kind: "postpone"; lead: Lead }
  | null;

export default function MyLeads() {
  const t = useT2();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const cat = useStatusCatalog();

  /* ── UI state ── */
  const deepList = sp.get("view") === "postponed" || !!sp.get("chip") || sp.get("quota") === "1" || !!sp.get("highlight");
  const [mode, setModeState] = useState<Mode>(() => (deepList ? "list" : readMode()));
  const setMode = (m: Mode) => {
    setModeState(m);
    saveMode(m);
  };
  const [view, setView] = useState<MyLeadsView>(sp.get("view") === "postponed" ? "postponed" : "active");
  const [quotaMode, setQuotaMode] = useState(sp.get("quota") === "1");
  const [statusChip, setStatusChip] = useState<string>(sp.get("chip") ?? "all");
  const [page, setPage] = useState(1);
  const [selectedDay, setSelectedDay] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [handled, setHandled] = useState<Record<number, number>>({});
  const [note, setNote] = useState("");
  const [sheet, setSheet] = useState<SheetState>(null);
  const [flash, setFlash] = useState<Set<number>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // URL deep links (helper panel navigates to /my?view=…&chip=…&quota=1 while already on /my)
  useEffect(() => {
    const v = sp.get("view");
    if (v === "postponed" || v === "active") {
      setView(v);
      if (v === "postponed") setModeState("list");
    }
    const chip = sp.get("chip");
    if (chip) {
      setStatusChip(chip);
      setModeState("list");
    }
    if (sp.get("quota") === "1") {
      setQuotaMode(true);
      setView("active");
      setStatusChip("all");
      setPage(1);
      setModeState("list");
    }
  }, [sp]);

  const exitQuota = () => {
    setQuotaMode(false);
    setPage(1);
    const url = new URL(window.location.href);
    url.searchParams.delete("quota");
    window.history.replaceState({}, "", url.toString());
  };

  /* ── data ── */
  const focusQ = useMyLeads(1, "active", false);
  const listQ = useMyLeads(page, view, quotaMode);
  const isChipView = view === "active" && statusChip !== "all" && !quotaMode;
  const chipQ = useMyLeadsByStatus(statusChip, page, mode === "list" && isChipView);
  const statusQ = useMyStatus();
  const callbacksQ = useMyCallbacks();
  const callsQ = useCallsMine();
  const attQ = useAttendanceCurrent();
  const salesQ = useMySales();
  const watcher = useCallbackWatcher({ enabled: true });
  const status = statusQ.data;

  const refresh = useCallback(() => {
    invalidateLeadQueries(qc);
    qc.invalidateQueries({ queryKey: ["calls-mine"] });
  }, [qc]);

  const tracked = useTrackedCallV2(refresh);

  // callbacks by lead (earliest open one)
  const cbByLead = useMemo(() => {
    const m = new Map<number, CallbackRow>();
    for (const c of callbacksQ.data ?? []) {
      if (c.status === "done" || c.status === "superseded") continue;
      const prev = m.get(c.lead);
      if (!prev || Date.parse(c.remind_at) < Date.parse(prev.remind_at)) m.set(c.lead, c);
    }
    return m;
  }, [callbacksQ.data]);

  const today0 = useMemo(() => dayStartMs(new Date(now)), [now]);

  /* ── focus queue ── */
  const activeLeads = focusQ.data?.results ?? [];
  const queue = useMemo(() => {
    const rank = (l: Lead) => {
      if (l.hot_until && Date.parse(l.hot_until) > now) return 0;
      const cb = cbByLead.get(l.id);
      if (cb && Date.parse(cb.remind_at) <= now) return 1;
      const f = leadFlags(l, today0, now);
      if (f.carry || f.recall) return 2;
      if (cb && Date.parse(cb.remind_at) > now) return 4;
      return 3;
    };
    const fresh = activeLeads.filter((l) => !handled[l.id]);
    const done = activeLeads.filter((l) => handled[l.id]).sort((a, b) => handled[a.id] - handled[b.id]);
    const sorted = fresh
      .map((l, i) => ({ l, r: rank(l), i }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.l);
    return [...sorted, ...done];
  }, [activeLeads, handled, cbByLead, today0, now]);

  const gateRows = useMemo(() => {
    if (!status?.gate_active) return [];
    const seen = new Set<number>();
    const rows: Array<{ leadId: number; name: string; phone: string; status: string | null; remindAt: string | null; updatedAt: string | null }> = [];
    for (const cb of status.overdue_callbacks ?? []) {
      if (seen.has(cb.lead_id)) continue;
      seen.add(cb.lead_id);
      rows.push({ leadId: cb.lead_id, name: cb.full_name, phone: cb.phone, status: cb.status || null, remindAt: cb.remind_at, updatedAt: null });
    }
    for (const b of status.blocking_leads ?? []) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      rows.push({ leadId: b.id, name: b.full_name, phone: b.phone, status: b.status, remindAt: null, updatedAt: b.updated_at });
    }
    return rows;
  }, [status]);
  const blocked = gateRows.length > 0;

  // progress for the gate card: max seen this session minus what is left
  const gateMax = useRef(0);
  if (gateRows.length > gateMax.current) gateMax.current = gateRows.length;
  if (!blocked) gateMax.current = 0;

  const findLead = (id: number | null): Lead | null => {
    if (id == null) return null;
    const pools: Lead[][] = [activeLeads, listQ.data?.results ?? [], chipQ.data?.results ?? []];
    for (const p of pools) {
      const l = p.find((x) => x.id === id);
      if (l) return l;
    }
    const g = gateRows.find((r) => r.leadId === id);
    if (g) return pseudoLead(g.leadId, g.name, g.phone, g.status ?? "");
    return null;
  };

  const current: Lead | null = useMemo(() => {
    if (blocked) {
      return findLead(selectedId) ?? findLead(gateRows[0]?.leadId ?? null);
    }
    const sel = selectedId != null ? activeLeads.find((l) => l.id === selectedId) : null;
    return sel ?? queue[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked, selectedId, activeLeads, queue, gateRows, listQ.data, chipQ.data]);

  useEffect(() => setNote(""), [current?.id]);

  /* ── highlight deep link (?highlight=1,2,3) ── */
  useEffect(() => {
    const raw = sp.get("highlight");
    if (!raw) return;
    const ids = raw.split(",").map((s) => Number(s.trim())).filter(Boolean);
    if (!ids.length) return;
    setModeState("list");
    setView("active");
    setSelectedDay("all");
    setFlash(new Set(ids));
    let tries = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const el = document.getElementById(`lead-${ids[0]}`);
      if (!el) {
        if (++tries < 25) window.setTimeout(tick, 200);
        return;
      }
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      window.setTimeout(() => setFlash(new Set()), 2200);
      const url = new URL(window.location.href);
      url.searchParams.delete("highlight");
      window.history.replaceState({}, "", url.toString());
    };
    window.setTimeout(tick, 60);
    return () => {
      cancelled = true;
    };
  }, [sp]);

  /* ── actions ── */
  const nextName = (leadId: number) => {
    const n = queue.find((l) => l.id !== leadId && !handled[l.id]);
    return n ? n.full_name || n.phone : "";
  };

  const markHandled = (leadId: number) => {
    setHandled((h) => ({ ...h, [leadId]: Date.now() }));
    setSelectedId((s) => (s === leadId ? null : s));
  };

  const optimistic = (leadId: number, oldStatus: string, newStatus: string | null) => {
    if (!newStatus) return () => {};
    const snaps = qc.getQueriesData<MyResponse>({ queryKey: ["leads-my"] });
    qc.setQueriesData<MyResponse>({ queryKey: ["leads-my"] }, (prev) =>
      prev ? { ...prev, results: prev.results.map((l) => (l.id === leadId ? { ...l, status: newStatus } : l)) } : prev,
    );
    const prevStatus = qc.getQueryData<MyStatus>(["leads-my-status"]);
    if (prevStatus?.by_status && oldStatus !== newStatus) {
      const by = { ...prevStatus.by_status };
      by[newStatus] = (by[newStatus] ?? 0) + 1;
      if (oldStatus) by[oldStatus] = Math.max(0, (by[oldStatus] ?? 0) - 1);
      qc.setQueryData<MyStatus>(["leads-my-status"], { ...prevStatus, by_status: by });
    }
    return () => {
      snaps.forEach(([k, v]) => qc.setQueryData(k, v));
      if (prevStatus) qc.setQueryData(["leads-my-status"], prevStatus);
    };
  };

  /**
   * Runs one lead action: optimistic status → request → toast AFTER the
   * server answered (with «Дальше …»), rollback + «Повторить» on error.
   */
  const run = async (
    lead: Lead,
    fn: () => Promise<unknown>,
    opts: { done: string; status?: string | null; advance?: boolean },
  ) => {
    const rollback = optimistic(lead.id, lead.status, opts.status ?? null);
    try {
      await fn();
      const next = opts.advance !== false ? nextName(lead.id) : "";
      toast.success(next ? t("v2.op.toast.doneNext", { what: opts.done, name: next }) : opts.done);
      if (opts.advance !== false) markHandled(lead.id);
    } catch (e) {
      rollback();
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(detail || t("v2.op.toast.failed"), {
        action: { label: t("v2.state.retry"), onClick: () => void run(lead, fn, opts) },
      });
    } finally {
      refresh();
    }
  };

  const doNoAnswer = (lead: Lead, code: string, viaTracked: boolean) => {
    const label = code === "no_answer" ? t("v2.op.na.beeps") : cat.label(code);
    if (viaTracked) {
      void run(
        lead,
        async () => {
          await tracked.finish("no_answer", { comment: note });
          if (code !== "no_answer") await leadActions.status(lead.id, code, note);
        },
        { done: label, status: code === "no_answer" ? (lead.status === "no_answer" ? "no_answer_2" : "no_answer") : code },
      );
      return;
    }
    if (code === "no_answer") {
      void run(lead, () => leadActions.callAttempt(lead.id, "no_answer", note), {
        done: label,
        status: lead.status === "no_answer" ? "no_answer_2" : "no_answer",
      });
    } else {
      void run(lead, () => leadActions.status(lead.id, code, note), { done: label, status: code });
    }
  };

  const doReject = (lead: Lead, code: string, viaTracked: boolean) => {
    const opt = REJECT_OPTIONS.find((o) => o.code === code);
    const label = t("v2.op.rej.closed", { reason: opt ? t(opt.key).toLowerCase() : cat.label(code) });
    const lost = code === LOST_SHORTCUT;
    if (viaTracked) {
      void run(
        lead,
        async () => {
          await tracked.finish(code === "notogri_raqam" ? "wrong_number" : "rejected", { comment: note });
          if (!lost) await leadActions.status(lead.id, code, note);
        },
        { done: label, status: lost ? "lost" : code },
      );
      return;
    }
    if (lost) void run(lead, () => leadActions.callAttempt(lead.id, "rejected", note), { done: label, status: "lost" });
    else void run(lead, () => leadActions.status(lead.id, code, note), { done: label, status: code });
  };

  const doTelegram = (lead: Lead, viaTracked = false) => {
    void openTelegram(lead.phone);
    void run(
      lead,
      () => (viaTracked ? tracked.finish("tg_only", { comment: note }) : leadActions.callAttempt(lead.id, "tg_only", note)),
      { done: t("v2.op.toast.tg"), status: "contacted_telegram" },
    );
  };

  const doTalked = (lead: Lead, viaTracked = false) => {
    void run(
      lead,
      () =>
        viaTracked ? tracked.finish("talked_interested", { comment: note }) : leadActions.callAttempt(lead.id, "talked_interested", note),
      { done: t("v2.op.toast.talked"), status: "in_progress", advance: false },
    );
  };

  const doStatus = (lead: Lead, code: string) => {
    if (!code) return;
    if (code === "no_answer") return doNoAnswer(lead, code, false);
    void run(lead, () => leadActions.status(lead.id, code, note), { done: cat.label(code), status: code, advance: false });
  };

  const doUnpostpone = (lead: Lead) =>
    void run(lead, () => leadActions.unpostpone(lead.id), { done: t("v2.op.toast.returned"), advance: false });

  const toSale = (lead: Lead) => nav(`/my/sale-new?lead=${lead.id}`, { state: { lead } });

  const startCall = (lead: Lead) => {
    if (!lead.phone) return;
    void tracked.startCall({ id: lead.id, full_name: lead.full_name, phone: lead.phone });
  };

  const outcome = (lead: Lead, k: 1 | 2 | 3 | 4) => {
    if (k === 1) return toSale(lead);
    if (k === 2) return setSheet({ kind: "callback", lead });
    if (k === 3) return setSheet({ kind: "noanswer", lead });
    return setSheet({ kind: "reject", lead });
  };

  /* ── keyboard: 1–4 outcomes, Space call, T telegram, O postpone ── */
  const anyDialog = !!sheet || tracked.modalOpen || watcher.due.length > 0;
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (mode !== "focus" || anyDialog || !current) return;
    if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
    const map: Record<string, 1 | 2 | 3 | 4> = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Numpad1: 1, Numpad2: 2, Numpad3: 3, Numpad4: 4 };
    if (map[e.code]) {
      e.preventDefault();
      outcome(current, map[e.code]);
    } else if (e.code === "Space") {
      e.preventDefault();
      startCall(current);
    } else if (e.code === "KeyT") {
      e.preventDefault();
      doTelegram(current);
    } else if (e.code === "KeyO") {
      e.preventDefault();
      setSheet({ kind: "postpone", lead: current });
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  /* ── header bits ── */
  const counts = focusQ.data?.counts ?? listQ.data?.counts ?? { active: 0, postponed: 0 };
  const working = status?.working_count ?? 0;
  const quota = status?.quota_limit ?? 5;

  const loading = focusQ.isLoading && mode === "focus";
  const error = mode === "focus" ? focusQ.isError && !focusQ.data : listQ.isError && !listQ.data;

  const trackedLead: Lead | null = tracked.pending
    ? findLead(tracked.pending.leadId) ?? pseudoLead(tracked.pending.leadId, tracked.pending.leadName, tracked.pending.leadPhone, "")
    : null;

  return (
    <>
      <header className="top" style={{ flexWrap: "wrap" }}>
        <h1 className="h1">{t("my.title")}</h1>
        <div className="seg" role="tablist" aria-label={t("v2.op.modeLabel")}>
          <button type="button" className={cx(mode === "focus" && "is-on")} aria-pressed={mode === "focus"} onClick={() => setMode("focus")}>
            {t("v2.op.mode.focus")}
          </button>
          <button type="button" className={cx(mode === "list" && "is-on")} aria-pressed={mode === "list"} onClick={() => setMode("list")}>
            {t("v2.op.mode.list")}
          </button>
        </div>
        <ShiftBadge checkedInAt={attQ.data?.open_log?.checked_in_at ?? null} loaded={!!attQ.data} />
        <span className="grow" />
        {mode === "list" ? (
          <div className="inwrap" style={{ width: 280, maxWidth: "100%" }}>
            <Search className="ic" />
            <input className="input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("v2.op.searchPh")} aria-label={t("v2.op.searchPh")} />
          </div>
        ) : blocked ? (
          <span className="badge b-bad" style={{ height: 28 }} title={status?.reason_ru}>
            <Lock className="ic ic-s" />
            {t("v2.op.gate.paused")}
          </span>
        ) : (
          <>
            {status ? (
              <div className="col g4" style={{ width: 150 }}>
                <div className="row between xs">
                  <span className="c3">{t("v2.op.inWork")}</span>
                  <span className="num w6">{working} / {quota}</span>
                </div>
                <Slots on={working} total={quota} />
              </div>
            ) : null}
            <PlanWidget status={status} />
          </>
        )}
        <Link className="btn btn-pri" to="/my/sale-new">
          <Plus className="ic" />
          {t("v2.op.newSale")}
        </Link>
      </header>

      <main className="page" style={{ gap: 16 }}>
        {error ? (
          <section className="card">
            <ErrorState error={mode === "focus" ? focusQ.error : listQ.error} onRetry={refresh} title={t("v2.op.loadFailed")} />
          </section>
        ) : loading ? (
          <section className="card">
            <LoadingBlock rows={6} onRetry={refresh} />
          </section>
        ) : mode === "focus" ? (
          blocked ? (
            <BlockedView
              rows={gateRows}
              max={gateMax.current}
              current={current}
              others={activeLeads.filter((l) => !gateRows.some((r) => r.leadId === l.id))}
              cat={cat}
              cbByLead={cbByLead}
              onPick={setSelectedId}
              onCall={startCall}
              onOutcome={outcome}
              now={now}
            />
          ) : (
            <>
              <DayLine
                today0={today0}
                now={now}
                checkedInAt={attQ.data?.open_log?.checked_in_at ?? attQ.data?.today_events?.[0]?.checked_in_at ?? null}
                salesToday={(salesQ.data?.results ?? []).filter((s) => Date.parse(s.sold_at) >= today0).map((s) => s.sold_at)}
                callbacks={(callbacksQ.data ?? []).filter((c) => c.status !== "done" && c.status !== "superseded")}
                calls={callsQ.data}
              />
              <StatusBanner status={status} overdue={[...cbByLead.values()].filter((c) => Date.parse(c.remind_at) <= now).length} />
              {current ? (
                <div className="row g20" style={{ alignItems: "stretch", flexWrap: "wrap" }}>
                  <FocusCard
                    lead={current}
                    pos={Math.max(1, queue.findIndex((l) => l.id === current.id) + 1)}
                    total={queue.length}
                    cat={cat}
                    cb={cbByLead.get(current.id) ?? null}
                    note={note}
                    setNote={setNote}
                    now={now}
                    onCall={() => startCall(current)}
                    onOutcome={(k) => outcome(current, k)}
                    onTelegram={() => doTelegram(current)}
                    onTalked={() => doTalked(current)}
                    onPostpone={() => setSheet({ kind: "postpone", lead: current })}
                    onStatus={(code) => doStatus(current, code)}
                  />
                  <aside className="col g12" style={{ flex: "1 1 340px", minWidth: 0 }} aria-label={t("v2.op.queue.title")}>
                    <QueueCard
                      queue={queue.filter((l) => l.id !== current.id).slice(0, 6)}
                      cat={cat}
                      cbByLead={cbByLead}
                      handled={handled}
                      now={now}
                      today0={today0}
                      postponed={counts.postponed}
                      onPick={(id) => setSelectedId(id)}
                      onAll={() => setMode("list")}
                      onPostponed={() => {
                        setView("postponed");
                        setQuotaMode(false);
                        setPage(1);
                        setMode("list");
                      }}
                    />
                    {status ? (
                      <section className="card col g8 pad">
                        <div className="row between">
                          <span className="s w6">{t("v2.op.slots")}</span>
                          <span className="num s w6">{working} / {quota}</span>
                        </div>
                        <Slots on={working} total={quota} />
                        <p className="xs c3">
                          {working < quota
                            ? t(`v2.op.slotsFree.${pluralForm(quota - working)}`, { n: quota - working })
                            : status.reason_ru || t("v2.op.slotsFull")}
                        </p>
                      </section>
                    ) : null}
                    <AttendanceStatusV2 />
                  </aside>
                </div>
              ) : (
                <>
                  <EmptyFocus
                    postponed={counts.postponed}
                    nextCallback={[...(callbacksQ.data ?? [])]
                      .filter((c) => c.status !== "done" && c.status !== "superseded" && Date.parse(c.remind_at) > now)
                      .sort((a, b) => Date.parse(a.remind_at) - Date.parse(b.remind_at))[0] ?? null}
                    onPostponed={() => {
                      setView("postponed");
                      setPage(1);
                      setMode("list");
                    }}
                  />
                  <AttendanceStatusV2 />
                </>
              )}
            </>
          )
        ) : (
          <ListView
            t={t}
            cat={cat}
            view={view}
            quotaMode={quotaMode}
            statusChip={statusChip}
            isChipView={isChipView}
            page={page}
            setPage={setPage}
            selectedDay={selectedDay}
            setSelectedDay={setSelectedDay}
            search={search}
            listQ={listQ}
            chipQ={chipQ}
            status={status}
            cbByLead={cbByLead}
            flash={flash}
            now={now}
            today0={today0}
            onTab={(v) => {
              setPage(1);
              setStatusChip("all");
              if (v === "quota") {
                setView("active");
                setQuotaMode(true);
                return;
              }
              setView(v);
              if (quotaMode) exitQuota();
            }}
            onChip={(c) => {
              setStatusChip(c);
              setPage(1);
            }}
            exitQuota={exitQuota}
            onOpen={(l) => {
              setSelectedId(l.id);
              setMode("focus");
            }}
            onCall={startCall}
            onUnpostpone={doUnpostpone}
          />
        )}
      </main>

      {/* ── sheets ── */}
      {sheet?.kind === "callback" ? (
        <CallbackDialog
          lead={sheet.lead}
          initialNote={note}
          onClose={() => {
            const wasTracked = sheet.tracked;
            setSheet(null);
            if (wasTracked) tracked.reopen();
          }}
          onSubmit={async (when, comment) => {
            const lead = sheet.lead;
            const wasTracked = sheet.tracked;
            setSheet(null);
            await run(
              lead,
              () =>
                wasTracked
                  ? tracked.finish("talked_callback", { comment, callback_remind_at: when.toISOString(), callback_comment: comment })
                  : leadActions.callback(lead.id, when, comment),
              { done: t("v2.op.cb.done", { when: whenLabel(when.toISOString(), t) }), status: "callback_scheduled" },
            );
          }}
        />
      ) : null}
      {sheet?.kind === "noanswer" ? (
        <NoAnswerDialog
          lead={sheet.lead}
          cat={cat}
          onBack={() => {
            const wasTracked = sheet.tracked;
            setSheet(null);
            if (wasTracked) tracked.reopen();
          }}
          onSave={(code) => {
            const s = sheet;
            setSheet(null);
            doNoAnswer(s.lead, code, !!s.tracked);
          }}
        />
      ) : null}
      {sheet?.kind === "reject" ? (
        <RejectDialog
          cat={cat}
          onBack={() => {
            const wasTracked = sheet.tracked;
            setSheet(null);
            if (wasTracked) tracked.reopen();
          }}
          onSave={(code) => {
            const s = sheet;
            setSheet(null);
            doReject(s.lead, code, !!s.tracked);
          }}
        />
      ) : null}
      {sheet?.kind === "postpone" ? (
        <PostponeDialog
          lead={sheet.lead}
          onClose={() => setSheet(null)}
          onSubmit={async (reason) => {
            const lead = sheet.lead;
            setSheet(null);
            await run(lead, () => leadActions.postpone(lead.id, reason), { done: t("my.lead_postponed") });
          }}
        />
      ) : null}

      {tracked.modalOpen && trackedLead ? (
        <CallOutcomeDialog
          lead={trackedLead}
          note={note}
          setNote={setNote}
          onClose={tracked.closeModal}
          onOutcome={(k) => {
            if (k === 1) {
              void run(trackedLead, () => tracked.finish("talked_interested", { comment: note }), {
                done: t("v2.op.toast.talked"),
                status: "in_progress",
                advance: false,
              }).then(() => toSale(trackedLead));
              return;
            }
            tracked.closeModal();
            if (k === 2) setSheet({ kind: "callback", lead: trackedLead, tracked: true });
            else if (k === 3) setSheet({ kind: "noanswer", lead: trackedLead, tracked: true });
            else setSheet({ kind: "reject", lead: trackedLead, tracked: true });
          }}
          onTelegram={() => doTelegram(trackedLead, true)}
          onTalked={() => doTalked(trackedLead, true)}
          onLater={() =>
            void tracked.finish("").catch(() => toast.error(t("v2.op.toast.failed"))).finally(refresh)
          }
        />
      ) : null}

      <CallbackDueDialog
        reminder={watcher.due[0] ?? null}
        onDismiss={watcher.dismiss}
        onCallNow={async (r) => {
          try {
            await leadActions.callbackDone(r.id);
            watcher.dismiss(r.id);
            refresh();
            toast.success(t("my.marked_done"));
            setSelectedId(r.lead);
            setMode("focus");
            if (r.lead_phone) void tracked.startCall({ id: r.lead, full_name: r.lead_name, phone: r.lead_phone });
          } catch {
            toast.error(t("v2.op.toast.failed"));
          }
        }}
        onSnooze={async (r) => {
          try {
            await leadActions.callbackSnooze(r.id, 15);
            watcher.dismiss(r.id);
            refresh();
            toast.success(t("v2.op.cb.snoozed", { time: hm(Date.now() + 15 * 60000) }));
          } catch {
            toast.error(t("v2.op.toast.failed"));
          }
        }}
      />
    </>
  );
}

function pseudoLead(id: number, name: string, phone: string, status: string): Lead {
  return {
    id,
    full_name: name,
    phone,
    phone_raw: phone,
    phone_invalid: false,
    product_hint: "",
    has_card: "",
    status,
    source: "",
    operator: null,
    operator_name: null,
    needs_review: false,
    sheet_source: null,
    sheet_source_name: null,
    sheet_row_index: null,
    metadata: {},
    postponed_at: null,
    postponed_by: null,
    postponed_by_name: null,
    postpone_reason: "",
    created_at: "",
    updated_at: "",
  };
}

/* ═════════════════════════ header widgets ═════════════════════════ */

function Slots({ on, total }: { on: number; total: number }) {
  const n = Math.max(1, Math.min(total || 5, 12));
  return (
    <div className="row g4" aria-hidden="true">
      {Array.from({ length: n }).map((_, i) => (
        <i key={i} className={cx("slot", i < on && "on")} />
      ))}
    </div>
  );
}

function PlanWidget({ status }: { status?: MyStatus }) {
  const t = useT2();
  if (!status || status.plan_target == null || !status.plan_target) return null;
  const actual = status.plan_actual ?? 0;
  const pct = Math.min(100, Math.round((actual / status.plan_target) * 100));
  return (
    <div className="col g4" style={{ width: 150 }}>
      <div className="row between xs">
        <span className="c3">{t("v2.op.plan")}</span>
        <span className="num w6">{t("v2.op.planOf", { a: actual, b: status.plan_target })}</span>
      </div>
      <div className="bar" style={{ height: 8 }} aria-hidden="true">
        <i className={pct >= 100 ? "ok" : undefined} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ShiftBadge({ checkedInAt, loaded }: { checkedInAt: string | null; loaded: boolean }) {
  const t = useT2();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!checkedInAt) return;
    const id = window.setInterval(() => tick((x) => x + 1), 1000);
    return () => window.clearInterval(id);
  }, [checkedInAt]);
  const scroll = () => document.querySelector<HTMLElement>("[data-attendance-widget]")?.scrollIntoView({ behavior: "smooth", block: "center" });
  if (!loaded) return null;
  if (!checkedInAt) {
    return (
      <button type="button" className="badge b-warn" style={{ height: 28, border: 0, cursor: "pointer" }} onClick={scroll}>
        <i className="dot" />
        {t("v2.op.shiftOff")}
      </button>
    );
  }
  const sec = Math.max(0, Math.floor((Date.now() - Date.parse(checkedInAt)) / 1000));
  const s = `${String(Math.floor(sec / 3600)).padStart(2, "0")}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  return (
    <button type="button" className="badge b-ok" style={{ height: 28, border: 0, cursor: "pointer" }} onClick={scroll} title={t("v2.op.shiftSince", { time: hm(checkedInAt) })}>
      <i className="dot" />
      {t("v2.op.shiftOn")} <span className="num">{s}</span>
    </button>
  );
}

/* ═════════════════════════ day line ═════════════════════════ */

function DayLine({
  today0,
  now,
  checkedInAt,
  salesToday,
  callbacks,
  calls,
}: {
  today0: number;
  now: number;
  checkedInAt: string | null;
  salesToday: string[];
  callbacks: CallbackRow[];
  calls?: { total: number; avg_duration_seconds: number | null };
}) {
  const t = useT2();
  const H = 3600 * 1000;
  const cbToday = callbacks.filter((c) => {
    const ms = Date.parse(c.remind_at);
    return ms >= today0 && ms < today0 + DAY_MS;
  });
  const marks: number[] = [now, ...salesToday.map(Date.parse), ...cbToday.map((c) => Date.parse(c.remind_at))];
  if (checkedInAt) marks.push(Date.parse(checkedInAt));
  const minH = Math.min(10, ...marks.map((m) => Math.floor((m - today0) / H)));
  const maxH = Math.max(20, ...marks.map((m) => Math.ceil((m - today0) / H)));
  const startH = Math.max(0, minH);
  const endH = Math.min(24, Math.max(startH + 1, maxH));
  const span = (endH - startH) * H;
  const x = (ms: number) => Math.min(99, Math.max(1, ((ms - today0 - startH * H) / span) * 100));
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [boxW, setBoxW] = useState(1000);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setBoxW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // ~56px per label keeps the hour ticks from overlapping on phones
  const step = Math.max(1, Math.ceil((endH - startH) / Math.max(2, Math.floor(boxW / 56))));
  const ticks: number[] = [];
  for (let h = startH; h <= endH; h += step) ticks.push(h);
  const nowX = x(now);
  const ahead = cbToday.filter((c) => Date.parse(c.remind_at) > now).sort((a, b) => Date.parse(a.remind_at) - Date.parse(b.remind_at));
  const avg = calls?.avg_duration_seconds ?? 0;
  const avgS = `${Math.floor(avg / 60)}:${String(Math.round(avg % 60)).padStart(2, "0")}`;
  return (
    <section className="col g6" aria-label={t("v2.op.dayline")}>
      <div className="dayline" ref={boxRef}>
        <i className="done" style={{ width: `${nowX}%` }} />
        {ticks.map((h, i) => (
          <span
            key={h}
            className="tick"
            style={
              i === 0
                ? { left: 8, transform: "none" }
                : i === ticks.length - 1 && h + step > endH
                  ? { left: "auto", right: 8, transform: "none" }
                  : { left: `${((h - startH) / (endH - startH)) * 100}%` }
            }
          >
            {String(h % 24).padStart(2, "0")}:00
          </span>
        ))}
        {checkedInAt ? <i className="mk mk-in" style={{ left: `${x(Date.parse(checkedInAt))}%` }} title={t("v2.op.dl.in", { time: hm(checkedInAt) })} /> : null}
        {salesToday.map((s, i) => (
          <i key={`s${i}`} className="mk mk-sale" style={{ left: `${x(Date.parse(s))}%` }} title={t("v2.op.dl.sale", { time: hm(s) })} />
        ))}
        {cbToday.map((c) => (
          <i
            key={`c${c.id}`}
            className={cx("mk", Date.parse(c.remind_at) <= now ? "mk-late" : "mk-cb")}
            style={{ left: `${x(Date.parse(c.remind_at))}%` }}
            title={t("v2.op.dl.cb", { time: hm(c.remind_at), name: c.lead_name || c.lead_phone })}
          />
        ))}
        <i className="now" style={{ left: `${nowX}%` }} />
      </div>
      <div className="row g16 xs c3 wrap">
        {checkedInAt ? (
          <span className="row g6">
            <i className="dot" style={{ color: "var(--brand)" }} />
            {t("v2.op.dl.inLegend")} <span className="num">{hm(checkedInAt)}</span>
          </span>
        ) : null}
        <span className="row g6">
          <i className="dot" style={{ color: "var(--ok-solid)" }} />
          {t("v2.op.dl.sales")} <span className="num">{salesToday.length}</span>
        </span>
        <span className="row g6">
          <i className="dot" style={{ color: "var(--warn-solid)" }} />
          {ahead.length
            ? t("v2.op.dl.cbAhead", { n: ahead.length, time: hm(ahead[0].remind_at) })
            : t("v2.op.dl.cbNone")}
        </span>
        <span className="grow" />
        {calls ? (
          <span>{calls.total ? t("v2.op.dl.calls", { n: calls.total, avg: avgS }) : t("v2.op.dl.callsZero")}</span>
        ) : null}
      </div>
    </section>
  );
}

/* ═════════════════════════ status banner ═════════════════════════ */

function StatusBanner({ status, overdue }: { status?: MyStatus; overdue: number }) {
  const t = useT2();
  if (!status) return null;
  const carry = status.carry_count ?? 0;
  const recall = status.recall_afternoon_count ?? 0;
  if (carry > 0 || overdue > 0) {
    return (
      <div className="banner b-bad">
        <AlertTriangle className="ic" />
        <span className="col g4">
          <span className="w6">{t("v2.op.banner.first", { n: carry + recall + overdue })}</span>
          {status.reason_ru ? <span>{status.reason_ru}</span> : null}
        </span>
      </div>
    );
  }
  if (status.recall_active_now && recall > 0) {
    return (
      <div className="banner b-warn">
        <Clock className="ic" />
        <span className="col g4">
          <span className="w6">{t("v2.op.banner.recall", { n: recall })}</span>
          {status.reason_ru ? <span>{status.reason_ru}</span> : null}
        </span>
      </div>
    );
  }
  return status.reason_ru ? <p className="xs c-ok w6" style={{ margin: 0 }}>{status.reason_ru}</p> : null;
}

/* ═════════════════════════ focus card ═════════════════════════ */

function leadHint(lead: Lead, cat: Catalog, t: TFn, today0: number, now: number) {
  const f = leadFlags(lead, today0, now);
  if (!f.carry && !f.recall) return null;
  const key = HINT_STATUS_KEY[lead.status];
  return `${whenLabel(lead.updated_at, t)} — ${key ? t(key) : cat.label(lead.status).toLowerCase()}`;
}

function FocusCard({
  lead,
  pos,
  total,
  cat,
  cb,
  note,
  setNote,
  now,
  onCall,
  onOutcome,
  onTelegram,
  onTalked,
  onPostpone,
  onStatus,
}: {
  lead: Lead;
  pos: number;
  total: number;
  cat: Catalog;
  cb: CallbackRow | null;
  note: string;
  setNote: (s: string) => void;
  now: number;
  onCall: () => void;
  onOutcome: (k: 1 | 2 | 3 | 4) => void;
  onTelegram: () => void;
  onTalked: () => void;
  onPostpone: () => void;
  onStatus: (code: string) => void;
}) {
  const t = useT2();
  const today0 = dayStartMs(new Date(now));
  const hist = useLeadCallAttempts(lead.id);
  const hint = leadHint(lead, cat, t, today0, now);
  const flags = leadFlags(lead, today0, now);
  const cbOverdue = cb ? Date.parse(cb.remind_at) <= now : false;
  const isHot = !!lead.hot_until && Date.parse(lead.hot_until) > now;
  const source = [lead.source === "sheet" ? null : lead.source ? t(`v2.op.src.${lead.source}`) : null, lead.sheet_source_name]
    .filter(Boolean)
    .join(" · ");

  const tips: ReactNode[] = [];
  if (isHot) tips.push(t("v2.op.tip.hot"));
  if (lead.is_retry && lead.previous_operator_name) tips.push(`${t("v2.op.tip.retry", { name: lead.previous_operator_name })} ${t("lead.retry_hint")}`);
  if (hint) tips.push(hint);
  if (lead.postponed_at && lead.postpone_reason) tips.push(t("v2.op.tip.postponed", { reason: lead.postpone_reason }));

  const historyRows: Array<{ what: string; when: string; at: number }> = [];
  for (const a of hist.data ?? []) {
    const what = [a.outcome ? t(`call_attempt.outcome.${a.outcome}`) : t("v2.op.hist.noOutcome"), a.comment].filter(Boolean).join(": ");
    historyRows.push({ what, when: whenLabel(a.created_at, t), at: Date.parse(a.created_at) });
  }
  if (cb) historyRows.push({ what: t("v2.op.hist.cb", { time: whenLabel(cb.remind_at, t) }) + (cb.comment ? `: ${cb.comment}` : ""), when: "", at: Date.parse(cb.remind_at) + 1e12 });
  if (lead.assigned_at) historyRows.push({ what: t("v2.op.hist.assigned"), when: whenLabel(lead.assigned_at, t), at: Date.parse(lead.assigned_at) });
  if (lead.created_at)
    historyRows.push({
      what: lead.sheet_source_name ? t("v2.op.hist.createdSheet", { name: lead.sheet_source_name }) : t("v2.op.hist.created"),
      when: whenLabel(lead.created_at, t),
      at: Date.parse(lead.created_at) - 1,
    });
  historyRows.sort((a, b) => b.at - a.at);

  return (
    <section className="focus" style={{ flex: "999 1 640px", minWidth: 0 }} aria-label={t("v2.op.current")}>
      <div className="row g8 wrap">
        {lead.status ? <StatusBadge code={lead.status} cat={cat} /> : null}
        <HotBadge until={lead.hot_until} />
        {lead.postponed_at ? <span className="badge">{t("my.postponed_badge")}</span> : null}
        {flags.carry ? <span className="badge b-info">{t("my.carry_yesterday_badge")}</span> : null}
        {source ? <span className="s c3">{source}</span> : null}
        <span className="grow" />
        {total ? <span className="xs c3">{t("v2.op.pos", { pos, total })}</span> : null}
      </div>

      <div className="row g24 wrap" style={{ alignItems: "flex-end" }}>
        <div className="col g8 grow" style={{ minWidth: 0 }}>
          <h2 className="display" style={{ fontSize: 32, lineHeight: "40px", overflowWrap: "anywhere" }}>{lead.full_name || t("my.no_name")}</h2>
          <div className="row g8 wrap">
            <span className="num" style={{ fontSize: 24, fontWeight: 600 }}>{lead.phone || t("leads.no_phone")}</span>
            {lead.phone ? (
              <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("v2.op.copyPhone")} title={t("v2.op.copyPhone")} onClick={() => void copyPhone(lead.phone, t)}>
                <Copy className="ic" />
              </button>
            ) : null}
          </div>
          {lead.phone_alt && lead.phone_alt !== lead.phone ? (
            <a className="xs c3 num" href={`tel:${lead.phone_alt}`}>
              {t("my.phone_alt_prefix")} {lead.phone_alt}
            </a>
          ) : null}
        </div>
        <button className="btn btn-ok btn-xl" type="button" onClick={onCall} disabled={!lead.phone} title={t("call_attempt.button.title")}>
          <Phone className="ic ic-l" />
          {t("v2.op.call")}
          <span className="kbd" style={{ background: "transparent", color: "#FFFFFF", borderColor: "rgba(255,255,255,.5)" }}>{t("v2.op.kbdSpace")}</span>
        </button>
      </div>

      <div className="row g8 wrap">
        {lead.product_hint ? <span className="chip" title={lead.product_hint}>{lead.product_hint}</span> : null}
        {lead.has_card ? <span className="chip">{t("v2.op.card", { v: lead.has_card })}</span> : null}
        {lead.assigned_at ? <span className="chip">{t("v2.op.assignedAt", { when: whenLabel(lead.assigned_at, t) })}</span> : null}
        {cb ? (
          <span className={cx("chip")} style={cbOverdue ? { borderColor: "var(--bad-solid)", color: "var(--bad)" } : undefined}>
            <AlarmClock className="ic ic-s" />
            {cbOverdue
              ? t("v2.op.cbOverdue", { time: hm(cb.remind_at), dur: durText(now - Date.parse(cb.remind_at), t) })
              : t("v2.op.cbAt", { when: whenLabel(cb.remind_at, t) })}
          </span>
        ) : null}
      </div>

      {tips.length ? (
        <div className="banner b-info">
          <Lightbulb className="ic" />
          <span className="col g4">
            {tips.map((x, i) => (
              <span key={i}>{x}</span>
            ))}
          </span>
        </div>
      ) : null}

      <div className="col g8">
        <div className="row between wrap g8">
          <span className="lbl">{t("v2.op.outcome")}</span>
          <span className="xs c3">{t("v2.op.outcomeHint")}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 10 }}>
          <OutcomeKeys onOutcome={onOutcome} />
        </div>
        <div className="row g8 wrap">
          <button className="btn grow" type="button" onClick={onTelegram} disabled={!lead.phone}>
            <span className="kbd">T</span>
            {t("v2.op.tg")}
          </button>
          <button className="btn grow" type="button" onClick={onTalked}>
            <MessageCircle className="ic" />
            {t("v2.op.talked")}
          </button>
          <button className="btn grow" type="button" onClick={onPostpone}>
            <span className="kbd">O</span>
            {t("my.postpone")}
          </button>
          <input className="input" type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("v2.op.notePh")} aria-label={t("v2.op.notePh")} style={{ flex: "2 1 200px" }} />
        </div>
        {cat.buttons.length ? (
          <div className="row g8 wrap">
            <span className="xs c3">{t("v2.op.setStatus")}</span>
            {cat.buttons.map((s) => (
              <button key={s.code} type="button" className={cx("chip", lead.status === s.code && "is-on")} onClick={() => onStatus(s.code)} disabled={lead.status === s.code}>
                {cat.label(s.code)}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="col g6">
        <span className="lbl">{t("v2.op.history")}</span>
        {hist.isLoading ? (
          <i className="sk" style={{ display: "block", height: 12, width: 240 }} />
        ) : historyRows.length ? (
          historyRows.slice(0, 8).map((h, i) => (
            <div key={i} className="row between g12 s">
              <span className="c2" style={{ minWidth: 0 }}>{h.what}</span>
              <span className="num xs c3" style={{ flex: "none" }}>{h.when}</span>
            </div>
          ))
        ) : (
          <span className="s c3">{t("v2.op.hist.empty")}</span>
        )}
      </div>
    </section>
  );
}

function OutcomeKeys({ onOutcome, compact }: { onOutcome: (k: 1 | 2 | 3 | 4) => void; compact?: boolean }) {
  const t = useT2();
  const items: Array<{ k: 1 | 2 | 3 | 4; title: string; sub: string; ok?: boolean }> = [
    { k: 1, title: t("v2.op.o1"), sub: t("v2.op.o1s"), ok: true },
    { k: 2, title: t("v2.op.o2"), sub: t("v2.op.o2s") },
    { k: 3, title: t("v2.op.o3"), sub: t("v2.op.o3s") },
    { k: 4, title: t("v2.op.o4"), sub: t("v2.op.o4s") },
  ];
  return (
    <>
      {items.map((it) => (
        <button key={it.k} type="button" className={cx("keycap", it.ok && "k-ok")} style={compact ? { minHeight: 56 } : undefined} onClick={() => onOutcome(it.k)}>
          <span className="kbd">{it.k}</span>
          <span>
            <b>{it.title}</b>
            {compact ? null : <span>{it.sub}</span>}
          </span>
        </button>
      ))}
    </>
  );
}

/* ═════════════════════════ queue ═════════════════════════ */

function queueReason(l: Lead, cb: CallbackRow | null, cat: Catalog, t: TFn, today0: number, now: number) {
  if (cb) {
    const ms = Date.parse(cb.remind_at);
    return ms <= now ? t("v2.op.q.cbLate", { dur: durText(now - ms, t) }) : t("v2.op.q.cb", { when: whenLabel(cb.remind_at, t) });
  }
  if (l.hot_until && Date.parse(l.hot_until) > now) return t("v2.op.q.hot", { when: whenLabel(l.assigned_at ?? l.created_at, t) });
  const h = leadHint(l, cat, t, today0, now);
  if (h) return h;
  if (l.postponed_at) return l.postpone_reason ? t("v2.op.tip.postponed", { reason: l.postpone_reason }) : t("my.postponed_badge");
  const when = l.assigned_at || l.created_at;
  return when ? t("v2.op.q.assigned", { when: whenLabel(when, t) }) : l.product_hint || "";
}

function QueueCard({
  queue,
  cat,
  cbByLead,
  handled,
  now,
  today0,
  postponed,
  onPick,
  onAll,
  onPostponed,
}: {
  queue: Lead[];
  cat: Catalog;
  cbByLead: Map<number, CallbackRow>;
  handled: Record<number, number>;
  now: number;
  today0: number;
  postponed: number;
  onPick: (id: number) => void;
  onAll: () => void;
  onPostponed: () => void;
}) {
  const t = useT2();
  return (
    <section className="card col">
      <div className="card-h">
        <span className="h3">{t("v2.op.queue.title")}</span>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onAll}>{t("v2.op.queue.all")}</button>
      </div>
      <div className="col g4" style={{ padding: 8 }}>
        {queue.length ? (
          queue.map((q, i) => {
            const cb = cbByLead.get(q.id) ?? null;
            return (
              <button
                key={q.id}
                type="button"
                className={cx("queue-item", i === 0 && "is-next")}
                style={{ textAlign: "left", width: "100%", background: i === 0 ? undefined : "none", opacity: handled[q.id] ? 0.6 : 1 }}
                onClick={() => onPick(q.id)}
              >
                <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                  <span className="row g6">
                    <span className="s w6 trunc">{q.full_name || t("my.no_name")}</span>
                    {q.hot_until && Date.parse(q.hot_until) > now ? <i className="dot" style={{ color: "var(--hot-solid)" }} /> : null}
                  </span>
                  <span className="xs c3 trunc">{queueReason(q, cb, cat, t, today0, now)}</span>
                </span>
                <StatusBadge code={q.status} cat={cat} overdue={!!cb && Date.parse(cb.remind_at) <= now} />
              </button>
            );
          })
        ) : (
          <span className="s c3" style={{ padding: "8px 10px" }}>{t("v2.op.queue.empty")}</span>
        )}
      </div>
      <hr className="hr" />
      <button className="li" type="button" style={{ minHeight: 48, width: "100%", background: "none", border: 0, textAlign: "left" }} onClick={onPostponed}>
        <span className="s grow">{t("my.tab_postponed")}</span>
        <span className="cnt cnt-mute">{postponed}</span>
        <ChevronRight className="ic c3" />
      </button>
    </section>
  );
}

/* ═════════════════════════ empty focus ═════════════════════════ */

function EmptyFocus({ postponed, nextCallback, onPostponed }: { postponed: number; nextCallback: CallbackRow | null; onPostponed: () => void }) {
  const t = useT2();
  return (
    <section className="focus" style={{ alignItems: "center", textAlign: "center", padding: "56px 32px 48px", gap: 16 }}>
      <span className="icon-tile t-ok" style={{ width: 56, height: 56, borderRadius: 16 }}>
        <CheckCircle2 className="ic ic-l" />
      </span>
      <h2 className="h1">{t("my.empty.title")}</h2>
      <p className="c2" style={{ maxWidth: 460 }}>{t("v2.op.empty.body")}</p>
      <div className="row g8 wrap" style={{ justifyContent: "center" }}>
        <Link className="btn btn-pri" to="/lessons/today">{t("v2.op.empty.lesson")}</Link>
        <button className="btn" type="button" onClick={onPostponed}>
          {t("my.tab_postponed")} · {postponed}
        </button>
      </div>
      {nextCallback ? (
        <p className="xs c3">
          {t("v2.op.empty.nextCb", { name: nextCallback.lead_name || nextCallback.lead_phone, when: whenLabel(nextCallback.remind_at, t) })}
        </p>
      ) : null}
    </section>
  );
}

/* ═════════════════════════ blocked (gate) ═════════════════════════ */

function BlockedView({
  rows,
  max,
  current,
  others,
  cat,
  cbByLead,
  onPick,
  onCall,
  onOutcome,
  now,
}: {
  rows: Array<{ leadId: number; name: string; phone: string; status: string | null; remindAt: string | null; updatedAt: string | null }>;
  max: number;
  current: Lead | null;
  others: Lead[];
  cat: Catalog;
  cbByLead: Map<number, CallbackRow>;
  onPick: (id: number) => void;
  onCall: (l: Lead) => void;
  onOutcome: (l: Lead, k: 1 | 2 | 3 | 4) => void;
  now: number;
}) {
  const t = useT2();
  const total = Math.max(max, rows.length);
  const done = total - rows.length;
  const reason = (r: (typeof rows)[number]) => {
    if (r.remindAt) return t("v2.op.gate.cbLate", { dur: durText(now - Date.parse(r.remindAt), t) });
    if (r.updatedAt) return t("v2.op.gate.waits", { status: cat.label(r.status ?? ""), dur: durText(now - Date.parse(r.updatedAt), t) });
    return cat.label(r.status ?? "");
  };
  const curRow = current ? rows.find((r) => r.leadId === current.id) : undefined;
  const curCb = current ? cbByLead.get(current.id) ?? null : null;
  const lateAt = curRow?.remindAt ?? (curCb && Date.parse(curCb.remind_at) <= now ? curCb.remind_at : null);
  return (
    <div className="split">
      <section className="list col g16">
        <div className="card col" style={{ borderColor: "var(--bad-solid)" }}>
          <div className="row g16 wrap" style={{ padding: "18px 20px", alignItems: "flex-start" }}>
            <div className="col g4 grow" style={{ minWidth: 260 }}>
              <h2 className="h2">{t(`v2.op.gate.title.${pluralForm(rows.length)}`, { n: rows.length })}</h2>
              <p className="s c3">{t("my.gate.explain")}</p>
            </div>
            <div className="col g6" style={{ width: 220 }}>
              <div className="row between">
                <span className="s w6">{t("v2.op.gate.closed")}</span>
                <span className="num s w6">{done} / {total}</span>
              </div>
              <div className="bar">
                <i className="bad" style={{ width: `${total ? Math.max(3, (done / total) * 100) : 0}%` }} />
              </div>
            </div>
          </div>
          <hr className="hr" />
          {rows.map((r) => (
            <div key={r.leadId} className={cx("row-item", current?.id === r.leadId && "is-sel")} style={{ flexWrap: "wrap" }}>
              <div className="col" style={{ width: 210, flex: "none", gap: 2 }}>
                <span className="h3 trunc">{r.name || t("my.no_name")}</span>
                <span className="num s c2">{r.phone || t("leads.no_phone")}</span>
              </div>
              <span className="s c-bad w6 grow" style={{ minWidth: 160 }}>{reason(r)}</span>
              {r.remindAt ? (
                <span className="badge b-bad"><i className="dot" />{t("my.gate.reason_callback")}</span>
              ) : r.status ? (
                <StatusBadge code={r.status} cat={cat} />
              ) : null}
              <button className="btn" type="button" onClick={() => onPick(r.leadId)}>{t("my.gate.open_lead")}</button>
            </div>
          ))}
        </div>
        {others.length ? (
          <>
            <div className="row between wrap g8">
              <span className="lbl">{t("v2.op.gate.others", { n: others.length })}</span>
              <span className="xs c3">{t("v2.op.gate.othersHint")}</span>
            </div>
            <div className="card" style={{ opacity: 0.72 }}>
              {others.map((l) => (
                <button key={l.id} type="button" className={cx("row-item", current?.id === l.id && "is-sel")} style={{ width: "100%", background: "none", border: 0, borderBottom: "1px solid var(--line)", textAlign: "left" }} onClick={() => onPick(l.id)}>
                  <div className="col" style={{ width: 210, flex: "none", gap: 2 }}>
                    <span className="h3 trunc">{l.full_name || t("my.no_name")}</span>
                    <span className="num s c2">{l.phone || t("leads.no_phone")}</span>
                  </div>
                  <span className="s grow trunc">{l.product_hint}</span>
                  <StatusBadge code={l.status} cat={cat} />
                </button>
              ))}
            </div>
          </>
        ) : null}
      </section>
      <aside className="panel col g16">
        {current ? (
          <section className="card col">
            <div className="col g12" style={{ padding: 20 }}>
              {lateAt ? (
                <div className="banner b-bad">
                  <Clock className="ic" />
                  <span>{t("v2.op.gate.cbBanner", { time: hm(lateAt), dur: durText(now - Date.parse(lateAt), t) })}</span>
                </div>
              ) : null}
              <div className="row between g12" style={{ alignItems: "flex-start" }}>
                <div className="col g4" style={{ minWidth: 0 }}>
                  <h2 className="h1 trunc" style={{ fontSize: 22, lineHeight: "28px" }}>{current.full_name || t("my.no_name")}</h2>
                  <span className="row g6">
                    <span className="num" style={{ fontSize: 17, fontWeight: 600 }}>{current.phone || t("leads.no_phone")}</span>
                    {current.phone ? (
                      <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("v2.op.copyPhone")} onClick={() => void copyPhone(current.phone, t)}>
                        <Copy className="ic" />
                      </button>
                    ) : null}
                  </span>
                </div>
                {current.status ? <StatusBadge code={current.status} cat={cat} /> : null}
              </div>
              {[current.product_hint, current.sheet_source_name, curCb?.comment ? `«${curCb.comment}»` : ""].filter(Boolean).length ? (
                <p className="s c3">{[current.product_hint, current.sheet_source_name, curCb?.comment ? `«${curCb.comment}»` : ""].filter(Boolean).join(" · ")}</p>
              ) : null}
              <button className="btn btn-ok btn-lg btn-block" type="button" disabled={!current.phone} onClick={() => onCall(current)}>
                <Phone className="ic" />
                {t("v2.op.call")}
              </button>
            </div>
            <hr className="hr" />
            <div className="col g8" style={{ padding: "16px 20px 20px" }}>
              <span className="lbl">{t("v2.op.outcome")}</span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                <OutcomeKeys compact onOutcome={(k) => onOutcome(current, k)} />
              </div>
            </div>
          </section>
        ) : null}
        <AttendanceStatusV2 />
      </aside>
    </div>
  );
}

/* ═════════════════════════ list view ═════════════════════════ */

type ListProps = {
  t: TFn;
  cat: Catalog;
  view: MyLeadsView;
  quotaMode: boolean;
  statusChip: string;
  isChipView: boolean;
  page: number;
  setPage: (n: number) => void;
  selectedDay: string;
  setSelectedDay: (s: string) => void;
  search: string;
  listQ: ReturnType<typeof useMyLeads>;
  chipQ: ReturnType<typeof useMyLeadsByStatus>;
  status?: MyStatus;
  cbByLead: Map<number, CallbackRow>;
  flash: Set<number>;
  now: number;
  today0: number;
  onTab: (v: ListTab) => void;
  onChip: (c: string) => void;
  exitQuota: () => void;
  onOpen: (l: Lead) => void;
  onCall: (l: Lead) => void;
  onUnpostpone: (l: Lead) => void;
};

function dayKeyOf(l: Lead, today0: number) {
  const src = l.assigned_at || l.created_at;
  const ts = src ? Date.parse(src) : 0;
  if (!ts) return "very_old";
  if (ts >= today0) return "today";
  if (ts >= today0 - DAY_MS) return "yesterday";
  if (ts >= today0 - 7 * DAY_MS) return `d:${ddmm(ts)}`;
  return "very_old";
}

function ListView(p: ListProps) {
  const { t, cat, view, quotaMode, isChipView, status, now, today0 } = p;
  const data = isChipView ? p.chipQ.data : p.listQ.data;
  const loading = isChipView ? p.chipQ.isLoading : p.listQ.isLoading;
  const rawResults = data?.results ?? [];
  const total = isChipView ? p.chipQ.data?.count ?? rawResults.length : p.listQ.data?.count ?? rawResults.length;
  const counts = p.listQ.data?.counts ?? { active: 0, postponed: 0 };
  const op = p.listQ.data?.operator;
  const backlog = (op?.open_callbacks ?? 0) + (op?.yesterday_backlog ?? 0);
  const working = status?.working_count ?? 0;
  const quota = status?.quota_limit ?? 5;

  const q = p.search.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, "");
  const results = q
    ? rawResults.filter(
        (l) =>
          (l.full_name || "").toLowerCase().includes(q) ||
          (l.product_hint || "").toLowerCase().includes(q) ||
          (qDigits.length >= 3 && (l.phone || "").replace(/\D/g, "").includes(qDigits)),
      )
    : rawResults;

  const tabs: Array<{ v: ListTab; label: string; n?: number; danger?: boolean }> = [
    { v: "active", label: t("my.tab_active"), n: backlog > 0 ? backlog : counts.active, danger: backlog > 0 },
    ...(working >= quota ? [{ v: "quota" as const, label: t("my.tab_quota"), n: working, danger: true }] : []),
    { v: "postponed", label: t("my.tab_postponed"), n: counts.postponed },
    { v: "closed", label: t("my.tabs.closed") },
    { v: "all", label: t("my.tab_all") },
  ];
  const activeTab: ListTab = quotaMode ? "quota" : view;

  // day groups (active, not chip, not quota)
  const grouped = view === "active" && !isChipView && !quotaMode;
  const prioritize = (ls: Lead[]) => {
    const prio: Lead[] = [];
    const rest: Lead[] = [];
    ls.forEach((l) => {
      const f = leadFlags(l, today0, now);
      (f.carry || f.recall ? prio : rest).push(l);
    });
    return [...prio, ...rest];
  };
  const byKey = new Map<string, Lead[]>();
  if (grouped) results.forEach((l) => {
    const k = dayKeyOf(l, today0);
    byKey.set(k, [...(byKey.get(k) ?? []), l]);
  });
  const dKeys = [...byKey.keys()]
    .filter((k) => k.startsWith("d:"))
    .sort((a, b) => {
      const parse = (s: string) => {
        const [dd, mm] = s.slice(2).split(".");
        return new Date(new Date().getFullYear(), Number(mm) - 1, Number(dd)).getTime();
      };
      return parse(b) - parse(a);
    });
  const order = ["today", "yesterday", ...dKeys, "very_old"].filter((k) => byKey.has(k));
  const dayChips = [
    { key: "all", n: results.length },
    { key: "today", n: byKey.get("today")?.length ?? 0 },
    ...order.filter((k) => k !== "today").map((k) => ({ key: k, n: byKey.get(k)!.length })),
  ];
  const activeDay = dayChips.some((c) => c.key === p.selectedDay) ? p.selectedDay : "today";
  const dayLabel = (k: string) =>
    k === "all" ? t("my.group.all") : k === "today" ? t("my.group.today") : k === "yesterday" ? t("my.group.yesterday") : k === "very_old" ? t("my.group.very_old") : k.slice(2);
  const dayNote = (k: string) =>
    k === "today" ? t("v2.op.grp.today") : k === "yesterday" ? t("v2.op.grp.yesterday") : k === "very_old" ? t("v2.op.grp.veryOld") : t("v2.op.grp.older");

  const byStatus = status?.by_status ?? {};

  const rowOf = (l: Lead) => (
    <LeadRow key={l.id} lead={l} cat={cat} cb={p.cbByLead.get(l.id) ?? null} flash={p.flash.has(l.id)} now={now} today0={today0} view={view} onOpen={p.onOpen} onCall={p.onCall} onUnpostpone={p.onUnpostpone} />
  );

  let body: ReactNode;
  if (loading) {
    body = <section className="card"><LoadingBlock rows={6} /></section>;
  } else if (view === "closed") {
    body = results.length ? (
      <section className="card tbl" style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 620 }}>
          <div className="tr th" style={{ gridTemplateColumns: "1.4fr 1.2fr 1fr 1fr" }}>
            <span>{t("v2.op.col.lead")}</span>
            <span>{t("v2.op.col.product")}</span>
            <span>{t("v2.op.col.result")}</span>
            <span>{t("v2.op.col.closedAt")}</span>
          </div>
          {results.map((l) => (
            <div key={l.id} className="tr" style={{ gridTemplateColumns: "1.4fr 1.2fr 1fr 1fr", color: "var(--ink-2)" }}>
              <span className="col" style={{ minWidth: 0 }}>
                <span className="w6 trunc">{l.full_name || t("my.no_name")}</span>
                <span className="num xs c3">{l.phone || t("leads.no_phone")}</span>
              </span>
              <span className="trunc">{l.product_hint || "—"}</span>
              <span><StatusBadge code={l.status} cat={cat} /></span>
              <span className="s c3">{whenLabel(l.updated_at, t)}</span>
            </div>
          ))}
        </div>
      </section>
    ) : (
      <section className="card"><EmptyState title={t("my.empty.closed")} /></section>
    );
  } else if (!results.length) {
    body = (
      <section className="card">
        {q ? (
          <EmptyState title={t("v2.op.searchEmpty")} body={t("v2.op.searchEmptyBody")} />
        ) : isChipView ? (
          <EmptyState title={t("my.empty.chip")} />
        ) : view === "active" && working === 0 ? (
          <EmptyState title={t("my.empty.title")} body={t("my.empty.subtitle")} />
        ) : (
          <EmptyState title={t("v2.state.empty")} />
        )}
      </section>
    );
  } else if (grouped) {
    const groups = activeDay === "all" ? order : [activeDay];
    const shown = groups.filter((k) => (byKey.get(k)?.length ?? 0) > 0);
    body = shown.length ? (
      shown.map((k) => (
        <section key={k} className="card tbl">
          <div className="card-h" style={{ minHeight: 44 }}>
            <span className="h3">{dayLabel(k)} · {byKey.get(k)!.length}</span>
            <span className="xs c3">{dayNote(k)}</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 720 }}>{prioritize(byKey.get(k)!).map(rowOf)}</div>
          </div>
        </section>
      ))
    ) : activeDay === "today" ? (
      <div className="banner b-info">
        <Lightbulb className="ic" />
        <span className="col g4">
          <span className="w6">{t("my.group.empty_today_title")}</span>
          <span>{t("my.group.empty_today")}</span>
        </span>
      </div>
    ) : (
      <section className="card"><EmptyState title={t("my.group.empty_day")} /></section>
    );
  } else {
    body = (
      <section className="card tbl">
        {view === "postponed" ? (
          <div className="card-h" style={{ minHeight: 44 }}>
            <span className="h3">{t("my.tab_postponed")} · {results.length}</span>
            <span className="xs c3">{t("v2.op.grp.postponed")}</span>
          </div>
        ) : null}
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 720 }}>{results.map(rowOf)}</div>
        </div>
      </section>
    );
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="row between wrap g12">
        <div className="tabs" style={{ borderBottom: 0 }} role="tablist">
          {tabs.map((tb) => (
            <button key={tb.v} type="button" role="tab" aria-selected={activeTab === tb.v} className={cx("tab", activeTab === tb.v && "is-on")} onClick={() => p.onTab(tb.v)}>
              {tb.label}
              {tb.n != null ? <span className={cx("cnt", !tb.danger && "cnt-mute")} style={tb.danger ? { background: "var(--bad-solid)", color: "#fff" } : undefined}>{tb.n}</span> : null}
            </button>
          ))}
        </div>
        {view === "active" && !quotaMode ? (
          <div className="row g8 wrap">
            {grouped
              ? dayChips.map((c) => (
                  <button key={c.key} type="button" className={cx("chip", activeDay === c.key && "is-on")} onClick={() => p.setSelectedDay(c.key)}>
                    {dayLabel(c.key)} <span className="n">{c.n}</span>
                  </button>
                ))
              : null}
            <select className="input" aria-label={t("v2.op.statusFilter")} value={p.statusChip} onChange={(e) => p.onChip(e.target.value)} style={{ width: 200, height: 32, fontSize: 13, borderRadius: 99 }}>
              <option value="all">{t("v2.op.allStatuses")} · {status?.total_leads ?? rawResults.length}</option>
              {cat.chips.map((s) => (
                <option key={s.code} value={s.code}>
                  {cat.label(s.code)} · {byStatus[s.code] ?? 0}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {view === "active" && !quotaMode && !isChipView ? <StatusBanner status={status} overdue={[...p.cbByLead.values()].filter((c) => Date.parse(c.remind_at) <= now).length} /> : null}

      {quotaMode ? (
        <div className="banner b-warn">
          <Lock className="ic" />
          <span className="col g4">
            <span className="w6">{t("my.quota.banner_title", { n: total })}</span>
            <span>{t("my.quota.banner_body", { limit: quota, need: Math.max(total - quota + 1, 1) })}</span>
          </span>
          <button className="btn btn-sm" type="button" onClick={p.exitQuota}>{t("my.quota.show_all")}</button>
        </div>
      ) : null}

      {body}

      {pages > 1 ? (
        <div className="row g8" style={{ justifyContent: "center", alignItems: "center" }}>
          <button className="btn btn-sm" type="button" disabled={p.page <= 1} onClick={() => p.setPage(p.page - 1)}>
            <ChevronLeft className="ic" />
            {t("v2.op.prev")}
          </button>
          <span className="s c3 num">
            {t("v2.op.shown", { from: (p.page - 1) * PAGE_SIZE + 1, to: Math.min(p.page * PAGE_SIZE, total), n: total })}
          </span>
          <button className="btn btn-sm" type="button" disabled={p.page >= pages} onClick={() => p.setPage(p.page + 1)}>
            {t("v2.op.next")}
            <ChevronRight className="ic" />
          </button>
        </div>
      ) : null}

      <div style={{ maxWidth: 460 }}>
        <AttendanceStatusV2 />
      </div>
    </>
  );
}

function LeadRow({
  lead,
  cat,
  cb,
  flash,
  now,
  today0,
  view,
  onOpen,
  onCall,
  onUnpostpone,
}: {
  lead: Lead;
  cat: Catalog;
  cb: CallbackRow | null;
  flash: boolean;
  now: number;
  today0: number;
  view: MyLeadsView;
  onOpen: (l: Lead) => void;
  onCall: (l: Lead) => void;
  onUnpostpone: (l: Lead) => void;
}) {
  const t = useT2();
  const postponed = !!lead.postponed_at;
  const canFocus = !postponed && view !== "closed";
  const cbLate = !!cb && Date.parse(cb.remind_at) <= now;
  return (
    <div
      id={`lead-${lead.id}`}
      className={cx("tr", flash && "is-sel")}
      style={{ gridTemplateColumns: "1.4fr 1.2fr 190px 1.5fr auto", minHeight: 60, transition: "background .3s", scrollMarginTop: 80 }}
    >
      {canFocus ? (
        <button type="button" className="col" style={{ minWidth: 0, background: "none", border: 0, padding: 0, textAlign: "left", cursor: "pointer" }} onClick={() => onOpen(lead)} title={t("v2.op.openFocus")}>
          <span className="w6 trunc">{lead.full_name || t("my.no_name")}</span>
          <span className="num xs c3">{lead.phone || t("leads.no_phone")}</span>
        </button>
      ) : (
        <span className="col" style={{ minWidth: 0 }}>
          <span className="w6 trunc">{lead.full_name || t("my.no_name")}</span>
          <span className="num xs c3">{lead.phone || t("leads.no_phone")}</span>
        </span>
      )}
      <span className="trunc">{lead.product_hint || t("v2.op.noProduct")}</span>
      <span className="row g4 wrap">
        <StatusBadge code={lead.status} cat={cat} overdue={cbLate} />
        <HotBadge until={lead.hot_until} />
        {postponed ? <span className="badge">{t("my.postponed_badge")}</span> : null}
      </span>
      <span className={cx("s trunc", cbLate ? "c-bad" : "c3")}>{queueReason(lead, cb, cat, t, today0, now)}</span>
      <span className="row g6" style={{ justifyContent: "flex-end" }}>
        {postponed ? (
          <button className="btn btn-sm" type="button" onClick={() => onUnpostpone(lead)}>
            <RotateCcw className="ic" />
            {t("my.return")}
          </button>
        ) : null}
        {lead.phone ? (
          <button className="btn btn-ok btn-sq" type="button" aria-label={t("v2.op.callTo", { name: lead.full_name || lead.phone })} title={t("call_attempt.button.title")} onClick={() => onCall(lead)}>
            <Phone className="ic" />
          </button>
        ) : null}
      </span>
    </div>
  );
}

/* ═════════════════════════ dialogs ═════════════════════════ */

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function localDate(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function localTime(d: Date) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function CallbackDialog({
  lead,
  initialNote,
  onClose,
  onSubmit,
}: {
  lead: Lead;
  initialNote: string;
  onClose: () => void;
  onSubmit: (when: Date, comment: string) => Promise<void>;
}) {
  const t = useT2();
  const quick = useMemo(() => {
    const now = new Date();
    const evening = new Date(now);
    evening.setHours(19, 0, 0, 0);
    if (evening <= now) evening.setDate(evening.getDate() + 1);
    const morning = new Date(now);
    morning.setDate(morning.getDate() + 1);
    morning.setHours(9, 30, 0, 0);
    return [
      { key: "1h", label: t("my.quick.in_1h"), d: new Date(now.getTime() + 3600_000) },
      { key: "3h", label: t("my.quick.in_3h"), d: new Date(now.getTime() + 3 * 3600_000) },
      { key: "ev", label: t("v2.op.cb.evening"), d: evening },
      { key: "mo", label: t("v2.op.cb.morning"), d: morning },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [picked, setPicked] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [comment, setComment] = useState(initialNote);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const when = date && time ? new Date(`${date}T${time}`) : null;
  const past = !!when && when.getTime() <= Date.now();
  const err = !when ? (touched ? t("my.time_required") : "") : past ? t("v2.op.cb.past", { time: localTime(new Date()) }) : "";

  const submit = async () => {
    setTouched(true);
    if (!when || past) return;
    setBusy(true);
    try {
      await onSubmit(when, comment.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={460}
      title={t("my.when_callback")}
      sub={<>{lead.full_name || t("my.no_name")} · <span className="num">{lead.phone}</span></>}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-pri" type="button" onClick={() => void submit()} disabled={busy || (touched && !!err)}>
            {busy ? t("common.saving") : when && !past ? t("v2.op.cb.assignAt", { time: localTime(when) }) : t("v2.op.cb.assign")}
          </button>
        </>
      }
    >
      <div className="col g8">
        <span className="lbl">{t("my.quick.title")}</span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
          {quick.map((q) => (
            <button
              key={q.key}
              type="button"
              className={cx("chip", picked === q.key && "is-on")}
              style={{ height: 40, justifyContent: "space-between" }}
              onClick={() => {
                setPicked(q.key);
                setDate(localDate(q.d));
                setTime(localTime(q.d));
              }}
            >
              {q.label} <span className="n">{localTime(q.d)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="row g8">
        <div className="field grow">
          <label htmlFor="cb-date">{t("v2.op.cb.date")}</label>
          <input
            className={cx("input num", touched && err && "is-bad")}
            id="cb-date"
            type="date"
            min={localDate(new Date())}
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setPicked(null);
            }}
          />
        </div>
        <div className="field" style={{ width: 130 }}>
          <label htmlFor="cb-time">{t("v2.op.cb.time")}</label>
          <input
            className={cx("input num", (past || (touched && err)) && "is-bad")}
            id="cb-time"
            type="time"
            value={time}
            onChange={(e) => {
              setTime(e.target.value);
              setPicked(null);
            }}
          />
        </div>
      </div>
      {err && (touched || past) ? (
        <span className="err row g6">
          <AlertTriangle className="ic ic-s" />
          {err}
        </span>
      ) : null}
      <div className="field">
        <label htmlFor="cb-note">{t("my.what_discussed")}</label>
        <textarea className="input" id="cb-note" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
        <div className="row g6 wrap">
          {["v2.op.cb.n1", "v2.op.cb.n2", "v2.op.cb.n3"].map((k) => (
            <button key={k} type="button" className="chip" onClick={() => setComment((c) => (c.trim() ? `${c.trim()}. ${t(k)}` : t(k)))}>
              {t(k)}
            </button>
          ))}
        </div>
      </div>
      <p className="s c3">{t("v2.op.cb.hint")}</p>
    </Dialog>
  );
}

const LOST_SHORTCUT = "__lost";
const REJECT_OPTIONS: Array<{ code: string; key: string }> = [
  { code: "qimmatlik_qildi", key: "v2.op.rej.expensive" },
  { code: "has_debt", key: "my.reason.reject.debt" },
  { code: "kartsi_yoq", key: "v2.op.rej.noCard" },
  { code: LOST_SHORTCUT, key: "my.reason.reject.bought_elsewhere" },
  { code: "shunchaki_qiziqdi", key: "my.reason.reject.just_asking" },
  { code: "notogri_raqam", key: "my.reason.reject.wrong_number" },
];

function NoAnswerDialog({ lead, cat, onBack, onSave }: { lead: Lead; cat: Catalog; onBack: () => void; onSave: (code: string) => void }) {
  const t = useT2();
  const opts = [
    { code: "no_answer", title: t("v2.op.na.beeps"), hint: lead.status === "no_answer" ? t("v2.op.na.beepsHint2") : t("v2.op.na.beepsHint") },
    { code: "phone_on", title: cat.label("phone_on") === "phone_on" ? t("v2.op.na.phoneOn") : cat.label("phone_on"), hint: t("v2.op.na.phoneOnHint") },
    { code: "sms_jonatildi", title: t("my.reason.no_answer.sms"), hint: t("v2.op.na.smsHint") },
  ].filter((o) => o.code === "no_answer" || !cat.loaded || cat.has(o.code));
  const [sel, setSel] = useState(opts[0]?.code ?? "no_answer");
  return (
    <Dialog
      open
      onClose={onBack}
      width={460}
      title={t("v2.op.na.title")}
      sub={<>{lead.full_name || lead.phone}</>}
      footer={
        <>
          <button className="btn" type="button" onClick={onBack}>{t("common.back")}</button>
          <button className="btn btn-pri" type="button" onClick={() => onSave(sel)}>
            {t("v2.op.saveNext")}
            <span className="kbd" style={{ background: "transparent", color: "#FFFFFF", borderColor: "rgba(255,255,255,.5)" }}>Enter</span>
          </button>
        </>
      }
    >
      <div
        className="col g8"
        role="radiogroup"
        onKeyDown={(e) => {
          const i = Number(e.key) - 1;
          if (i >= 0 && i < opts.length) setSel(opts[i].code);
          if (e.key === "Enter") {
            e.preventDefault();
            onSave(sel);
          }
        }}
      >
        {opts.map((o, i) => (
          <label key={o.code} className={cx("keycap", sel === o.code && "is-on")} style={{ minHeight: 56, cursor: "pointer" }}>
            <input type="radio" name="na" checked={sel === o.code} onChange={() => setSel(o.code)} style={{ margin: 0 }} autoFocus={i === 0} />
            <span>
              <b>{o.title}</b>
              <span>{o.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}

function RejectDialog({ cat, onBack, onSave }: { cat: Catalog; onBack: () => void; onSave: (code: string) => void }) {
  const t = useT2();
  const opts = REJECT_OPTIONS.filter((o) => o.code === LOST_SHORTCUT || !cat.loaded || cat.has(o.code));
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const i = Number(e.key) - 1;
      if (i >= 0 && i < opts.length) setSel(opts[i].code);
      if (e.key === "Enter" && sel) {
        e.preventDefault();
        onSave(sel);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [opts, sel, onSave]);
  return (
    <Dialog
      open
      onClose={onBack}
      width={460}
      title={t("my.reason.reject.title")}
      sub={t("v2.op.rej.sub")}
      footer={
        <>
          <button className="btn" type="button" onClick={onBack}>{t("common.back")}</button>
          <button className="btn btn-pri" type="button" disabled={!sel} onClick={() => sel && onSave(sel)}>{t("v2.op.rej.close")}</button>
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
        {opts.map((o) => (
          <button key={o.code} type="button" className={cx("chip chip-lg", sel === o.code && "is-on")} onClick={() => setSel(o.code)} style={{ justifyContent: "flex-start", whiteSpace: "normal", textAlign: "left" }}>
            {t(o.key)}
          </button>
        ))}
      </div>
      {sel === "qimmatlik_qildi" ? (
        <div className="banner b-info">
          <Lightbulb className="ic" />
          <span>{t("v2.op.rej.expensiveHint")}</span>
        </div>
      ) : null}
    </Dialog>
  );
}

function PostponeDialog({ lead, onClose, onSubmit }: { lead: Lead; onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const t = useT2();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      width={460}
      title={t("my.postpone_title")}
      sub={<>{lead.full_name || t("my.no_name")} · <span className="num">{lead.phone || t("my.no_phone_short")}</span></>}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <button
            className="btn btn-pri"
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(reason);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? t("common.saving") : t("my.postpone")}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="pp-reason">{t("v2.op.pp.reason")}</label>
        <textarea className="input" id="pp-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value.slice(0, 280))} placeholder={t("my.postpone_reason_ph")} autoFocus />
        <span className="hint row between">
          <span>{t("v2.op.pp.hint")}</span>
          <span className="num">{reason.length}/280</span>
        </span>
      </div>
      <div className="row g6 wrap">
        {["v2.op.pp.c1", "v2.op.pp.c2", "v2.op.pp.c3"].map((k) => (
          <button key={k} type="button" className="chip" onClick={() => setReason(t(k))}>{t(k)}</button>
        ))}
      </div>
    </Dialog>
  );
}

function CallOutcomeDialog({
  lead,
  note,
  setNote,
  onClose,
  onOutcome,
  onTelegram,
  onTalked,
  onLater,
}: {
  lead: Lead;
  note: string;
  setNote: (s: string) => void;
  onClose: () => void;
  onOutcome: (k: 1 | 2 | 3 | 4) => void;
  onTelegram: () => void;
  onTalked: () => void;
  onLater: () => void;
}) {
  const t = useT2();
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey) return;
      const map: Record<string, 1 | 2 | 3 | 4> = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Numpad1: 1, Numpad2: 2, Numpad3: 3, Numpad4: 4 };
      if (map[e.code]) {
        e.preventDefault();
        onOutcome(map[e.code]);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onOutcome]);
  return (
    <Dialog
      open
      onClose={onClose}
      width={460}
      title={t("call_attempt.modal.title")}
      sub={<>{lead.full_name || t("my.no_name")} · <span className="num">{lead.phone}</span></>}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onTelegram}>{t("v2.op.tg")}</button>
          <button className="btn btn-ghost" type="button" onClick={onTalked}>{t("v2.op.talked")}</button>
          <span className="grow" />
          <button className="btn" type="button" onClick={onLater}>{t("v2.op.later")}</button>
        </>
      }
    >
      <div className="col g8">
        <OutcomeKeys compact onOutcome={onOutcome} />
      </div>
      <input className="input" type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("v2.op.notePhOpt")} aria-label={t("v2.op.notePhOpt")} />
    </Dialog>
  );
}

function CallbackDueDialog({
  reminder,
  onDismiss,
  onCallNow,
  onSnooze,
}: {
  reminder: { id: number; lead: number; lead_name: string; lead_phone: string; remind_at: string; comment: string } | null;
  onDismiss: (id: number) => void;
  onCallNow: (r: NonNullable<typeof reminder>) => Promise<void>;
  onSnooze: (r: NonNullable<typeof reminder>) => Promise<void>;
}) {
  const t = useT2();
  const [busy, setBusy] = useState(false);
  if (!reminder) return null;
  const go = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      locked
      onClose={() => onDismiss(reminder.id)}
      width={440}
      title={
        <span className="row g8" style={{ color: "var(--warn)" }}>
          <AlarmClock className="ic ic-l" />
          <span className="col g4">
            <span className="lbl" style={{ color: "var(--warn)" }}>{t("v2.op.due.eyebrow")}</span>
            <span className="num">{hm(reminder.remind_at)}</span>
          </span>
        </span>
      }
      footer={
        <>
          <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => onDismiss(reminder.id)}>{t("v2.op.later")}</button>
          <span className="grow" />
          <button className="btn" type="button" disabled={busy} onClick={() => void go(() => onSnooze(reminder))}>{t("v2.op.due.snooze")}</button>
          <button className="btn btn-ok" type="button" disabled={busy} onClick={() => void go(() => onCallNow(reminder))}>
            <Phone className="ic" />
            {t("v2.op.due.call")}
          </button>
        </>
      }
    >
      <h2 className="display" style={{ fontSize: 24, lineHeight: "32px" }}>{reminder.lead_name || t("my.no_name")}</h2>
      <span className="num" style={{ fontSize: 18, fontWeight: 600 }}>{reminder.lead_phone || t("leads.no_phone")}</span>
      {reminder.comment ? <div className="well s">«{reminder.comment}»</div> : null}
    </Dialog>
  );
}
