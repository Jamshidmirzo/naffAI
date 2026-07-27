import { forwardRef, useMemo } from "react";
import { cn } from "./cn";

/**
 * Uzbek phone input.
 * — Always shows `+998` as a locked prefix on the left.
 * — Accepts digits only; strips everything else on paste.
 * — Visual mask: `+998 90 123 45 67`.
 * — Emits the canonical form `+998XXXXXXXXX` (13 chars) to `onChange`
 *   so the backend sees the same shape it expects for auth/TG/etc.
 * — `invalid` — soft red border when we know the value is bad
 *   (e.g. wrong length after blur).
 */

interface Props {
  value: string;
  onChange: (canonical: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  name?: string;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  autoComplete?: string;
  "aria-label"?: string;
}

const DIGITS_RE = /\D+/g;

function toDigits9(raw: string): string {
  const digits = raw.replace(DIGITS_RE, "");
  // If the user typed leading 998 — keep only the trailing 9 digits.
  const trimmed = digits.startsWith("998") ? digits.slice(3) : digits;
  return trimmed.slice(0, 9);
}

function formatVisible(digits9: string): string {
  // 90 123 45 67  →  chunks 2 3 2 2
  const p1 = digits9.slice(0, 2);
  const p2 = digits9.slice(2, 5);
  const p3 = digits9.slice(5, 7);
  const p4 = digits9.slice(7, 9);
  return [p1, p2, p3, p4].filter(Boolean).join(" ");
}

export function normalizeUzPhone(canonicalOrRaw: string): {
  canonical: string;
  valid: boolean;
} {
  const d = toDigits9(canonicalOrRaw);
  return {
    canonical: d ? `+998${d}` : "",
    valid: d.length === 9,
  };
}

export const PhoneInput = forwardRef<HTMLInputElement, Props>(function PhoneInput(
  {
    value,
    onChange,
    invalid,
    disabled,
    placeholder = "90 123 45 67",
    autoFocus,
    className,
    name,
    onBlur,
    autoComplete = "tel",
    ...rest
  },
  ref,
) {
  const digits9 = useMemo(() => toDigits9(value), [value]);
  const visible = formatVisible(digits9);

  const onInput: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const nextDigits = toDigits9(e.target.value);
    onChange(nextDigits ? `+998${nextDigits}` : "");
  };

  return (
    <div
      className={cn(
        "flex items-stretch rounded-input overflow-hidden transition",
        className,
      )}
      style={{
        background: "var(--surface2)",
        border: `1px solid ${
          invalid ? "rgba(220,60,40,.6)" : "var(--border)"
        }`,
        borderRadius: 14,
      }}
    >
      <div
        className="grid place-items-center font-mono text-[14px] font-semibold select-none px-3.5"
        style={{
          background: "var(--faint)",
          color: "var(--muted)",
          borderRight: "1px solid var(--border)",
          minWidth: 66,
        }}
      >
        +998
      </div>
      <input
        ref={ref}
        type="tel"
        inputMode="numeric"
        value={visible}
        onChange={onInput}
        onBlur={onBlur}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        name={name}
        autoComplete={autoComplete}
        className="flex-1 font-mono text-[14px] tabular-nums bg-transparent outline-none"
        style={{
          padding: "12px 16px",
          color: "var(--text)",
          letterSpacing: "0.02em",
        }}
        aria-label={rest["aria-label"]}
      />
    </div>
  );
});
