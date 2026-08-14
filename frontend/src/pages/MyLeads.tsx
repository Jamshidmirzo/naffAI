import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  Phone,
  MessageCircle,
  AlarmClock,
  CheckCircle2,
  Lock,
  PauseCircle,
  PlayCircle,
  ChevronDown,
  PhoneCall,
  Plus,
  XCircle,
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
import AttendanceStatusWidget from "../components/AttendanceStatusWidget";

type MyLeadsView = "active" | "postponed" | "all" | "closed";
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

// --- Hint plate helpers (2026-08-04) ------------------------------------
// Форматируем `updated_at` относительно «сегодня» в Asia/Tashkent, чтобы
// оператор сразу читал «Сегодня 14:32» / «Вчера 10:00» / «02.08 в 09:15».
// Даём t-функцию снаружи, чтобы helper оставался вне React-контекста.
type TFn = (key: string, params?: Record<string, string | number>) => string;

// Парсим Y/M/D/HH/MM в Asia/Tashkent через Intl.DateTimeFormat (no DST).
function tashkentParts(d: Date): {
  y: number; m: number; day: number; hh: string; mm: string;
} {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const g = (k: string) => parts.find((p) => p.type === k)!.value;
  // Intl может отдать «24» вместо «00» для полуночи — нормализуем.
  const hourRaw = g("hour");
  const hh = hourRaw === "24" ? "00" : hourRaw;
  return {
    y: Number(g("year")),
    m: Number(g("month")),
    day: Number(g("day")),
    hh,
    mm: g("minute"),
  };
}

function daysDiffTashkent(then: Date, now: Date): number {
  const a = tashkentParts(then);
  const b = tashkentParts(now);
  // Считаем разницу дат как целое число дней между Y-M-D (без часов).
  const ta = Date.UTC(a.y, a.m - 1, a.day);
  const tb = Date.UTC(b.y, b.m - 1, b.day);
  return Math.round((tb - ta) / 86_400_000);
}

function formatHintWhen(iso: string | null | undefined, t: TFn): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const p = tashkentParts(d);
  const time = `${p.hh}:${p.mm}`;
  const diff = daysDiffTashkent(d, now);
  if (diff <= 0) return t("my.hist.today", { time });
  if (diff === 1) return t("my.hist.yesterday", { time });
  if (diff === 2) return t("my.hist.day_before", { time });
  const date = `${String(p.day).padStart(2, "0")}.${String(p.m).padStart(2, "0")}`;
  return t("my.hist.date_at", { date, time });
}

// Ручной маппинг статус-кодов → короткий человеческий хвост подсказки.
// Кастомные статусы, которых нет в этом словаре, покажутся через
// LeadStatusLabel.label из useLeadStatusInfo как fallback.
const HINT_STATUS_KEY: Record<string, string> = {
  no_answer: "my.hint.no_answer",
  no_answer_2: "my.hint.no_answer_2",
  phone_on: "my.hint.phone_on",
  callback_scheduled: "my.hint.callback_scheduled",
  contacted_telegram: "my.hint.contacted_telegram",
  dokonga_keladi: "my.hint.dokonga_keladi",
};

// Статусы, для которых плашка «после обеда — надо перезвонить» тоже
// уместна (сегодняшний no_answer/phone_on до обеда). Совпадает с
// RECALL_STATUSES внутри MyLeads.
const RECALL_HINT_STATUSES = new Set(["no_answer", "phone_on"]);
const CARRY_HINT_STATUSES = new Set([
  "no_answer",
  "no_answer_2",
  "phone_on",
  "callback_scheduled",
  "contacted_telegram",
  "dokonga_keladi",
]);

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

  // Chip-режим (view=active + chip !== "all"): отдельный запрос за ВСЕМИ
  // лидами оператора с этим статусом за всё время (включая terminal —
  // contacted_telegram, harid_qildi, lost и т.д., которых нет в
  // active_lead_status_codes и потому нет в my.data.results). Без этого
  // клик по chip показывает пустоту — оператор растерян: «Я ж поставил,
  // куда пропал?!». Envelope тот же (operator + counts + results + count).
  const isChipView = view === "active" && statusChip !== "all";
  const PAGE_SIZE_CHIP = 50;
  const myByStatus = useQuery({
    queryKey: ["leads-my-by-status", statusChip, page],
    queryFn: () => {
      const offset = (page - 1) * PAGE_SIZE_CHIP;
      return api
        .get<MyResponse>(
          `/leads/my/?status=${encodeURIComponent(statusChip)}&limit=${PAGE_SIZE_CHIP}&offset=${offset}`,
        )
        .then((r) => r.data);
    },
    enabled: isChipView,
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
          by_status: Record<string, number>;
          total_leads: number;
        }>("/leads/my/status/")
        .then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  });

  // Единый invalidator для всех query-keys, которые могут поменяться после
  // любого действия оператора над лидом (статус, call-attempt, postpone,
  // callback). Без этого chip-counts на баннере (`leads-my-status`) и
  // chip-режим (`leads-my-by-status`) обновлялись только по
  // refetchInterval и оператор думал «не сработало».
  const invalidateAllLeadQueries = () => {
    qc.invalidateQueries({ queryKey: ["leads-my"] });
    qc.invalidateQueries({ queryKey: ["leads-my-status"] });
    qc.invalidateQueries({ queryKey: ["leads-my-by-status"] });
    qc.invalidateQueries({ queryKey: ["callbacks-mine-due"] });
  };

  const unpostpone = useMutation({
    mutationFn: (lead: Lead) => api.post(`/leads/${lead.id}/unpostpone/`),
    onSuccess: () => invalidateAllLeadQueries(),
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

  // Оптимистично двигаем счётчики by_status в кэше `leads-my-status`,
  // чтобы chip'ы («TG'га боғланди · N», etc.) и баннер обновлялись
  // мгновенно при клике, не дожидаясь refetch'а. Возвращаем предыдущий
  // snapshot для rollback'а в onError.
  type MyStatusData = {
    working_count: number;
    quota_limit: number;
    carry_count: number;
    recall_afternoon_count: number;
    today_fresh_count: number;
    postponed_count: number;
    eligible_for_new: boolean;
    reason_ru: string;
    recall_active_now: boolean;
    by_status: Record<string, number>;
    total_leads: number;
  };
  const applyOptimisticStatusCounts = (
    oldStatus: string | null | undefined,
    newStatus: string,
  ): MyStatusData | undefined => {
    const key = ["leads-my-status"];
    const prev = qc.getQueryData<MyStatusData>(key);
    if (!prev?.by_status || oldStatus === newStatus) return prev;
    const oldCount = oldStatus ? prev.by_status[oldStatus] ?? 0 : 0;
    const newCount = prev.by_status[newStatus] ?? 0;
    const by_status = { ...prev.by_status, [newStatus]: newCount + 1 };
    if (oldStatus) by_status[oldStatus] = Math.max(0, oldCount - 1);
    qc.setQueryData<MyStatusData>(key, { ...prev, by_status });
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
      await qc.cancelQueries({ queryKey: ["leads-my-status"] });
      const next =
        outcome === "no_answer" && lead.status === "no_answer"
          ? "no_answer_2"
          : OUTCOME_TO_STATUS[outcome];
      if (!next) return { prev: undefined, prevStatusData: undefined };
      const prev = applyOptimisticStatus(lead.id, next as LeadStatus);
      const prevStatusData = applyOptimisticStatusCounts(lead.status, next);
      return { prev, prevStatusData };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["leads-my", page, view], ctx.prev);
      if (ctx?.prevStatusData) qc.setQueryData(["leads-my-status"], ctx.prevStatusData);
      toast.error(t("toast.error"));
    },
    onSettled: () => invalidateAllLeadQueries(),
  });

  const setStatus = useMutation({
    mutationFn: ({ lead, status }: { lead: Lead; status: string }) =>
      api.post(`/leads/${lead.id}/status/`, { status }),
    onMutate: async ({ lead, status }) => {
      await qc.cancelQueries({ queryKey: ["leads-my"] });
      await qc.cancelQueries({ queryKey: ["leads-my-status"] });
      const prev = applyOptimisticStatus(lead.id, status);
      const prevStatusData = applyOptimisticStatusCounts(lead.status, status);
      return { prev, prevStatusData };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["leads-my", page, view], ctx.prev);
      if (ctx?.prevStatusData) qc.setQueryData(["leads-my-status"], ctx.prevStatusData);
      toast.error(t("toast.error"));
    },
    onSettled: () => invalidateAllLeadQueries(),
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

  const refetch = () => invalidateAllLeadQueries();

  const operator = my.data?.operator;
  const results = my.data?.results ?? [];
  const counts = my.data?.counts ?? { active: 0, postponed: 0 };
  // Флат-список в chip-режиме (view=active + chip !== "all"). Пагинация
  // приходит с бэка, count там — всего лидов оператора с этим статусом.
  const chipResults = myByStatus.data?.results ?? [];
  const chipTotal = myByStatus.data?.count ?? chipResults.length;

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
    { value: "closed", label: t("my.tabs.closed") },
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

  // Chip-бейджи считаются по `by_status` из /leads/my/status/ — это разрез по
  // ВСЕМ лидам оператора за всё время, включая terminal (contacted_telegram,
  // won, lost, …). Иначе terminal chip'ы всегда 0, потому что локальный
  // `results` — это view=active и terminal туда не попадают. Пока `myStatus`
  // не загрузился, показываем 0 (chip UX ждать 200 мс лучше, чем показать
  // неправильную цифру от `results.length`).
  const statusChipCounts = useMemo(() => {
    const byStatus = myStatus.data?.by_status ?? {};
    const total = myStatus.data?.total_leads ?? results.length;
    const c: Record<string, number> = { all: total };
    for (const s of chipStatuses) {
      c[s.code] = byStatus[s.code] ?? 0;
    }
    return c;
  }, [myStatus.data, chipStatuses, results.length]);

  const visibleLeads = useMemo(() => {
    if (view !== "active" || statusChip === "all") return results;
    // Chip-режим — плоский список с бэка (includes terminal statuses).
    // Не фильтруем локально: бэк уже вернул только нужный статус.
    return chipResults;
  }, [results, chipResults, view, statusChip]);

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
    // В chip-режиме секции carry/recall/today не имеют смысла — оператор
    // смотрит исторический срез по статусу, а не «что работать сегодня».
    // Возвращаем плоский список в `today`.
    if (isChipView) {
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
    isChipView,
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
      {/* --- Attendance status widget (2026-08-14) --------------------- */}
      <AttendanceStatusWidget />

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
            <div className="mt-5">
              <Link to="/my/sale-new" className="nf-btn nf-btn--primary">
                + {t("dash.new_sale")}
              </Link>
            </div>
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
          {t("my.leads_count", { n: isChipView ? chipTotal : visibleLeads.length })}
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
                onClick={() => {
                  setStatusChip(chip.key);
                  setPage(1);
                }}
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

      {/* --- Баннер статуса плеч (Phase 1 redesign) --------------------
          Три визуальных тона (design_handoff_naffai_simple):
            🔴 red (danger)  — carry_count > 0 ИЛИ overdue callback:
                                «Сначала закрой это» + пульсирующий круг;
            🟠 orange (pale) — recall_active_now > 0 без carry:
                                тот же layout, но без пульсации;
            🟢 green (soft)  — всё в норме: мелкая плашка с ✓.
          Carry больше НЕ блокирует выдачу (2026-08-04) — красный тон
          здесь только визуальное напоминание, не gate. Строка reasonRu
          приходит с /leads/my/status/. */}
      {view === "active" && myStatus.data && (() => {
        const s = myStatus.data;
        const {
          carry_count: carry,
          recall_afternoon_count: recall,
        } = s;
        const hasOverdue = overdueCount > 0;
        const hasCarry = carry > 0;
        const hasRecall = s.recall_active_now && recall > 0;

        // === Красный: carry или overdue callback (главный блокер). ===
        if (hasCarry || hasOverdue) {
          const num = carry + recall + overdueCount;
          return (
            <div
              className="rounded-[20px] p-4 flex items-start gap-3 nf-fade-up"
              style={{
                background: "var(--danger-bg)",
                border: "1.5px solid var(--danger-border)",
              }}
            >
              <div
                className="nf-pulse-ring grid place-items-center text-white font-bold shrink-0"
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 999,
                  background: "var(--danger)",
                  fontSize: 19,
                }}
              >
                {num}
              </div>
              <div className="flex-1 min-w-0">
                <div
                  className="text-[17px] font-bold leading-tight"
                  style={{ color: "var(--danger-text)" }}
                >
                  Сначала закрой это
                </div>
                <div
                  className="text-[14px] mt-0.5"
                  style={{ color: "var(--danger-text-strong)" }}
                >
                  {s.reason_ru}
                </div>
              </div>
            </div>
          );
        }

        // === Оранжевый: только recall-после-обеда, без carry. ===
        if (hasRecall) {
          return (
            <div
              className="rounded-[20px] p-4 flex items-start gap-3 nf-fade-up"
              style={{
                background: "var(--accent-pale-bg)",
                border: "1.5px solid var(--accent-pale-border)",
              }}
            >
              <div
                className="grid place-items-center text-white font-bold shrink-0"
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 999,
                  background: "var(--accent)",
                  fontSize: 19,
                }}
              >
                {recall}
              </div>
              <div className="flex-1 min-w-0">
                <div
                  className="text-[17px] font-bold leading-tight"
                  style={{ color: "var(--accent-pale-text)" }}
                >
                  Проверь дневные звонки
                </div>
                <div
                  className="text-[14px] mt-0.5"
                  style={{ color: "var(--accent-pale-text-strong)" }}
                >
                  {s.reason_ru}
                </div>
              </div>
            </div>
          );
        }

        // === Зелёный: всё под контролем. ===
        return (
          <div
            className="rounded-2xl px-3.5 py-2.5 flex items-center gap-2.5 nf-fade-up"
            style={{
              background: "var(--success-bg)",
              color: "var(--success-text-strong)",
            }}
          >
            <CheckCircle2
              className="w-4 h-4 shrink-0"
              style={{ color: "var(--success)" }}
            />
            <span className="text-[13.5px] font-semibold">
              {s.reason_ru}
            </span>
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
              // Try to look up a human label from the DB catalog; fall
              // back to the raw code for custom statuses.
              const row =
                buttonStatuses.find((s) => s.code === code) ??
                (statusesQ.data ?? []).find((s) => s.code === code);
              toast.success(
                row ? `✓ ${row.emoji ? row.emoji + " " : ""}${labelFor(row)}` : "✓",
              );
            }}
            onSchedule={() => setScheduleFor(lead)}
            onPostpone={() => setPostponeFor(lead)}
            onUnpostpone={() => unpostpone.mutate(lead)}
            onConvert={() => nav(`/sales/new?lead=${lead.id}`)}
          />
        );

        if (visibleLeads.length === 0) {
          // Chip-режим: «Пока нет лидов с этим статусом» — отдельное
          // сообщение, потому что «Все лиды закрыты, новые придут» здесь
          // сбивает с толку (у оператора может быть куча активных лидов
          // других статусов).
          if (isChipView) {
            if (myByStatus.isLoading) {
              return (
                <div
                  className="rounded-2xl py-12 text-center text-[13.5px] text-muted animate-nfFadeUp"
                  style={{ border: "1.5px dashed var(--border)" }}
                >
                  {t("my.loading")}
                </div>
              );
            }
            return (
              <div
                className="rounded-2xl py-12 text-center animate-nfFadeUp"
                style={{ border: "1.5px dashed var(--border)" }}
              >
                <div className="text-[16px] font-semibold">
                  {t("my.empty.chip")}
                </div>
              </div>
            );
          }
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
          // Специальный empty для «Закрытых» — новичок, ничего не закрыл.
          if (view === "closed") {
            return (
              <div
                className="rounded-2xl py-12 text-center text-[13.5px] text-muted"
                style={{ border: "1.5px dashed var(--border)" }}
              >
                {t("my.empty.closed")}
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

        // Closed = read-only история: простая карточка (имя, телефон,
        // статус-badge, дата закрытия). Никаких кнопок «позвонить /
        // статус / отложить» — оператор смотрит, не работает. Клик по
        // карточке ничего не делает: детальная страница лида пока
        // доступна только менеджеру (`/leads` под RoleGate=manager),
        // так что перевод оператора туда дал бы 403.
        if (view === "closed") {
          return (
            <section className="flex flex-col gap-[9px]">
              {visibleLeads.map((lead, i) => (
                <ClosedLeadCard key={lead.id} lead={lead} index={i} />
              ))}
            </section>
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
          total={isChipView ? chipTotal : my.data?.count || results.length}
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

/**
 * Простая карточка для вкладки «Закрытые» на /my.
 * Только read-only отображение — оператор смотрит историю, не работает.
 * Дата закрытия форматируется как «сегодня 14:32» / «вчера 09:15» /
 * «02.08 11:00», чтобы недавние закрытия читались моментально.
 */
function fmtClosedAt(iso: string | null | undefined, t: (k: string, p?: Record<string, string | number>) => string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const now = new Date();
    const isSameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const time = d.toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
    if (isSameDay(d, now)) return t("my.closed.today", { time });
    if (isSameDay(d, yesterday)) return t("my.closed.yesterday", { time });
    return d.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function ClosedLeadCard({
  lead,
  index,
}: {
  lead: Lead;
  index: number;
}) {
  const t = useT();
  const closedAt = fmtClosedAt(lead.updated_at, t);

  return (
    <div
      className="animate-nfFadeUp flex items-center gap-4 w-full"
      style={{
        borderRadius: 18,
        padding: "14px 18px",
        background: "var(--bg-card)",
        border: "1.5px solid var(--border-main)",
        animationDelay: `${0.04 + index * 0.04}s`,
      }}
    >
      <div
        className="grid place-items-center text-white text-[13px] font-semibold shrink-0"
        style={{
          width: 38,
          height: 38,
          borderRadius: 12,
          // Для закрытых — серый градиент, чтобы визуально отличалось
          // от активных «оранжевых» карточек.
          background: "linear-gradient(145deg, #9aa3af, #6b7280)",
          opacity: 0.9,
        }}
      >
        {initials(lead.full_name || lead.phone || "?")}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-[14.5px] font-medium truncate">
            {lead.full_name || t("my.no_name")}
          </div>
          <LeadStatusBadge code={lead.status} />
        </div>
        <div
          className="mt-1 tabular-nums font-mono truncate"
          style={{ fontSize: 14, fontWeight: 500 }}
        >
          {lead.phone || t("leads.no_phone")}
        </div>
        {closedAt && (
          <div className="text-[12px] text-muted mt-0.5">
            {t("my.closed.at", { date: closedAt })}
          </div>
        )}
      </div>
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
  const callbackAt = (lead as unknown as { callback_at?: string }).callback_at;
  const t = useT();

  // "Звонили вчера" badge — mirrors the server-side carry rule
  // (see /leads/my selector): a lead in a carry-status whose last
  // update was before today's midnight (browser-local) is a
  // yesterday-carry. Cheap client-side check keeps the badge
  // reactive even while /my is refetching in the background.
  const wasYesterday = useMemo(() => {
    const carrySet = new Set([
      "no_answer",
      "no_answer_2",
      "phone_on",
      "callback_scheduled",
      "contacted_telegram",
      "dokonga_keladi",
    ]);
    if (!carrySet.has(lead.status)) return false;
    const updated = lead.updated_at ? new Date(lead.updated_at).getTime() : 0;
    const t0 = new Date();
    t0.setHours(0, 0, 0, 0);
    return updated < t0.getTime();
  }, [lead.status, lead.updated_at]);

  // --- Hint plate (2026-08-04) ---------------------------------------
  // Плашка с конкретной подсказкой «когда и что было» — расшифровка
  // бейджа «Звонили вчера» + также помогает по recall-after-lunch
  // (сегодняшний no_answer/phone_on до 13:00). Условия:
  //   1) carry-status и updated_at < сегодняшняя полуночь (совпадает с
  //      wasYesterday выше), ИЛИ
  //   2) recall-status (no_answer / phone_on) и сейчас >= 13:00 Ташкента,
  //      и updated_at был сегодня в первой половине дня.
  const statusInfo = useLeadStatusInfo(lead.status);
  const hint = useMemo(() => {
    if (!lead.updated_at) return null;
    const upd = new Date(lead.updated_at).getTime();
    if (Number.isNaN(upd) || upd <= 0) return null;

    // Локальная полночь + 13:00 Ташкента (повторяем логику MyLeads).
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tashkent",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const y = Number(parts.find((p) => p.type === "year")!.value);
    const mo = Number(parts.find((p) => p.type === "month")!.value);
    const dy = Number(parts.find((p) => p.type === "day")!.value);
    const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
    const todayStartMs = Date.UTC(y, mo - 1, dy, 0, 0, 0) - TASHKENT_OFFSET_MS;
    const lunchMs = todayStartMs + 13 * 60 * 60 * 1000;
    const isCarry = CARRY_HINT_STATUSES.has(lead.status) && upd < todayStartMs;
    const isRecall =
      now.getTime() >= lunchMs &&
      RECALL_HINT_STATUSES.has(lead.status) &&
      upd >= todayStartMs &&
      upd < lunchMs;
    if (!isCarry && !isRecall) return null;
    const key = HINT_STATUS_KEY[lead.status];
    const statusText = key
      ? t(key)
      : (statusInfo.label || lead.status).toLowerCase();
    return {
      whenLabel: formatHintWhen(lead.updated_at, t),
      statusHint: statusText,
    };
    // statusInfo.label может обновиться, когда придёт /lead-statuses/;
    // держим его в зависимостях, чтобы fallback перестроился.
  }, [lead.status, lead.updated_at, statusInfo.label, t]);

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
      className="animate-nfFadeUp nf-lead-card relative flex flex-wrap items-start gap-4"
      style={{
        borderRadius: 18,
        padding: "14px 18px",
        background: "var(--bg-card)",
        border: "1.5px solid var(--border-main)",
        transition: "border-color .16s cubic-bezier(.16,1,.3,1), transform .16s cubic-bezier(.16,1,.3,1), box-shadow .16s cubic-bezier(.16,1,.3,1)",
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
        {wasYesterday && (
          <div
            className="mt-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-semibold"
            style={{
              background: "var(--info-bg)",
              color: "var(--info-text)",
            }}
          >
            <span>📅</span>
            {t("my.carry_yesterday_badge")}
          </div>
        )}
        {hint && (
          <div
            className="mt-1.5 rounded-[12px] px-3 py-2 flex items-start gap-2"
            style={{
              background: "var(--accent-pale-bg)",
              border: "1px solid var(--accent-pale-border)",
              color: "var(--accent-pale-text)",
            }}
          >
            <span style={{ fontSize: 14, lineHeight: 1 }}>💡</span>
            <div className="flex-1 min-w-0 text-[13px] leading-tight">
              <span className="font-medium">{hint.whenLabel}</span>
              {" — "}
              <span>{hint.statusHint}</span>
            </div>
          </div>
        )}
        {callbackAt && overdue && (
          <div
            className="mt-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-semibold"
            style={{
              background: "var(--danger-bg)",
              color: "var(--danger-text-strong)",
              border: "1px solid var(--danger-border)",
            }}
          >
            <span>⚠️</span>
            {t("my.overdue_prefix")} · {fmtCallback(callbackAt)}
          </div>
        )}
        {callbackAt && !overdue && (
          <div
            className="text-[12px] mt-0.5"
            style={{ color: "var(--text-label)" }}
          >
            {fmtCallback(callbackAt)}
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

/**
 * One decision tile in the 2×2 outcome grid. Keeps its own hover /
 * active feedback via the .nf-outcome CSS block.
 */
function OutcomeTile({
  emoji,
  title,
  hint,
  iconBg,
  onClick,
}: {
  emoji: string;
  title: string;
  hint: string;
  iconBg: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="nf-outcome" onClick={onClick}>
      <div className="nf-outcome__icon" style={{ background: iconBg }}>
        <span aria-hidden>{emoji}</span>
      </div>
      <div className="nf-outcome__title">{title}</div>
      <div className="nf-outcome__hint">{hint}</div>
    </button>
  );
}

/**
 * Reason picker modal for the two outcome tiles that need a
 * follow-up choice ("Не ответил" → 4 sub-statuses,
 * "Не купит" → 6 sub-statuses). Everything else routes directly
 * (Продажа → nav, Перезвон → ScheduleCallbackModal).
 *
 * Status codes MUST exist in the DB LeadStatusLabel catalog on the
 * server — hardcoded here because the outcome flow itself is a fixed
 * UX contract, but the labels come from i18n so they stay ru/uz.
 * The special sentinel "no_answer_lost_shortcut" is intercepted by
 * the parent to route through the existing onReject (which fires
 * the `quickCall(rejected)` mutation → lead moves to `lost`).
 */
function OutcomeReasonModal({
  open,
  onClose,
  onPick,
}: {
  open: "no_answer" | "reject" | null;
  onClose: () => void;
  onPick: (code: string) => void;
}) {
  const t = useT();
  const rows: { code: string; emoji: string; label: string }[] =
    open === "no_answer"
      ? [
          { code: "no_answer", emoji: "📵", label: t("my.reason.no_answer.calls") },
          { code: "no_answer_2", emoji: "⚠️", label: t("my.reason.no_answer.calls_2") },
          { code: "phone_on", emoji: "📞", label: t("my.reason.no_answer.phone_off") },
          { code: "sms_jonatildi", emoji: "💬", label: t("my.reason.no_answer.sms") },
        ]
      : open === "reject"
      ? [
          { code: "qimmatlik_qildi", emoji: "💸", label: t("my.reason.reject.expensive") },
          { code: "has_debt", emoji: "💳", label: t("my.reason.reject.debt") },
          { code: "kartsi_yoq", emoji: "🚫", label: t("my.reason.reject.no_card") },
          { code: "no_answer_lost_shortcut", emoji: "🏪", label: t("my.reason.reject.bought_elsewhere") },
          { code: "shunchaki_qiziqdi", emoji: "👀", label: t("my.reason.reject.just_asking") },
          { code: "notogri_raqam", emoji: "☎️", label: t("my.reason.reject.wrong_number") },
        ]
      : [];

  const title =
    open === "no_answer"
      ? t("my.reason.no_answer.title")
      : open === "reject"
      ? t("my.reason.reject.title")
      : "";
  const subtitle =
    open === "no_answer"
      ? t("my.reason.no_answer.subtitle")
      : open === "reject"
      ? t("my.reason.reject.subtitle")
      : "";

  return (
    <Modal open={!!open} onClose={onClose} width={460}>
      <div className="p-7">
        <div className="text-[19px] font-semibold tracking-tight">{title}</div>
        {subtitle && (
          <div className="text-[13px] mt-1" style={{ color: "var(--text-label)" }}>
            {subtitle}
          </div>
        )}
        <div className="mt-5 flex flex-col gap-2">
          {rows.map((r) => (
            <button
              key={r.code}
              type="button"
              className="nf-reason-row"
              onClick={() => onPick(r.code)}
            >
              <span className="nf-reason-row__emoji" aria-hidden>
                {r.emoji}
              </span>
              <span className="nf-reason-row__label">{r.label}</span>
            </button>
          ))}
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------

/**
 * Format a Date as the "YYYY-MM-DDTHH:MM" string that a
 * <input type="datetime-local"> expects. Uses the browser's local
 * timezone (matches how the user reads the input), which for
 * naffAI = Asia/Tashkent in prod. Pure helper — kept module-local.
 */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildQuickTimes(t: (k: string) => string): { key: string; label: string; date: Date }[] {
  const now = new Date();
  const inHour = new Date(now.getTime() + 60 * 60 * 1000);
  const inThreeHours = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  // Evening = 19:00 today; if already past 19:00, roll to tomorrow.
  const evening = new Date(now);
  evening.setHours(19, 0, 0, 0);
  if (evening.getTime() <= now.getTime()) evening.setDate(evening.getDate() + 1);
  // Tomorrow morning = tomorrow 09:30.
  const morning = new Date(now);
  morning.setDate(morning.getDate() + 1);
  morning.setHours(9, 30, 0, 0);
  return [
    { key: "1h", label: t("my.quick.in_1h"), date: inHour },
    { key: "3h", label: t("my.quick.in_3h"), date: inThreeHours },
    { key: "evening", label: t("my.quick.evening"), date: evening },
    { key: "morning", label: t("my.quick.tomorrow_morning"), date: morning },
  ];
}

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
  const [pickedQuick, setPickedQuick] = useState<string | null>(null);
  const qc = useQueryClient();
  const t = useT();

  // Reset local state whenever the modal is (re)opened for a
  // different lead — stale times/comments carrying over across
  // leads would be a real UX foot-gun.
  useEffect(() => {
    if (lead) {
      setRemindAt("");
      setComment("");
      setError("");
      setPickedQuick(null);
    }
  }, [lead?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const quickTimes = useMemo(() => buildQuickTimes(t), [t]);

  const pickQuick = (key: string, d: Date) => {
    setPickedQuick(key);
    setRemindAt(toLocalInputValue(d));
  };

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
      qc.invalidateQueries({ queryKey: ["leads-my-status"] });
      qc.invalidateQueries({ queryKey: ["leads-my-by-status"] });
      qc.invalidateQueries({ queryKey: ["callbacks-mine-due"] });
      toast.success(t("my.callback_scheduled"));
      onDone();
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  return (
    <Modal open={!!lead} onClose={onClose} width={460}>
      <div className="p-7">
        <div className="text-[18px] font-semibold tracking-tight">
          Callback · {lead?.full_name || lead?.phone || ""}
        </div>
        <div className="mt-5 flex flex-col gap-4">
          <div>
            <div className="nf-col mb-2">{t("my.quick.title")}</div>
            <div className="flex flex-wrap gap-2">
              {quickTimes.map((q) => (
                <button
                  key={q.key}
                  type="button"
                  className="nf-time-chip"
                  data-selected={pickedQuick === q.key ? "true" : "false"}
                  onClick={() => pickQuick(q.key, q.date)}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="nf-col mb-1.5">{t("my.when_callback")}</div>
            <input
              type="datetime-local"
              className="nf-input"
              value={remindAt}
              onChange={(e) => {
                setRemindAt(e.target.value);
                setPickedQuick(null);
              }}
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
  const qc = useQueryClient();
  const mut = useMutation({
    mutationFn: async () => {
      if (!lead) return;
      await api.post(`/leads/${lead.id}/postpone/`, {
        reason: reason.trim().slice(0, 280),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads-my"] });
      qc.invalidateQueries({ queryKey: ["leads-my-status"] });
      qc.invalidateQueries({ queryKey: ["leads-my-by-status"] });
      qc.invalidateQueries({ queryKey: ["callbacks-mine-due"] });
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
      qc.invalidateQueries({ queryKey: ["leads-my-status"] });
      qc.invalidateQueries({ queryKey: ["leads-my-by-status"] });
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
      qc.invalidateQueries({ queryKey: ["leads-my-status"] });
      qc.invalidateQueries({ queryKey: ["leads-my-by-status"] });
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
