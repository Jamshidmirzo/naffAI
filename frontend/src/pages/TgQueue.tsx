import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MessageCircle,
  PauseCircle,
  Play,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { api } from "../lib/api";
import { Button, Chip, StatusBadge, toast } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";

interface JobInfo {
  id: number;
  status: "pending" | "running" | "done" | "error";
  since: string | null;
  started_at: string | null;
  finished_at: string | null;
  chats_scanned: number;
  messages_saved: number;
  last_error: string;
}

interface QueueRow {
  operator_id: number;
  operator_name: string;
  session_id: number | null;
  session_status:
    | "active"
    | "pending_code"
    | "pending_2fa"
    | "expired"
    | "revoked"
    | "error"
    | "none";
  tg_username: string;
  last_connected_at: string | null;
  last_error: string;
  chats_count: number;
  messages_count: number;
  insights_count: number;
  latest_job: JobInfo | null;
}

interface QueueResponse {
  queue: QueueRow[];
  total: number;
}

const SESSION_LABELS: Record<string, string> = {
  active: "активна",
  pending_code: "ждёт код",
  pending_2fa: "ждёт 2FA",
  expired: "истёкла",
  revoked: "отозвана",
  error: "ошибка",
  none: "не подключён",
};

const JOB_LABELS: Record<string, string> = {
  pending: "в очереди",
  running: "загружаем",
  done: "готово",
  error: "ошибка",
};

function fmtRelative(iso: string | null) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  return `${d} дн назад`;
}

function sessionTone(s: QueueRow["session_status"]): "hot" | "danger" | "neutral" {
  if (s === "active") return "hot";
  if (s === "error" || s === "expired" || s === "revoked") return "danger";
  return "neutral";
}

function jobTone(j: JobInfo | null): "hot" | "danger" | "neutral" {
  if (!j) return "neutral";
  if (j.status === "error") return "danger";
  if (j.status === "running" || j.status === "pending") return "hot";
  return "neutral";
}

export default function TgQueue() {
  const nav = useNavigate();
  const qc = useQueryClient();

  usePageHeader({
    title: (useT())("tg_queue.title"),
    subtitle: (useT())("tg_queue.subtitle"),
  });

  const q = useQuery<QueueResponse>({
    queryKey: ["tg-queue"],
    queryFn: () =>
      api.get<QueueResponse>("/tg-userclient/queue/").then((r) => r.data),
    refetchInterval: 5000,
  });

  const retryMut = useMutation({
    mutationFn: (operator_id: number) =>
      api.post("/tg-userclient/backfill-jobs/retry/", { operator_id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tg-queue"] });
      toast.success("Задача перезапущена");
    },
    onError: () => toast.error("Не удалось перезапустить"),
  });

  const rows = q.data?.queue ?? [];
  const totals = useMemo(() => {
    const t = { active: 0, connecting: 0, running: 0, none: 0, error: 0, chats: 0, msgs: 0, ai: 0 };
    for (const r of rows) {
      t.chats += r.chats_count;
      t.msgs += r.messages_count;
      t.ai += r.insights_count;
      if (r.session_status === "active") t.active++;
      else if (r.session_status === "pending_code" || r.session_status === "pending_2fa") t.connecting++;
      else if (r.session_status === "error" || r.session_status === "expired") t.error++;
      else if (r.session_status === "none") t.none++;
      if ((r.latest_job?.status ?? "") === "running") t.running++;
    }
    return t;
  }, [rows]);

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Aggregate KPIs */}
      <section className="grid gap-[13px] grid-cols-2 md:grid-cols-6 animate-nfFadeUp">
        <TotalTile label="Активны" value={totals.active} accent />
        <TotalTile label="Подключаются" value={totals.connecting} />
        <TotalTile label="Загружаем" value={totals.running} />
        <TotalTile label="Не подключены" value={totals.none} />
        <TotalTile
          label="Ошибок"
          value={totals.error}
          danger={totals.error > 0}
        />
        <TotalTile label="Всего сообщений" value={totals.msgs} />
      </section>

      {/* Legend / hint */}
      <div className="flex items-center gap-3 text-[12.5px] text-muted animate-nfFadeUp">
        <span>Автообновление каждые 5 сек</span>
        <span>·</span>
        <span>{q.data?.total ?? 0} операторов</span>
      </div>

      {/* Queue table */}
      <section className="nf-card overflow-hidden">
        <div
          className="grid gap-2 px-6 pt-5 pb-3 nf-col"
          style={{ gridTemplateColumns: "1.2fr .9fr 1.1fr .7fr .7fr .6fr .8fr" }}
        >
          <div>Оператор</div>
          <div>TG-сессия</div>
          <div>Backfill</div>
          <div className="text-right">Чаты</div>
          <div className="text-right">Сообщ.</div>
          <div className="text-right">AI</div>
          <div className="text-right">Действия</div>
        </div>

        {q.isLoading ? (
          <div className="text-center text-muted py-14 text-[13px]">Загрузка…</div>
        ) : rows.length === 0 ? (
          <div className="text-center text-muted py-14 text-[13px]">Пусто</div>
        ) : (
          <div>
            {rows.map((r, i) => {
              const j = r.latest_job;
              const active = r.session_status === "active";
              const running = j?.status === "running";
              return (
                <div
                  key={r.operator_id}
                  className="nf-row animate-nfFadeUp"
                  style={{
                    gridTemplateColumns: "1.2fr .9fr 1.1fr .7fr .7fr .6fr .8fr",
                    animationDelay: `${0.02 + i * 0.03}s`,
                  }}
                  onClick={() => nav(`/operators/${r.operator_id}`)}
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{r.operator_name}</div>
                    {r.tg_username && (
                      <div className="text-[11.5px] text-muted truncate">
                        @{r.tg_username}
                      </div>
                    )}
                  </div>
                  <div>
                    <StatusBadge tone={sessionTone(r.session_status)}>
                      {SESSION_LABELS[r.session_status]}
                    </StatusBadge>
                    {r.last_connected_at && (
                      <div className="text-[11.5px] text-muted mt-0.5">
                        {fmtRelative(r.last_connected_at)}
                      </div>
                    )}
                    {r.last_error && (
                      <div className="text-[11.5px] mt-0.5" style={{ color: "var(--danger)" }}>
                        {r.last_error.slice(0, 60)}
                      </div>
                    )}
                  </div>
                  <div>
                    {j ? (
                      <>
                        <div className="flex items-center gap-1.5">
                          {j.status === "running" && (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: "var(--accent)" }} />
                          )}
                          {j.status === "done" && (
                            <CheckCircle2 className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />
                          )}
                          {j.status === "pending" && (
                            <PauseCircle className="w-3.5 h-3.5 text-muted" />
                          )}
                          {j.status === "error" && (
                            <AlertTriangle className="w-3.5 h-3.5" style={{ color: "var(--danger)" }} />
                          )}
                          <StatusBadge tone={jobTone(j)}>
                            {JOB_LABELS[j.status] ?? j.status}
                          </StatusBadge>
                        </div>
                        {running && (
                          <div className="text-[11.5px] text-muted mt-0.5 tabular-nums">
                            {j.chats_scanned} чатов · {j.messages_saved} сообщ.
                          </div>
                        )}
                        {j.status === "done" && j.finished_at && (
                          <div className="text-[11.5px] text-muted mt-0.5">
                            {fmtRelative(j.finished_at)}
                          </div>
                        )}
                        {j.status === "error" && j.last_error && (
                          <div className="text-[11.5px] mt-0.5" style={{ color: "var(--danger)" }}>
                            {j.last_error.slice(0, 60)}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-muted text-[12.5px]">—</span>
                    )}
                  </div>
                  <div className="text-right tabular-nums">
                    <span className={r.chats_count > 0 ? "font-semibold" : "text-muted"}>
                      {r.chats_count}
                    </span>
                  </div>
                  <div className="text-right tabular-nums">
                    <span className={r.messages_count > 0 ? "font-semibold" : "text-muted"}>
                      {r.messages_count}
                    </span>
                  </div>
                  <div className="text-right tabular-nums">
                    <span
                      className={r.insights_count > 0 ? "font-semibold" : "text-muted"}
                      style={r.insights_count > 0 ? { color: "var(--accent)" } : undefined}
                    >
                      {r.insights_count}
                    </span>
                  </div>
                  <div className="text-right" onClick={(e) => e.stopPropagation()}>
                    {active && j?.status === "error" && (
                      <button
                        onClick={() => retryMut.mutate(r.operator_id)}
                        className="nf-btn nf-btn--ghost"
                        style={{ padding: "6px 10px", fontSize: 12 }}
                        title="Retry backfill"
                      >
                        <RefreshCw className="w-3 h-3" /> Retry
                      </button>
                    )}
                    {r.session_status === "none" && (
                      <button
                        onClick={() => nav(`/operators/${r.operator_id}`)}
                        className="nf-btn"
                        style={{
                          padding: "6px 10px",
                          fontSize: 12,
                          background: "rgba(242,86,11,.12)",
                          color: "var(--accent)",
                        }}
                        title="Подключить TG"
                      >
                        <Play className="w-3 h-3" /> Подключить
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Chips at bottom for quick jumps */}
      <div className="flex items-center gap-2 flex-wrap animate-nfFadeUp">
        <span className="nf-col">Всего:</span>
        <Chip>
          <MessageCircle className="w-3 h-3" /> {totals.chats} чатов
        </Chip>
        <Chip>
          <MessageCircle className="w-3 h-3" /> {totals.msgs.toLocaleString("ru-RU")} сообщений
        </Chip>
        <Chip>
          <Sparkles className="w-3 h-3" /> {totals.ai} AI-инсайтов
        </Chip>
      </div>
    </div>
  );
}

function TotalTile({
  label,
  value,
  accent,
  danger,
}: {
  label: string;
  value: number;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="nf-card animate-nfFadeUp" style={{ padding: "16px 18px" }}>
      <div className="text-[11.5px] text-muted uppercase font-semibold tracking-wide">
        {label}
      </div>
      <div
        className="mt-1.5 font-semibold tabular-nums"
        style={{
          fontSize: 24,
          letterSpacing: "-0.025em",
          color: danger ? "var(--danger)" : accent ? "var(--accent)" : "var(--text)",
        }}
      >
        {value.toLocaleString("ru-RU")}
      </div>
    </div>
  );
}
