import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import {
  formatDateRu,
  monthLabel,
  recentMonths,
  type MonthChoice,
} from "../lib/period";

// Compact period picker with a fully custom popover: "Все период",
// "Текущий период", a rolling list of past N calendar months, and an
// inline mini-calendar for arbitrary date ranges. Every color and
// control uses design tokens (--accent, --border-main, --bg-card, …)
// so the popover matches the naffAI palette in both light and dark
// themes — no native <input type="date"> anywhere so the OS blue
// picker never leaks through.

type Props = {
  value: MonthChoice;
  onChange: (v: MonthChoice) => void;
  monthsBack?: number;
};

const RU_MONTH_NAMES_FULL = [
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

const RU_WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

const pad2 = (n: number) => String(n).padStart(2, "0");

const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

const parseIso = (iso: string): { y: number; m: number; d: number } | null => {
  const parts = iso.split("-");
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!y || !m || !d) return null;
  return { y, m, d };
};

const daysInMonth = (year: number, month1: number): number =>
  new Date(year, month1, 0).getDate();

// Return the ordered ISO days that fill a monthly grid: 6 rows of 7 days,
// leading days from prev month + this month + trailing next-month days.
// Weeks start on Monday (Russian convention).
const buildCalendarGrid = (
  year: number,
  month1: number,
): { iso: string; inMonth: boolean }[] => {
  const first = new Date(year, month1 - 1, 1);
  // JS: 0=Sun..6=Sat; convert to Mon=0..Sun=6.
  const startDow = (first.getDay() + 6) % 7;
  const dim = daysInMonth(year, month1);

  const cells: { iso: string; inMonth: boolean }[] = [];

  // Leading previous-month days.
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

  // Current month.
  for (let d = 1; d <= dim; d++) {
    cells.push({ iso: `${year}-${pad2(month1)}-${pad2(d)}`, inMonth: true });
  }

  // Trailing next-month days to complete a 6×7 grid (42 cells).
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

export default function MonthPicker({ value, onChange, monthsBack = 6 }: Props) {
  const [open, setOpen] = useState(false);
  const [rangeMode, setRangeMode] = useState(value.kind === "range");
  const ref = useRef<HTMLDivElement | null>(null);
  const months = recentMonths(monthsBack + 1);

  const today = todayIso();

  // Calendar view state (month currently rendered in the mini calendar).
  const initialViewDate = useMemo(() => {
    if (value.kind === "range") {
      const p = parseIso(value.from) ?? parseIso(today);
      return { year: p!.y, month: p!.m };
    }
    if (value.kind === "specific") {
      return { year: value.year, month: value.month };
    }
    const t = parseIso(today)!;
    return { year: t.y, month: t.m };
  }, [value, today]);
  const [view, setView] = useState(initialViewDate);

  // Range picker "from" / "to" state (ISO). We commit on Apply so the
  // parent doesn't refetch until the user picks a full range.
  const [fromDate, setFromDate] = useState(
    value.kind === "range" ? value.from : "",
  );
  const [toDate, setToDate] = useState(
    value.kind === "range" ? value.to : "",
  );

  useEffect(() => {
    if (value.kind === "range") {
      setFromDate(value.from);
      setToDate(value.to);
      setRangeMode(true);
    } else {
      setRangeMode(false);
    }
  }, [value]);

  const label = useMemo(() => {
    if (value.kind === "all") return "За весь период";
    if (value.kind === "current") return "Текущий период";
    if (value.kind === "range") {
      return `${formatDateRu(value.from)} — ${formatDateRu(value.to)}`;
    }
    return monthLabel(value.year, value.month);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isAll = value.kind === "all";
  const isCurrent = value.kind === "current";
  const isRange = value.kind === "range";

  const applyRange = () => {
    if (!fromDate || !toDate) return;
    const [from, to] = fromDate <= toDate ? [fromDate, toDate] : [toDate, fromDate];
    onChange({ kind: "range", from, to });
    setOpen(false);
  };

  const canApplyRange = !!fromDate && !!toDate;

  const gotoPrev = () => {
    setView((v) => ({
      year: v.month === 1 ? v.year - 1 : v.year,
      month: v.month === 1 ? 12 : v.month - 1,
    }));
  };
  const gotoNext = () => {
    setView((v) => ({
      year: v.month === 12 ? v.year + 1 : v.year,
      month: v.month === 12 ? 1 : v.month + 1,
    }));
  };

  const cells = useMemo(
    () => buildCalendarGrid(view.year, view.month),
    [view],
  );

  const pickDay = (iso: string) => {
    if (iso > today) return; // no future dates for a sales report
    if (!fromDate || (fromDate && toDate)) {
      // Start a new range.
      setFromDate(iso);
      setToDate("");
      return;
    }
    // We have "from" but not "to" — set "to". Auto-swap if needed.
    if (iso < fromDate) {
      setToDate(fromDate);
      setFromDate(iso);
    } else {
      setToDate(iso);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-[color:var(--border-main)] bg-[color:var(--bg-card)] text-[color:var(--text-primary)] hover:bg-[color:var(--bg-nested)] transition-colors"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{label}</span>
        <ChevronDown className="w-4 h-4 opacity-60" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-30 mt-1 w-80 rounded-xl border border-[color:var(--border-main)] bg-[color:var(--bg-card)] text-[color:var(--text-primary)] shadow-modal py-1 max-h-[32rem] overflow-auto"
        >
          <button
            role="option"
            aria-selected={isAll}
            onClick={() => {
              onChange({ kind: "all" });
              setOpen(false);
            }}
            className={
              "w-full text-left px-3 py-1.5 text-sm transition-colors hover:bg-[color:var(--bg-nested)] " +
              (isAll
                ? "text-[color:var(--accent)] font-medium"
                : "text-[color:var(--text-primary)]")
            }
          >
            За весь период
          </button>
          <button
            role="option"
            aria-selected={isCurrent}
            onClick={() => {
              onChange({ kind: "current" });
              setOpen(false);
            }}
            className={
              "w-full text-left px-3 py-1.5 text-sm transition-colors hover:bg-[color:var(--bg-nested)] " +
              (isCurrent
                ? "text-[color:var(--accent)] font-medium"
                : "text-[color:var(--text-primary)]")
            }
          >
            Текущий период (день/неделя/месяц)
          </button>
          <div className="my-1 border-t border-[color:var(--border-row)]" />
          <button
            role="option"
            aria-selected={isRange || rangeMode}
            onClick={() => setRangeMode((v) => !v)}
            className={
              "w-full text-left px-3 py-1.5 text-sm transition-colors hover:bg-[color:var(--bg-nested)] " +
              (isRange
                ? "text-[color:var(--accent)] font-medium"
                : "text-[color:var(--text-primary)]")
            }
          >
            {rangeMode
              ? "▼ Произвольный период"
              : "▶ Произвольный период..."}
          </button>
          {rangeMode && (
            <div className="px-3 py-2 space-y-2 bg-[color:var(--bg-nested)]">
              {/* Calendar header with month/year + prev/next */}
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
                  {RU_MONTH_NAMES_FULL[view.month - 1]} {view.year}
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
                {cells.map(({ iso, inMonth }) => {
                  const isFuture = iso > today;
                  const isFrom = fromDate === iso;
                  const isTo = toDate === iso;
                  const isInRange =
                    !!fromDate && !!toDate && iso > fromDate && iso < toDate;
                  const isEndpoint = isFrom || isTo;
                  const dayNum = Number(iso.slice(-2));

                  const base =
                    "w-full aspect-square rounded-md text-xs flex items-center justify-center transition-colors";
                  let cls = base;
                  if (isFuture) {
                    cls += " text-[color:var(--text-weak)] opacity-40 cursor-not-allowed";
                  } else if (isEndpoint) {
                    cls +=
                      " bg-[color:var(--accent)] text-white font-medium shadow-sm";
                  } else if (isInRange) {
                    cls +=
                      " bg-[color:var(--accent-pale-bg)] text-[color:var(--accent-pale-text-strong)]";
                  } else if (inMonth) {
                    cls +=
                      " text-[color:var(--text-primary)] hover:bg-[color:var(--bg-card)]";
                  } else {
                    cls +=
                      " text-[color:var(--text-weak)] hover:bg-[color:var(--bg-card)]";
                  }

                  return (
                    <button
                      key={iso}
                      type="button"
                      disabled={isFuture}
                      onClick={() => pickDay(iso)}
                      className={cls}
                      aria-label={iso}
                    >
                      {dayNum}
                    </button>
                  );
                })}
              </div>

              {/* Selected range summary */}
              <div className="text-[11px] text-[color:var(--text-muted)] text-center pt-1">
                {fromDate && !toDate && `С ${formatDateRu(fromDate)} — выберите конец`}
                {fromDate && toDate && `${formatDateRu(fromDate)} — ${formatDateRu(toDate)}`}
                {!fromDate && "Выберите начало периода"}
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setFromDate("");
                    setToDate("");
                  }}
                  className="text-xs px-2 py-1 rounded-md text-[color:var(--text-muted)] hover:bg-[color:var(--bg-card)]"
                >
                  Очистить
                </button>
                <button
                  type="button"
                  onClick={applyRange}
                  disabled={!canApplyRange}
                  className={
                    "text-xs px-3 py-1 rounded-md font-medium transition-colors " +
                    (canApplyRange
                      ? "bg-[color:var(--accent)] text-white hover:bg-[color:var(--accent-hover)]"
                      : "bg-[color:var(--bg-muted-block)] text-[color:var(--text-weak)] cursor-not-allowed")
                  }
                >
                  Применить
                </button>
              </div>
            </div>
          )}
          <div className="my-1 border-t border-[color:var(--border-row)]" />
          {months.map(({ year, month }) => {
            const selected =
              value.kind === "specific" &&
              value.year === year &&
              value.month === month;
            return (
              <button
                key={`${year}-${month}`}
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange({ kind: "specific", year, month });
                  setOpen(false);
                }}
                className={
                  "w-full text-left px-3 py-1.5 text-sm transition-colors hover:bg-[color:var(--bg-nested)] " +
                  (selected
                    ? "text-[color:var(--accent)] font-medium"
                    : "text-[color:var(--text-primary)]")
                }
              >
                {monthLabel(year, month)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
