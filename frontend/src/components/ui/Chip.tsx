import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export const Chip = forwardRef<HTMLButtonElement, Props>(function Chip(
  { active, className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn("nf-chip", active && "nf-chip--active", className)}
      {...rest}
    />
  );
});
