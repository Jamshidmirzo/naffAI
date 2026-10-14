import type { CSSProperties } from "react";

/**
 * Sticky-заголовок секции группировки лидов на /my
 *   «Сегодня / Вчера / DD.MM / Давно»
 * Используется в MyLeads.tsx как header над группой карточек.
 *
 * Design intent:
 *   — цветовая точка слева кодирует «свежесть» группы
 *     (зелёная=сегодня, янтарная=вчера, нейтральная=старее);
 *   — счётчик лидов — компактный pill справа;
 *   — sticky top-0 (операторская страница скроллится — заголовок остаётся
 *     перед глазами при прокрутке группы).
 */

export type SectionTone = "today" | "yesterday" | "older" | "very_old";

interface Props {
  label: string;
  count: number;
  tone: SectionTone;
}

const TONE_DOT: Record<SectionTone, string> = {
  today: "#16a34a",
  yesterday: "#f59e0b",
  older: "#94a3b8",
  very_old: "#64748b",
};

export default function SectionHeader({ label, count, tone }: Props) {
  const dot: CSSProperties = {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: TONE_DOT[tone],
    flexShrink: 0,
  };
  return (
    <div
      className="sticky top-0 z-10 flex items-center gap-2 px-1 py-1.5 -mx-1 mb-1"
      style={{
        background:
          "linear-gradient(to bottom, var(--bg) 70%, transparent)",
        backdropFilter: "blur(4px)",
      }}
    >
      <span style={dot} aria-hidden />
      <span
        className="text-[12.5px] uppercase tracking-[.06em] font-semibold"
        style={{ color: "var(--muted)" }}
      >
        {label}
      </span>
      <span
        className="ml-auto text-[11.5px] font-semibold px-2 py-0.5 rounded-full"
        style={{
          background: "var(--surface, #f6f6f6)",
          color: "var(--text, #111)",
        }}
      >
        {count}
      </span>
    </div>
  );
}
