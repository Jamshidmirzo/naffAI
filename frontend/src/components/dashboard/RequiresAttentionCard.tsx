import { type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { formatNumber } from "../../lib/format";

/**
 * Правая колонка «Требует решения» на менеджерском дашборде «Сводка дня».
 *
 * 4 счётчика: Требуют проверки / Сироты / Продажи на проверке / Опоздали
 * сегодня. Клик по строке — переход на фильтрованный список.
 *
 * Пустое состояние (все нули) — карточка показывает всё равно (важно
 * подтвердить «дырок в потоке нет»), но с приглушённой типографикой.
 */

export interface AttentionCounters {
  to_review: number;
  orphans: number;
  /**
   * Оставлен как optional-hint для обратной совместимости API. Раньше
   * отдельная строка «Зависли на уволенных» — теперь эти лиды
   * автоматически уходят в system-lost, для менеджера строки нет.
   */
  stranded_on_inactive?: number;
  on_review: number;
  late_today: number;
}

interface Props {
  counters: AttentionCounters;
  title?: string;
}

interface Row {
  key: keyof AttentionCounters;
  label: string;
  path: string;
  tone?: "urgent" | "info";
}

const ROWS: Row[] = [
  { key: "to_review", label: "Требуют проверки", path: "/sales/pending", tone: "urgent" },
  { key: "orphans", label: "Сироты не назначены", path: "/leads/orphans", tone: "urgent" },
  { key: "on_review", label: "Продажи на проверке", path: "/sales/pending", tone: "info" },
  { key: "late_today", label: "Опоздали сегодня", path: "/attendance/today", tone: "info" },
];

function Chevron(): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

export function RequiresAttentionCard({ counters, title = "Требует решения" }: Props) {
  const nav = useNavigate();
  const allZero = Object.values(counters).every((n) => Number(n) === 0);

  return (
    <div
      className="nf-card p-5 animate-nfFadeUp"
      style={{ animationDelay: "0.18s" }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="text-[15px] font-semibold tracking-tight">{title}</div>
        {allZero && (
          <span className="text-[11px] uppercase tracking-wider text-muted">
            всё чисто
          </span>
        )}
      </div>

      <ul className="flex flex-col gap-1">
        {ROWS.map((r) => {
          const count = Number(counters[r.key] ?? 0);
          const highlight = r.tone === "urgent" && count > 0;
          return (
            <li key={r.key}>
              <button
                type="button"
                onClick={() => nav(r.path)}
                className="w-full flex items-center justify-between text-left rounded-lg transition"
                style={{
                  padding: "12px 12px 12px 14px",
                  background: highlight ? "rgba(242,86,11,0.06)" : "transparent",
                }}
              >
                <span
                  className="text-[13.5px]"
                  style={{
                    color: count > 0 ? "var(--text)" : "var(--muted)",
                    fontWeight: highlight ? 600 : 500,
                  }}
                >
                  {r.label}
                </span>
                <span className="flex items-center gap-2.5">
                  <span
                    className="text-[14px] tabular-nums font-semibold"
                    style={{
                      color: highlight
                        ? "var(--accent)"
                        : count > 0
                          ? "var(--text)"
                          : "var(--muted)",
                    }}
                  >
                    {formatNumber(count)}
                  </span>
                  <span
                    className="opacity-40"
                    style={{ color: "var(--muted)" }}
                  >
                    <Chevron />
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
