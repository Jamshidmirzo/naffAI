import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Phone,
  MessageCircle,
  AlarmClock,
  CheckCircle2,
  PauseCircle,
  PlayCircle,
  PhoneMissed,
  XCircle,
  Plus,
  ChevronDown,
  PhoneCall,
  Wallet,
} from "lucide-react";
import { Paginator } from "../components/Paginator";
import { apiErrorMessage } from "../lib/api-types";
import { api } from "../lib/api";
import {
  type CallOutcome,
  type CallbackReminder,
  LEAD_STATUS_LABEL,
  type Lead,
  type LeadStatus,
  TG_LINK_FALLBACK,
} from "../lib/leads";
import { useCallbackWatcher } from "../hooks/useCallbackWatcher";
import {
  Button,
  Eyebrow,
  Modal,
  StatusBadge,
  TabPill,
  toast,
  type TabItem,
} from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";
import { GaugeScene } from "../components/three/GaugeScene";

type MyLeadsView = "active" | "postponed" | "all";
type StatusChipKey =
  | "all"
  | "new"
  | "callback"
  | "no_answer_1"
  | "no_answer_2"
  | "phone_on"
  | "tg"
  | "debt";

const STATUS_CHIP_MATCH: Record<StatusChipKey, (s: LeadStatus) => boolean> = {
  all: () => true,
  new: (s) => s === "new" || s === "assigned" || s === "in_progress",
  callback: (s) => s === "callback_scheduled",
  no_answer_1: (s) => s === "no_answer",
  no_answer_2: (s) => s === "no_answer_2",
  phone_on: (s) => s === "phone_on",
  tg: (s) => s === "contacted_telegram",
  debt: (s) => s === "has_debt",
};

type MyResponse = {
  operator: { id: number; full_name: string; status: string; blocked: boolean };
  counts: { active: number; postponed: number };
  results: Lead[];
  count?: number;
};

function fmtCallback(iso: string | null | undefined) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function isOverdue(iso: string | null | undefined) {
  if (!iso) return false;
  try {
    return new Date(iso).getTime() < Date.now();
  } catch {
    return false;
  }
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase() || "?";
}

export default function MyLeads() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const [view, setView] = useState<MyLeadsView>("active");
  const [postponeFor, setPostponeFor] = useState<Lead | null>(null);
  const [scheduleFor, setScheduleFor] = useState<Lead | null>(null);
  const [statusChip, setStatusChip] = useState<StatusChipKey>("all");

  const t = useT();
  usePageHeader({ title: t("my.title"), subtitle: t("my.subtitle") }, [t("my.title")]);

  const my = useQuery({
    queryKey: ["leads-my", page, view],
    queryFn: () =>
      api.get<MyResponse>(`/leads/my/?page=${page}&view=${view}`).then((r) => r.data),
    refetchInterval: 60_000,
  });

  const unpostpone = useMutation({
    mutationFn: (lead: Lead) => api.post(`/leads/${lead.id}/unpostpone/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["leads-my"] }),
  });

  // Both mutations share an optimistic-update helper: we patch the lead's
  // status in the react-query cache immediately so the chip counters and
  // status badge on the card reflect the click before the network round
  // trip. On error we roll back; on settle we invalidate so any server-side
  // side effects (e.g. NO_ANSWER → NO_ANSWER_2 escalation) get picked up.
  const applyOptimisticStatus = (leadId: number, status: LeadStatus) => {
    const key = ["leads-my", page, view];
    const prev = qc.getQueryData<MyResponse>(key);
    if (prev) {
      qc.setQueryData<MyResponse>(key, {
        ...prev,
        results: prev.results.map((l) =>
          l.id === leadId ? { ...l, status } : l,
        ),
      });
    }
    return prev;
  };

  const OUTCOME_TO_STATUS: Partial<Record<CallOutcome, LeadStatus>> = {
    talked_interested: "in_progress",
    no_answer: "no_answer",
    rejected: "lost",
    tg_only: "contacted_telegram",
  };

  const quickCall = useMutation({
    mutationFn: ({ lead, outcome, comment }: { lead: Lead; outcome: CallOutcome; comment?: string }) =>
      api.post(`/leads/${lead.id}/call-attempts/`, { outcome, comment }),
    onMutate: async ({ lead, outcome }) => {
      await qc.cancelQueries({ queryKey: ["leads-my"] });
      const next =
        outcome === "no_answer" && lead.status === "no_answer"
          ? "no_answer_2"
          : OUTCOME_TO_STATUS[outcome];
      if (!next) return { prev: undefined };
      return { prev: applyOptimisticStatus(lead.id, next as LeadStatus) };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["leads-my", page, view], ctx.prev);
      toast.error(t("toast.error"));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["leads-my"] }),
  });

  const setStatus = useMutation({
    mutationFn: ({ lead, status }: { lead: Lead; status: LeadStatus }) =>
      api.post(`/leads/${lead.id}/status/`, { status }),
    onMutate: async ({ lead, status }) => {
      await qc.cancelQueries({ queryKey: ["leads-my"] });
      return { prev: applyOptimisticStatus(lead.id, status) };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["leads-my", page, view], ctx.prev);
      toast.error(t("toast.error"));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["leads-my"] }),
  });

  const watcher = useCallbackWatcher({ enabled: true });

  const openTg = async (lead: Lead) => {
    if (!lead.phone) return;
    try {
      const { data } = await api.get(
        `/telegram/lookup/?phone=${encodeURIComponent(lead.phone)}`,
      );
      if (data?.username) {
        window.open(`https://t.me/${data.username}`, "_blank", "noopener");
        return;
      }
    } catch {
      /* fallthrough */
    }
    window.location.href = TG_LINK_FALLBACK(lead.phone);
  };

  const refetch = () => qc.invalidateQueries({ queryKey: ["leads-my"] });

  const operator = my.data?.operator;
  const results = my.data?.results ?? [];
  const counts = my.data?.counts ?? { active: 0, postponed: 0 };

  const tabs: TabItem<MyLeadsView>[] = [
    { value: "active", label: t("my.tab_active"), count: counts.active },
    { value: "postponed", label: t("my.tab_postponed"), count: counts.postponed },
    { value: "all", label: t("my.tab_all") },
  ];

  const overdueCount = useMemo(
    () => results.filter((l) => isOverdue((l as unknown as { callback_at?: string }).callback_at)).length,
    [results],
  );

  const statusChipCounts = useMemo(() => {
    const c: Record<StatusChipKey, number> = {
      all: results.length,
      new: 0,
      callback: 0,
      no_answer_1: 0,
      no_answer_2: 0,
      phone_on: 0,
      tg: 0,
      debt: 0,
    };
    for (const l of results) {
      const s = l.status as LeadStatus;
      if (STATUS_CHIP_MATCH.new(s)) c.new++;
      if (STATUS_CHIP_MATCH.callback(s)) c.callback++;
      if (STATUS_CHIP_MATCH.no_answer_1(s)) c.no_answer_1++;
      if (STATUS_CHIP_MATCH.no_answer_2(s)) c.no_answer_2++;
      if (STATUS_CHIP_MATCH.phone_on(s)) c.phone_on++;
      if (STATUS_CHIP_MATCH.tg(s)) c.tg++;
      if (STATUS_CHIP_MATCH.debt(s)) c.debt++;
    }
    return c;
  }, [results]);

  const visibleLeads = useMemo(() => {
    if (view !== "active" || statusChip === "all") return results;
    const match = STATUS_CHIP_MATCH[statusChip];
    return results.filter((l) => match(l.status as LeadStatus));
  }, [results, view, statusChip]);

  const statusChips: { key: StatusChipKey; label: string; count: number }[] = [
    { key: "all", label: t("common.all"), count: statusChipCounts.all },
    { key: "new", label: t("my.chip_new"), count: statusChipCounts.new },
    { key: "callback", label: t("my.chip_callback"), count: statusChipCounts.callback },
    { key: "no_answer_1", label: t("my.chip_no_answer_1"), count: statusChipCounts.no_answer_1 },
    { key: "no_answer_2", label: t("my.chip_no_answer_2"), count: statusChipCounts.no_answer_2 },
    { key: "phone_on", label: t("my.chip_phone_on"), count: statusChipCounts.phone_on },
    { key: "tg", label: t("my.chip_tg"), count: statusChipCounts.tg },
    { key: "debt", label: t("my.chip_debt"), count: statusChipCounts.debt },
  ];

  const dailyPlan = 20;
  const donePlan = counts.active + counts.postponed;
  const planPct = Math.min(100, Math.round((donePlan / dailyPlan) * 100));

  if (my.isLoading) {
    return (
      <div className="mx-auto max-w-[960px] py-16 text-center text-muted text-[14px]">
        {t("my.loading")}
      </div>
    );
  }
  if (my.isError || !my.data) {
    return (
      <div
        className="mx-auto max-w-[960px] text-[14px] rounded-2xl px-5 py-4"
        style={{
          background: "rgba(220,60,40,.08)",
          color: "var(--danger)",
          border: "1px solid rgba(220,60,40,.2)",
        }}
      >
        {t("my.load_failed")}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[960px] flex flex-col gap-5">
      {/* --- Overdue banner --- */}
      {operator?.blocked && (
        <div
          className="rounded-[20px] px-6 py-5 flex items-center gap-4 text-white animate-nfPop"
          style={{
            background: "linear-gradient(100deg, var(--accent), var(--accent2))",
            boxShadow: "0 18px 40px -20px var(--accent)",
          }}
        >
          <span className="relative flex w-3 h-3 shrink-0">
            <span className="animate-nfPulse absolute inline-flex h-full w-full rounded-full bg-white/60" />
            <span className="relative inline-flex w-3 h-3 rounded-full bg-white" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold">
              {overdueCount > 0
                ? t("my.overdue_count", { n: overdueCount })
                : t("my.have_overdue")}
            </div>
            <div className="text-[13px] opacity-90">
              {t("my.overdue_hint")}
            </div>
          </div>
          <button
            className="rounded-full px-5 py-2.5 text-[13px] font-semibold text-[color:var(--accent)]"
            style={{ background: "#fff" }}
            onClick={() => setView("active")}
          >
            {t("my.resolve")}
          </button>
        </div>
      )}

      {/* --- Hero --- */}
      <section
        className="nf-hero animate-nfFadeUp"
        style={{ borderRadius: 28, padding: "34px 36px", border: "1px solid var(--border)" }}
      >
        <div className="grid gap-6 md:grid-cols-[1.4fr,1fr] items-center">
          <div>
            <Eyebrow>{t("my.morning")}</Eyebrow>
            <h1
              className="font-semibold mt-3"
              style={{ fontSize: 33, letterSpacing: "-0.03em", lineHeight: 1.1 }}
            >
              {counts.active > 0 ? (
                <>
                  {t("my.you_have_prefix")} <span style={{ color: "var(--accent)" }}>{counts.active}</span>{" "}
                  {counts.active === 1 ? t("my.active_lead_one") : t("my.active_lead_many")}
                </>
              ) : (
                <>{t("my.all_done")}</>
              )}
            </h1>
            <p className="text-[14px] text-muted mt-2.5 max-w-md">
              {operator?.full_name} · {t("my.daily_plan_hint", { n: dailyPlan })}
              {counts.postponed > 0 && <> {t("my.postponed_hint", { n: counts.postponed })}</>}
            </p>
          </div>
          <div
            className="hidden md:block rounded-2xl relative overflow-hidden"
            style={{ height: 200, background: "var(--surface)", border: "1px solid var(--border)" }}
          >
            <GaugeScene
              percent={planPct}
              className="absolute inset-0"
              style={{ pointerEvents: "none" }}
            />
            <div className="absolute inset-x-0 bottom-3 text-center">
              <div className="text-[12.5px] font-medium">
                {t("my.plan_day_pct", { n: planPct })}
              </div>
              <div className="text-[11.5px] text-muted">
                {t("my.plan_progress", { done: donePlan, total: dailyPlan })}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* --- Tabs + summary --- */}
      <section className="flex flex-wrap items-center justify-between gap-3 animate-nfFadeUp">
        <TabPill value={view} onChange={(v) => { setView(v); setPage(1); setStatusChip("all"); }} items={tabs} />
        <div className="text-[13px] text-muted">
          {t("my.leads_count", { n: visibleLeads.length })}
          {overdueCount > 0 && (
            <>
              {" · "}
              <span style={{ color: "var(--accent)" }} className="font-semibold">
                {t("leads.overdue", { n: overdueCount })}
              </span>
            </>
          )}
        </div>
      </section>

      {/* --- Status chips (only in "active" view) --- */}
      {view === "active" && (
        <section className="flex flex-wrap gap-2 animate-nfFadeUp">
          {statusChips.map((chip) => {
            const isActive = statusChip === chip.key;
            const dim = chip.count === 0 && chip.key !== "all";
            return (
              <button
                key={chip.key}
                onClick={() => setStatusChip(chip.key)}
                className="nf-chip"
                style={{
                  padding: "6px 12px",
                  fontSize: 12.5,
                  borderRadius: 999,
                  border: "1px solid var(--border)",
                  background: isActive ? "var(--accent-grad)" : "transparent",
                  color: isActive ? "#fff" : dim ? "var(--muted)" : "var(--text)",
                  fontWeight: isActive ? 600 : 500,
                  opacity: dim ? 0.55 : 1,
                }}
              >
                {chip.label}
                {chip.count > 0 && (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 11,
                      opacity: 0.75,
                      fontWeight: 500,
                    }}
                  >
                    · {chip.count}
                  </span>
                )}
              </button>
            );
          })}
        </section>
      )}

      {/* --- Lead cards --- */}
      {visibleLeads.length === 0 ? (
        <div
          className="rounded-2xl py-12 text-center text-[13.5px] text-muted"
          style={{ border: "1.5px dashed var(--border)" }}
        >
          {t("my.empty")}
        </div>
      ) : (
        <section className="flex flex-col gap-[9px]">
          {visibleLeads.map((lead, i) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              index={i}
              onCall={() => {
                quickCall.mutate({ lead, outcome: "talked_interested" });
                toast.success(t("my.toast_called"));
              }}
              onMiss={() => {
                quickCall.mutate({ lead, outcome: "no_answer" });
                toast.success(t("my.toast_no_answer"));
              }}
              onReject={() => {
                quickCall.mutate({ lead, outcome: "rejected" });
                toast.success(t("my.toast_rejected"));
              }}
              onTg={() => {
                openTg(lead);
                quickCall.mutate({ lead, outcome: "tg_only" });
                toast.success(t("my.toast_tg"));
              }}
              onPhoneOn={() => {
                setStatus.mutate({ lead, status: "phone_on" });
                toast.success(t("my.toast_phone_on"));
              }}
              onHasDebt={() => {
                setStatus.mutate({ lead, status: "has_debt" });
                toast.success(t("my.toast_debt"));
              }}
              onSchedule={() => setScheduleFor(lead)}
              onPostpone={() => setPostponeFor(lead)}
              onUnpostpone={() => unpostpone.mutate(lead)}
              onConvert={() => nav(`/sales/new?lead=${lead.id}`)}
            />
          ))}
        </section>
      )}

      <div className="flex justify-center">
        <Paginator
          page={page}
          total={my.data?.count || results.length}
          pageSize={50}
          onChange={setPage}
        />
      </div>

      {/* --- Modals --- */}
      <ScheduleCallbackModal
        lead={scheduleFor}
        onClose={() => setScheduleFor(null)}
        onDone={() => {
          setScheduleFor(null);
          refetch();
        }}
      />

      <PostponeModal
        lead={postponeFor}
        onClose={() => setPostponeFor(null)}
        onDone={() => {
          setPostponeFor(null);
          refetch();
        }}
      />

      <CallbackDueModal
        reminders={watcher.due}
        onDismiss={watcher.dismiss}
        onDone={refetch}
      />
    </div>
  );
}

// -------------------------------------------------------------------------

interface LeadCardProps {
  lead: Lead;
  index: number;
  onCall: () => void;
  onMiss: () => void;
  onReject: () => void;
  onTg: () => void;
  onPhoneOn: () => void;
  onHasDebt: () => void;
  onSchedule: () => void;
  onPostpone: () => void;
  onUnpostpone: () => void;
  onConvert: () => void;
}

function LeadCard({
  lead,
  index,
  onCall,
  onMiss,
  onReject,
  onTg,
  onPhoneOn,
  onHasDebt,
  onSchedule,
  onPostpone,
  onUnpostpone,
  onConvert,
}: LeadCardProps) {
  const [called, setCalled] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const contactRef = useRef<HTMLDivElement | null>(null);
  const [flashKey, setFlashKey] = useState(0);
  const prevStatusRef = useRef(lead.status);

  // Whenever the lead's status changes (from optimistic update or refetch),
  // pulse a soft accent ring around the whole card so the operator has a
  // clear "yep, saved" confirmation.
  useEffect(() => {
    if (prevStatusRef.current !== lead.status) {
      prevStatusRef.current = lead.status;
      setFlashKey((k) => k + 1);
    }
  }, [lead.status]);

  const wrap = <T extends unknown[]>(fn: (...args: T) => void) => {
    return (...args: T) => {
      setFlashKey((k) => k + 1); // immediate ring even before status arrives
      fn(...args);
    };
  };
  const isPostponed = !!lead.postponed_at;
  const overdue = isOverdue((lead as unknown as { callback_at?: string }).callback_at);
  const source = (lead as unknown as { source_name?: string }).source_name ?? lead.sheet_source_name ?? "";
  const calls = (lead as unknown as { calls_count?: number }).calls_count ?? 0;
  const t = useT();

  useEffect(() => {
    if (!contactOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (contactRef.current && !contactRef.current.contains(e.target as Node)) {
        setContactOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [contactOpen]);

  const markCalled = () => {
    onCall();
    setCalled(true);
    toast.success(t("my.call_marked"));
  };

  const chooseCall = () => {
    setContactOpen(false);
    if (lead.phone) window.open(`tel:${lead.phone}`, "_self");
    markCalled();
  };
  const chooseTg = () => {
    setContactOpen(false);
    onTg();
  };

  return (
    <div
      key={`card-${lead.id}`}
      className="animate-nfFadeUp flex items-start gap-4 relative"
      style={{
        borderRadius: 18,
        padding: "14px 18px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        boxShadow: "var(--shadow)",
        animationDelay: `${0.04 + index * 0.055}s`,
      }}
    >
      {/* Feedback ring — remounts on flashKey change so the CSS animation
          restarts on every action; pointer-events: none keeps it invisible
          to the mouse. */}
      <span
        key={flashKey}
        className="pointer-events-none absolute inset-0 animate-nfFlashRing"
        style={{ borderRadius: 18 }}
      />
      {/* avatar */}
      <div
        className="grid place-items-center text-white text-[13px] font-semibold shrink-0"
        style={{
          width: 38,
          height: 38,
          borderRadius: 12,
          background: isPostponed
            ? "linear-gradient(145deg, #ffcfae, #ffa15c)"
            : "var(--accent-grad)",
        }}
      >
        {initials(lead.full_name || lead.phone || "?")}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-[14.5px] font-medium truncate">
            {lead.full_name || t("my.no_name")}
          </div>
          <StatusBadge tone={overdue || lead.status === "needs_review" ? "hot" : "neutral"}>
            {LEAD_STATUS_LABEL[lead.status as LeadStatus] ?? lead.status}
          </StatusBadge>
          {isPostponed && (
            <StatusBadge tone="hot">
              <PauseCircle className="w-3 h-3 inline mr-0.5" /> {t("my.postponed_badge")}
            </StatusBadge>
          )}
        </div>
        <div className="text-[12.5px] text-muted mt-1 flex flex-wrap gap-x-3 gap-y-1">
          <span>{lead.phone || t("leads.no_phone")}</span>
          {source && <span>· {source}</span>}
          {calls > 0 && <span>· {t("my.calls_short", { n: calls })}</span>}
          {(lead as unknown as { callback_at?: string }).callback_at && (
            <span
              style={overdue ? { color: "var(--accent)", fontWeight: 600 } : undefined}
            >
              · {overdue ? `${t("my.overdue_prefix")} ` : ""}
              {fmtCallback((lead as unknown as { callback_at?: string }).callback_at)}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 justify-end items-start">
        {called ? (
          <div className="text-[12.5px] text-muted flex items-center gap-1.5 px-3 py-2">
            <CheckCircle2 className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />
            {t("my.call_marked_lower")}
          </div>
        ) : (
          <>
            {/* Split-button: main "Bog'lanish" with dropdown for Call / TG */}
            <div className="relative" ref={contactRef}>
              <button
                type="button"
                className="nf-btn nf-btn--primary transition-transform active:scale-[.94]"
                style={{ padding: "9px 14px", fontSize: 13, gap: 6 }}
                onClick={() => setContactOpen((v) => !v)}
                disabled={!lead.phone}
              >
                <PhoneCall className="w-3.5 h-3.5" />
                {t("my.contact")}
                <ChevronDown className="w-3 h-3 opacity-80" />
              </button>
              {contactOpen && (
                <div
                  className="absolute right-0 mt-1 z-30 min-w-[200px] rounded-xl overflow-hidden"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    boxShadow: "var(--shadow-lg, 0 12px 28px -12px rgba(0,0,0,.35))",
                  }}
                >
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left text-[13px] hover:bg-[color:var(--faint)] transition-transform active:scale-[.98]"
                    onClick={wrap(chooseCall)}
                  >
                    <Phone className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />
                    {t("my.opt_call")}
                  </button>
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left text-[13px] hover:bg-[color:var(--faint)] transition-transform active:scale-[.98]"
                    onClick={wrap(chooseTg)}
                  >
                    <MessageCircle className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />
                    {t("my.opt_tg")}
                  </button>
                </div>
              )}
            </div>

            <button
              className="nf-btn nf-btn--ghost transition-transform active:scale-[.92]"
              style={{ padding: "9px 12px", fontSize: 13 }}
              onClick={wrap(onMiss)}
              title={t("my.no_answer")}
            >
              <PhoneMissed className="w-3.5 h-3.5" />
              <span className="hidden md:inline ml-1">{t("my.chip_no_answer_1")}</span>
            </button>
            <button
              className="nf-btn nf-btn--ghost transition-transform active:scale-[.92]"
              style={{ padding: "9px 12px", fontSize: 13 }}
              onClick={wrap(onPhoneOn)}
              title={t("my.chip_phone_on")}
            >
              <Phone className="w-3.5 h-3.5" />
              <span className="hidden md:inline ml-1">{t("my.chip_phone_on")}</span>
            </button>
            <button
              className="nf-btn nf-btn--ghost transition-transform active:scale-[.92]"
              style={{ padding: "9px 12px", fontSize: 13 }}
              onClick={wrap(onHasDebt)}
              title={t("my.chip_debt")}
            >
              <Wallet className="w-3.5 h-3.5" />
              <span className="hidden md:inline ml-1">{t("my.chip_debt")}</span>
            </button>
            <button
              className="nf-btn nf-btn--ghost transition-transform active:scale-[.94]"
              style={{ padding: "9px 14px", fontSize: 13 }}
              onClick={onSchedule}
            >
              <AlarmClock className="w-3.5 h-3.5" /> Callback
            </button>
            {isPostponed ? (
              <button
                className="nf-btn nf-btn--ghost transition-transform active:scale-[.94]"
                style={{ padding: "9px 14px", fontSize: 13, color: "var(--accent)" }}
                onClick={wrap(onUnpostpone)}
              >
                <PlayCircle className="w-3.5 h-3.5" /> {t("my.return")}
              </button>
            ) : (
              <button
                className="nf-btn nf-btn--ghost transition-transform active:scale-[.94]"
                style={{ padding: "9px 14px", fontSize: 13 }}
                onClick={onPostpone}
              >
                <PauseCircle className="w-3.5 h-3.5" /> {t("my.postpone")}
              </button>
            )}
            <button
              className="nf-btn transition-transform active:scale-[.94]"
              style={{
                padding: "9px 14px",
                fontSize: 13,
                background: "rgba(242,86,11,.12)",
                color: "var(--accent)",
              }}
              onClick={onConvert}
            >
              <Plus className="w-3.5 h-3.5" /> {t("my.to_sale")}
            </button>
            <button
              className="nf-btn nf-btn--ghost transition-transform active:scale-[.92]"
              style={{ padding: "9px 12px", fontSize: 13, color: "var(--danger)" }}
              onClick={wrap(onReject)}
              aria-label={t("my.reject")}
              title={t("my.reject")}
            >
              <XCircle className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------

function ScheduleCallbackModal({
  lead,
  onClose,
  onDone,
}: {
  lead: Lead | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [remindAt, setRemindAt] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const qc = useQueryClient();
  const t = useT();

  const mut = useMutation({
    mutationFn: async () => {
      if (!lead) return;
      if (!remindAt) throw new Error(t("my.time_required"));
      await api.post(`/leads/${lead.id}/callbacks/`, {
        remind_at: new Date(remindAt).toISOString(),
        comment,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads-my"] });
      qc.invalidateQueries({ queryKey: ["callbacks-mine-due"] });
      toast.success(t("my.callback_scheduled"));
      onDone();
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  return (
    <Modal open={!!lead} onClose={onClose} width={440}>
      <div className="p-7">
        <div className="text-[18px] font-semibold tracking-tight">
          Callback · {lead?.full_name || lead?.phone || ""}
        </div>
        <div className="mt-5 flex flex-col gap-4">
          <div>
            <div className="nf-col mb-1.5">{t("my.when_callback")}</div>
            <input
              type="datetime-local"
              className="nf-input"
              value={remindAt}
              onChange={(e) => setRemindAt(e.target.value)}
            />
          </div>
          <div>
            <div className="nf-col mb-1.5">{t("common.comment")}</div>
            <textarea
              className="nf-input min-h-[80px]"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={t("my.what_discussed")}
            />
          </div>
          {error && (
            <div
              className="text-[13px] rounded-xl px-3.5 py-2.5"
              style={{ background: "rgba(220,60,40,.08)", color: "var(--danger)" }}
            >
              {error}
            </div>
          )}
        </div>
        <div className="mt-7 flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? t("common.saving") : t("leads.assign_short")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function PostponeModal({
  lead,
  onClose,
  onDone,
}: {
  lead: Lead | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const t = useT();
  const mut = useMutation({
    mutationFn: async () => {
      if (!lead) return;
      await api.post(`/leads/${lead.id}/postpone/`, {
        reason: reason.trim().slice(0, 280),
      });
    },
    onSuccess: () => {
      toast.success(t("my.lead_postponed"));
      onDone();
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  return (
    <Modal open={!!lead} onClose={onClose} width={440}>
      <div className="p-7">
        <div className="text-[18px] font-semibold tracking-tight">
          {t("my.postpone_title")}
        </div>
        <div className="text-[13px] text-muted mt-1">
          {lead?.full_name || t("my.no_name")} · {lead?.phone || t("my.no_phone_short")}
        </div>
        <div className="mt-5">
          <div className="nf-col mb-1.5">{t("leads.reason_optional")}</div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 280))}
            rows={3}
            placeholder={t("my.postpone_reason_ph")}
            className="nf-input min-h-[80px]"
          />
          <div className="text-[11px] text-muted text-right mt-1">{reason.length}/280</div>
        </div>
        {error && (
          <div
            className="mt-3 text-[13px] rounded-xl px-3.5 py-2.5"
            style={{ background: "rgba(220,60,40,.08)", color: "var(--danger)" }}
          >
            {error}
          </div>
        )}
        <div className="mt-6 flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} disabled={mut.isPending}>{t("common.cancel")}</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? t("common.saving") : t("my.postpone")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------

function CallbackDueModal({
  reminders,
  onDismiss,
  onDone,
}: {
  reminders: CallbackReminder[];
  onDismiss: (id: number) => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const cur = reminders[0];
  const t = useT();

  const complete = async () => {
    if (!cur) return;
    try {
      await api.post(`/callbacks/${cur.id}/done/`);
      qc.invalidateQueries({ queryKey: ["leads-my"] });
      qc.invalidateQueries({ queryKey: ["callbacks-mine-due"] });
      onDismiss(cur.id);
      onDone();
      toast.success(t("my.marked_done"));
    } catch {
      /* silent */
    }
  };

  const snooze = async (minutes: number) => {
    if (!cur) return;
    try {
      await api.post(`/callbacks/${cur.id}/snooze/`, { minutes });
      qc.invalidateQueries({ queryKey: ["leads-my"] });
      qc.invalidateQueries({ queryKey: ["callbacks-mine-due"] });
      onDismiss(cur.id);
      onDone();
      toast.success(t("my.snoozed_min", { n: minutes }));
    } catch {
      /* silent */
    }
  };

  return (
    <Modal
      open={!!cur}
      onClose={() => cur && onDismiss(cur.id)}
      width={410}
      closeOnBackdrop={false}
    >
      {cur && (
        <div className="p-8 text-center">
          <div className="relative mx-auto grid place-items-center" style={{ width: 62, height: 62 }}>
            <span
              className="absolute inset-0 rounded-full animate-nfPulse"
              style={{ background: "var(--accent)" }}
            />
            <div
              className="relative grid place-items-center rounded-full text-white"
              style={{ width: 62, height: 62, background: "var(--accent-grad)" }}
            >
              <AlarmClock className="w-6 h-6" />
            </div>
          </div>
          <Eyebrow className="mt-5">{t("my.callback_time")}</Eyebrow>
          <div
            className="mt-3 font-semibold"
            style={{ fontSize: 25, letterSpacing: "-0.02em", lineHeight: 1.15 }}
          >
            {cur.lead_name || t("my.no_name")}
          </div>
          <div className="mt-2 text-[13px] text-muted">
            {cur.lead_phone || t("leads.no_phone")}
            {cur.remind_at && <> · {t("my.promised_at", { time: fmtCallback(cur.remind_at) })}</>}
          </div>
          {cur.comment && (
            <div
              className="mt-4 text-[12.5px] text-left rounded-xl px-4 py-3"
              style={{ background: "var(--faint)" }}
            >
              {cur.comment}
            </div>
          )}
          <div className="mt-6 flex flex-col gap-2">
            <Button block onClick={complete}>
              {t("my.call_now")}
            </Button>
            <Button variant="ghost" block onClick={() => snooze(15)}>
              {t("my.plus_15_min")}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
