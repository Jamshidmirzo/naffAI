import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";

export type ComboboxOption = {
  id: number;
  label: string;
  isActive?: boolean;
};

type Props = {
  options: ComboboxOption[];
  /** Selected id (number) or free-text string or null when nothing chosen. */
  value: number | string | null;
  /** Fires with the option id (number) when a known option is chosen, or
   *  a string when the user commits free text. */
  onChange: (next: number | string) => void;
  placeholder?: string;
  /** When true, allows committing a search query that does not match any option. */
  allowFreeText?: boolean;
  /** Show inline search when options.length >= this. */
  searchThreshold?: number;
  className?: string;
};

/**
 * Compact single-select combobox with:
 *  - a button-styled trigger showing the current label,
 *  - a popover with an always-visible search input,
 *  - scrollable, hoverable option list,
 *  - inactive options shown grey with a "неактивен" badge,
 *  - optional "+ Добавить «{query}»" row when allowFreeText is on and the
 *    typed text does not match any existing option.
 */
export function SingleSelectCombobox({
  options,
  value,
  onChange,
  placeholder = "Выбрать…",
  allowFreeText = false,
  searchThreshold = 0,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    // Focus the search input after the popover renders.
    setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const matchedById = useMemo(
    () => (typeof value === "number" ? options.find((o) => o.id === value) ?? null : null),
    [options, value],
  );
  const currentLabel = matchedById
    ? matchedById.label
    : typeof value === "string" && value.trim()
      ? value.trim()
      : "";

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) => o.label.toLowerCase().includes(needle));
  }, [options, q]);

  const exact = useMemo(
    () => options.find((o) => o.label.toLowerCase() === q.trim().toLowerCase()),
    [options, q],
  );
  const showAddFreeText = allowFreeText && q.trim().length > 0 && !exact;

  const pickOption = (o: ComboboxOption) => {
    onChange(o.id);
    setOpen(false);
    setQ("");
  };
  const commitFreeText = () => {
    if (!q.trim()) return;
    onChange(q.trim());
    setOpen(false);
    setQ("");
  };

  return (
    <div className={`relative ${className ?? ""}`} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="input flex items-center justify-between w-full text-left"
      >
        <span className={currentLabel ? "" : "text-gray-400 dark:text-slate-500"}>
          {currentLabel || placeholder}
        </span>
        <ChevronDown className="w-4 h-4 opacity-60 ml-2 flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 left-0 right-0 min-w-full max-h-72 overflow-auto rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg p-2">
          {options.length >= searchThreshold && (
            <input
              ref={inputRef}
              className="input mb-2 text-sm"
              placeholder="Поиск…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (filtered.length > 0) {
                    pickOption(filtered[0]);
                  } else if (allowFreeText) {
                    commitFreeText();
                  }
                }
              }}
            />
          )}
          {filtered.length === 0 && !showAddFreeText && (
            <div className="px-2 py-3 text-xs text-gray-500 dark:text-slate-400">
              Нет вариантов
            </div>
          )}
          <ul className="space-y-0.5">
            {filtered.map((o) => {
              const isInactive = o.isActive === false;
              const selected =
                typeof value === "number" && value === o.id;
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => pickOption(o)}
                    className={`w-full text-left flex items-center justify-between gap-2 px-2 py-1.5 rounded text-sm
                      ${selected ? "bg-indigo-50 dark:bg-indigo-500/20" : "hover:bg-gray-100 dark:hover:bg-slate-800"}
                      ${isInactive ? "text-gray-400 dark:text-slate-500" : ""}
                    `}
                  >
                    <span className="truncate">{o.label}</span>
                    {isInactive && (
                      <span className="badge bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-slate-400 text-[10px]">
                        неактивен
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
            {showAddFreeText && (
              <li>
                <button
                  type="button"
                  onClick={commitFreeText}
                  className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-emerald-50 dark:hover:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                >
                  <Plus className="w-3 h-3" />
                  <span>
                    Добавить «<span className="font-medium">{q.trim()}</span>»
                  </span>
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
