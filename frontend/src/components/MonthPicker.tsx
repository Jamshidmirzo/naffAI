import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  formatDateRu,
  monthLabel,
  recentMonths,
  type MonthChoice,
} from "../lib/period";

// A compact dropdown to pick between "Этот месяц" (label — falls back to
// the day/week/month tab strip), "За весь период", a fixed calendar month
// (Июнь 2026, Май 2026, …), or an arbitrary date range picked via two
// native <input type="date"> calendars. Used on Dashboard and OperatorDetail.
//
// Native <input type="date"> is used on purpose — no extra dependency, the
// OS-provided calendar is already localized, and it plays well with both
// desktop and mobile.

type Props = {
  value: MonthChoice;
  onChange: (v: MonthChoice) => void;
  monthsBack?: number;
};

const todayIso = (): string => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export default function MonthPicker({ value, onChange, monthsBack = 6 }: Props) {
  const [open, setOpen] = useState(false);
  // "range mode" reveals two date inputs inside the dropdown. Auto-enabled
  // when the current choice IS already a range, so re-opening the picker
  // takes the user straight back to the calendar they just used.
  const [rangeMode, setRangeMode] = useState(value.kind === "range");
  const ref = useRef<HTMLDivElement | null>(null);
  const months = recentMonths(monthsBack + 1); // includes current month

  const initialFrom = value.kind === "range" ? value.from : "";
  const initialTo = value.kind === "range" ? value.to : "";
  const [fromDate, setFromDate] = useState(initialFrom);
  const [toDate, setToDate] = useState(initialTo);

  // Keep the local inputs in sync if the parent swaps the choice from
  // outside (e.g. resetting to "current").
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
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const isAll = value.kind === "all";
  const isCurrent = value.kind === "current";
  const isRange = value.kind === "range";

  const applyRange = () => {
    if (!fromDate || !toDate) return;
    // Auto-swap if the user picked "from" > "to" — cheaper than showing an
    // error and lets them chain selections without extra clicks.
    const [from, to] = fromDate <= toDate ? [fromDate, toDate] : [toDate, fromDate];
    onChange({ kind: "range", from, to });
    setOpen(false);
  };

  const canApplyRange = !!fromDate && !!toDate;
  const today = todayIso();

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
          className="absolute right-0 z-20 mt-1 w-72 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg py-1 max-h-96 overflow-auto"
        >
          <button
            role="option"
            aria-selected={isAll}
            onClick={() => {
              onChange({ kind: "all" });
              setOpen(false);
            }}
            className={
              "w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-slate-800 " +
              (isAll
                ? "text-blue-600 dark:text-blue-400 font-medium"
                : "text-gray-700 dark:text-slate-200")
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
              "w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-slate-800 " +
              (isCurrent
                ? "text-blue-600 dark:text-blue-400 font-medium"
                : "text-gray-700 dark:text-slate-200")
            }
          >
            Текущий период (день/неделя/месяц)
          </button>
          <div className="my-1 border-t border-gray-100 dark:border-slate-800" />
          <button
            role="option"
            aria-selected={isRange || rangeMode}
            onClick={() => setRangeMode((v) => !v)}
            className={
              "w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-slate-800 " +
              (isRange
                ? "text-blue-600 dark:text-blue-400 font-medium"
                : "text-gray-700 dark:text-slate-200")
            }
          >
            {rangeMode ? "▼ Произвольный период" : "▶ Произвольный период..."}
          </button>
          {rangeMode && (
            <div className="px-3 py-2 space-y-2 bg-gray-50 dark:bg-slate-800/40">
              <div className="flex flex-col gap-1">
                <label className="text-[11px] uppercase text-gray-500 dark:text-slate-400">
                  С
                </label>
                <input
                  type="date"
                  value={fromDate}
                  max={toDate || today}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="w-full text-sm rounded-md border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-gray-700 dark:text-slate-200"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[11px] uppercase text-gray-500 dark:text-slate-400">
                  По
                </label>
                <input
                  type="date"
                  value={toDate}
                  min={fromDate || undefined}
                  max={today}
                  onChange={(e) => setToDate(e.target.value)}
                  className="w-full text-sm rounded-md border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-gray-700 dark:text-slate-200"
                />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setFromDate("");
                    setToDate("");
                  }}
                  className="text-xs px-2 py-1 rounded-md text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800"
                >
                  Очистить
                </button>
                <button
                  type="button"
                  onClick={applyRange}
                  disabled={!canApplyRange}
                  className={
                    "text-xs px-3 py-1 rounded-md font-medium " +
                    (canApplyRange
                      ? "bg-blue-600 text-white hover:bg-blue-700"
                      : "bg-gray-200 dark:bg-slate-700 text-gray-400 dark:text-slate-500 cursor-not-allowed")
                  }
                >
                  Применить
                </button>
              </div>
            </div>
          )}
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
