import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";

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
};

type Block = { slug: string; label_ru: string; label_uz: string; sensitive: boolean };
type Period = { slug: string; label: string };

interface Props {
  draft: BotReportDraft;
  onChange: (d: BotReportDraft) => void;
  chats: Chat[];
  blocks: Block[];
  periods: Period[];
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}

const WEEKDAYS: { key: string; short_ru: string; short_uz: string }[] = [
  { key: "mon", short_ru: "Пн", short_uz: "Du" },
  { key: "tue", short_ru: "Вт", short_uz: "Se" },
  { key: "wed", short_ru: "Ср", short_uz: "Cho" },
  { key: "thu", short_ru: "Чт", short_uz: "Pa" },
  { key: "fri", short_ru: "Пт", short_uz: "Ju" },
  { key: "sat", short_ru: "Сб", short_uz: "Sha" },
  { key: "sun", short_ru: "Вс", short_uz: "Ya" },
];

export default function BotReportEditor({
  draft,
  onChange,
  chats,
  blocks,
  periods,
  onSave,
  onCancel,
  saving,
}: Props) {
  const t = useT();
  const [preview, setPreview] = useState<string | null>(null);
  const activeChats = useMemo(() => chats.filter((c) => c.is_active), [chats]);

  const set = <K extends keyof BotReportDraft>(k: K, v: BotReportDraft[K]) =>
    onChange({ ...draft, [k]: v });

  const toggleDay = (day: string) => {
    const next = draft.schedule_days.includes(day)
      ? draft.schedule_days.filter((d) => d !== day)
      : [...draft.schedule_days, day];
    set("schedule_days", next);
  };

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

  const previewMut = useMutation({
    mutationFn: () =>
      api.post<{ previews: { html: string; title?: string }[] }>(`/bot/reports/preview/`, draft),
    onSuccess: (r) => {
      const html = (r.data.previews || []).map((p) => p.html).join("\n\n─────\n\n");
      setPreview(html);
    },
  });

  return (
    <div className="p-6 max-h-[80vh] overflow-y-auto">
      <div className="text-[18px] font-semibold tracking-tight mb-4">
        {t("bot.editor.title")}
      </div>

      <div className="space-y-4">
        <div>
          <label className="nf-col mb-1.5 block">{t("bot.editor.name")}</label>
          <input
            className="nf-input"
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={t("bot.editor.name_ph")}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="nf-col mb-1.5 block">{t("bot.editor.time")}</label>
            <input
              type="time"
              className="nf-input"
              value={draft.schedule_time.slice(0, 5)}
              onChange={(e) => set("schedule_time", e.target.value + ":00")}
            />
          </div>
          <div>
            <label className="nf-col mb-1.5 block">{t("bot.editor.language")}</label>
            <select
              className="nf-input"
              value={draft.language}
              onChange={(e) => set("language", e.target.value)}
            >
              <option value="uz">O'zbekcha</option>
              <option value="ru">Русский</option>
            </select>
          </div>
        </div>

        <div>
          <label className="nf-col mb-1.5 block">{t("bot.editor.days")}</label>
          <div className="flex gap-1.5 flex-wrap">
            {WEEKDAYS.map((d) => (
              <button
                key={d.key}
                type="button"
                onClick={() => toggleDay(d.key)}
                className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition ${
                  draft.schedule_days.length === 0 || draft.schedule_days.includes(d.key)
                    ? "bg-[var(--accent)] text-white"
                    : "bg-[var(--faint)] text-muted"
                }`}
              >
                {d.short_ru}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-muted mt-1.5">
            {draft.schedule_days.length === 0 ? t("bot.editor.every_day_hint") : ""}
          </div>
        </div>

        <div>
          <label className="nf-col mb-1.5 block">{t("bot.editor.period")}</label>
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

        <div>
          <label className="nf-col mb-1.5 block">{t("bot.editor.recipients")}</label>
          {activeChats.length === 0 && (
            <div className="text-[12px] text-muted">{t("bot.editor.no_chats")}</div>
          )}
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
                <span className="text-[13px] truncate">{c.title || c.chat_id}</span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <label className="nf-col mb-1.5 block">{t("bot.editor.blocks")}</label>
          <div className="space-y-1 max-h-52 overflow-y-auto border border-[var(--border)] rounded-xl p-2">
            {blocks.map((b) => (
              <label
                key={b.slug}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--faint)] cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={draft.blocks.includes(b.slug)}
                  onChange={() => toggleBlock(b.slug)}
                />
                <span className="text-[13px] flex-1">
                  {draft.language === "uz" ? b.label_uz : b.label_ru}
                </span>
                {b.sensitive && (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500"
                    title={t("bot.editor.sensitive_hint")}
                  >
                    private only
                  </span>
                )}
              </label>
            ))}
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

        {preview && (
          <div className="nf-tile p-4">
            <div className="text-[11px] text-muted mb-2">{t("bot.editor.preview")}</div>
            <div
              className="text-[13px] whitespace-pre-wrap"
              dangerouslySetInnerHTML={{ __html: preview }}
            />
          </div>
        )}
      </div>

      <div className="flex justify-between items-center mt-6 pt-4 border-t border-[var(--border)] gap-2">
        <button
          type="button"
          className="nf-btn nf-btn--ghost"
          onClick={() => previewMut.mutate()}
          disabled={previewMut.isPending}
        >
          {previewMut.isPending ? "…" : t("bot.editor.preview_btn")}
        </button>
        <div className="flex gap-2">
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
    </div>
  );
}
