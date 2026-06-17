import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";

type Option = { id: number; name: string };

type Props = {
  label: string;
  options: Option[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  /** Show an inline search box when there are more than this many options. */
  searchThreshold?: number;
  className?: string;
};

/**
 * Compact multi-select with a popover. Trigger button shows either
 * "{label}: все" or "{label}: N выбрано". Click outside or press Esc
 * closes. Selection commits immediately as the user toggles checkboxes
 * — there is no "Apply" button, since the parent uses the value to
 * update the URL and the React Query key in real time.
 */
export function MultiSelectPopover({
  label,
  options,
  selectedIds,
  onChange,
  searchThreshold = 8,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

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
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    if (!q.trim()) return options;
    const needle = q.trim().toLowerCase();
    return options.filter((o) => o.name.toLowerCase().includes(needle));
  }, [options, q]);

  const triggerText =
    selectedIds.length === 0
      ? `${label}: все`
      : `${label}: ${selectedIds.length} выбрано`;

  const toggle = (id: number) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  return (
    <div className={`relative inline-block ${className ?? ""}`} ref={ref}>
      <button
        type="button"
        className="btn-ghost"
        onClick={() => setOpen((v) => !v)}
      >
        {triggerText}
        <ChevronDown className="w-4 h-4 opacity-60" />
      </button>
      {selectedIds.length > 0 && (
        <button
          type="button"
          aria-label="Очистить"
          className="absolute -top-1 -right-1 bg-gray-200 dark:bg-slate-700 rounded-full w-4 h-4 flex items-center justify-center"
          onClick={(e) => {
            e.stopPropagation();
            onChange([]);
          }}
        >
          <X className="w-3 h-3" />
        </button>
      )}

      {open && (
        <div className="absolute z-30 mt-1 left-0 min-w-[14rem] max-h-72 overflow-auto rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg p-2">
          {options.length >= searchThreshold && (
            <input
              autoFocus
              className="input mb-2 text-sm"
              placeholder="Поиск…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          )}
          {filtered.length === 0 && (
            <div className="px-2 py-3 text-xs text-gray-500 dark:text-slate-400">
              Нет вариантов
            </div>
          )}
          <ul className="space-y-1">
            {filtered.map((o) => {
              const checked = selectedIds.includes(o.id);
              return (
                <li key={o.id}>
                  <label className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-slate-800 cursor-pointer text-sm">
                    <span
                      className={`w-4 h-4 rounded border flex items-center justify-center ${
                        checked
                          ? "bg-indigo-600 border-indigo-600 text-white"
                          : "border-gray-300 dark:border-slate-600"
                      }`}
                    >
                      {checked && <Check className="w-3 h-3" />}
                    </span>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      onChange={() => toggle(o.id)}
                    />
                    <span>{o.name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
