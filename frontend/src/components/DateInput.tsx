import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar, ChevronDown, X } from "lucide-react";
import { formatDateRu } from "../lib/period";
import MiniCalendar, {
  RU_MONTH_NAMES_FULL,
  parseIso,
  todayIso,
  type Cell,
} from "./MiniCalendar";

// Universal single-day picker — a token-styled button that opens a
// compact popover with our own mini-calendar. Never uses the native
// <input type="date"> so the OS blue picker can't leak through.
//
// Value contract: `value` is an ISO "YYYY-MM-DD" string or "" for
// empty. `onChange` emits the same shape; when `allowClear` is on and
// the user clicks the ✕, `onChange("")` fires.

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** ISO min bound (inclusive) — days before are unselectable. */
  min?: string;
  /** ISO max bound (inclusive) — days after are unselectable. */
  max?: string;
  ariaLabel?: string;
  className?: string;
  /** Show a small ✕ button that resets to "". */
  allowClear?: boolean;
  /** Optional id for label htmlFor targeting. */
  id?: string;
};

// Year dropdown range centred on the currently shown year. We cap
// range at ~50 years back / 10 forward so the list stays scannable.
const YEAR_WINDOW_BACK = 50;
const YEAR_WINDOW_FWD = 10;

export default function DateInput({
  value,
  onChange,
  placeholder = "Выберите дату",
  disabled = false,
  min,
  max,
  ariaLabel,
  className = "",
  allowClear = false,
  id,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const today = todayIso();

  // Which month/year the calendar is currently rendering.
  const initialView = useMemo(() => {
    const src = parseIso(value) ?? parseIso(today)!;
    return { year: src.y, month: src.m };
  }, [value, today]);
  const [view, setView] = useState(initialView);

  // Sync the visible month when `value` changes externally (e.g. form reset).
  useEffect(() => {
    if (!open) {
      setView(initialView);
    }
  }, [initialView, open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
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

  const label = value ? formatDateRu(value) : "";

  const currentYear = view.year;
  const years = useMemo(() => {
    const nowY = new Date().getFullYear();
    // Ensure the currently-shown year is always in range.
    const base = Math.max(currentYear, nowY);
    const out: number[] = [];
    for (let y = base - YEAR_WINDOW_BACK; y <= base + YEAR_WINDOW_FWD; y++) {
      out.push(y);
    }
    return out;
  }, [currentYear]);

  const isDisabledCell = (cell: Cell): boolean => {
    if (min && cell.iso < min) return true;
    if (max && cell.iso > max) return true;
    return false;
  };

  const renderCellClass = (cell: Cell): string => {
    const base =
      "w-full aspect-square rounded-md text-xs flex items-center justify-center transition-colors";
    const disabledDay = isDisabledCell(cell);
    const isSelected = value === cell.iso;
    const isToday = today === cell.iso;

    if (disabledDay) {
      return `${base} text-[color:var(--text-weak)] opacity-40 cursor-not-allowed`;
    }
    if (isSelected) {
      return `${base} bg-[color:var(--accent)] text-white font-medium shadow-sm`;
    }
    if (isToday) {
      return `${base} bg-[color:var(--accent-pale-bg)] text-[color:var(--accent-pale-text-strong)] hover:bg-[color:var(--bg-card)]`;
    }
    if (cell.inMonth) {
      return `${base} text-[color:var(--text-primary)] hover:bg-[color:var(--bg-card)]`;
    }
    return `${base} text-[color:var(--text-weak)] hover:bg-[color:var(--bg-card)]`;
  };

  const pickDay = (iso: string) => {
    onChange(iso);
    setOpen(false);
  };

  const clear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange("");
  };

  const toggle = () => {
    if (disabled) return;
    setOpen((v) => !v);
  };

  const yearHeader = (
    <div className="flex items-center gap-1">
      <span>{RU_MONTH_NAMES_FULL[view.month - 1]}</span>
      <div className="relative">
        <select
          value={view.year}
          onChange={(e) =>
            setView((v) => ({ ...v, year: Number(e.target.value) }))
          }
          className="appearance-none bg-transparent text-sm font-medium text-[color:var(--text-primary)] pr-4 pl-1 py-0.5 rounded hover:bg-[color:var(--bg-card)] cursor-pointer focus:outline-none"
          aria-label="Год"
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 opacity-60 pointer-events-none" />
      </div>
    </div>
  );

  return (
    <div className={`relative ${className}`} ref={wrapRef}>
      <button
        type="button"
        id={id}
        onClick={toggle}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={
          "nf-input flex items-center justify-between text-left " +
          (disabled ? "opacity-50 cursor-not-allowed " : "cursor-pointer ") +
          (open ? "border-[color:var(--accent)] " : "")
        }
      >
        <span
          className={
            "flex items-center gap-2 " +
            (label ? "text-[color:var(--text)]" : "text-[color:var(--muted)]")
          }
        >
          <Calendar className="w-4 h-4 opacity-60" />
          {label || placeholder}
        </span>
        <span className="flex items-center gap-1">
          {allowClear && value && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              onClick={clear}
              className="p-0.5 rounded hover:bg-[color:var(--bg-card)] text-[color:var(--muted)]"
              aria-label="Очистить"
            >
              <X className="w-3.5 h-3.5" />
            </span>
          )}
          <ChevronDown className="w-4 h-4 opacity-60" />
        </span>
      </button>

      {open && (
        <>
          {/* Mobile centred popover backdrop — invisible layer that
              re-centres the calendar on small screens. */}
          <div className="hidden max-sm:block fixed inset-0 z-40 bg-black/20" />
          <div
            role="dialog"
            className={
              "z-50 rounded-xl border border-[color:var(--border-main)] bg-[color:var(--bg-card)] text-[color:var(--text-primary)] shadow-modal p-3 w-72 " +
              // On sm+ anchor under the trigger. On max-sm centre in viewport.
              "absolute left-0 mt-1 " +
              "max-sm:fixed max-sm:left-1/2 max-sm:top-1/2 max-sm:-translate-x-1/2 max-sm:-translate-y-1/2 max-sm:mt-0"
            }
          >
            <MiniCalendar
              year={view.year}
              month={view.month}
              onNavigate={(y, m) => setView({ year: y, month: m })}
              onPickDay={pickDay}
              renderCellClass={renderCellClass}
              isDisabled={isDisabledCell}
              headerCenter={yearHeader}
            />

            <div className="flex items-center justify-between pt-2 mt-2 border-t border-[color:var(--border-row)]">
              <button
                type="button"
                onClick={() => {
                  const t = parseIso(today)!;
                  setView({ year: t.y, month: t.m });
                  pickDay(today);
                }}
                className="text-xs px-2 py-1 rounded-md text-[color:var(--accent)] hover:bg-[color:var(--accent-pale-bg)] font-medium"
              >
                Сегодня
              </button>
              {allowClear && value && (
                <button
                  type="button"
                  onClick={() => {
                    onChange("");
                    setOpen(false);
                  }}
                  className="text-xs px-2 py-1 rounded-md text-[color:var(--text-muted)] hover:bg-[color:var(--bg-nested)]"
                >
                  Очистить
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
