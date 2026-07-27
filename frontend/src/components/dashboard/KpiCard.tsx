import { type ReactNode } from "react";
import { cn } from "../ui/cn";
import { useCountUp } from "../../lib/countUp";

interface Props {
  label: string;
  value: number;
  format?: (n: number) => string;
  delta?: ReactNode;
  hint?: string;
  onClick?: () => void;
  index?: number;
}

export function DashKpiCard({
  label,
  value,
  format = (n) => Math.round(n).toLocaleString("ru-RU"),
  delta,
  hint,
  onClick,
  index = 0,
}: Props) {
  const animated = useCountUp(value, 1000);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "nf-card text-left animate-nfFadeUp",
        "transition-all duration-300 ease-nf",
        onClick && "hover:-translate-y-[3px] hover:border-[color:var(--accent)]",
      )}
      style={{
        padding: "20px 22px 22px",
        animationDelay: `${0.05 + index * 0.07}s`,
      }}
    >
      <div className="text-[12.5px] text-muted mb-2">{label}</div>
      <div
        className="font-semibold tabular-nums"
        style={{ fontSize: 31, letterSpacing: "-0.035em", lineHeight: 1.05 }}
      >
        {format(animated)}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[12.5px]">
        {delta && (
          <span className="font-semibold" style={{ color: "var(--accent)" }}>
            {delta}
          </span>
        )}
        {hint && <span className="text-muted">{hint}</span>}
      </div>
    </button>
  );
}
