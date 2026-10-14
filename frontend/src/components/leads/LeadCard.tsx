import type { ReactNode, CSSProperties } from "react";

/**
 * Визуальная обёртка над операторской карточкой лида (`/my`).
 *
 * Намеренно НЕ дублирует бизнес-логику существующего LeadCard
 * (кнопки, mutations, hint-плашки живут в `pages/MyLeads.tsx`). Эта
 * обёртка добавляет:
 *   — левую акцент-полосу по тону («сегодня/вчера/qimmatlik/hot/...»),
 *   — опциональный бейдж группы снизу (из `SectionHeader`-дубля для
 *     скан-глаза при длинной прокрутке),
 * — mobile-friendly tap area (padding + no-select).
 *
 * Использование: `<LeadCard tone="today">{existing <LeadCard/> JSX}</LeadCard>`.
 * Планово выделяется в полноценный компонент при следующем рефакторе — пока
 * же служит обрамлением без ломки текущих тестов и mutations.
 */

export type LeadCardTone =
  | "today"
  | "yesterday"
  | "older"
  | "danger"
  | "hot"
  | "neutral";

const TONE_BAR: Record<LeadCardTone, string> = {
  today: "#16a34a",
  yesterday: "#f59e0b",
  older: "#94a3b8",
  danger: "#ef4444",
  hot: "#f97316",
  neutral: "transparent",
};

interface Props {
  tone?: LeadCardTone;
  groupBadge?: string | null;
  children: ReactNode;
}

export default function LeadCard({
  tone = "neutral",
  groupBadge,
  children,
}: Props) {
  const barColor = TONE_BAR[tone];
  const wrapStyle: CSSProperties = {
    position: "relative",
    paddingLeft: tone === "neutral" ? 0 : 6,
    borderRadius: 18,
  };
  return (
    <div style={wrapStyle} className="nf-lead-wrap">
      {barColor !== "transparent" && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            top: 10,
            bottom: 10,
            width: 3,
            borderRadius: 999,
            background: barColor,
            opacity: 0.85,
          }}
        />
      )}
      {children}
      {groupBadge && (
        <div
          className="mt-1 px-3 text-[11px] font-semibold uppercase tracking-wide"
          style={{ color: "var(--muted)" }}
        >
          {groupBadge}
        </div>
      )}
    </div>
  );
}
