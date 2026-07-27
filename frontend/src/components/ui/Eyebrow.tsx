import { type ReactNode } from "react";
import { cn } from "./cn";

export function Eyebrow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("nf-eyebrow", className)}>{children}</div>;
}
