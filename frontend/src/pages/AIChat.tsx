/**
 * F3.A — AI chat page (manager-only).
 *
 * Two-column layout:
 *   left  — session list + "new session" button
 *   right — messages + input
 *
 * The backend loop is blocking (POST /messages/ returns the full history
 * once the LLM finishes), so we don't need SSE; we just re-render.
 */

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Send, Wrench } from "lucide-react";
import { api } from "../lib/api";
import { apiErrorMessage } from "../lib/api-types";

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
  created_at: string;
}

interface MessagesResponse {
  messages: ChatMessageRow[];
  last_assistant_id: number;
}

function isSessionArray(data: unknown): data is ChatSession[] {
  return Array.isArray(data);
}

export default function AIChat() {
  const qc = useQueryClient();
  const [activeId, setActiveId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const sessionsQ = useQuery({
    queryKey: ["ai-chat", "sessions"],
    queryFn: async () => {
      const r = await api.get("/ai-chat/sessions/");
      return isSessionArray(r.data) ? r.data : ((r.data as { results?: ChatSession[] }).results ?? []);
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
    mutationFn: () => api.post<ChatSession>("/ai-chat/sessions/", { title: "Новая сессия" }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["ai-chat", "sessions"] });
      setActiveId(r.data.id);
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const sendMessage = useMutation({
    mutationFn: async (payload: { content: string }) => {
      if (activeId == null) throw new Error("Нет активной сессии");
      const r = await api.post<MessagesResponse>(
        `/ai-chat/sessions/${activeId}/messages/`,
        payload
      );
      return r.data;
    },
    onSuccess: (data) => {
      qc.setQueryData<ChatMessageRow[]>(
        ["ai-chat", "messages", activeId],
        data.messages
      );
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

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4 h-[calc(100vh-6rem)]">
      <aside className="card p-3 overflow-y-auto">
        <button
          className="btn-primary w-full mb-3"
          onClick={() => createSession.mutate()}
          disabled={createSession.isPending}
        >
          <Plus className="w-4 h-4" /> Новая сессия
        </button>
        <div className="space-y-1">
          {sessions.map((s) => (
            <button
              key={s.id}
              className={
                "w-full text-left px-3 py-2 rounded text-sm truncate " +
                (s.id === activeId
                  ? "bg-accent/10 text-accent"
                  : "hover:bg-gray-100 dark:hover:bg-slate-800")
              }
              onClick={() => setActiveId(s.id)}
            >
              {s.title || `Сессия #${s.id}`}
              <div className="text-[10px] text-gray-400">
                {new Date(s.updated_at).toLocaleString("ru-RU")}
              </div>
            </button>
          ))}
          {sessions.length === 0 && (
            <div className="text-xs text-gray-400 px-3 py-4 text-center">
              Пока нет сессий
            </div>
          )}
        </div>
      </aside>

      <section className="card flex flex-col overflow-hidden">
        <div className="border-b border-gray-100 dark:border-slate-800 px-5 py-3">
          <h2 className="text-sm font-semibold">AI-ассистент (read-only)</h2>
          <div className="text-xs text-gray-500 dark:text-slate-400">
            Спросите: «сколько лидов на этой неделе?», «топ-3 оператора», «просроченные callback'и»
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {messages.length === 0 && (
            <div className="text-center text-gray-400 text-sm py-8">
              Начните диалог с ассистентом.
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} m={m} />
          ))}
          {sendMessage.isPending && (
            <div className="text-xs text-gray-400 animate-pulse">Думаем…</div>
          )}
          <div ref={bottomRef} />
        </div>
        {error && (
          <div className="text-xs text-red-500 px-5 pb-2">{error}</div>
        )}
        <form onSubmit={onSubmit} className="border-t border-gray-100 dark:border-slate-800 p-3 flex gap-2">
          <input
            className="input flex-1"
            placeholder="Ваше сообщение…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={sendMessage.isPending}
          />
          <button
            type="submit"
            className="btn-primary"
            disabled={!input.trim() || sendMessage.isPending}
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </section>
    </div>
  );
}

function MessageBubble({ m }: { m: ChatMessageRow }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="bg-accent/10 text-accent rounded-lg rounded-br-none px-3 py-2 max-w-2xl whitespace-pre-wrap text-sm">
          {m.content}
        </div>
      </div>
    );
  }
  if (m.role === "tool") {
    return (
      <details className="text-xs text-gray-400">
        <summary className="cursor-pointer inline-flex items-center gap-1">
          <Wrench className="w-3 h-3" /> {m.tool_name}
        </summary>
        <pre className="mt-1 bg-gray-50 dark:bg-slate-900 rounded p-2 whitespace-pre-wrap break-words overflow-x-auto">
          {m.content}
        </pre>
      </details>
    );
  }
  if (m.tool_calls?.length) {
    return (
      <div className="text-xs text-gray-500 italic">
        Ассистент вызывает: {m.tool_calls.map((tc) => tc.name).join(", ")}
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="bg-gray-100 dark:bg-slate-800 rounded-lg rounded-bl-none px-3 py-2 max-w-2xl whitespace-pre-wrap text-sm">
        {m.content || "…"}
      </div>
    </div>
  );
}
