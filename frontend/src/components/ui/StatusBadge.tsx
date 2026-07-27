import { type ReactNode } from "react";
import { cn } from "./cn";

type Tone = "neutral" | "hot" | "danger";

interface Props {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}

const toneCls: Record<Tone, string> = {
  neutral: "",
  hot: "nf-badge--hot",
  danger: "nf-badge--danger",
};

export function StatusBadge({ children, tone = "neutral", className }: Props) {
  return <span className={cn("nf-badge", toneCls[tone], className)}>{children}</span>;
}
