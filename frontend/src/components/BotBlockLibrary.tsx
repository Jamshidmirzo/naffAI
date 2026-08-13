import { useMemo, useState } from "react";
import {
  Coins,
  Users2,
  PhoneCall,
  UserSquare,
  Smartphone,
  Layers,
  Check,
  Lock,
} from "lucide-react";
import { useT } from "../lib/i18n";

export type BlockMeta = {
  slug: string;
  label_ru: string;
  label_uz: string;
  category: string; // sales | leads | calls | operators | catalog | ops
  sensitive: boolean;
};

interface Props {
  blocks: BlockMeta[];
  selected: string[];
  onToggle: (slug: string) => void;
  language: string;
}

// Icon + accent color per category. Kept minimal — see designer follow-up
// for a proper palette. Category strings mirror `report_blocks.CATEGORIES`.
const CATEGORY_META: Record<
  string,
  { icon: React.FC<{ className?: string }>; i18nKey: string }
> = {
  sales: { icon: Coins, i18nKey: "bot.blocks.cat_sales" },
  leads: { icon: Layers, i18nKey: "bot.blocks.cat_leads" },
  calls: { icon: PhoneCall, i18nKey: "bot.blocks.cat_calls" },
  operators: { icon: UserSquare, i18nKey: "bot.blocks.cat_operators" },
  catalog: { icon: Smartphone, i18nKey: "bot.blocks.cat_catalog" },
  ops: { icon: Users2, i18nKey: "bot.blocks.cat_ops" },
};

const CATEGORY_ORDER = ["sales", "leads", "calls", "operators", "catalog", "ops"];

export default function BotBlockLibrary({
  blocks,
  selected,
  onToggle,
  language,
}: Props) {
  const t = useT();
  const [activeCat, setActiveCat] = useState<string>("sales");

  const grouped = useMemo(() => {
    const g: Record<string, BlockMeta[]> = {};
    for (const cat of CATEGORY_ORDER) g[cat] = [];
    for (const b of blocks) {
      const cat = b.category in g ? b.category : "ops";
      g[cat].push(b);
    }
    return g;
  }, [blocks]);

  const selectedInCat = (cat: string) =>
    grouped[cat].filter((b) => selected.includes(b.slug)).length;

  return (
    <div className="border border-[var(--border)] rounded-xl overflow-hidden">
      <div className="flex overflow-x-auto border-b border-[var(--border)] bg-[var(--faint)]">
        {CATEGORY_ORDER.map((cat) => {
          const meta = CATEGORY_META[cat];
          const Icon = meta.icon;
          const active = cat === activeCat;
          const sel = selectedInCat(cat);
          return (
            <button
              key={cat}
              type="button"
              onClick={() => setActiveCat(cat)}
              className={`flex items-center gap-1.5 px-3.5 py-2.5 text-[12px] whitespace-nowrap transition ${
                active
                  ? "bg-white dark:bg-[var(--bg-card)] text-text font-medium border-b-2 border-[var(--accent)]"
                  : "text-muted hover:text-text"
              }`}
            >
              <Icon className="w-3.5 h-3.5" /> {t(meta.i18nKey)}
              {sel > 0 && (
                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--accent)] text-white leading-none">
                  {sel}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="p-2 max-h-64 overflow-y-auto space-y-1">
        {grouped[activeCat].length === 0 && (
          <div className="text-[12px] text-muted p-4 text-center">
            {t("bot.blocks.empty_cat")}
          </div>
        )}
        {grouped[activeCat].map((b) => {
          const isSelected = selected.includes(b.slug);
          const label = language === "uz" ? b.label_uz : b.label_ru;
          return (
            <button
              key={b.slug}
              type="button"
              onClick={() => onToggle(b.slug)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition ${
                isSelected
                  ? "bg-[var(--accent-pale-bg,rgba(228,87,27,0.08))] text-text"
                  : "hover:bg-[var(--faint)]"
              }`}
            >
              <span
                className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                  isSelected
                    ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                    : "border-[var(--border)]"
                }`}
              >
                {isSelected && <Check className="w-3 h-3" />}
              </span>
              <span className="text-[13px] flex-1 truncate">{label}</span>
              {b.sensitive && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 flex items-center gap-1 flex-shrink-0"
                  title={t("bot.blocks.sensitive_hint")}
                >
                  <Lock className="w-3 h-3" /> {t("bot.blocks.sensitive_badge")}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
