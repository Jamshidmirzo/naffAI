import { useQuery } from "@tanstack/react-query";
import { Sparkles, Sunrise, Moon, TrendingUp, Crown, Sun } from "lucide-react";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import type { BotReportDraft } from "./BotReportEditor";

export type BotReportTemplate = {
  id: number;
  slug: string;
  name: string;
  description: string;
  category: string;
  blocks: string[];
  schedule_defaults: {
    schedule_time?: string;
    schedule_days?: string[];
    period?: string;
    include_header?: boolean;
    language?: string;
  };
};

interface Props {
  onPick: (draft: BotReportDraft) => void;
  onSkip: () => void;
}

const CATEGORY_ICON: Record<
  string,
  React.FC<{ className?: string }>
> = {
  morning: Sunrise,
  evening: Moon,
  weekly: TrendingUp,
  owner: Crown,
  operator: Sun,
  custom: Sparkles,
};

export default function BotTemplateGallery({ onPick, onSkip }: Props) {
  const t = useT();
  const templates = useQuery({
    queryKey: ["bot-templates"],
    queryFn: () =>
      api
        .get<{ results: BotReportTemplate[] }>("/bot/templates/")
        .then((r) => r.data.results || []),
  });

  const pickTemplate = (tpl: BotReportTemplate) => {
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
    <div className="p-6 max-h-[80vh] overflow-y-auto">
      <div className="text-[18px] font-semibold tracking-tight mb-1">
        {t("bot.gallery.title")}
      </div>
      <div className="text-[13px] text-muted mb-5">
        {t("bot.gallery.subtitle")}
      </div>

      {templates.isLoading && (
        <div className="text-muted text-[13px]">{t("common.loading")}</div>
      )}

      <div className="grid gap-2.5 sm:grid-cols-2">
        {(templates.data || []).map((tpl) => {
          const Icon = CATEGORY_ICON[tpl.category] || Sparkles;
          return (
            <button
              key={tpl.id}
              type="button"
              onClick={() => pickTemplate(tpl)}
              className="text-left border border-[var(--border)] rounded-xl p-4 hover:border-[var(--accent)] hover:bg-[var(--faint)] transition"
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="w-8 h-8 rounded-lg bg-[var(--accent-pale-bg,rgba(228,87,27,0.08))] flex items-center justify-center text-[var(--accent)]">
                  <Icon className="w-4 h-4" />
                </span>
                <div className="text-[14px] font-semibold">{tpl.name}</div>
              </div>
              {tpl.description && (
                <div className="text-[12px] text-muted mb-2">
                  {tpl.description}
                </div>
              )}
              <div className="text-[10.5px] text-muted flex flex-wrap gap-1">
                {tpl.blocks.slice(0, 4).map((slug) => (
                  <span
                    key={slug}
                    className="px-1.5 py-0.5 rounded bg-[var(--faint2)]"
                  >
                    {slug}
                  </span>
                ))}
                {tpl.blocks.length > 4 && (
                  <span className="px-1.5 py-0.5">
                    +{tpl.blocks.length - 4}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-6 pt-4 border-t border-[var(--border)]">
        <button
          type="button"
          className="nf-btn nf-btn--ghost w-full"
          onClick={onSkip}
        >
          {t("bot.gallery.blank")}
        </button>
      </div>
    </div>
  );
}
