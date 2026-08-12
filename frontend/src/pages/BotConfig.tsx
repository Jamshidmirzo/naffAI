import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, MessageSquare, Users, Zap, Plus, Play, Trash2, Edit3 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { usePageHeader } from "../store/page";
import { Modal } from "../components/ui";
import BotReportEditor, { type BotReportDraft } from "../components/BotReportEditor";

type Tab = "reports" | "chats" | "audit";

type BotChat = {
  id: number;
  chat_id: number;
  kind: "private" | "group" | "supergroup" | "channel";
  title: string;
  language: string;
  is_active: boolean;
  linked_profile_name: string;
  last_seen_at: string;
};

type BotReport = {
  id: number;
  name: string;
  enabled: boolean;
  schedule_time: string;
  schedule_days: string[];
  recipients: BotChat[];
  blocks: string[];
  language: string;
  period: string;
  include_header: boolean;
  last_sent_at: string | null;
  last_send_error: string;
};

type BlockMeta = { slug: string; label_ru: string; label_uz: string; sensitive: boolean };
type PeriodMeta = { slug: string; label: string };

const emptyDraft = (): BotReportDraft => ({
  name: "",
  enabled: true,
  schedule_time: "20:00",
  schedule_days: [],
  recipient_ids: [],
  blocks: ["sales_total", "top_operators", "daily_quote"],
  language: "uz",
  period: "today",
  include_header: true,
});

export default function BotConfig() {
  const t = useT();
  const qc = useQueryClient();
  usePageHeader({ title: t("bot.title"), subtitle: t("bot.subtitle") }, [t("bot.title")]);
  const [tab, setTab] = useState<Tab>("reports");
  const [editing, setEditing] = useState<BotReportDraft | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);

  const chats = useQuery({
    queryKey: ["bot-chats"],
    queryFn: () => api.get<{ results: BotChat[] }>("/bot/chats/").then((r) => r.data.results),
  });
  const reports = useQuery({
    queryKey: ["bot-reports"],
    queryFn: () => api.get<{ results: BotReport[]; count?: number } | BotReport[]>("/bot/reports/").then((r) => {
      const d = r.data as any;
      return (d.results || d) as BotReport[];
    }),
  });
  const blocks = useQuery({
    queryKey: ["bot-blocks"],
    queryFn: () =>
      api.get<{ blocks: BlockMeta[]; periods: PeriodMeta[] }>("/bot/blocks/").then((r) => r.data),
  });
  const audit = useQuery({
    queryKey: ["bot-audit"],
    queryFn: () => api.get<{ results: any[] }>("/bot/audit/?days=7").then((r) => r.data.results || []),
    enabled: tab === "audit",
  });

  const save = useMutation({
    mutationFn: (draft: BotReportDraft & { id?: number }) => {
      const body = { ...draft };
      delete (body as any).id;
      if (draft.id) return api.patch(`/bot/reports/${draft.id}/`, body);
      return api.post(`/bot/reports/`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bot-reports"] });
      setEditing(null);
      setEditingId(null);
      toast.success(t("bot.reports.saved"));
    },
    onError: () => toast.error(t("bot.reports.save_failed")),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/bot/reports/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bot-reports"] });
      toast.success(t("bot.reports.deleted"));
    },
  });

  const sendNow = useMutation({
    mutationFn: (id: number) => api.post(`/bot/reports/${id}/send_now/`),
    onSuccess: (r) => {
      toast.success(
        t("bot.reports.sent", { n: (r.data as any)?.sent ?? 0 }) +
          ((r.data as any)?.failed ? ` · ${t("bot.reports.failed", { n: (r.data as any).failed })}` : ""),
      );
      qc.invalidateQueries({ queryKey: ["bot-reports"] });
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.detail || t("bot.reports.send_failed")),
  });

  const openEdit = (r?: BotReport) => {
    if (!r) {
      setEditing(emptyDraft());
      setEditingId(null);
    } else {
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
    }
  };

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "reports", label: t("bot.tab_reports"), icon: <Zap className="w-4 h-4" /> },
    { key: "chats", label: t("bot.tab_chats"), icon: <MessageSquare className="w-4 h-4" /> },
    { key: "audit", label: t("bot.tab_audit"), icon: <Users className="w-4 h-4" /> },
  ];

  return (
    <div className="max-w-5xl space-y-5">
      <div className="nf-card p-2 inline-flex gap-1">
        {tabs.map((x) => (
          <button
            key={x.key}
            type="button"
            onClick={() => setTab(x.key)}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[13px] transition ${
              tab === x.key
                ? "bg-[var(--accent-pale-bg,rgba(228,87,27,0.08))] text-text font-medium"
                : "text-muted hover:bg-[var(--faint)]"
            }`}
          >
            {x.icon} {x.label}
          </button>
        ))}
      </div>

      {tab === "reports" && (
        <div className="space-y-3">
          <button
            type="button"
            className="nf-btn nf-btn--primary"
            onClick={() => openEdit()}
          >
            <Plus className="w-4 h-4" /> {t("bot.reports.new")}
          </button>
          {reports.isLoading && <div className="text-muted">{t("common.loading")}</div>}
          {!reports.isLoading && (reports.data || []).length === 0 && (
            <div className="nf-card p-12 text-center">
              <Bot className="w-8 h-8 text-muted mx-auto mb-3" />
              <div className="text-[15px] font-semibold mb-1">
                {t("bot.reports.empty_title")}
              </div>
              <div className="text-muted text-[13px]">{t("bot.reports.empty_hint")}</div>
            </div>
          )}
          <div className="grid gap-3">
            {(reports.data || []).map((r) => (
              <div key={r.id} className="nf-card p-4 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="text-[15px] font-semibold">{r.name}</div>
                    {!r.enabled && (
                      <span className="text-[10.5px] px-2 py-0.5 rounded-full bg-[var(--faint2)] text-muted">
                        {t("bot.reports.disabled")}
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] text-muted mt-1">
                    ⏰ {r.schedule_time} ·{" "}
                    {r.schedule_days.length === 0
                      ? t("bot.reports.every_day")
                      : r.schedule_days.map((d) => t(`bot.weekdays.${d}`)).join(", ")}{" "}
                    · {r.recipients.length} {t("bot.reports.recipients_short")}
                  </div>
                  <div className="text-[11.5px] text-muted mt-1 truncate">
                    {r.blocks.map((s) => s).join(" · ") || "—"}
                  </div>
                  {r.last_sent_at && (
                    <div className="text-[11px] text-muted mt-1">
                      {t("bot.reports.last_sent")}: {new Date(r.last_sent_at).toLocaleString()}
                    </div>
                  )}
                </div>
                <div className="flex gap-1.5 flex-shrink-0">
                  <button
                    type="button"
                    className="nf-btn nf-btn--ghost !py-1.5 !px-2.5"
                    onClick={() => sendNow.mutate(r.id)}
                    title={t("bot.reports.send_now")}
                  >
                    <Play className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    className="nf-btn nf-btn--ghost !py-1.5 !px-2.5"
                    onClick={() => openEdit(r)}
                    title={t("common.edit")}
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    className="nf-btn nf-btn--ghost !py-1.5 !px-2.5 text-red-500"
                    onClick={() => {
                      if (confirm(t("bot.reports.confirm_delete", { name: r.name }))) {
                        remove.mutate(r.id);
                      }
                    }}
                    title={t("common.delete")}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "chats" && (
        <div className="space-y-3">
          <div className="nf-tile p-4 text-[13px]">
            <div className="font-medium mb-1">{t("bot.chats.info_title")}</div>
            <div className="text-muted">{t("bot.chats.info_body")}</div>
          </div>
          {chats.isLoading && <div className="text-muted">{t("common.loading")}</div>}
          <div className="nf-card overflow-hidden">
            <table className="w-full text-[13px]">
              <thead className="bg-[var(--faint)] text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="text-left px-4 py-2.5">{t("bot.chats.col_kind")}</th>
                  <th className="text-left px-4 py-2.5">{t("bot.chats.col_title")}</th>
                  <th className="text-left px-4 py-2.5">{t("bot.chats.col_linked")}</th>
                  <th className="text-left px-4 py-2.5">{t("bot.chats.col_lang")}</th>
                  <th className="text-left px-4 py-2.5">{t("bot.chats.col_status")}</th>
                </tr>
              </thead>
              <tbody>
                {(chats.data || []).map((c) => (
                  <tr key={c.id} className="border-t border-[var(--border-row)]">
                    <td className="px-4 py-2.5">
                      <span className="text-[11.5px] px-2 py-0.5 rounded-full bg-[var(--faint2)]">
                        {c.kind}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-medium">
                      {c.title || <span className="text-muted">—</span>}
                      <div className="text-[10.5px] text-muted font-mono">{c.chat_id}</div>
                    </td>
                    <td className="px-4 py-2.5 text-muted">{c.linked_profile_name || "—"}</td>
                    <td className="px-4 py-2.5 text-muted">{c.language}</td>
                    <td className="px-4 py-2.5">
                      {c.is_active ? (
                        <span className="text-emerald-500">●</span>
                      ) : (
                        <span className="text-red-500">●</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "audit" && (
        <div className="nf-card overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="bg-[var(--faint)] text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="text-left px-4 py-2.5">{t("bot.audit.col_at")}</th>
                <th className="text-left px-4 py-2.5">{t("bot.audit.col_chat")}</th>
                <th className="text-left px-4 py-2.5">{t("bot.audit.col_user")}</th>
                <th className="text-left px-4 py-2.5">{t("bot.audit.col_cmd")}</th>
                <th className="text-left px-4 py-2.5">{t("bot.audit.col_outcome")}</th>
              </tr>
            </thead>
            <tbody>
              {(audit.data || []).map((row: any) => (
                <tr key={row.id} className="border-t border-[var(--border-row)]">
                  <td className="px-4 py-2 text-muted text-[11.5px]">
                    {new Date(row.at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 font-mono text-[11.5px]">{row.chat_id}</td>
                  <td className="px-4 py-2 text-muted">
                    {row.username ? "@" + row.username : row.tg_user_id || "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-[11.5px]">{row.command}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`text-[10.5px] px-2 py-0.5 rounded-full ${
                        row.outcome === "ok" || row.outcome === "scheduled_sent"
                          ? "bg-emerald-500/15 text-emerald-500"
                          : row.outcome === "denied"
                          ? "bg-amber-500/15 text-amber-500"
                          : "bg-red-500/15 text-red-500"
                      }`}
                    >
                      {row.outcome}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={!!editing}
        onClose={() => {
          setEditing(null);
          setEditingId(null);
        }}
        width={640}
      >
        {editing && blocks.data && (
          <BotReportEditor
            draft={editing}
            onChange={setEditing}
            chats={chats.data || []}
            blocks={blocks.data.blocks}
            periods={blocks.data.periods}
            onSave={() => save.mutate({ ...editing, id: editingId ?? undefined } as any)}
            onCancel={() => {
              setEditing(null);
              setEditingId(null);
            }}
            saving={save.isPending}
          />
        )}
      </Modal>
    </div>
  );
}
