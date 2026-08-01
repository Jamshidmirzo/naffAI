import { cn } from "./cn";

export interface TabItem<V extends string = string> {
  value: V;
  label: string;
  count?: number;
  /**
   * When true, render the count in danger-red and prefix a small 🔒
   * — used by /my to signal that N blocking-status leads are holding
   * the operator's RR intake.
   */
  danger?: boolean;
}

interface Props<V extends string> {
  items: TabItem<V>[];
  value: V;
  onChange: (v: V) => void;
  className?: string;
  block?: boolean;
}

export function TabPill<V extends string>({
  items,
  value,
  onChange,
  className,
  block,
}: Props<V>) {
  return (
    <div className={cn("nf-tabs", block && "w-full", className)}>
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            onClick={() => onChange(it.value)}
            className={cn(
              "nf-tab",
              active && "nf-tab--active",
              block && "flex-1",
            )}
          >
            {it.label}
            {typeof it.count === "number" && (
              <span
                className={cn(
                  "ml-1.5 text-[11px] tabular-nums font-semibold",
                  !it.danger && (active ? "text-muted" : "text-muted"),
                )}
                style={it.danger ? { color: "#dc2626" } : undefined}
              >
                {it.danger && "🔒 "}
                {it.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
