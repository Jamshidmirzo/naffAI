import { useT } from "../../lib/i18n";

export type DayChip = {
  key: string; // 'all' | 'today' | 'yesterday' | 'd:DD.MM' | 'very_old'
  count: number;
};

type Props = {
  chips: DayChip[];
  activeKey: string;
  onPick: (key: string) => void;
};

/**
 * Горизонтальная полоса-переключатель дней над списком лидов на /my.
 * Заменяет прежние sticky-секции «Сегодня / Вчера / DD.MM / Давно».
 * Mobile-first: overflow-x: auto, tap-target ≥44px, активный chip
 * заполнен акцент-цветом, неактивные — outline. «Сегодня» — зелёный
 * тон, «Вчера» — янтарный, остальные — нейтральные.
 */
export default function DayStrip({ chips, activeKey, onPick }: Props) {
  const t = useT();
  const labelOf = (key: string): string => {
    if (key === "all") return t("my.group.all");
    if (key === "today") return t("my.group.today");
    if (key === "yesterday") return t("my.group.yesterday");
    if (key === "very_old") return t("my.group.very_old");
    return key.startsWith("d:") ? key.slice(2) : key;
  };

  const toneColors = (
    key: string,
    active: boolean,
  ): { bg: string; fg: string; border: string } => {
    // Акценты: today = зелёный, yesterday = янтарный, остальные = neutral.
    if (key === "today") {
      return active
        ? {
            bg: "#16a34a",
            fg: "#ffffff",
            border: "#16a34a",
          }
        : {
            bg: "color-mix(in srgb, #16a34a 8%, var(--bg-card))",
            fg: "#166534",
            border: "color-mix(in srgb, #16a34a 35%, var(--border))",
          };
    }
    if (key === "yesterday") {
      return active
        ? {
            bg: "#d97706",
            fg: "#ffffff",
            border: "#d97706",
          }
        : {
            bg: "color-mix(in srgb, #d97706 8%, var(--bg-card))",
            fg: "#92400e",
            border: "color-mix(in srgb, #d97706 35%, var(--border))",
          };
    }
    return active
      ? {
          bg: "var(--accent)",
          fg: "#ffffff",
          border: "var(--accent)",
        }
      : {
          bg: "var(--bg-card)",
          fg: "var(--fg)",
          border: "var(--border)",
        };
  };

  return (
    <div
      className="flex gap-2 overflow-x-auto no-scrollbar"
      style={{
        WebkitOverflowScrolling: "touch",
        paddingBottom: 4,
        marginBottom: 2,
      }}
      role="tablist"
      aria-label="day-filter"
    >
      {chips.map((c) => {
        const active = c.key === activeKey;
        const col = toneColors(c.key, active);
        return (
          <button
            key={c.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onPick(c.key)}
            className="shrink-0 whitespace-nowrap transition-colors"
            style={{
              minHeight: 44,
              padding: "9px 14px",
              borderRadius: 999,
              border: `1.5px solid ${col.border}`,
              background: col.bg,
              color: col.fg,
              fontSize: 13.5,
              fontWeight: active ? 700 : 600,
              lineHeight: 1,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span>{labelOf(c.key)}</span>
            <span
              style={{
                fontSize: 12,
                opacity: active ? 0.9 : 0.7,
                fontWeight: 600,
              }}
            >
              {c.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
