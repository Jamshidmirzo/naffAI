import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  monthLabel,
  recentMonths,
  type MonthChoice,
} from "../lib/period";

// A compact dropdown to pick between "Этот месяц" (label — falls back to
// the day/week/month tab strip) and a fixed calendar month
// (Июнь 2026, Май 2026, …). Used on Dashboard and OperatorDetail.

type Props = {
  value: MonthChoice;
  onChange: (v: MonthChoice) => void;
  monthsBack?: number;
};

export default function MonthPicker({ value, onChange, monthsBack = 6 }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const months = recentMonths(monthsBack + 1); // includes current month

  const label =
    value.kind === "current"
      ? "Текущий период"
      : monthLabel(value.year, value.month);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const isCurrent = value.kind === "current";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-800"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{label}</span>
        <ChevronDown className="w-4 h-4 opacity-60" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg py-1 max-h-80 overflow-auto"
        >
          <button
            role="option"
            aria-selected={isCurrent}
            onClick={() => {
              onChange({ kind: "current" });
              setOpen(false);
            }}
            className={
              "w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-slate-800 " +
              (isCurrent
                ? "text-blue-600 dark:text-blue-400 font-medium"
                : "text-gray-700 dark:text-slate-200")
            }
          >
            Текущий период (день/неделя/месяц)
          </button>
          <div className="my-1 border-t border-gray-100 dark:border-slate-800" />
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
                  "w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-slate-800 " +
                  (selected
                    ? "text-blue-600 dark:text-blue-400 font-medium"
                    : "text-gray-700 dark:text-slate-200")
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
