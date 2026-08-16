import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

// Reusable 6×7 mini-calendar grid used by MonthPicker and DateInput.
// Weeks start on Monday (Russian convention). Fully token-based so
// light/dark themes just work.

export const RU_MONTH_NAMES_FULL = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

export const RU_WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export const pad2 = (n: number) => String(n).padStart(2, "0");

export const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

export const parseIso = (
  iso: string,
): { y: number; m: number; d: number } | null => {
  const parts = iso.split("-");
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!y || !m || !d) return null;
  return { y, m, d };
};

export const daysInMonth = (year: number, month1: number): number =>
  new Date(year, month1, 0).getDate();

export type Cell = { iso: string; inMonth: boolean };

// Ordered ISO days that fill a monthly grid: 6 rows × 7 days.
export const buildCalendarGrid = (year: number, month1: number): Cell[] => {
  const first = new Date(year, month1 - 1, 1);
  const startDow = (first.getDay() + 6) % 7; // Mon=0..Sun=6
  const dim = daysInMonth(year, month1);
  const cells: Cell[] = [];

  if (startDow > 0) {
    const prevMonth = month1 === 1 ? 12 : month1 - 1;
    const prevYear = month1 === 1 ? year - 1 : year;
    const prevDim = daysInMonth(prevYear, prevMonth);
    for (let i = startDow - 1; i >= 0; i--) {
      const day = prevDim - i;
      cells.push({
        iso: `${prevYear}-${pad2(prevMonth)}-${pad2(day)}`,
        inMonth: false,
      });
    }
  }

  for (let d = 1; d <= dim; d++) {
    cells.push({ iso: `${year}-${pad2(month1)}-${pad2(d)}`, inMonth: true });
  }

  const trailing = 42 - cells.length;
  if (trailing > 0) {
    const nextMonth = month1 === 12 ? 1 : month1 + 1;
    const nextYear = month1 === 12 ? year + 1 : year;
    for (let d = 1; d <= trailing; d++) {
      cells.push({
        iso: `${nextYear}-${pad2(nextMonth)}-${pad2(d)}`,
        inMonth: false,
      });
    }
  }

  return cells;
};

// Renders the calendar chrome (month header + weekdays + day grid).
// Callers control selection/range highlighting via `renderCellClass`
// so the same grid can serve single-day and range pickers.
export type MiniCalendarProps = {
  year: number;
  month: number; // 1..12
  onNavigate: (year: number, month: number) => void;
  onPickDay: (iso: string) => void;
  // Return CSS classes for a cell — full styling contract lives with
  // the caller (single-date vs range highlights).
  renderCellClass: (cell: Cell) => string;
  isDisabled?: (cell: Cell) => boolean;
  // Optional custom header (year dropdown, extra buttons). If provided,
  // the default `MonthName YYYY` label is replaced by this element,
  // but the ← → chevrons still render on either side.
  headerCenter?: React.ReactNode;
};

export default function MiniCalendar({
  year,
  month,
  onNavigate,
  onPickDay,
  renderCellClass,
  isDisabled,
  headerCenter,
}: MiniCalendarProps) {
  const cells = useMemo(
    () => buildCalendarGrid(year, month),
    [year, month],
  );

  const gotoPrev = () => {
    const y = month === 1 ? year - 1 : year;
    const m = month === 1 ? 12 : month - 1;
    onNavigate(y, m);
  };
  const gotoNext = () => {
    const y = month === 12 ? year + 1 : year;
    const m = month === 12 ? 1 : month + 1;
    onNavigate(y, m);
  };

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={gotoPrev}
          className="p-1 rounded-md hover:bg-[color:var(--bg-card)] text-[color:var(--text-primary)]"
          aria-label="Предыдущий месяц"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="text-sm font-medium text-[color:var(--text-primary)]">
          {headerCenter ?? (
            <>
              {RU_MONTH_NAMES_FULL[month - 1]} {year}
            </>
          )}
        </div>
        <button
          type="button"
          onClick={gotoNext}
          className="p-1 rounded-md hover:bg-[color:var(--bg-card)] text-[color:var(--text-primary)]"
          aria-label="Следующий месяц"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-1 text-[10px] uppercase text-[color:var(--text-label)]">
        {RU_WEEKDAYS.map((w) => (
          <div key={w} className="text-center py-1">
            {w}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell) => {
          const disabled = isDisabled?.(cell) ?? false;
          const dayNum = Number(cell.iso.slice(-2));
          return (
            <button
              key={cell.iso}
              type="button"
              disabled={disabled}
              onClick={() => onPickDay(cell.iso)}
              className={renderCellClass(cell)}
              aria-label={cell.iso}
            >
              {dayNum}
            </button>
          );
        })}
      </div>
    </div>
  );
}
