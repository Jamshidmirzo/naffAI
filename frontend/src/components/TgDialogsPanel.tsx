import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Mic,
  Sparkles,
  X,
} from "lucide-react";
import {
  tgChats,
  tgMessages,
  tgInsights,
  tgStatus,
  tgRetryBackfill,
  tgCoaching,
  TG_STATUS_KEY,
  type TgCoachingIssue,
  type TgCoachingResult,
  type TgMessageItem,
} from "../lib/tgUserclient";
import { Button, Modal, StatusBadge, toast } from "./ui";
import { useLang } from "../store/lang";

const MAX_SELECTION = 30;

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function severityTone(s: TgCoachingIssue["severity"]): "hot" | "danger" | "neutral" {
  if (s === "high") return "danger";
  if (s === "mid") return "hot";
  return "neutral";
}

const SEVERITY_LABEL: Record<TgCoachingIssue["severity"], string> = {
  high: "критично",
  mid: "средне",
  low: "мелко",
};

export default function TgDialogsPanel({ operatorId }: { operatorId: number }) {
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null);
  const [selectedMsgIds, setSelectedMsgIds] = useState<Set<number>>(new Set());
  const [coachingOpen, setCoachingOpen] = useState(false);
  const [coachingResult, setCoachingResult] = useState<TgCoachingResult | null>(null);
  const lang = useLang((s) => s.lang);

  const statusQ = useQuery({
    queryKey: TG_STATUS_KEY(operatorId),
    queryFn: () => tgStatus(operatorId).then((r) => r.data),
    refetchInterval: (query) => {
      const job = query.state.data?.latest_backfill_job;
      return job?.status === "running" || job?.status === "pending" ? 3000 : false;
    },
  });

  const retryMut = useMutation({
    mutationFn: () => tgRetryBackfill({ operator_id: operatorId }),
    onSuccess: () => statusQ.refetch(),
  });

  const chatsQ = useQuery({
    queryKey: ["tg-chats", operatorId],
    queryFn: () => tgChats(operatorId).then((r) => r.data),
  });

  const messagesQ = useQuery({
    queryKey: ["tg-messages", selectedChatId],
    queryFn: () => tgMessages(selectedChatId!, 100).then((r) => r.data),
    enabled: !!selectedChatId,
  });

  const insightsQ = useQuery({
    queryKey: ["tg-insights", selectedChatId],
    queryFn: () => tgInsights({ chat: selectedChatId! }).then((r) => r.data),
    enabled: !!selectedChatId,
  });

  const coachingMut = useMutation({
    mutationFn: () =>
      tgCoaching(selectedChatId!, Array.from(selectedMsgIds), lang).then(
        (r) => r.data,
      ),
    onSuccess: (data) => {
      setCoachingResult(data);
      setCoachingOpen(true);
    },
    onError: () => toast.error("Не удалось получить AI-анализ"),
  });

  const insight = insightsQ.data?.[0];
  const backfillJob = statusQ.data?.latest_backfill_job;

  const messagesChronological = useMemo(
    () => (messagesQ.data ? [...messagesQ.data].reverse() : []),
    [messagesQ.data],
  );

  const toggleMsg = (id: number) => {
    setSelectedMsgIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_SELECTION) next.add(id);
      else toast.error(`Максимум ${MAX_SELECTION} сообщений`);
      return next;
    });
  };

  const clearSelection = () => setSelectedMsgIds(new Set());

  // Reset selection when switching chats.
  const onChatClick = (id: number) => {
    setSelectedChatId(id);
    setSelectedMsgIds(new Set());
  };

  return (
    <div className="flex flex-col">
      {backfillJob && (
        <div
          className="px-4 py-2 text-[12px] flex items-center justify-between"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          {backfillJob.status === "running" && (
            <span style={{ color: "var(--accent)" }} className="font-medium">
              ⏳ Загружаем историю… чатов: {backfillJob.chats_scanned}, сообщений: {backfillJob.messages_saved}
            </span>
          )}
          {backfillJob.status === "pending" && (
            <span style={{ color: "var(--accent)" }} className="font-medium">
              ⏳ В очереди на загрузку истории…
            </span>
          )}
          {backfillJob.status === "done" && (
            <span style={{ color: "var(--accent)" }}>
              ✓ История загружена (чатов: {backfillJob.chats_scanned}, сообщений: {backfillJob.messages_saved})
            </span>
          )}
          {backfillJob.status === "error" && (
            <div className="flex items-center gap-2 w-full justify-between">
              <span style={{ color: "var(--danger)" }} className="font-medium truncate">
                ⚠ Ошибка загрузки: {backfillJob.last_error}
              </span>
              <Button
                variant="ghost"
                onClick={() => retryMut.mutate()}
                disabled={retryMut.isPending}
                className="!px-3 !py-1 !text-[12px]"
              >
                Повторить
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="flex" style={{ height: 620 }}>
        {/* --- Chats list --- */}
        <div
          className="w-1/3 overflow-y-auto nf-scroll-thin"
          style={{ borderRight: "1px solid var(--border)" }}
        >
          {chatsQ.isLoading && (
            <div className="p-4 text-muted text-[13px]">Загрузка чатов…</div>
          )}
          {chatsQ.data?.length === 0 && (
            <div className="p-4 text-muted text-[13px]">Нет чатов</div>
          )}
          {chatsQ.data?.map((chat) => {
            const active = selectedChatId === chat.id;
            return (
              <button
                key={chat.id}
                onClick={() => onChatClick(chat.id)}
                className="w-full text-left p-3 transition"
                style={{
                  borderBottom: "1px solid var(--border)",
                  background: active ? "var(--faint)" : "transparent",
                }}
              >
                <div className="font-medium text-[13.5px] truncate">
                  {chat.partner_name || chat.title || "Чат"}
                </div>
                <div className="text-[11.5px] text-muted mt-0.5">
                  {chat.last_message_at ? fmtDate(chat.last_message_at) : "—"}
                </div>
              </button>
            );
          })}
        </div>

        {/* --- Messages + insight + selection bar --- */}
        <div
          className="w-2/3 flex flex-col relative"
          style={{ background: "var(--faint)" }}
        >
          {!selectedChatId ? (
            <div className="flex-1 grid place-items-center text-muted text-[13px]">
              Выберите чат слева
            </div>
          ) : (
            <>
              {insight && (
                <div
                  className="p-4 z-10"
                  style={{
                    background: "var(--surface)",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="font-semibold text-[13px]">AI-анализ (весь чат)</span>
                    <StatusBadge
                      tone={
                        (insight.quality_score ?? 0) >= 80
                          ? "neutral"
                          : (insight.quality_score ?? 0) >= 50
                            ? "hot"
                            : "danger"
                      }
                    >
                      {insight.quality_score ?? 0}/100
                    </StatusBadge>
                  </div>
                  <div className="text-[12.5px] mb-2">{insight.summary}</div>
                  {insight.red_flags?.length > 0 && (
                    <div className="mb-1">
                      <span
                        className="text-[11px] font-semibold"
                        style={{ color: "var(--danger)" }}
                      >
                        Риски:
                      </span>
                      <ul
                        className="list-disc list-inside text-[11.5px]"
                        style={{ color: "var(--danger)" }}
                      >
                        {insight.red_flags.map((rf, i) => (
                          <li key={i}>{rf}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {insight.highlights?.length > 0 && (
                    <div>
                      <span
                        className="text-[11px] font-semibold"
                        style={{ color: "var(--accent)" }}
                      >
                        Плюсы:
                      </span>
                      <ul
                        className="list-disc list-inside text-[11.5px]"
                        style={{ color: "var(--accent)" }}
                      >
                        {insight.highlights.map((hl, i) => (
                          <li key={i}>{hl}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <div className="flex-1 overflow-y-auto nf-scroll-thin p-4 space-y-2 pb-16">
                {messagesQ.isLoading && (
                  <div className="text-center text-muted text-[13px]">Загрузка…</div>
                )}
                {messagesChronological.map((msg) => (
                  <MessageBubble
                    key={msg.id}
                    msg={msg}
                    selected={selectedMsgIds.has(msg.id)}
                    onToggle={() => toggleMsg(msg.id)}
                  />
                ))}
              </div>

              {/* Sticky selection bar */}
              {selectedMsgIds.size > 0 && (
                <div
                  className="absolute left-0 right-0 bottom-0 p-3 flex items-center gap-3 animate-nfPop"
                  style={{
                    background: "var(--surface)",
                    borderTop: "1px solid var(--border)",
                    boxShadow: "0 -8px 24px -12px rgba(0,0,0,.15)",
                  }}
                >
                  <span className="text-[13px]">
                    Выбрано:{" "}
                    <span className="font-semibold tabular-nums">
                      {selectedMsgIds.size}
                    </span>{" "}
                    <span className="text-muted">/ {MAX_SELECTION}</span>
                  </span>
                  <Button
                    variant="ghost"
                    onClick={clearSelection}
                    className="!px-3 !py-1.5 !text-[12px]"
                  >
                    <X className="w-3.5 h-3.5" /> Снять
                  </Button>
                  <div className="ml-auto">
                    <Button
                      onClick={() => coachingMut.mutate()}
                      disabled={coachingMut.isPending}
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      {coachingMut.isPending
                        ? "Анализируем…"
                        : "AI: как сказать лучше"}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* --- Coaching result modal --- */}
      <Modal
        open={coachingOpen}
        onClose={() => setCoachingOpen(false)}
        width={640}
      >
        {coachingResult && (
          <div className="p-7">
            <div className="flex items-center justify-between gap-3 mb-1">
              <div className="flex items-center gap-2.5">
                <div
                  className="grid place-items-center text-white"
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 10,
                    background: "var(--accent-grad)",
                  }}
                >
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-[16px] font-semibold tracking-tight">
                    AI-разбор сообщений
                  </div>
                  <div className="text-[11.5px] text-muted mt-0.5">
                    {coachingResult.model || coachingResult.provider || "—"} · {" "}
                    {coachingResult.issues.length}{" "}
                    {coachingResult.issues.length === 1 ? "замечание" : "замечаний"}
                  </div>
                </div>
              </div>
            </div>

            {coachingResult.summary && (
              <div
                className="mt-4 text-[13.5px] rounded-xl px-4 py-3"
                style={{
                  background:
                    "linear-gradient(165deg, rgba(242,86,11,.07), var(--surface) 55%)",
                  border: "1px solid var(--border)",
                }}
              >
                {coachingResult.summary}
              </div>
            )}

            {coachingResult.has_voice_selected && (
              <div
                className="mt-3 rounded-xl px-3.5 py-2.5 text-[12.5px] flex items-start gap-2"
                style={{
                  background: "rgba(242,86,11,.1)",
                  color: "var(--accent)",
                  border: "1px solid rgba(242,86,11,.25)",
                }}
              >
                <Mic className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  <b>Демо:</b> голосовые сообщения не транскрибируются на этом стенде,
                  AI пометил их как «нужен транскрипт» и не оценивал по содержанию.
                </span>
              </div>
            )}

            {coachingResult.issues.length === 0 && !coachingResult.error && (
              <div className="mt-5 py-6 text-center">
                <CheckCircle2
                  className="w-8 h-8 mx-auto mb-2"
                  style={{ color: "var(--accent)" }}
                />
                <div className="text-[14px] font-medium">
                  Явных ошибок не нашлось
                </div>
                <div className="text-[12.5px] text-muted mt-1">
                  В выбранных сообщениях всё выглядит нормально.
                </div>
              </div>
            )}

            {coachingResult.error && (
              <div
                className="mt-4 text-[13px] rounded-xl px-3.5 py-2.5"
                style={{
                  background: "rgba(220,60,40,.08)",
                  color: "var(--danger)",
                  border: "1px solid rgba(220,60,40,.2)",
                }}
              >
                {coachingResult.error}
              </div>
            )}

            <div className="mt-5 flex flex-col gap-3">
              {coachingResult.issues.map((iss) => {
                const src = messagesQ.data?.find((m) => m.id === iss.message_id);
                return (
                  <div
                    key={iss.message_id}
                    className="rounded-2xl p-4"
                    style={{
                      background: "var(--surface2)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <StatusBadge tone={severityTone(iss.severity)}>
                        <AlertTriangle className="w-3 h-3 inline mr-0.5" />
                        {SEVERITY_LABEL[iss.severity]}
                      </StatusBadge>
                      {src && (
                        <div className="text-[11px] text-muted tabular-nums">
                          {fmtTime(src.sent_at)}
                        </div>
                      )}
                    </div>
                    {src && (
                      <div
                        className="rounded-lg px-3 py-2 text-[13px] mb-2.5 italic"
                        style={{ background: "var(--faint)" }}
                      >
                        «
                        {src.text ||
                          (src.kind === "voice"
                            ? `голосовое ${src.voice_duration_sec ?? "?"} сек`
                            : `[${src.kind}]`)}
                        »
                      </div>
                    )}
                    <div className="text-[12px] text-muted uppercase tracking-wide font-semibold mb-1">
                      Проблема
                    </div>
                    <div className="text-[13.5px] mb-3">{iss.problem}</div>
                    <div
                      className="text-[12px] uppercase tracking-wide font-semibold mb-1"
                      style={{ color: "var(--accent)" }}
                    >
                      Как лучше сказать
                    </div>
                    <div
                      className="text-[13.5px] rounded-lg px-3 py-2"
                      style={{
                        background: "rgba(242,86,11,.08)",
                        borderLeft: "3px solid var(--accent)",
                      }}
                    >
                      {iss.suggestion}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-6 flex justify-end">
              <Button onClick={() => setCoachingOpen(false)}>Закрыть</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

interface BubbleProps {
  msg: TgMessageItem;
  selected: boolean;
  onToggle: () => void;
}

function MessageBubble({ msg, selected, onToggle }: BubbleProps) {
  const isOut = msg.direction === "out";
  const isVoice = msg.kind === "voice";

  return (
    <div className={`flex ${isOut ? "justify-end" : "justify-start"} items-end gap-2`}>
      {isOut && (
        <button
          type="button"
          onClick={onToggle}
          className="nf-check shrink-0 mb-1"
          data-on={selected}
          aria-label="Выбрать для AI-анализа"
          title="Выбрать для AI-анализа"
        >
          {selected && (
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path
                d="M2.5 6.2 5 8.7l4.5-5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      )}
      <div
        onClick={isOut ? onToggle : undefined}
        className="max-w-[75%] px-3 py-2 text-[13px] transition"
        style={{
          borderRadius: isOut ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
          background: isOut
            ? selected
              ? "var(--accent-grad)"
              : "var(--surface)"
            : "var(--surface)",
          color: isOut && selected ? "#fff" : "var(--text)",
          border:
            isOut && !selected
              ? "1px solid var(--border)"
              : !isOut
                ? "1px solid var(--border)"
                : `1px solid var(--accent)`,
          cursor: isOut ? "pointer" : "default",
        }}
      >
        {isVoice ? (
          <div className="flex items-center gap-2">
            <Mic className="w-3.5 h-3.5 shrink-0" style={{ opacity: 0.7 }} />
            <span className="italic">
              Голосовое {msg.voice_duration_sec ?? "?"} сек
            </span>
            <span
              className="text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5"
              style={{
                background: isOut && selected ? "rgba(255,255,255,.2)" : "var(--faint2)",
                color: isOut && selected ? "#fff" : "var(--muted)",
              }}
            >
              демо
            </span>
          </div>
        ) : (
          <div className="whitespace-pre-wrap break-words">
            {msg.text || <span className="italic opacity-60">[{msg.kind}]</span>}
          </div>
        )}
        <div
          className="text-[10px] mt-1 text-right tabular-nums"
          style={{
            opacity: 0.55,
            color: isOut && selected ? "#fff" : undefined,
          }}
        >
          {fmtTime(msg.sent_at)}
        </div>
      </div>
      {!isOut && (
        <span className="text-[10px] text-muted mb-1 shrink-0" style={{ width: 19 }} />
      )}
    </div>
  );
}
