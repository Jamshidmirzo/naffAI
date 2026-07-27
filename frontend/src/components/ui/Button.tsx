import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "md" | "sm" | "lg";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
}

const sizeCls: Record<Size, string> = {
  sm: "px-3.5 py-2 text-[13px]",
  md: "",
  lg: "px-6 py-3.5 text-[15px]",
};

const variantCls: Record<Variant, string> = {
  primary: "nf-btn nf-btn--primary",
  secondary: "nf-btn nf-btn--secondary",
  ghost: "nf-btn nf-btn--ghost",
  danger: "nf-btn nf-btn--danger",
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "primary", size = "md", block, className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(variantCls[variant], sizeCls[size], block && "w-full", className)}
      {...rest}
    />
  );
});
