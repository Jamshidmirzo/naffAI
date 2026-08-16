import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export type SelectOption<V extends string | number = string> = {
  value: V;
  label: string;
  disabled?: boolean;
};

type Props<V extends string | number> = {
  value: V;
  onChange: (next: V) => void;
  options: SelectOption<V>[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  /** Show a search box when options.length >= this. Default: no search. */
  searchable?: boolean;
  /** Optional min width for the popover. */
  popoverClassName?: string;
  /** Fixed width for the trigger button. */
  triggerClassName?: string;
};

/**
 * Design-system single <select> replacement. Renders a token-styled
 * button trigger + popover with an option list — no native <select>
 * so the OS blue picker never leaks through and the UI matches the
 * rest of the naffAI popovers. Preserves the value/onChange contract
 * so it can slot in wherever a bare <select> used to sit.
 */
export function Select<V extends string | number = string>({
  value,
  onChange,
  options,
  placeholder = "Выбрать…",
  disabled,
  className,
  ariaLabel,
  searchable = false,
  popoverClassName,
  triggerClassName,
}: Props<V>) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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
    if (searchable) {
      setTimeout(() => searchRef.current?.focus(), 0);
    }
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, searchable]);

  const current = useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value],
  );

  const filtered = useMemo(() => {
    if (!searchable || !q.trim()) return options;
    const needle = q.trim().toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(needle));
  }, [options, q, searchable]);

  const pick = (opt: SelectOption<V>) => {
    if (opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
    setQ("");
  };

  return (
    <div className={`relative ${className ?? ""}`} ref={ref}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`nf-input flex items-center justify-between w-full text-left disabled:opacity-50 disabled:cursor-not-allowed ${triggerClassName ?? ""}`}
      >
        <span
          className={
            current ? "truncate" : "truncate text-[color:var(--text-weak)]"
          }
        >
          {current ? current.label : placeholder}
        </span>
        <ChevronDown className="w-4 h-4 opacity-60 ml-2 flex-shrink-0" />
      </button>

      {open && (
        <div
          role="listbox"
          className={`absolute z-30 mt-1 left-0 right-0 min-w-full max-h-72 overflow-auto rounded-xl border border-[color:var(--border-main)] bg-[color:var(--bg-card)] text-[color:var(--text-primary)] shadow-modal p-2 ${popoverClassName ?? ""}`}
        >
          {searchable && (
            <input
              ref={searchRef}
              className="nf-input mb-2 text-sm"
              placeholder="Поиск…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          )}
          {filtered.length === 0 && (
            <div className="px-2 py-3 text-xs text-[color:var(--text-muted)]">
              Нет вариантов
            </div>
          )}
          <ul className="space-y-0.5">
            {filtered.map((o) => {
              const selected = o.value === value;
              return (
                <li key={String(o.value)}>
                  <button
                    type="button"
                    onClick={() => pick(o)}
                    disabled={o.disabled}
                    role="option"
                    aria-selected={selected}
                    className={`w-full text-left flex items-center justify-between gap-2 px-2 py-1.5 rounded text-sm transition-colors
                      ${
                        selected
                          ? "bg-[color:var(--accent-pale-bg)] text-[color:var(--accent-pale-text-strong)] font-medium"
                          : "text-[color:var(--text-primary)] hover:bg-[color:var(--bg-nested)]"
                      }
                      ${o.disabled ? "opacity-40 cursor-not-allowed" : ""}
                    `}
                  >
                    <span className="truncate">{o.label}</span>
                    {selected && (
                      <Check className="w-3.5 h-3.5 flex-shrink-0 text-[color:var(--accent)]" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
