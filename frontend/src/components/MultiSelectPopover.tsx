import { useMemo, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { Popover } from "./ui/Popover";

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
 * Compact multi-select with a Portal-based popover. Trigger button
 * shows either "{label}: все" or "{label}: N выбрано". Click outside
 * or press Esc closes. Selection commits immediately as the user
 * toggles checkboxes — there is no "Apply" button, since the parent
 * uses the value to update the URL and the React Query key in real
 * time.
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
  const triggerRef = useRef<HTMLButtonElement>(null);

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
    <div className={`relative inline-block ${className ?? ""}`}>
      <button
        ref={triggerRef}
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
          className="absolute -top-1 -right-1 rounded-full w-4 h-4 flex items-center justify-center bg-[color:var(--bg-nested)] text-[color:var(--text-primary)] border border-[color:var(--border-main)]"
          onClick={(e) => {
            e.stopPropagation();
            onChange([]);
          }}
        >
          <X className="w-3 h-3" />
        </button>
      )}

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        align="start"
        minWidth={224}
        role="listbox"
        contentClassName="max-h-72 overflow-auto p-2"
      >
        {options.length >= searchThreshold && (
          <input
            autoFocus
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
        <ul className="space-y-1">
          {filtered.map((o) => {
            const checked = selectedIds.includes(o.id);
            return (
              <li key={o.id}>
                <label className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer text-sm text-[color:var(--text-primary)] hover:bg-[color:var(--bg-nested)]">
                  <span
                    className={`w-4 h-4 rounded border flex items-center justify-center ${
                      checked
                        ? "bg-[color:var(--accent)] border-[color:var(--accent)] text-white"
                        : "border-[color:var(--border-btn)] bg-[color:var(--bg-card)]"
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
      </Popover>
    </div>
  );
}
