import { useMemo, useState } from "react";
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

  const quickCall = useMutation({
    mutationFn: ({ lead, outcome, comment }: { lead: Lead; outcome: CallOutcome; comment?: string }) =>
      api.post(`/leads/${lead.id}/call-attempts/`, { outcome, comment }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["leads-my"] }),
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
    { value: "active", label: "Активные", count: counts.active },
    { value: "postponed", label: "Отложенные", count: counts.postponed },
    { value: "all", label: "Все" },
  ];

  const overdueCount = useMemo(
    () => results.filter((l) => isOverdue((l as unknown as { callback_at?: string }).callback_at)).length,
    [results],
  );

  const dailyPlan = 20;
  const donePlan = counts.active + counts.postponed;
  const planPct = Math.min(100, Math.round((donePlan / dailyPlan) * 100));

  if (my.isLoading) {
    return (
      <div className="mx-auto max-w-[960px] py-16 text-center text-muted text-[14px]">
        Загружаем лиды…
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
        Не удалось загрузить лиды
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
                ? `${overdueCount} просроченных колбэка`
                : "Есть просроченные колбэки"}
            </div>
            <div className="text-[13px] opacity-90">
              Разберите их, чтобы продолжить работу — новые лиды пока не назначаются.
            </div>
          </div>
          <button
            className="rounded-full px-5 py-2.5 text-[13px] font-semibold text-[color:var(--accent)]"
            style={{ background: "#fff" }}
            onClick={() => setView("active")}
          >
            Разобрать
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
            <Eyebrow>Доброе утро</Eyebrow>
            <h1
              className="font-semibold mt-3"
              style={{ fontSize: 33, letterSpacing: "-0.03em", lineHeight: 1.1 }}
            >
              {counts.active > 0 ? (
                <>
                  У вас <span style={{ color: "var(--accent)" }}>{counts.active}</span>{" "}
                  {counts.active === 1 ? "активный лид" : "активных лидов"}
                </>
              ) : (
                <>Активные лиды разобраны</>
              )}
            </h1>
            <p className="text-[14px] text-muted mt-2.5 max-w-md">
              {operator?.full_name} · план на сегодня — {dailyPlan} звонков.
              {counts.postponed > 0 && <> {counts.postponed} лидов отложены.</>}
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
                План на день · {planPct}%
              </div>
              <div className="text-[11.5px] text-muted">
                {donePlan} из {dailyPlan} лидов в работе
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* --- Tabs + summary --- */}
      <section className="flex flex-wrap items-center justify-between gap-3 animate-nfFadeUp">
        <TabPill value={view} onChange={(v) => { setView(v); setPage(1); }} items={tabs} />
        <div className="text-[13px] text-muted">
          {results.length} лидов
          {overdueCount > 0 && (
            <>
              {" · "}
              <span style={{ color: "var(--accent)" }} className="font-semibold">
                {overdueCount} просрочено
              </span>
            </>
          )}
        </div>
      </section>

      {/* --- Lead cards --- */}
      {results.length === 0 ? (
        <div
          className="rounded-2xl py-12 text-center text-[13.5px] text-muted"
          style={{ border: "1.5px dashed var(--border)" }}
        >
          Здесь пока пусто
        </div>
      ) : (
        <section className="flex flex-col gap-[9px]">
          {results.map((lead, i) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              index={i}
              onCall={() => quickCall.mutate({ lead, outcome: "talked_interested" })}
              onMiss={() => quickCall.mutate({ lead, outcome: "no_answer" })}
              onReject={() => quickCall.mutate({ lead, outcome: "rejected" })}
              onTg={() => openTg(lead)}
              onSchedule={() => setScheduleFor(lead)}
              onPostpone={() => setPostponeFor(lead)}
              onUnpostpone={() => unpostpone.mutate(lead)}
              onConvert={() => nav("/sales/new")}
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
  onSchedule,
  onPostpone,
  onUnpostpone,
  onConvert,
}: LeadCardProps) {
  const [called, setCalled] = useState(false);
  const isPostponed = !!lead.postponed_at;
  const overdue = isOverdue((lead as unknown as { callback_at?: string }).callback_at);
  const source = (lead as unknown as { source_name?: string }).source_name ?? "";
  const calls = (lead as unknown as { calls_count?: number }).calls_count ?? 0;

  const handleCall = () => {
    onCall();
    setCalled(true);
    toast.success("Звонок отмечен");
  };

  return (
    <div
      className="animate-nfFadeUp flex items-start gap-4"
      style={{
        borderRadius: 18,
        padding: "14px 18px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        boxShadow: "var(--shadow)",
        animationDelay: `${0.04 + index * 0.055}s`,
      }}
    >
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
            {lead.full_name || "Без имени"}
          </div>
          <StatusBadge tone={overdue || lead.status === "needs_review" ? "hot" : "neutral"}>
            {LEAD_STATUS_LABEL[lead.status as LeadStatus] ?? lead.status}
          </StatusBadge>
          {isPostponed && (
            <StatusBadge tone="hot">
              <PauseCircle className="w-3 h-3 inline mr-0.5" /> отложен
            </StatusBadge>
          )}
        </div>
        <div className="text-[12.5px] text-muted mt-1 flex flex-wrap gap-x-3 gap-y-1">
          <span>{lead.phone || "нет телефона"}</span>
          {source && <span>· {source}</span>}
          {calls > 0 && <span>· {calls} звонк.</span>}
          {(lead as unknown as { callback_at?: string }).callback_at && (
            <span
              style={overdue ? { color: "var(--accent)", fontWeight: 600 } : undefined}
            >
              · {overdue ? "просрочен " : ""}
              {fmtCallback((lead as unknown as { callback_at?: string }).callback_at)}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 justify-end">
        {called ? (
          <div className="text-[12.5px] text-muted flex items-center gap-1.5 px-3 py-2">
            <CheckCircle2 className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />
            звонок отмечен
          </div>
        ) : (
          <>
            {lead.phone && (
              <a
                href={`tel:${lead.phone}`}
                className="nf-btn nf-btn--primary"
                style={{ padding: "9px 14px", fontSize: 13 }}
                onClick={handleCall}
              >
                <Phone className="w-3.5 h-3.5" /> Позвонил
              </a>
            )}
            <button
              className="nf-btn nf-btn--ghost"
              style={{ padding: "9px 12px", fontSize: 13 }}
              onClick={onTg}
              disabled={!lead.phone}
              aria-label="Telegram"
            >
              <MessageCircle className="w-3.5 h-3.5" />
            </button>
            <button
              className="nf-btn nf-btn--ghost"
              style={{ padding: "9px 12px", fontSize: 13 }}
              onClick={onMiss}
              aria-label="Не берёт"
            >
              <PhoneMissed className="w-3.5 h-3.5" />
            </button>
            {isPostponed ? (
              <button
                className="nf-btn nf-btn--ghost"
                style={{ padding: "9px 14px", fontSize: 13, color: "var(--accent)" }}
                onClick={onUnpostpone}
              >
                <PlayCircle className="w-3.5 h-3.5" /> Вернуть
              </button>
            ) : (
              <button
                className="nf-btn nf-btn--ghost"
                style={{ padding: "9px 14px", fontSize: 13 }}
                onClick={onPostpone}
              >
                <PauseCircle className="w-3.5 h-3.5" /> Отложить
              </button>
            )}
            <button
              className="nf-btn nf-btn--ghost"
              style={{ padding: "9px 14px", fontSize: 13 }}
              onClick={onSchedule}
            >
              <AlarmClock className="w-3.5 h-3.5" /> Callback
            </button>
            <button
              className="nf-btn"
              style={{
                padding: "9px 14px",
                fontSize: 13,
                background: "rgba(242,86,11,.12)",
                color: "var(--accent)",
              }}
              onClick={onConvert}
            >
              <Plus className="w-3.5 h-3.5" /> В продажу
            </button>
            <button
              className="nf-btn nf-btn--ghost"
              style={{ padding: "9px 12px", fontSize: 13, color: "var(--danger)" }}
              onClick={onReject}
              aria-label="Отказ"
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

  const mut = useMutation({
    mutationFn: async () => {
      if (!lead) return;
      if (!remindAt) throw new Error("Укажите время");
      await api.post(`/leads/${lead.id}/callbacks/`, {
        remind_at: new Date(remindAt).toISOString(),
        comment,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads-my"] });
      qc.invalidateQueries({ queryKey: ["callbacks-mine-due"] });
      toast.success("Callback назначен");
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
            <div className="nf-col mb-1.5">Когда перезвонить</div>
            <input
              type="datetime-local"
              className="nf-input"
              value={remindAt}
              onChange={(e) => setRemindAt(e.target.value)}
            />
          </div>
          <div>
            <div className="nf-col mb-1.5">Комментарий</div>
            <textarea
              className="nf-input min-h-[80px]"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Что обсудили?"
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
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? "Сохраняем…" : "Назначить"}
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
  const mut = useMutation({
    mutationFn: async () => {
      if (!lead) return;
      await api.post(`/leads/${lead.id}/postpone/`, {
        reason: reason.trim().slice(0, 280),
      });
    },
    onSuccess: () => {
      toast.success("Лид отложен");
      onDone();
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  return (
    <Modal open={!!lead} onClose={onClose} width={440}>
      <div className="p-7">
        <div className="text-[18px] font-semibold tracking-tight">
          Отложить на потом
        </div>
        <div className="text-[13px] text-muted mt-1">
          {lead?.full_name || "Без имени"} · {lead?.phone || "без телефона"}
        </div>
        <div className="mt-5">
          <div className="nf-col mb-1.5">Причина (не обязательно)</div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 280))}
            rows={3}
            placeholder="Например: «после обеда», «ждёт зарплату»"
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
          <Button variant="ghost" onClick={onClose} disabled={mut.isPending}>Отмена</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? "Сохраняем…" : "Отложить"}
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

  const complete = async () => {
    if (!cur) return;
    try {
      await api.post(`/callbacks/${cur.id}/done/`);
      qc.invalidateQueries({ queryKey: ["leads-my"] });
      qc.invalidateQueries({ queryKey: ["callbacks-mine-due"] });
      onDismiss(cur.id);
      onDone();
      toast.success("Отмечено сделанным");
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
      toast.success(`Отложено на ${minutes} мин`);
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
          <Eyebrow className="mt-5">Время колбэка</Eyebrow>
          <div
            className="mt-3 font-semibold"
            style={{ fontSize: 25, letterSpacing: "-0.02em", lineHeight: 1.15 }}
          >
            {cur.lead_name || "Без имени"}
          </div>
          <div className="mt-2 text-[13px] text-muted">
            {cur.lead_phone || "нет телефона"}
            {cur.remind_at && <> · обещал перезвон в {fmtCallback(cur.remind_at)}</>}
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
              Позвонить сейчас
            </Button>
            <Button variant="ghost" block onClick={() => snooze(15)}>
              +15 мин
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
