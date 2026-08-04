import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Phone,
  MessageCircle,
  AlarmClock,
  CheckCircle2,
  Lock,
  PauseCircle,
  PlayCircle,
  XCircle,
  Plus,
  ChevronDown,
  PhoneCall,
} from "lucide-react";
import { Paginator } from "../components/Paginator";
import { apiErrorMessage } from "../lib/api-types";
import { api } from "../lib/api";
import {
  type CallOutcome,
  type CallbackReminder,
  type Lead,
  type LeadStatus,
  TG_LINK_FALLBACK,
} from "../lib/leads";
import {
  useLeadStatuses,
  useLeadStatusInfo,
  type LeadStatusRow,
  type LeadStatusTone,
} from "../hooks/useLeadStatuses";
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
import { useT, useLangValue } from "../lib/i18n";
import { GaugeScene } from "../components/three/GaugeScene";

type MyLeadsView = "active" | "postponed" | "all";
// Chip filter key = LeadStatusLabel.code OR the sentinel "all".
type StatusChipKey = string;

type MyResponse = {
  operator: {
    id: number;
    full_name: string;
    status: string;
    blocked: boolean;
    overdue_blocked?: boolean;
    open_callbacks?: number;
    yesterday_backlog?: number;
  };
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

function LeadStatusBadge({
  code,
  overdue = false,
}: {
  code: string;
  overdue?: boolean;
}) {
  const info = useLeadStatusInfo(code);
  const tone: "hot" | "danger" | "neutral" =
    overdue
      ? "hot"
      : info.tone === "danger"
      ? "danger"
      : info.tone === "hot" || info.tone === "success" || info.tone === "info"
      ? "hot"
      : "neutral";
  return (
    <StatusBadge tone={tone}>
      {info.emoji ? `${info.emoji} ${info.label}` : info.label}
    </StatusBadge>
  );
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

  // Диагностика для баннера «сначала закрой это». Тот же endpoint читает
  // sidebar-бейдж — react-query дедуплицирует. Обновляем чаще, чем список
  // лидов: цифры блокеров важнее, чем полный список.
  const myStatus = useQuery({
    queryKey: ["leads-my-status"],
    queryFn: () =>
      api
        .get<{
          working_count: number;
          quota_limit: number;
          carry_count: number;
          recall_afternoon_count: number;
          today_fresh_count: number;
          postponed_count: number;
          eligible_for_new: boolean;
          reason_ru: string;
          recall_active_now: boolean;
        }>("/leads/my/status/")
        .then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
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
  const applyOptimisticStatus = (leadId: number, status: string) => {
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
    mutationFn: ({ lead, status }: { lead: Lead; status: string }) =>
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

  const backlogCount =
    (operator?.open_callbacks ?? 0) + (operator?.yesterday_backlog ?? 0);
  const tabs: TabItem<MyLeadsView>[] = [
    {
      value: "active",
      label: t("my.tab_active"),
      count: backlogCount > 0 ? backlogCount : counts.active,
      danger: backlogCount > 0,
    },
    { value: "postponed", label: t("my.tab_postponed"), count: counts.postponed },
    { value: "all", label: t("my.tab_all") },
  ];

  const overdueCount = useMemo(
    () => results.filter((l) => isOverdue((l as unknown as { callback_at?: string }).callback_at)).length,
    [results],
  );

  // Chip filters + LeadCard mark-as buttons are now driven by the
  // manager-managed LeadStatusLabel catalog.
  const statusesQ = useLeadStatuses();
  const chipStatuses = useMemo(
    () =>
      (statusesQ.data ?? [])
        .filter((s) => s.is_active && s.show_in_chip)
        .sort((a, b) => a.sort_order - b.sort_order),
    [statusesQ.data],
  );
  const buttonStatuses = useMemo(
    () =>
      (statusesQ.data ?? [])
        .filter((s) => s.is_active && s.show_in_button)
        .sort((a, b) => a.sort_order - b.sort_order),
    [statusesQ.data],
  );
  const lang = useLangValue();
  const labelFor = (row: LeadStatusRow) =>
    lang === "uz" && row.label_uz ? row.label_uz : row.label_ru;

  const statusChipCounts = useMemo(() => {
    const c: Record<string, number> = { all: results.length };
    for (const s of chipStatuses) c[s.code] = 0;
    for (const l of results) {
      if (c[l.status] !== undefined) c[l.status]++;
    }
    return c;
  }, [results, chipStatuses]);

  const visibleLeads = useMemo(() => {
    if (view !== "active" || statusChip === "all") return results;
    return results.filter((l) => l.status === statusChip);
  }, [results, view, statusChip]);

  // --- Секционирование /my active (2026-08 UX-fix) ---------------------
  // Разбиваем visibleLeads на три группы по правилам carry/recall/today,
  // чтобы оператор сразу видел «вчерашние спец-лиды» отдельно и не путал
  // их с сегодняшними. Пороговые времена считаем в Asia/Tashkent, повторяя
  // серверную логику `_active_today_filter`.
  const { todayStartMs, lunchStartMs, recallActiveNow } = useMemo(() => {
    // Полночь и 13:00 Ташкента сегодня, выраженные UTC-миллисекундами.
    const now = new Date();
    const partsInTashkent = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tashkent",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const y = Number(partsInTashkent.find((p) => p.type === "year")!.value);
    const m = Number(partsInTashkent.find((p) => p.type === "month")!.value);
    const d = Number(partsInTashkent.find((p) => p.type === "day")!.value);
    // Asia/Tashkent = UTC+5, без DST — фиксированное смещение.
    // Полночь Ташкента = Date.UTC(y, m-1, d, 0, 0, 0) − 5h.
    const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
    const today0 = Date.UTC(y, m - 1, d, 0, 0, 0) - TASHKENT_OFFSET_MS;
    const lunch = today0 + 13 * 60 * 60 * 1000;
    return {
      todayStartMs: today0,
      lunchStartMs: lunch,
      recallActiveNow: now.getTime() >= lunch,
    };
  }, [
    // Пересчитываем максимум раз в 30с — этого достаточно, чтобы после
    // 13:00 recall-секция появилась без reload. `myStatus.dataUpdatedAt`
    // сбрасывается с той же частотой, что и запрос статуса.
    myStatus.dataUpdatedAt,
  ]);

  const CARRY_STATUSES = useMemo(
    () =>
      new Set([
        "no_answer",
        "no_answer_2",
        "phone_on",
        "callback_scheduled",
        "contacted_telegram",
        "dokonga_keladi",
      ]),
    [],
  );
  const RECALL_STATUSES = useMemo(
    () => new Set(["no_answer", "phone_on"]),
    [],
  );

  const sections = useMemo(() => {
    if (view !== "active") {
      return { carry: [] as Lead[], recall: [] as Lead[], today: visibleLeads };
    }
    const carry: Lead[] = [];
    const recall: Lead[] = [];
    const todayList: Lead[] = [];
    for (const l of visibleLeads) {
      const updatedMs = l.updated_at ? Date.parse(l.updated_at) : 0;
      const isCarry =
        CARRY_STATUSES.has(l.status) && updatedMs < todayStartMs;
      const isRecall =
        recallActiveNow &&
        RECALL_STATUSES.has(l.status) &&
        updatedMs >= todayStartMs &&
        updatedMs < lunchStartMs;
      if (isCarry) carry.push(l);
      else if (isRecall) recall.push(l);
      else todayList.push(l);
    }
    return { carry, recall, today: todayList };
  }, [
    visibleLeads,
    view,
    todayStartMs,
    lunchStartMs,
    recallActiveNow,
    CARRY_STATUSES,
    RECALL_STATUSES,
  ]);

  const statusChips: { key: StatusChipKey; label: string; count: number }[] = [
    { key: "all", label: t("common.all"), count: statusChipCounts.all ?? results.length },
    ...chipStatuses.map((s) => ({
      key: s.code,
      label: `${s.emoji ? s.emoji + " " : ""}${labelFor(s)}`,
      count: statusChipCounts[s.code] ?? 0,
    })),
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
                : t("my.backlog_gate", {
                    n:
                      (operator?.open_callbacks ?? 0) +
                      (operator?.yesterday_backlog ?? 0),
                  })}
            </div>
            <div className="text-[13px] opacity-90">
              {overdueCount > 0
                ? t("my.overdue_hint")
                : t("my.backlog_gate_hint")}
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

      {/* --- Приоритетный баннер «сначала закрой это» -------------------
          Показываем всегда, когда есть carry или recall — это главное,
          что оператор должен увидеть, открыв страницу. Цвет:
            красный — есть carry (вчерашние спец-лиды);
            оранжевый — есть только recall (после обеда);
            зелёный — всё ок, слоты свободны.
          Не рендерим в других вьюхах — там смысла нет. */}
      {view === "active" && myStatus.data && (() => {
        const s = myStatus.data;
        const {
          working_count: working,
          quota_limit: limit,
          carry_count: carry,
          recall_afternoon_count: recall,
          eligible_for_new: eligible,
        } = s;
        // Определяем цвет
        let tone: "red" | "orange" | "green" = "green";
        if (carry > 0) tone = "red";
        else if (s.recall_active_now && recall > 0) tone = "orange";
        else if (!eligible) tone = "orange";

        const bg =
          tone === "red"
            ? "rgba(220,38,38,0.10)"
            : tone === "orange"
            ? "rgba(249,115,22,0.10)"
            : "rgba(16,185,129,0.10)";
        const border =
          tone === "red"
            ? "rgba(220,38,38,0.45)"
            : tone === "orange"
            ? "rgba(249,115,22,0.45)"
            : "rgba(16,185,129,0.45)";
        const fg =
          tone === "red" ? "#dc2626" : tone === "orange" ? "#c2410c" : "#047857";

        // Готовим строку — предпочитаем i18n-варианты, чтобы работал uz.
        let text = "";
        if (carry > 0 && recall > 0 && s.recall_active_now) {
          text = t("my.status.banner.carry_and_recall", {
            working,
            carry,
            recall,
          });
        } else if (carry > 0) {
          text = t("my.status.banner.carry_only", { working, carry });
        } else if (recall > 0 && s.recall_active_now) {
          text = t("my.status.banner.recall_only", { working, recall });
        } else if (!eligible && working >= limit) {
          text = t("my.status.banner.quota_full", { limit });
        } else {
          text = t("my.status.banner.ok", {
            free: Math.max(0, limit - working),
            limit,
          });
        }

        return (
          <div
            className="rounded-2xl border px-4 py-3 flex items-start gap-3 animate-nfFadeUp"
            style={{ background: bg, borderColor: border }}
          >
            <div
              className="shrink-0 rounded-xl p-2"
              style={{ background: bg, border: `1px solid ${border}` }}
            >
              <Lock className="w-5 h-5" style={{ color: fg }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[14.5px] font-semibold" style={{ color: fg }}>
                {text}
              </div>
              <div className="text-[12px] opacity-80 mt-0.5" style={{ color: fg }}>
                {t("my.status.banner.progress", { working, limit })}
              </div>
            </div>
          </div>
        );
      })()}

      {/* --- Legacy overdue-callback banner (morning-gate) -------------- */}
      {view === "active" && operator?.blocked && (
        <div
          className="sticky z-30 flex items-center gap-3 rounded-2xl border px-4 py-3 backdrop-blur-md shadow-lg"
          style={{
            top: 74,
            background: "rgba(220, 38, 38, 0.10)",
            borderColor: "rgba(220, 38, 38, 0.45)",
            color: "var(--fg)",
          }}
        >
          <div
            className="shrink-0 rounded-xl p-2"
            style={{ background: "rgba(220, 38, 38, 0.18)" }}
          >
            <Lock className="w-6 h-6" style={{ color: "#dc2626" }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-[14.5px]" style={{ color: "#dc2626" }}>
              {t("my.locked_title", {
                n:
                  (operator?.open_callbacks ?? 0) +
                  (operator?.yesterday_backlog ?? 0),
              })}
            </div>
            <div className="text-[12.5px] opacity-90">
              {t("my.locked_hint")}
            </div>
          </div>
        </div>
      )}

      {(() => {
        // Общий helper для рендера карточки — используется секциями и в
        // не-active вьюхе (там сплошным списком).
        const renderCard = (lead: Lead, i: number) => (
          <LeadCard
            key={lead.id}
            lead={lead}
            index={i}
            onCall={() => {
              quickCall.mutate({ lead, outcome: "talked_interested" });
              toast.success(t("my.toast_called"));
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
            statusButtons={buttonStatuses.map((s) => ({
              code: s.code,
              emoji: s.emoji,
              label: labelFor(s),
            }))}
            onStatus={(code) => {
              if (code === "no_answer") {
                quickCall.mutate({ lead, outcome: "no_answer" });
              } else {
                setStatus.mutate({ lead, status: code });
              }
              const btn = buttonStatuses.find((s) => s.code === code);
              toast.success(
                btn ? `✓ ${btn.emoji ? btn.emoji + " " : ""}${labelFor(btn)}` : "✓",
              );
            }}
            onSchedule={() => setScheduleFor(lead)}
            onPostpone={() => setPostponeFor(lead)}
            onUnpostpone={() => unpostpone.mutate(lead)}
            onConvert={() => nav(`/sales/new?lead=${lead.id}`)}
          />
        );

        if (visibleLeads.length === 0) {
          // Полностью пусто — оператор всё разобрал, ждём refill.
          const workingCount = myStatus.data?.working_count ?? 0;
          if (view === "active" && workingCount === 0) {
            return (
              <div
                className="rounded-2xl py-12 text-center animate-nfFadeUp"
                style={{ border: "1.5px dashed var(--border)" }}
              >
                <div className="text-[36px] leading-none mb-2">✅</div>
                <div className="text-[16px] font-semibold">
                  {t("my.empty.title")}
                </div>
                <div className="text-[13px] text-muted mt-1.5 max-w-[420px] mx-auto px-4">
                  {t("my.empty.subtitle")}
                </div>
              </div>
            );
          }
          // Обычный empty (фильтр по чипу отсеял всё, или postponed-вью
          // пустая).
          return (
            <div
              className="rounded-2xl py-12 text-center text-[13.5px] text-muted"
              style={{ border: "1.5px dashed var(--border)" }}
            >
              {t("my.empty")}
            </div>
          );
        }

        if (view !== "active") {
          return (
            <section className="flex flex-col gap-[9px]">
              {visibleLeads.map(renderCard)}
            </section>
          );
        }

        // Секционный вид: 🔴 carry → 🟠 recall → 🟢 today. Пустые
        // группы не рендерим.
        const groups: {
          key: "carry" | "recall" | "today";
          leads: Lead[];
          labelKey: string;
        }[] = [
          { key: "carry", leads: sections.carry, labelKey: "my.section.carry" },
          { key: "recall", leads: sections.recall, labelKey: "my.section.recall" },
          { key: "today", leads: sections.today, labelKey: "my.section.today" },
        ];

        return (
          <>
            {groups.map((g) =>
              g.leads.length === 0 ? null : (
                <section
                  key={g.key}
                  className="flex flex-col gap-[9px] animate-nfFadeUp"
                >
                  <div
                    className="text-[12.5px] uppercase tracking-[.06em] font-semibold px-1"
                    style={{ color: "var(--muted)" }}
                  >
                    {t(g.labelKey, { n: g.leads.length })}
                  </div>
                  {g.leads.map(renderCard)}
                </section>
              ),
            )}
          </>
        );
      })()}

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
  onReject: () => void;
  onTg: () => void;
  statusButtons: { code: string; emoji: string; label: string }[];
  onStatus: (code: string) => void;
  onSchedule: () => void;
  onPostpone: () => void;
  onUnpostpone: () => void;
  onConvert: () => void;
}

function LeadCard({
  lead,
  index,
  onCall,
  onReject,
  onTg,
  statusButtons,
  onStatus,
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
      className="animate-nfFadeUp relative flex flex-wrap items-start gap-4"
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

      {/* Text column — grows, but always keeps at least ~200px so name/phone
          never collapse to 0 width when the action buttons pack the row. */}
      <div className="flex-1 min-w-[200px]">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-[14.5px] font-medium truncate">
            {lead.full_name || t("my.no_name")}
          </div>
          <LeadStatusBadge code={lead.status} overdue={overdue} />
          {isPostponed && (
            <StatusBadge tone="hot">
              <PauseCircle className="w-3 h-3 inline mr-0.5" /> {t("my.postponed_badge")}
            </StatusBadge>
          )}
        </div>
        <div
          className="mt-1 tabular-nums font-mono truncate"
          style={{ fontSize: 14, fontWeight: 500 }}
        >
          {lead.phone || t("leads.no_phone")}
        </div>
        {lead.phone_alt && lead.phone_alt !== lead.phone && (
          <a
            href={`tel:${lead.phone_alt}`}
            className="mt-0.5 text-[12px] text-muted underline block tabular-nums font-mono"
          >
            {t("my.phone_alt_prefix")} {lead.phone_alt}
          </a>
        )}
        {lead.product_hint && (
          <div
            className="text-[12px] text-muted truncate mt-0.5"
            title={lead.product_hint}
          >
            {lead.product_hint}
          </div>
        )}
        {lead.is_retry && lead.previous_operator_name && (
          <div
            className="mt-1 flex items-start gap-1.5 rounded-md border px-2 py-1 text-[12px]"
            style={{
              background: "rgba(249,115,22,0.10)",
              borderColor: "rgba(249,115,22,0.40)",
              color: "#c2410c",
            }}
          >
            <span>🔄</span>
            <div className="leading-tight">
              <div className="font-semibold">
                {t("lead.retry_badge", { name: lead.previous_operator_name })}
              </div>
              <div className="text-[11px] opacity-90">
                {t("lead.retry_hint")}
              </div>
            </div>
          </div>
        )}
        {(lead as unknown as { callback_at?: string }).callback_at && (
          <div
            className="text-[12px] mt-0.5"
            style={overdue ? { color: "var(--accent)", fontWeight: 600 } : { color: "var(--muted)" }}
          >
            {overdue ? `${t("my.overdue_prefix")} ` : ""}
            {fmtCallback((lead as unknown as { callback_at?: string }).callback_at)}
          </div>
        )}
      </div>

      {/* Action row — full-width on the second visual line so buttons
          never eat into the text column. */}
      <div className="flex flex-wrap gap-2 items-start w-full md:w-auto md:ml-auto md:justify-end">
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

            {statusButtons.map((btn) => (
              <button
                key={btn.code}
                className="nf-btn nf-btn--ghost transition-transform active:scale-[.92]"
                style={{ padding: "9px 12px", fontSize: 13 }}
                onClick={wrap(() => onStatus(btn.code))}
                title={btn.label}
              >
                {btn.emoji ? (
                  <span aria-hidden style={{ fontSize: 14 }}>{btn.emoji}</span>
                ) : null}
                <span className="hidden md:inline ml-1">{btn.label}</span>
              </button>
            ))}
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
