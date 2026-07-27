import { cn } from "./cn";

interface Props {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

export function Toggle({ on, onChange, disabled, className, ...rest }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={rest["aria-label"]}
      disabled={disabled}
      data-on={on}
      onClick={() => onChange(!on)}
      className={cn("nf-toggle", disabled && "opacity-50 cursor-not-allowed", className)}
    />
  );
}
