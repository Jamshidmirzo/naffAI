/**
 * Operator workstation — /my
 *
 * Shows the operator's currently-assigned leads plus a blocked-state banner
 * when they have overdue callbacks. Each lead card exposes the primary
 * call-outcome actions in one click:
 *   [ +7 назв ] [ Позвонил ] [ TG ] [ Callback ]
 *
 * Uses `useCallbackWatcher` to raise a modal + audio cue when a reminder
 * comes due; the caller can either "Позвонить сейчас" (mark done) or
 * "+15 минут" (snooze).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Phone, MessageCircle, PhoneOff, AlarmClock, CheckCircle2, Clock } from "lucide-react";
import { api } from "../lib/api";
import {
  CALL_OUTCOMES,
  type CallOutcome,
  type CallbackReminder,
  LEAD_STATUS_BADGE,
  LEAD_STATUS_LABEL,
  type Lead,
  TG_LINK_FALLBACK,
} from "../lib/leads";
import { useCallbackWatcher } from "../hooks/useCallbackWatcher";
import { formatDate } from "../lib/format";

type MyResponse = {
  operator: { id: number; full_name: string; status: string; blocked: boolean };
  results: Lead[];
};

export default function MyLeads() {
  const qc = useQueryClient();
  const my = useQuery({
    queryKey: ["leads-my"],
    queryFn: () => api.get<MyResponse>("/leads/my/").then((r) => r.data),
    refetchInterval: 60_000,
  });

  const [callFor, setCallFor] = useState<Lead | null>(null);
  const [scheduleFor, setScheduleFor] = useState<Lead | null>(null);

  const watcher = useCallbackWatcher({ enabled: true });

  const openTg = async (lead: Lead) => {
    if (!lead.phone) return;
    try {
      const { data } = await api.get(`/telegram/lookup/?phone=${encodeURIComponent(lead.phone)}`);
      if (data?.username) {
        window.open(`https://t.me/${data.username}`, "_blank", "noopener");
        return;
      }
    } catch {
      /* 404 → fall through to phone-based deep-link */
    }
    window.location.href = TG_LINK_FALLBACK(lead.phone);
  };

  const refetch = () => {
    qc.invalidateQueries({ queryKey: ["leads-my"] });
  };

  if (my.isLoading) {
    return <div className="text-gray-500">Загружаем лиды…</div>;
  }
  if (my.isError || !my.data) {
    return <div className="text-rose-600">Не удалось загрузить лиды</div>;
  }

  const { operator, results } = my.data;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Мои лиды</h1>
          <div className="text-sm text-gray-500 dark:text-slate-400">
            {operator.full_name} · {results.length} активных
          </div>
        </div>
      </div>

      {operator.blocked && (
        <div className="rounded-lg border border-rose-300 bg-rose-50 text-rose-800 p-4 flex items-start gap-3 dark:bg-rose-500/10 dark:border-rose-500/40 dark:text-rose-200">
          <AlarmClock className="w-5 h-5 mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-medium">Есть просроченные callback'и</div>
            <div className="text-sm mt-1">
              Пока хотя бы один callback просрочен больше чем на 30 минут, новые лиды тебе не назначаются.
              Закрой их или отложи, и распределение возобновится.
            </div>
          </div>
        </div>
      )}

      {results.length === 0 && (
        <div className="rounded-lg border border-gray-200 dark:border-slate-800 p-8 text-center text-gray-500 dark:text-slate-400">
          Активных лидов пока нет. Как только сюда прилетит новый — он появится в этом списке.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {results.map((lead) => (
          <div
            key={lead.id}
            className="card p-4 flex flex-col gap-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-medium">{lead.full_name || "Без имени"}</div>
                <div className="text-sm text-gray-500 dark:text-slate-400">
                  {lead.phone || <span className="text-rose-500">телефон не разобран</span>}
                </div>
                <div className="text-xs text-gray-400 mt-1">
                  {lead.product_hint || "Модель не указана"}
                </div>
              </div>
              <span className={`px-2 py-0.5 rounded text-xs ${LEAD_STATUS_BADGE[lead.status]}`}>
                {LEAD_STATUS_LABEL[lead.status]}
              </span>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                className="btn-primary text-sm"
                onClick={() => setCallFor(lead)}
                disabled={!lead.phone}
                title="Записать результат звонка"
              >
                <Phone className="w-4 h-4" /> Звонок
              </button>
              <button
                className="btn-ghost text-sm"
                onClick={() => openTg(lead)}
                disabled={!lead.phone}
              >
                <MessageCircle className="w-4 h-4" /> TG
              </button>
              <button
                className="btn-ghost text-sm"
                onClick={() => setScheduleFor(lead)}
              >
                <AlarmClock className="w-4 h-4" /> Callback
              </button>
              <a
                href={`tel:${lead.phone}`}
                className="btn-ghost text-sm"
                aria-disabled={!lead.phone}
              >
                <PhoneOff className="w-4 h-4" /> Набрать
              </a>
            </div>
          </div>
        ))}
      </div>

      {callFor && (
        <CallModal
          lead={callFor}
          onClose={() => setCallFor(null)}
          onDone={() => {
            setCallFor(null);
            refetch();
          }}
        />
      )}

      {scheduleFor && (
        <ScheduleCallbackModal
          lead={scheduleFor}
          onClose={() => setScheduleFor(null)}
          onDone={() => {
            setScheduleFor(null);
            refetch();
          }}
        />
      )}

      {watcher.due.length > 0 && (
        <CallbackDueModal
          reminders={watcher.due}
          onDismiss={watcher.dismiss}
          onDone={refetch}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------------------

function CallModal({
  lead,
  onClose,
  onDone,
}: {
  lead: Lead;
  onClose: () => void;
  onDone: () => void;
}) {
  const [outcome, setOutcome] = useState<CallOutcome>("talked_interested");
  const [comment, setComment] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const [error, setError] = useState("");

  const mut = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { outcome, comment };
      if (outcome === "talked_callback") {
        if (!remindAt) {
          throw new Error("Укажите время callback'а");
        }
        body.callback_remind_at = new Date(remindAt).toISOString();
      }
      await api.post(`/leads/${lead.id}/call-attempts/`, body);
    },
    onSuccess: onDone,
    onError: (err: any) => {
      setError(err?.response?.data?.detail || err?.message || "Ошибка");
    },
  });

  return (
    <ModalShell title={`Звонок: ${lead.full_name || lead.phone}`} onClose={onClose}>
      <label className="label">Исход</label>
      <select
        className="input"
        value={outcome}
        onChange={(e) => setOutcome(e.target.value as CallOutcome)}
      >
        {CALL_OUTCOMES.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {outcome === "talked_callback" && (
        <>
          <label className="label mt-3">Когда перезвонить</label>
          <input
            type="datetime-local"
            className="input"
            value={remindAt}
            onChange={(e) => setRemindAt(e.target.value)}
          />
        </>
      )}

      <label className="label mt-3">Комментарий</label>
      <textarea
        className="input min-h-[80px]"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Что сказал клиент?"
      />

      {error && <div className="text-sm text-rose-600 mt-2">{error}</div>}

      <div className="mt-4 flex gap-2 justify-end">
        <button className="btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button
          className="btn-primary"
          onClick={() => mut.mutate()}
          disabled={mut.isPending}
        >
          {mut.isPending ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
    </ModalShell>
  );
}

function ScheduleCallbackModal({
  lead,
  onClose,
  onDone,
}: {
  lead: Lead;
  onClose: () => void;
  onDone: () => void;
}) {
  const [remindAt, setRemindAt] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");

  const mut = useMutation({
    mutationFn: async () => {
      if (!remindAt) throw new Error("Укажите время");
      await api.post(`/leads/${lead.id}/callbacks/`, {
        remind_at: new Date(remindAt).toISOString(),
        comment,
      });
    },
    onSuccess: onDone,
    onError: (err: any) => setError(err?.response?.data?.detail || err?.message || "Ошибка"),
  });

  return (
    <ModalShell title={`Callback: ${lead.full_name || lead.phone}`} onClose={onClose}>
      <label className="label">Когда перезвонить</label>
      <input
        type="datetime-local"
        className="input"
        value={remindAt}
        onChange={(e) => setRemindAt(e.target.value)}
      />
      <label className="label mt-3">Комментарий</label>
      <textarea
        className="input min-h-[80px]"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Что обсудили?"
      />
      {error && <div className="text-sm text-rose-600 mt-2">{error}</div>}
      <div className="mt-4 flex gap-2 justify-end">
        <button className="btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button
          className="btn-primary"
          onClick={() => mut.mutate()}
          disabled={mut.isPending}
        >
          {mut.isPending ? "Сохраняем…" : "Назначить"}
        </button>
      </div>
    </ModalShell>
  );
}

function CallbackDueModal({
  reminders,
  onDismiss,
  onDone,
}: {
  reminders: CallbackReminder[];
  onDismiss: (id: number) => void;
  onDone: () => void;
}) {
  const cur = reminders[0];
  if (!cur) return null;

  const complete = async () => {
    try {
      await api.post(`/callbacks/${cur.id}/done/`);
      onDismiss(cur.id);
      onDone();
    } catch {
      /* toast is enough */
    }
  };

  const snooze = async (minutes: number) => {
    try {
      await api.post(`/callbacks/${cur.id}/snooze/`, { minutes });
      onDismiss(cur.id);
      onDone();
    } catch {
      /* silent */
    }
  };

  return (
    <ModalShell title="Время callback'а!" onClose={() => onDismiss(cur.id)}>
      <div className="space-y-3">
        <div>
          <div className="text-sm text-gray-500 dark:text-slate-400">Клиент</div>
          <div className="font-medium">{cur.lead_name || cur.lead_phone}</div>
          <div className="text-sm">{cur.lead_phone}</div>
        </div>
        <div className="text-sm text-gray-500 dark:text-slate-400 flex items-center gap-2">
          <Clock className="w-4 h-4" /> Назначено на {formatDate(cur.remind_at)}
        </div>
        {cur.comment && <div className="text-sm">{cur.comment}</div>}
      </div>
      <div className="mt-5 flex flex-wrap gap-2 justify-end">
        <button className="btn-ghost" onClick={() => snooze(15)}>
          +15 минут
        </button>
        <button className="btn-ghost" onClick={() => snooze(60)}>
          +1 час
        </button>
        <button className="btn-primary" onClick={complete}>
          <CheckCircle2 className="w-4 h-4" /> Сделано
        </button>
      </div>
    </ModalShell>
  );
}

function ModalShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md card p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold">{title}</div>
          <button className="btn-ghost text-xs" onClick={onClose}>
            Закрыть
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
