import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Plus, Sparkles, Wrench } from "lucide-react";
import { apiErrorMessage } from "../../lib/api-types";
import { useLangValue } from "../../lib/i18n";
import {
  useAiChatCreateSession,
  useAiChatMessages,
  useAiChatProviders,
  useAiChatSend,
  useAiChatSessions,
  type AiChatMessage,
} from "../api/admin";
import { useT2 } from "../i18n";
import { ErrorState, LoadingBlock, PageHeader, cx } from "../ui";

const PROVIDER_STORAGE_KEY = "naffai_ai_provider_key";

function readProvider() {
  try {
    return localStorage.getItem(PROVIDER_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export default function AIChat() {
  const t = useT2();
  const lang = useLangValue();
  const [activeId, setActiveId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [providerKey, setProviderKey] = useState<string>(readProvider);
  const bottomRef = useRef<HTMLDivElement>(null);

  const providersQ = useAiChatProviders();
  const providers = providersQ.data ?? [];
  const sessionsQ = useAiChatSessions();
  const sessions = useMemo(() => sessionsQ.data ?? [], [sessionsQ.data]);
  const messagesQ = useAiChatMessages(activeId);
  const messages = useMemo(() => messagesQ.data ?? [], [messagesQ.data]);
  const createSession = useAiChatCreateSession();
  const send = useAiChatSend();

  useEffect(() => {
    if (activeId == null && sessions.length > 0) setActiveId(sessions[0].id);
  }, [sessions, activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, send.isPending]);

  const persistProvider = (key: string) => {
    setProviderKey(key);
    try {
      if (key) localStorage.setItem(PROVIDER_STORAGE_KEY, key);
      else localStorage.removeItem(PROVIDER_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  const newSession = async () => {
    setError(null);
    try {
      const s = await createSession.mutateAsync(t("ai_chat.new_session"));
      setActiveId(s.id);
      return s.id;
    } catch (err) {
      setError(apiErrorMessage(err));
      return null;
    }
  };

  /** Sends `content`; with no session yet, creates one first and still sends the text. */
  const ask = async (content: string) => {
    setError(null);
    const text = content.trim();
    if (!text) return;
    let sid = activeId;
    if (sid == null) sid = await newSession();
    if (sid == null) return;
    send.mutate(
      { sessionId: sid, content: text, provider_key: providerKey || undefined, language: lang },
      {
        onSuccess: () => setInput(""),
        onError: (err) => setError(apiErrorMessage(err)),
      },
    );
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    ask(input);
  };

  const pending = send.isPending || createSession.isPending;
  const activeProvider = providers.find((p) => p.key === providerKey);
  const QUICK = [t("ai_chat.qp_sales_week"), t("ai_chat.qp_top3"), t("ai_chat.qp_by_channel"), t("ai_chat.qp_overdue")];
  const empty = messages.length === 0 && !send.isPending;

  return (
    <>
      <PageHeader title={t("ai_chat.title")} meta={t("ai_chat.subtitle")}>
        {providers.length > 0 ? (
          <>
            <span className="lbl">{t("common.model")}</span>
            <select
              className="input"
              aria-label={t("common.model")}
              title={activeProvider ? activeProvider.model : t("ai_chat.auto_chain_hint")}
              value={providerKey}
              onChange={(e) => persistProvider(e.target.value)}
              style={{ width: 200, height: 36 }}
            >
              <option value="">{t("ai_chat.auto_chain")}</option>
              {providers.map((p) => (
                <option key={p.key} value={p.key}>{p.label}</option>
              ))}
            </select>
            {activeProvider ? <span className="num xs c3 trunc" style={{ maxWidth: 180 }}>{activeProvider.model}</span> : null}
          </>
        ) : null}
        <button className="btn btn-pri" type="button" onClick={newSession} disabled={createSession.isPending}>
          <Plus className="ic" />{t("ai_chat.new_session")}
        </button>
      </PageHeader>

      <div className="row" style={{ alignItems: "stretch", flex: "1 1 auto", minHeight: 0, flexWrap: "wrap", gap: 0 }}>
        <nav className="col g4" aria-label={t("v2.admin.aichat.sessions")} style={{ flex: "1 1 240px", padding: "16px 12px", borderRight: "1px solid var(--line)", background: "var(--surface)" }}>
          <span className="lbl" style={{ padding: "0 8px 6px" }}>{t("v2.admin.aichat.sessions")}</span>
          {sessionsQ.isLoading ? (
            <LoadingBlock rows={3} />
          ) : sessionsQ.isError ? (
            <ErrorState error={sessionsQ.error} onRetry={() => sessionsQ.refetch()} />
          ) : sessions.length === 0 ? (
            <span className="xs c3" style={{ padding: 8 }}>{t("v2.admin.aichat.noSessions")}</span>
          ) : (
            <>
              {sessions.slice(0, 6).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={cx("side-item", s.id === activeId && "is-on")}
                  aria-current={s.id === activeId ? "true" : undefined}
                  style={{ border: 0, background: s.id === activeId ? undefined : "transparent", textAlign: "left", width: "100%" }}
                  onClick={() => {
                    setError(null);
                    setActiveId(s.id);
                  }}
                >
                  <span className="trunc">{s.title || t("ai_chat.session_num", { id: s.id })}</span>
                </button>
              ))}
              {sessions.length > 6 ? <span className="xs c3" style={{ padding: 8 }}>{t("v2.admin.aichat.last6")}</span> : null}
            </>
          )}
        </nav>

        <main className="col g16" style={{ flex: "999 1 420px", minWidth: 0, padding: "24px clamp(16px, 4vw, 32px)" }}>
          {activeId != null && messagesQ.isLoading ? (
            <LoadingBlock rows={3} onRetry={() => messagesQ.refetch()} />
          ) : activeId != null && messagesQ.isError ? (
            <ErrorState error={messagesQ.error} onRetry={() => messagesQ.refetch()} />
          ) : empty ? (
            <section className="card col" style={{ alignItems: "center", textAlign: "center", padding: "32px 24px", gap: 10 }}>
              <span className="icon-tile t-info" style={{ width: 52, height: 52, borderRadius: 16 }}><Sparkles className="ic ic-l" /></span>
              <span className="lbl">{t("ai_chat.ready_eyebrow")}</span>
              <span className="h2">{t("ai_chat.what_to_ask")}</span>
              <span className="s c3">{t("ai_chat.ask_hint")}</span>
              <div className="row g8 wrap" style={{ justifyContent: "center", marginTop: 6 }}>
                {QUICK.map((q) => (
                  <button key={q} className="chip" type="button" disabled={pending} onClick={() => ask(q)}>{q}</button>
                ))}
              </div>
            </section>
          ) : (
            <div className="col g16">
              {messages.map((m) => <Bubble key={m.id} m={m} />)}
              {send.isPending ? (
                <div className="row g8 s c3" style={{ paddingLeft: 4 }} aria-live="polite">
                  <span className="row g4" aria-hidden><i className="dot" style={{ width: 7, height: 7 }} /><i className="dot" style={{ width: 7, height: 7, opacity: 0.6 }} /><i className="dot" style={{ width: 7, height: 7, opacity: 0.3 }} /></span>
                  {t("ai_chat.typing")}
                </div>
              ) : null}
            </div>
          )}

          {error ? (
            <div className="banner b-bad" style={{ maxWidth: 760 }} role="alert">
              <AlertTriangle className="ic" />
              <span className="grow">{error}</span>
            </div>
          ) : null}

          <div ref={bottomRef} />

          <form onSubmit={onSubmit} className="col g8" style={{ position: "sticky", bottom: 0, paddingBottom: 8, background: "var(--bg)", marginTop: "auto" }}>
            <div className="row g8">
              <input
                className="input input-lg grow"
                type="text"
                placeholder={activeId ? t("ai_chat.ph_ask") : t("ai_chat.ph_start")}
                aria-label={t("v2.admin.aichat.question")}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={pending}
              />
              <button className="btn btn-pri btn-lg" type="submit" disabled={!input.trim() || pending}>{t("v2.admin.aichat.ask")}</button>
            </div>
          </form>
        </main>
      </div>
    </>
  );
}

function Bubble({ m }: { m: AiChatMessage }) {
  const t = useT2();
  const [open, setOpen] = useState(false);

  if (m.role === "tool") {
    return (
      <div className="well col g6" style={{ padding: "8px 12px", maxWidth: 620 }}>
        <button type="button" className="row g6 xs w6 c2" style={{ border: 0, background: "none", padding: 0, textAlign: "left" }} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown className="ic ic-s" /> : <ChevronRight className="ic ic-s" />}
          {t("v2.admin.aichat.toolResult")}{m.tool_name ? <span className="num">· {m.tool_name}</span> : null}
        </button>
        {open ? (
          <pre className="num" style={{ margin: 0, fontSize: 11.5, lineHeight: "17px", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--ink-2)" }}>{m.content}</pre>
        ) : null}
      </div>
    );
  }

  if (m.tool_calls?.length) {
    return (
      <span className="row g8 xs c2">
        <Wrench className="ic ic-s" />
        {t("ai_chat.calling")}: <span className="num w6">{m.tool_calls.map((c) => c.name).join(", ")}</span>
      </span>
    );
  }

  if (m.role === "user") {
    return (
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <div className="card pad" style={{ maxWidth: 560, background: "var(--brand)", color: "var(--brand-ink)", borderColor: "var(--brand)", borderRadius: "18px 18px 6px 18px", whiteSpace: "pre-wrap" }}>
          {m.content}
        </div>
      </div>
    );
  }

  const badge = m.provider_used && m.provider_used !== "none" ? (m.model_used ? `${m.provider_used} · ${m.model_used}` : m.provider_used) : null;
  return (
    <div className="col g6" style={{ maxWidth: 720 }}>
      <div className="card s" style={{ padding: "14px 18px", borderRadius: "18px 18px 18px 6px", whiteSpace: "pre-wrap", lineHeight: "20px" }}>
        {m.content || "…"}
      </div>
      {badge ? <span className="xs c3 w6" style={{ letterSpacing: ".06em", textTransform: "uppercase", paddingLeft: 4 }}>{badge}</span> : null}
    </div>
  );
}
