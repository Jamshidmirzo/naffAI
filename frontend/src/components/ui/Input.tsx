import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "./cn";

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  hint?: string;
  label?: string;
}

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { invalid, hint, label, className, id, ...rest },
  ref,
) {
  const inputId = id ?? rest.name;
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="nf-col">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        className={cn("nf-input", invalid && "is-invalid", className)}
        {...rest}
      />
      {hint && (
        <span
          className={cn(
            "text-[12px] leading-tight",
            invalid ? "text-[color:var(--danger)]" : "text-muted",
          )}
        >
          {hint}
        </span>
      )}
    </div>
  );
});
