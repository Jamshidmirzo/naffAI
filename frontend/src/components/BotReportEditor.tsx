import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Send, Eye } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import BotBlockLibrary, { type BlockMeta } from "./BotBlockLibrary";
import BotSchedulePicker from "./BotSchedulePicker";

export type BotReportDraft = {
  name: string;
  enabled: boolean;
  schedule_time: string;
  schedule_days: string[];
  recipient_ids: number[];
  blocks: string[];
  language: string;
  period: string;
  include_header: boolean;
};

type Chat = {
  id: number;
  chat_id: number;
  kind: string;
  title: string;
  language: string;
  is_active: boolean;
  linked_profile_name?: string;
};

type Period = { slug: string; label: string };

interface Props {
  draft: BotReportDraft;
  onChange: (d: BotReportDraft) => void;
  chats: Chat[];
  blocks: BlockMeta[];
  periods: Period[];
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  reportId?: number | null;
}

type PreviewButton = { text: string; url: string };

export default function BotReportEditor({
  draft,
  onChange,
  chats,
  blocks,
  periods,
  onSave,
  onCancel,
  saving,
  reportId,
}: Props) {
  const t = useT();
  const [previewHtml, setPreviewHtml] = useState<string>("");
  const [previewButtons, setPreviewButtons] = useState<PreviewButton[]>([]);
  const [previewAs, setPreviewAs] = useState<number | null>(null); // BotChat.id
  const debounceRef = useRef<number | null>(null);

  const activeChats = useMemo(() => chats.filter((c) => c.is_active), [chats]);

  const set = <K extends keyof BotReportDraft>(k: K, v: BotReportDraft[K]) =>
    onChange({ ...draft, [k]: v });

  const toggleBlock = (slug: string) => {
    const next = draft.blocks.includes(slug)
      ? draft.blocks.filter((s) => s !== slug)
      : [...draft.blocks, slug];
    set("blocks", next);
  };

  const toggleRecipient = (id: number) => {
    const next = draft.recipient_ids.includes(id)
      ? draft.recipient_ids.filter((x) => x !== id)
      : [...draft.recipient_ids, id];
    set("recipient_ids", next);
  };

  // Live preview: debounce 300ms after any change to the draft.
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      api
        .post<{ html: string; buttons: PreviewButton[]; chat_kind: string }>(
          `/bot/reports/preview_as/`,
          { draft, chat_id: previewAs },
        )
        .then((r) => {
          setPreviewHtml(r.data.html || "");
          setPreviewButtons(r.data.buttons || []);
        })
        .catch(() => {
          setPreviewHtml(`<i style="color:var(--muted)">${t("bot.editor.preview_error")}</i>`);
          setPreviewButtons([]);
        });
    }, 300);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [draft, previewAs]);

  const testSend = useMutation({
    mutationFn: (chatId: number) => {
      if (!reportId) {
        return Promise.reject(new Error("Отчёт нужно сначала сохранить."));
      }
      return api.post(`/bot/reports/${reportId}/test_send/`, {
        chat_id: chatId,
      });
    },
    onSuccess: () => {
      toast.success(t("bot.editor.test_sent_ok"));
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || t("bot.editor.test_sent_fail");
      toast.error(msg);
    },
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] max-h-[85vh]">
      {/* Left column — form */}
      <div className="p-5 overflow-y-auto">
        <div className="text-[18px] font-semibold tracking-tight mb-4">
          {reportId ? t("bot.editor.title_edit") : t("bot.editor.title_new")}
        </div>

        <div className="space-y-4">
          <div>
            <label className="nf-col mb-1.5 block">
              {t("bot.editor.name")}
            </label>
            <input
              className="nf-input"
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder={t("bot.editor.name_ph")}
            />
          </div>

          <div>
            <label className="nf-col mb-1.5 block">
              {t("bot.editor.schedule")}
            </label>
            <BotSchedulePicker
              time={draft.schedule_time}
              days={draft.schedule_days}
              onChange={({ time, days }) => {
                onChange({ ...draft, schedule_time: time, schedule_days: days });
              }}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="nf-col mb-1.5 block">
                {t("bot.editor.language")}
              </label>
              <select
                className="nf-input"
                value={draft.language}
                onChange={(e) => set("language", e.target.value)}
              >
                <option value="uz">O'zbekcha</option>
                <option value="ru">Русский</option>
              </select>
            </div>
            <div>
              <label className="nf-col mb-1.5 block">
                {t("bot.editor.period")}
              </label>
              <select
                className="nf-input"
                value={draft.period}
                onChange={(e) => set("period", e.target.value)}
              >
                {periods.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="nf-col mb-1.5 block">
              {t("bot.editor.recipients")}
            </label>
            {activeChats.length === 0 && (
              <div className="text-[12px] text-muted p-2 border border-dashed border-[var(--border)] rounded-lg">
                {t("bot.editor.no_chats")}
              </div>
            )}
            {activeChats.length > 0 && (
              <div className="space-y-1 max-h-40 overflow-y-auto border border-[var(--border)] rounded-xl p-2">
                {activeChats.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--faint)] cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={draft.recipient_ids.includes(c.id)}
                      onChange={() => toggleRecipient(c.id)}
                    />
                    <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-[var(--faint2)]">
                      {c.kind}
                    </span>
                    <span className="text-[13px] truncate flex-1">
                      {c.title || c.chat_id}
                    </span>
                    {c.linked_profile_name ? (
                      <span className="text-[10.5px] text-muted">
                        @ {c.linked_profile_name}
                      </span>
                    ) : null}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="nf-col mb-1.5 block">
              {t("bot.editor.blocks")}
            </label>
            <BotBlockLibrary
              blocks={blocks}
              selected={draft.blocks}
              onToggle={toggleBlock}
              language={draft.language}
            />
            <div className="text-[11px] text-muted mt-1.5">
              {t("bot.editor.selected_count", { n: draft.blocks.length })}
            </div>
          </div>

          <label className="flex items-center gap-2 text-[13px] cursor-pointer">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
            />
            {t("bot.editor.enabled")}
          </label>
        </div>

        <div className="flex justify-end items-center mt-6 pt-4 border-t border-[var(--border)] gap-2">
          <button type="button" className="nf-btn nf-btn--ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="nf-btn nf-btn--primary"
            onClick={onSave}
            disabled={saving || !draft.name.trim()}
          >
            {saving ? t("common.loading") : t("common.save")}
          </button>
        </div>
      </div>

      {/* Right column — live preview */}
      <div className="bg-[var(--faint)] border-l border-[var(--border)] flex flex-col overflow-hidden">
        <div className="p-4 border-b border-[var(--border)] space-y-2">
          <div className="flex items-center gap-2">
            <Eye className="w-4 h-4 text-muted" />
            <div className="text-[13px] font-semibold">
              {t("bot.editor.preview_title")}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted">
              {t("bot.editor.preview_as")}
            </span>
            <select
              className="nf-input !py-1 !text-[12px] flex-1"
              value={previewAs ?? ""}
              onChange={(e) =>
                setPreviewAs(e.target.value ? Number(e.target.value) : null)
              }
            >
              <option value="">{t("bot.editor.preview_as_default")}</option>
              {activeChats.map((c) => (
                <option key={c.id} value={c.id}>
                  [{c.kind}] {c.title || c.chat_id}
                </option>
              ))}
            </select>
          </div>
          {reportId && previewAs && (
            <button
              type="button"
              className="nf-btn nf-btn--ghost !py-1.5 w-full"
              onClick={() => testSend.mutate(previewAs)}
              disabled={testSend.isPending}
            >
              <Send className="w-3.5 h-3.5" />{" "}
              {testSend.isPending
                ? t("bot.editor.test_sending")
                : t("bot.editor.test_send")}
            </button>
          )}
          {!reportId && (
            <div className="text-[11px] text-muted italic">
              {t("bot.editor.save_first_hint")}
            </div>
          )}
        </div>
        <div className="p-4 overflow-y-auto flex-1">
          <div
            className="text-[13px] leading-relaxed whitespace-pre-wrap font-mono bg-white dark:bg-[var(--bg-card)] p-3 rounded-lg border border-[var(--border)] min-h-[240px]"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
          {previewButtons.length > 0 && (
            <div className="mt-3 space-y-1">
              <div className="text-[10.5px] text-muted">
                {t("bot.editor.preview_buttons")}
              </div>
              {previewButtons.map((b, i) => (
                <div
                  key={i}
                  className="text-[12px] px-2.5 py-1.5 bg-[var(--faint2)] rounded-lg flex items-center justify-between gap-2"
                >
                  <span>{b.text}</span>
                  <span className="text-muted text-[10.5px] truncate">
                    {b.url.replace(/^https?:\/\//, "")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
