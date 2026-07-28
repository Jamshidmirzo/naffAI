import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Plus, Sparkles, Wrench } from "lucide-react";
import { api } from "../lib/api";
import { apiErrorMessage } from "../lib/api-types";
import { Chip, Eyebrow } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT, useLangValue } from "../lib/i18n";

interface ChatSession {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ChatMessageRow {
  id: number;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls: { name: string; arguments: Record<string, unknown> }[];
  tool_name: string;
  model_used?: string;
  provider_used?: string;
  created_at: string;
}

interface MessagesResponse {
  messages: ChatMessageRow[];
  last_assistant_id: number;
}

interface ProviderInfo {
  key: string;
  label: string;
  model: string;
}

function isSessionArray(data: unknown): data is ChatSession[] {
  return Array.isArray(data);
}

const PROVIDER_STORAGE_KEY = "naffai_ai_provider_key";

export default function AIChat() {
  const qc = useQueryClient();
  const [activeId, setActiveId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [providerKey, setProviderKey] = useState<string>(
    () => localStorage.getItem(PROVIDER_STORAGE_KEY) || "",
  );
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lang = useLangValue();

  const t = useT();
  usePageHeader({ title: t("ai_chat.title"), subtitle: t("ai_chat.subtitle") }, [t("ai_chat.title")]);

  const QUICK_PROMPTS = [
    t("ai_chat.qp_sales_week"),
    t("ai_chat.qp_top3"),
    t("ai_chat.qp_by_channel"),
    t("ai_chat.qp_overdue"),
  ];

  const providersQ = useQuery<ProviderInfo[]>({
    queryKey: ["ai-chat", "providers"],
    queryFn: () =>
      api.get<ProviderInfo[]>("/ai-chat/providers/").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  const providers = providersQ.data ?? [];

  const persistProviderKey = (key: string) => {
    setProviderKey(key);
    if (key) localStorage.setItem(PROVIDER_STORAGE_KEY, key);
    else localStorage.removeItem(PROVIDER_STORAGE_KEY);
  };

  const sessionsQ = useQuery({
    queryKey: ["ai-chat", "sessions"],
    queryFn: async () => {
      const r = await api.get("/ai-chat/sessions/");
      return isSessionArray(r.data)
        ? r.data
        : ((r.data as { results?: ChatSession[] }).results ?? []);
    },
  });

  const sessions = sessionsQ.data ?? [];
  useEffect(() => {
    if (activeId == null && sessions.length > 0) setActiveId(sessions[0].id);
  }, [sessions, activeId]);

  const messagesQ = useQuery<ChatMessageRow[]>({
    queryKey: ["ai-chat", "messages", activeId],
    queryFn: async () => {
      if (activeId == null) return [];
      const r = await api.get<ChatMessageRow[]>(`/ai-chat/sessions/${activeId}/messages/`);
      return r.data;
    },
    enabled: activeId != null,
  });

  const messages = useMemo(() => messagesQ.data ?? [], [messagesQ.data]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const createSession = useMutation({
    mutationFn: () => api.post<ChatSession>("/ai-chat/sessions/", { title: t("ai_chat.new_session") }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["ai-chat", "sessions"] });
      setActiveId(r.data.id);
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const sendMessage = useMutation({
    mutationFn: async (payload: { content: string }) => {
      if (activeId == null) throw new Error(t("ai_chat.no_active_session"));
      const r = await api.post<MessagesResponse>(
        `/ai-chat/sessions/${activeId}/messages/`,
        { ...payload, provider_key: providerKey || undefined, language: lang },
      );
      return r.data;
    },
    onSuccess: (data) => {
      qc.setQueryData<ChatMessageRow[]>(["ai-chat", "messages", activeId], data.messages);
      qc.invalidateQueries({ queryKey: ["ai-chat", "sessions"] });
      setInput("");
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const content = input.trim();
    if (!content) return;
    if (activeId == null) {
      createSession.mutate();
      return;
    }
    sendMessage.mutate({ content });
  };

  const sendQuick = (content: string) => {
    if (activeId == null) {
      createSession.mutate(undefined, {
        onSuccess: () => sendMessage.mutate({ content }),
      });
      return;
    }
    sendMessage.mutate({ content });
  };

  const activeProvider = providers.find((p) => p.key === providerKey);

  return (
    <div className="mx-auto max-w-[820px] flex flex-col" style={{ minHeight: "calc(100vh - 160px)" }}>
      {/* Model selector */}
      {providers.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap mb-3 animate-nfFadeUp">
          <span className="nf-col">{t("common.model")}</span>
          <div className="flex flex-wrap gap-1.5">
            <Chip
              active={!providerKey}
              onClick={() => persistProviderKey("")}
              title={t("ai_chat.auto_chain_hint")}
            >
              {t("ai_chat.auto_chain")}
            </Chip>
            {providers.map((p) => (
              <Chip
                key={p.key}
                active={providerKey === p.key}
                onClick={() => persistProviderKey(p.key)}
                title={p.model}
              >
                {p.label}
              </Chip>
            ))}
          </div>
          {activeProvider && (
            <span className="text-[11px] text-muted font-mono ml-auto">
              {activeProvider.model}
            </span>
          )}
        </div>
      )}

      {/* Session strip */}
      <div className="flex items-center gap-2 flex-wrap mb-4 animate-nfFadeUp">
        <button
          onClick={() => createSession.mutate()}
          disabled={createSession.isPending}
          className="nf-chip"
          title={t("ai_chat.new_session")}
        >
          <Plus className="w-3.5 h-3.5" /> {t("common.new")}
        </button>
        {sessions.slice(0, 6).map((s) => (
          <Chip
            key={s.id}
            active={s.id === activeId}
            onClick={() => setActiveId(s.id)}
            className="max-w-[180px] truncate"
          >
            {s.title || t("ai_chat.session_num", { id: s.id })}
          </Chip>
        ))}
      </div>

      {/* Messages */}
      <div className="flex-1 flex flex-col gap-3 pb-6">
        {messages.length === 0 && (
          <div className="grid place-items-center py-16 animate-nfFadeUp">
            <div className="text-center">
              <div
                className="grid place-items-center mx-auto text-white"
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 18,
                  background: "var(--accent-grad)",
                  boxShadow: "0 12px 26px -10px var(--accent)",
                }}
              >
                <Sparkles className="w-6 h-6" />
              </div>
              <Eyebrow className="mt-5">{t("ai_chat.ready_eyebrow")}</Eyebrow>
              <div
                className="mt-2 font-semibold"
                style={{ fontSize: 22, letterSpacing: "-0.025em" }}
              >
                {t("ai_chat.what_to_ask")}
              </div>
              <p className="text-[13px] text-muted mt-2 max-w-xs mx-auto">
                {t("ai_chat.ask_hint")}
              </p>
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <MessageBubble key={m.id} m={m} index={i} />
        ))}

        {sendMessage.isPending && (
          <div className="flex justify-start animate-nfFadeUp">
            <div
              className="text-[13px] text-muted px-4 py-2.5 rounded-2xl"
              style={{ background: "var(--faint)" }}
            >
              <span className="inline-flex gap-1">
                <span className="animate-nfPulse inline-block w-1 h-1 rounded-full bg-current" />
                <span className="animate-nfPulse inline-block w-1 h-1 rounded-full bg-current" style={{ animationDelay: "0.2s" }} />
                <span className="animate-nfPulse inline-block w-1 h-1 rounded-full bg-current" style={{ animationDelay: "0.4s" }} />
              </span>
              <span className="ml-2">{t("ai_chat.typing")}</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div
          className="text-[13px] rounded-xl px-3.5 py-2.5 mb-2"
          style={{
            background: "rgba(220,60,40,.08)",
            color: "var(--danger)",
            border: "1px solid rgba(220,60,40,.2)",
          }}
        >
          {error}
        </div>
      )}

      {/* Quick prompts */}
      {messages.length === 0 && (
        <div className="flex flex-wrap gap-2 mb-3 animate-nfFadeUp">
          {QUICK_PROMPTS.map((p) => (
            <Chip key={p} onClick={() => sendQuick(p)}>
              {p}
            </Chip>
          ))}
        </div>
      )}

      {/* Composer */}
      <form
        onSubmit={onSubmit}
        className="sticky bottom-0 flex gap-2 items-end pt-2 pb-4"
        style={{ background: "var(--bg)" }}
      >
        <input
          ref={inputRef}
          className="nf-input flex-1"
          placeholder={activeId ? t("ai_chat.ph_ask") : t("ai_chat.ph_start")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={sendMessage.isPending}
        />
        <button
          type="submit"
          className="grid place-items-center rounded-full text-white transition"
          style={{
            width: 44,
            height: 44,
            background: "var(--accent-grad)",
            boxShadow: "0 10px 24px -10px var(--accent)",
            opacity: !input.trim() || sendMessage.isPending ? 0.35 : 1,
            cursor: !input.trim() || sendMessage.isPending ? "not-allowed" : "pointer",
          }}
          disabled={!input.trim() || sendMessage.isPending}
        >
          <ArrowUp className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
}

function MessageBubble({ m, index }: { m: ChatMessageRow; index: number }) {
  const delay = `${0.03 + index * 0.04}s`;
  const t = useT();

  if (m.role === "tool") {
    return (
      <details className="text-[12px] text-muted animate-nfFadeUp" style={{ animationDelay: delay }}>
        <summary className="cursor-pointer inline-flex items-center gap-1">
          <Wrench className="w-3 h-3" /> {m.tool_name}
        </summary>
        <pre
          className="mt-1.5 rounded-xl p-3 whitespace-pre-wrap break-words overflow-x-auto text-[11.5px]"
          style={{ background: "var(--faint)" }}
        >
          {m.content}
        </pre>
      </details>
    );
  }

  if (m.tool_calls?.length) {
    return (
      <div
        className="text-[12px] italic text-muted animate-nfFadeUp"
        style={{ animationDelay: delay }}
      >
        <Wrench className="w-3 h-3 inline mr-1" />
        {t("ai_chat.calling")}: {m.tool_calls.map((tc) => tc.name).join(", ")}
      </div>
    );
  }

  if (m.role === "user") {
    return (
      <div className="flex justify-end animate-nfFadeUp" style={{ animationDelay: delay }}>
        <div
          className="text-white text-[14.5px] leading-[1.5] whitespace-pre-wrap"
          style={{
            maxWidth: "76%",
            padding: "13px 19px",
            borderRadius: "20px 20px 6px 20px",
            background: "var(--accent-grad)",
          }}
        >
          {m.content}
        </div>
      </div>
    );
  }

  const providerBadge =
    m.provider_used && m.provider_used !== "none"
      ? m.model_used
        ? `${m.provider_used} · ${m.model_used}`
        : m.provider_used
      : null;

  return (
    <div
      className="flex justify-start animate-nfFadeUp"
      style={{ animationDelay: delay }}
    >
      <div style={{ maxWidth: "76%" }}>
        <div
          className="text-[14.5px] leading-[1.55] whitespace-pre-wrap"
          style={{
            padding: "13px 19px",
            borderRadius: "20px 20px 20px 6px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
          }}
        >
          {m.content || "…"}
        </div>
        {providerBadge && (
          <div className="text-[10.5px] text-muted mt-1.5 pl-1 uppercase tracking-wide">
            {providerBadge}
          </div>
        )}
      </div>
    </div>
  );
}
