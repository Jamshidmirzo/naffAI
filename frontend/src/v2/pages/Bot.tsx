import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Bot as BotIcon,
  Clock,
  Coins,
  Crown,
  Eye,
  Info,
  Layers,
  Moon,
  Pencil,
  PhoneCall,
  Play,
  Plus,
  Send,
  Smartphone,
  Sparkles,
  Sun,
  Sunrise,
  Trash2,
  TrendingUp,
  UserSquare,
  Users,
  Users2,
  type LucideIcon,
} from "lucide-react";
import { toast } from "../../components/ui";
import { useLang } from "../../store/lang";
import { useT2 } from "../i18n";
import { Dialog, EmptyState, ErrorState, LoadingBlock, PageHeader, cx, useConfirm } from "../ui";
import {
  botPreviewAs,
  useBotAudit,
  useBotBlocks,
  useBotChats,
  useBotReportDelete,
  useBotReportSave,
  useBotReportSendNow,
  useBotReportTestSend,
  useBotReports,
  useBotTemplates,
  type BotBlockMeta,
  type BotChat,
  type BotPeriodMeta,
  type BotReport,
  type BotReportDraftV2,
  type BotTemplate,
} from "../api/admin";

type Tab = "reports" | "chats" | "audit";
const TABS: Tab[] = ["reports", "chats", "audit"];

const emptyDraft = (): BotReportDraftV2 => ({
  name: "",
  enabled: true,
  schedule_time: "20:00:00",
  schedule_days: [],
  recipient_ids: [],
  blocks: ["sales_total", "top_operators", "daily_quote"],
  language: "ru",
  period: "today",
  include_header: true,
});

function errDetail(e: unknown): string | undefined {
  return (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || undefined;
}

function fmtWhen(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

/** /bot — Telegram bot: scheduled reports, chats, command audit (MgBot, MgBot2). */
export default function Bot() {
  const t = useT2();
  const [sp, setSp] = useSearchParams();
  const tab: Tab = TABS.includes(sp.get("tab") as Tab) ? (sp.get("tab") as Tab) : "reports";
  const setTab = (x: Tab) => setSp(x === "reports" ? {} : { tab: x }, { replace: true });

  const chats = useBotChats();
  const blocks = useBotBlocks();

  const [editing, setEditing] = useState<BotReportDraftV2 | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);

  const openReport = (r: BotReport) => {
    setEditing({
      name: r.name,
      enabled: r.enabled,
      schedule_time: r.schedule_time,
      schedule_days: r.schedule_days || [],
      recipient_ids: (r.recipients || []).map((c) => c.id),
      blocks: r.blocks || [],
      language: r.language,
      period: r.period,
      include_header: r.include_header,
    });
    setEditingId(r.id);
  };
  const closeEditor = () => {
    setEditing(null);
    setEditingId(null);
  };

  return (
    <>
      <PageHeader title={t("bot.title")} meta={t("bot.subtitle")}>
        <div className="seg" role="tablist" aria-label={t("bot.title")}>
          {TABS.map((x) => (
            <button key={x} type="button" role="tab" aria-selected={tab === x} className={cx(tab === x && "is-on")} onClick={() => setTab(x)}>
              {t(`bot.tab_${x}`)}
            </button>
          ))}
        </div>
        <Link className="btn" to="/bot-subscribers">
          <Users className="ic ic-s" />
          {t("v2.admin.bot.subs")}
        </Link>
        {tab === "reports" ? (
          <>
            <button className="btn" type="button" onClick={() => setGalleryOpen(true)}>
              <Sparkles className="ic ic-s" />
              {t("bot.reports.from_template")}
            </button>
            <button className="btn btn-pri" type="button" onClick={() => setGalleryOpen(true)}>
              <Plus className="ic ic-s" />
              {t("bot.reports.new")}
            </button>
          </>
        ) : null}
      </PageHeader>
      <main className="page">
        {tab === "reports" ? (
          <ReportsTab blocks={blocks.data?.blocks ?? []} periods={blocks.data?.periods ?? []} onEdit={openReport} onNew={() => setGalleryOpen(true)} />
        ) : tab === "chats" ? (
          <ChatsTab q={chats} />
        ) : (
          <AuditTab />
        )}
      </main>

      {galleryOpen ? (
        <TemplateGallery
          blocks={blocks.data?.blocks ?? []}
          onClose={() => setGalleryOpen(false)}
          onPick={(d) => {
            setEditing(d);
            setEditingId(null);
            setGalleryOpen(false);
          }}
          onSkip={() => {
            setEditing(emptyDraft());
            setEditingId(null);
            setGalleryOpen(false);
          }}
        />
      ) : null}

      {editing ? (
        <ReportEditor
          draft={editing}
          onChange={setEditing}
          reportId={editingId}
          onCreated={setEditingId}
          chats={chats.data ?? []}
          blocksQ={blocks}
          onClose={closeEditor}
        />
      ) : null}
    </>
  );
}

/* ------------------------------ reports tab ------------------------------ */

function ReportsTab({ blocks, periods, onEdit, onNew }: { blocks: BotBlockMeta[]; periods: BotPeriodMeta[]; onEdit: (r: BotReport) => void; onNew: () => void }) {
  const t = useT2();
  const q = useBotReports();
  const del = useBotReportDelete();
  const sendNow = useBotReportSendNow();
  const confirm = useConfirm();
  const bySlug = useMemo(() => Object.fromEntries(blocks.map((b) => [b.slug, b])), [blocks]);
  const periodLabel = (slug: string) => periods.find((p) => p.slug === slug)?.label ?? slug;

  const remove = async (r: BotReport) => {
    const ok = await confirm({ title: t("bot.reports.confirm_delete", { name: r.name }), body: t("v2.admin.bot.deleteBody"), confirm: t("v2.admin.bot.delete"), danger: true });
    if (!ok) return;
    del.mutate(r.id, {
      onSuccess: () => toast.success(t("bot.reports.deleted")),
      onError: (e) => toast.error(errDetail(e) || t("bot.reports.save_failed")),
    });
  };

  const send = (r: BotReport) =>
    sendNow.mutate(r.id, {
      onSuccess: (d) => toast.success(t("bot.reports.sent", { n: d?.sent ?? 0 }) + (d?.failed ? ` · ${t("bot.reports.failed", { n: d.failed })}` : "")),
      onError: (e) => toast.error(errDetail(e) || t("bot.reports.send_failed")),
    });

  if (q.isLoading) return <section className="card"><LoadingBlock rows={4} onRetry={() => q.refetch()} /></section>;
  if (q.isError) return <section className="card"><ErrorState error={q.error} onRetry={() => q.refetch()} /></section>;
  const rows = q.data ?? [];
  if (rows.length === 0)
    return (
      <section className="card">
        <EmptyState
          icon={<BotIcon className="ic ic-l" />}
          title={t("bot.reports.empty_title")}
          body={t("bot.reports.empty_hint")}
          action={<button className="btn btn-pri" type="button" onClick={onNew}><Plus className="ic ic-s" />{t("bot.reports.new")}</button>}
        />
      </section>
    );

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))", gap: 16 }}>
        {rows.map((r) => {
          const days = r.schedule_days.length === 0 ? t("bot.reports.every_day") : r.schedule_days.map((d) => t(`bot.weekdays.${d}`)).join(", ");
          const sending = sendNow.isPending && sendNow.variables === r.id;
          return (
            <section key={r.id} className="card col g12" style={{ padding: "18px 20px", opacity: r.enabled ? 1 : 0.6 }}>
              <div className="row between g8">
                <span className="h3 trunc">{r.name}</span>
                <span className="row g6">
                  {r.last_send_error ? (
                    <span className="badge b-bad" title={r.last_send_error}><i className="dot" />{t("bot.reports.error_badge")}</span>
                  ) : null}
                  {!r.enabled ? <span className="badge">{t("bot.reports.disabled")}</span> : null}
                </span>
              </div>
              <div className="row g16 s c2 wrap">
                <span className="row g6">
                  <Clock className="ic ic-s c3" />
                  <span className="num">{r.schedule_time.slice(0, 5)}</span> · {days} · {t("v2.admin.bot.recipients", { n: r.recipients.length })}
                </span>
                <span className="c3">
                  {t(`v2.admin.bot.lang.${r.language === "uz" ? "uz" : "ru"}`)} · {t("v2.admin.bot.period", { p: periodLabel(r.period) })}
                </span>
              </div>
              {r.blocks.length ? (
                <div className="row g6 wrap">
                  {r.blocks.map((s) => {
                    const m = bySlug[s];
                    return (
                      <span key={s} className="chip" style={{ height: 26 }}>
                        {m ? (r.language === "uz" ? m.label_uz : m.label_ru) : s}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <span className="s c3">—</span>
              )}
              <span className={cx("xs", r.last_send_error ? "c-bad w6" : "c3")} title={r.last_send_error || undefined}>
                {r.last_sent_at ? t("v2.admin.bot.lastSent", { at: fmtWhen(r.last_sent_at) }) : t("v2.admin.bot.neverSent")}
              </span>
              {r.last_send_error ? <span className="xs c-bad" style={{ marginTop: -8 }}>{t("v2.admin.bot.lastError", { err: r.last_send_error })}</span> : null}
              <div className="row g8">
                <button className="btn btn-sm" type="button" disabled={sending} onClick={() => send(r)}>
                  <Play className="ic ic-s" />
                  {sending ? t("v2.admin.bot.sending") : t("bot.reports.send_now")}
                </button>
                <button className="btn btn-sm" type="button" onClick={() => onEdit(r)}>
                  <Pencil className="ic ic-s" />
                  {t("v2.admin.bot.edit")}
                </button>
                <span className="grow" />
                <button className="btn btn-sm btn-ghost btn-bad" type="button" disabled={del.isPending && del.variables === r.id} onClick={() => remove(r)}>
                  <Trash2 className="ic ic-s" />
                  {t("v2.admin.bot.delete")}
                </button>
              </div>
            </section>
          );
        })}
      </div>
      {confirm.node}
    </>
  );
}

/* ------------------------------ chats tab ------------------------------ */

const CHAT_COLS = "120px minmax(180px,1.6fr) minmax(140px,1.3fr) 90px 100px";

function ChatsTab({ q }: { q: ReturnType<typeof useBotChats> }) {
  const t = useT2();
  return (
    <>
      <div className="well row g12" style={{ alignItems: "flex-start", background: "var(--brand-soft)", borderColor: "transparent" }}>
        <span className="icon-tile t-info" style={{ background: "var(--surface)" }}><Info className="ic" /></span>
        <span className="col g4">
          <span className="s w6">{t("bot.chats.info_title")}</span>
          <span className="s c2">{t("bot.chats.info_body")}</span>
        </span>
      </div>
      <section className="card tbl">
        {q.isLoading ? (
          <LoadingBlock rows={5} onRetry={() => q.refetch()} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (q.data ?? []).length === 0 ? (
          <EmptyState title={t("v2.admin.bot.chatsEmpty")} body={t("bot.editor.no_chats")} />
        ) : (
          <div className="scroll-x">
            <div style={{ minWidth: 640 }}>
              <div className="tr th" style={{ gridTemplateColumns: CHAT_COLS }}>
                <span>{t("bot.chats.col_kind")}</span>
                <span>{t("bot.chats.col_title")}</span>
                <span>{t("bot.chats.col_linked")}</span>
                <span>{t("bot.chats.col_lang")}</span>
                <span>{t("bot.chats.col_status")}</span>
              </div>
              {(q.data ?? []).map((c) => (
                <div key={c.id} className="tr" style={{ gridTemplateColumns: CHAT_COLS, minHeight: 54 }}>
                  <span><span className="badge" style={{ borderRadius: 99 }}>{c.kind}</span></span>
                  <span className="col" style={{ minWidth: 0 }}>
                    <span className="s w6 trunc">{c.title || "—"}</span>
                    <span className="num xs c3">{c.chat_id}</span>
                  </span>
                  <span className="s c2 trunc">{c.linked_profile_name || "—"}</span>
                  <span className="s c3">{c.language}</span>
                  <span className={cx("row g6 xs", c.is_active ? "c-ok" : "c-bad")}>
                    <i className="dot" style={{ width: 8, height: 8 }} />
                    {c.is_active ? t("v2.admin.bot.chatActive") : t("v2.admin.bot.chatInactive")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
}

/* ------------------------------ audit tab ------------------------------ */

const AUDIT_COLS = "170px 150px minmax(140px,1.2fr) minmax(120px,1fr) 150px";

function AuditTab() {
  const t = useT2();
  const q = useBotAudit(true);
  const tone = (o: string) => (o === "ok" || o === "scheduled_sent" ? "b-ok" : o === "denied" ? "b-warn" : "b-bad");
  return (
    <>
      <span className="when">{t("v2.admin.bot.auditTitle")}</span>
      <section className="card tbl">
        {q.isLoading ? (
          <LoadingBlock rows={6} onRetry={() => q.refetch()} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (q.data ?? []).length === 0 ? (
          <EmptyState title={t("v2.state.empty")} body={t("v2.admin.bot.auditEmpty")} />
        ) : (
          <div className="scroll-x">
            <div style={{ minWidth: 720 }}>
              <div className="tr th" style={{ gridTemplateColumns: AUDIT_COLS }}>
                <span>{t("bot.audit.col_at")}</span>
                <span>{t("bot.audit.col_chat")}</span>
                <span>{t("bot.audit.col_user")}</span>
                <span>{t("bot.audit.col_cmd")}</span>
                <span>{t("bot.audit.col_outcome")}</span>
              </div>
              {(q.data ?? []).map((a) => (
                <div key={a.id} className="tr" style={{ gridTemplateColumns: AUDIT_COLS, minHeight: 42 }}>
                  <span className="num xs c3">{fmtWhen(a.at)}</span>
                  <span className="num xs trunc">{a.chat_id}</span>
                  <span className="s c2 trunc">{a.username ? "@" + a.username : a.tg_user_id || "—"}</span>
                  <span className="num xs w6 trunc">{a.command}</span>
                  <span><span className={cx("badge", tone(a.outcome))} style={{ borderRadius: 99, height: 20, fontSize: 11 }}>{a.outcome}</span></span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
      <p className="xs c3">{t("v2.admin.bot.auditHint")}</p>
    </>
  );
}

/* ------------------------------ template gallery ------------------------------ */

const TPL_ICON: Record<string, LucideIcon> = { morning: Sunrise, evening: Moon, weekly: TrendingUp, owner: Crown, operator: Sun, custom: Sparkles };

function TemplateGallery({ blocks, onPick, onSkip, onClose }: { blocks: BotBlockMeta[]; onPick: (d: BotReportDraftV2) => void; onSkip: () => void; onClose: () => void }) {
  const t = useT2();
  const lang = useLang((s) => s.lang);
  const q = useBotTemplates(true);
  const label = (slug: string) => {
    const m = blocks.find((b) => b.slug === slug);
    return m ? (lang === "uz" ? m.label_uz : m.label_ru) : slug;
  };
  const pick = (tpl: BotTemplate) => {
    const d = tpl.schedule_defaults || {};
    onPick({
      name: tpl.name,
      enabled: true,
      schedule_time: d.schedule_time || "09:00:00",
      schedule_days: d.schedule_days || [],
      recipient_ids: [],
      blocks: tpl.blocks || [],
      language: d.language || "ru",
      period: d.period || "today",
      include_header: d.include_header !== false,
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={960}
      title={t("bot.gallery.title")}
      sub={t("bot.gallery.subtitle")}
      footer={<button className="btn" type="button" onClick={onSkip}>{t("bot.gallery.blank")}</button>}
    >
      {q.isLoading ? (
        <LoadingBlock rows={2} onRetry={() => q.refetch()} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (q.data ?? []).length === 0 ? (
        <EmptyState title={t("v2.state.empty")} body={t("v2.admin.bot.templatesEmpty")} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
          {(q.data ?? []).map((tpl) => {
            const Icon = TPL_ICON[tpl.category] || Sparkles;
            return (
              <button key={tpl.id} type="button" className="card col g6 pad" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => pick(tpl)}>
                <span className="row g8">
                  <span className="icon-tile t-info" style={{ width: 30, height: 30 }}><Icon className="ic ic-s" /></span>
                  <span className="h3">{tpl.name}</span>
                </span>
                {tpl.description ? <span className="xs c3">{tpl.description}</span> : null}
                <span className="row g4 wrap">
                  {tpl.blocks.slice(0, 4).map((b) => (
                    <span key={b} className="badge" style={{ height: 20, fontSize: 11 }}>{label(b)}</span>
                  ))}
                  {tpl.blocks.length > 4 ? <span className="xs c3">+{tpl.blocks.length - 4}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}

/* ------------------------------ report editor ------------------------------ */

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const PRESETS = [
  { key: "bot.schedule.preset_morning", time: "09:00:00", days: [] as string[] },
  { key: "bot.schedule.preset_evening", time: "20:00:00", days: [] as string[] },
  { key: "bot.schedule.preset_workweek", time: "09:00:00", days: ["mon", "tue", "wed", "thu", "fri"] },
  { key: "bot.schedule.preset_monday", time: "09:00:00", days: ["mon"] },
];
const sameDays = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((d, i) => d === [...b].sort()[i]);

const CATS: Array<{ k: string; icon: LucideIcon }> = [
  { k: "sales", icon: Coins },
  { k: "leads", icon: Layers },
  { k: "calls", icon: PhoneCall },
  { k: "operators", icon: UserSquare },
  { k: "catalog", icon: Smartphone },
  { k: "ops", icon: Users2 },
];

function ReportEditor({
  draft,
  onChange,
  reportId,
  onCreated,
  chats,
  blocksQ,
  onClose,
}: {
  draft: BotReportDraftV2;
  onChange: (d: BotReportDraftV2) => void;
  reportId: number | null;
  onCreated: (id: number) => void;
  chats: BotChat[];
  blocksQ: ReturnType<typeof useBotBlocks>;
  onClose: () => void;
}) {
  const t = useT2();
  const save = useBotReportSave();
  const testSend = useBotReportTestSend();
  const [cat, setCat] = useState("sales");
  const [previewAs, setPreviewAs] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ html: string; buttons: Array<{ text: string; url: string }>; error?: boolean } | null>(null);
  const [tried, setTried] = useState(false);
  const timer = useRef<number | null>(null);

  const active = useMemo(() => chats.filter((c) => c.is_active), [chats]);
  const blocks = blocksQ.data?.blocks ?? [];
  const periods = blocksQ.data?.periods ?? [];
  const set = <K extends keyof BotReportDraftV2>(k: K, v: BotReportDraftV2[K]) => onChange({ ...draft, [k]: v });

  const grouped = useMemo(() => {
    const g: Record<string, BotBlockMeta[]> = Object.fromEntries(CATS.map((c) => [c.k, [] as BotBlockMeta[]]));
    for (const b of blocks) (g[b.category] ?? g.ops).push(b);
    return g;
  }, [blocks]);

  // Live preview, debounced 300 ms like the old editor.
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      botPreviewAs(draft, previewAs)
        .then((d) => setPreview({ html: d.html || "", buttons: d.buttons || [] }))
        .catch(() => setPreview({ html: "", buttons: [], error: true }));
    }, 300);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [draft, previewAs]);

  const toggleIn = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  // Empty days = every day: clicking a day while «every day» drops just that day.
  const toggleDay = (d: string) => {
    const base = draft.schedule_days.length === 0 ? WEEKDAYS : draft.schedule_days;
    const next = toggleIn(base, d);
    set("schedule_days", next.length === WEEKDAYS.length ? [] : WEEKDAYS.filter((x) => next.includes(x)));
  };

  const testTarget = previewAs ?? (draft.recipient_ids.length ? draft.recipient_ids[0] : null);
  const testChat = active.find((c) => c.id === testTarget);
  const groupTarget = testChat && testChat.kind !== "private";

  const submit = () => {
    setTried(true);
    if (!draft.name.trim()) return;
    save.mutate(
      { id: reportId, draft },
      {
        onSuccess: (data) => {
          if (!reportId && data?.id) onCreated(data.id);
          toast.success(t("bot.reports.saved"));
        },
        onError: (e) => toast.error(errDetail(e) || t("bot.reports.save_failed")),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={1080}
      title={reportId ? t("bot.editor.title_edit") : t("bot.editor.title_new")}
      footer={
        <>
          <label className="row g8 s grow">
            <input className="check" type="checkbox" checked={draft.enabled} onChange={(e) => set("enabled", e.target.checked)} />
            {t("bot.editor.enabled")}
          </label>
          <button className="btn" type="button" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-pri" type="button" disabled={save.isPending} onClick={submit}>
            {save.isPending ? t("common.saving") : t("common.save")}
          </button>
        </>
      }
    >
      {blocksQ.isLoading ? (
        <LoadingBlock rows={4} />
      ) : blocksQ.isError ? (
        <ErrorState error={blocksQ.error} onRetry={() => blocksQ.refetch()} />
      ) : (
        <div className="row g20 wrap" style={{ alignItems: "flex-start" }}>
          {/* form */}
          <div className="col g12" style={{ flex: "1.1 1 380px", minWidth: 0 }}>
            <div className="field">
              <label htmlFor="br-name">{t("bot.editor.name")}</label>
              <input id="br-name" className={cx("input", tried && !draft.name.trim() && "is-bad")} type="text" value={draft.name} placeholder={t("bot.editor.name_ph")} onChange={(e) => set("name", e.target.value)} />
              {tried && !draft.name.trim() ? <span className="err">{t("v2.admin.bot.needName")}</span> : null}
            </div>

            <div className="field">
              <label>{t("bot.editor.schedule")}</label>
              <div className="row g6 wrap">
                {PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className={cx("chip", draft.schedule_time === p.time && sameDays(p.days, draft.schedule_days) && "is-on")}
                    onClick={() => onChange({ ...draft, schedule_time: p.time, schedule_days: p.days })}
                  >
                    {t(p.key)}
                  </button>
                ))}
              </div>
              <div className="well col g8" style={{ padding: "10px 12px" }}>
                <span className="xs w6 c2">{t("bot.schedule.advanced")}</span>
                <div className="row g8">
                  <div className="field" style={{ width: 120 }}>
                    <label htmlFor="br-time" className="xs">{t("bot.editor.time")}</label>
                    <input
                      id="br-time"
                      className="input num"
                      type="time"
                      value={draft.schedule_time.slice(0, 5)}
                      style={{ height: 34 }}
                      onChange={(e) => e.target.value && set("schedule_time", e.target.value + ":00")}
                    />
                  </div>
                  <span className="xs c3" style={{ alignSelf: "flex-end", paddingBottom: 9 }} title={t("bot.schedule.tz_tip")}>{t("bot.schedule.tz_label")}</span>
                </div>
                <span className="xs w6 c2">{t("bot.editor.days")}</span>
                <div className="row g4 wrap">
                  {WEEKDAYS.map((d) => {
                    const on = draft.schedule_days.length === 0 || draft.schedule_days.includes(d);
                    return (
                      <button key={d} type="button" className={cx("chip", on && "is-on")} style={{ height: 28 }} aria-pressed={on} onClick={() => toggleDay(d)}>
                        {t(`bot.weekdays.${d}`)}
                      </button>
                    );
                  })}
                </div>
                <span className="hint">{draft.schedule_days.length === 0 ? t("bot.editor.every_day_hint") : t("bot.schedule.custom_hint")}</span>
              </div>
            </div>

            <div className="row g8 wrap" style={{ alignItems: "flex-start" }}>
              <div className="field grow" style={{ flexBasis: 180 }}>
                <label>{t("bot.editor.language")}</label>
                <div className="seg seg-lg">
                  {(["uz", "ru"] as const).map((l) => (
                    <button key={l} type="button" className={cx(draft.language === l && "is-on")} onClick={() => set("language", l)}>
                      {t(`v2.admin.bot.lang.${l}`)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field grow" style={{ flexBasis: 180 }}>
                <label htmlFor="br-period">{t("bot.editor.period")}</label>
                <select id="br-period" className="input" value={draft.period} onChange={(e) => set("period", e.target.value)}>
                  {periods.map((p) => (
                    <option key={p.slug} value={p.slug}>{p.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field">
              <label>{t("bot.editor.recipients")}</label>
              {active.length === 0 ? (
                <span className="well xs c3">{t("bot.editor.no_chats")}</span>
              ) : (
                <div className="col g6" style={{ maxHeight: 180, overflowY: "auto" }}>
                  {active.map((c) => (
                    <label key={c.id} className="row g8 s" style={{ cursor: "pointer" }}>
                      <input
                        className="check"
                        type="checkbox"
                        checked={draft.recipient_ids.includes(c.id)}
                        onChange={() => set("recipient_ids", draft.recipient_ids.includes(c.id) ? draft.recipient_ids.filter((x) => x !== c.id) : [...draft.recipient_ids, c.id])}
                      />
                      <span className="badge" style={{ height: 20 }}>{c.kind}</span>
                      <span className="trunc">{c.title || c.chat_id}</span>
                      {c.linked_profile_name ? <span className="xs c3 trunc">@ {c.linked_profile_name}</span> : null}
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="field">
              <label>{t("bot.editor.blocks")}</label>
              <div className="tabs" style={{ gap: 0, flexWrap: "wrap", overflow: "visible" }} role="tablist">
                {CATS.map(({ k, icon: Icon }) => {
                  const n = grouped[k].filter((b) => draft.blocks.includes(b.slug)).length;
                  return (
                    <button key={k} type="button" role="tab" aria-selected={cat === k} className={cx("tab", cat === k && "is-on")} style={{ padding: "0 8px", fontSize: 13 }} onClick={() => setCat(k)}>
                      <Icon className="ic ic-s" />
                      {t(`bot.blocks.cat_${k}`)}
                      {n ? <span className="cnt cnt-mute">{n}</span> : null}
                    </button>
                  );
                })}
              </div>
              <div className="col g6" style={{ maxHeight: 240, overflowY: "auto", paddingTop: 6 }}>
                {grouped[cat].length === 0 ? (
                  <span className="xs c3">{t("bot.blocks.empty_cat")}</span>
                ) : (
                  grouped[cat].map((b) => (
                    <label key={b.slug} className="row g8 s" style={{ cursor: "pointer" }}>
                      <input className="check" type="checkbox" checked={draft.blocks.includes(b.slug)} onChange={() => set("blocks", toggleIn(draft.blocks, b.slug))} />
                      <span className="trunc">{draft.language === "uz" ? b.label_uz : b.label_ru}</span>
                      {b.sensitive ? (
                        <span className="badge b-warn" style={{ height: 20 }} title={t("bot.blocks.sensitive_hint")}>{t("bot.blocks.sensitive_badge")}</span>
                      ) : null}
                    </label>
                  ))
                )}
              </div>
              <span className="xs c3">{t("bot.editor.selected_count", { n: draft.blocks.length })}</span>
            </div>
          </div>

          {/* live preview */}
          <div className="col g8" style={{ flex: "1 1 320px", minWidth: 0 }}>
            <span className="row g6 lbl"><Eye className="ic ic-s" />{t("bot.editor.preview_title")}</span>
            <div className="row g8">
              <span className="xs c3" style={{ flex: "none" }}>{t("bot.editor.preview_as")}</span>
              <select
                className="input grow"
                aria-label={t("bot.editor.preview_as")}
                style={{ height: 30, fontSize: 12 }}
                value={previewAs ? String(previewAs) : ""}
                onChange={(e) => setPreviewAs(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">{t("bot.editor.preview_as_default")}</option>
                {active.map((c) => (
                  <option key={c.id} value={c.id}>[{c.kind}] {c.title || c.chat_id}</option>
                ))}
              </select>
            </div>
            {preview?.error ? (
              <div className="banner b-bad"><AlertTriangle className="ic" /><span>{t("bot.editor.preview_error")}</span></div>
            ) : preview ? (
              <div
                className="num well"
                style={{ margin: 0, fontSize: 12, lineHeight: "19px", whiteSpace: "pre-wrap", minHeight: 220, overflowWrap: "anywhere" }}
                dangerouslySetInnerHTML={{ __html: preview.html }}
              />
            ) : (
              <div className="well"><LoadingBlock rows={3} /></div>
            )}
            {preview && preview.buttons.length ? (
              <>
                <span className="xs w6 c2">{t("bot.editor.preview_buttons")}</span>
                <div className="col g4">
                  {preview.buttons.map((b, i) => (
                    <span key={i} className="btn btn-sm btn-soft" style={{ justifyContent: "space-between" }} title={b.url}>
                      <span className="trunc">{b.text}</span>
                      <span className="xs c3 trunc" style={{ fontWeight: 400 }}>{b.url.replace(/^https?:\/\//, "")}</span>
                    </span>
                  ))}
                </div>
              </>
            ) : null}
            <button
              className="btn"
              type="button"
              style={{ alignSelf: "flex-start" }}
              disabled={!reportId || !testTarget || testSend.isPending}
              onClick={() =>
                reportId &&
                testTarget &&
                testSend.mutate(
                  { reportId, chatId: testTarget },
                  {
                    onSuccess: () => toast.success(t("bot.editor.test_sent_ok")),
                    onError: (e) => toast.error(errDetail(e) || (e as Error)?.message || t("bot.editor.test_sent_fail")),
                  },
                )
              }
            >
              <Send className="ic ic-s" />
              {testSend.isPending ? t("bot.editor.test_sending") : t("bot.editor.test_send")}
            </button>
            {!reportId ? (
              <span className="hint">{t("bot.editor.save_first_hint")}</span>
            ) : !testTarget ? (
              <span className="hint">{t("v2.admin.bot.pickChat")}</span>
            ) : groupTarget ? (
              <span className="hint">{t("v2.admin.bot.groupHint")}</span>
            ) : null}
          </div>
        </div>
      )}
    </Dialog>
  );
}
