import { forwardRef, useMemo } from "react";
import { cn } from "./cn";

/**
 * Uzbek phone input — single-input variant.
 *
 * — Renders as a normal `<input>` with `+998 ` baked into the visible
 *   value as a locked prefix (not a separate DOM element). The operator
 *   sees exactly what will be sent, and paste/copy pulls the full
 *   canonical string.
 * — Backspacing past the prefix snaps back — you cannot erase `+998 `.
 * — Accepts digits only in the tail; strips letters, punctuation,
 *   country codes on paste.
 * — Hard cap: 9 local digits after `+998 ` (Uz phone length). Anything
 *   longer is silently truncated at the source (`toDigits9`), so
 *   pasting `2345678987654325...` never lets the field grow.
 * — Emits the canonical form `+998XXXXXXXXX` (13 chars) to `onChange`,
 *   or `""` when nothing but the prefix is left.
 * — `invalid` — soft red border for a known-bad value (wrong length
 *   after blur, etc.).
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

const PREFIX = "+998 ";
const LOCAL_MAX = 9;
const DIGITS_RE = /\D+/g;

function toDigits9(raw: string): string {
  const digits = raw.replace(DIGITS_RE, "");
  const trimmed = digits.startsWith("998") ? digits.slice(3) : digits;
  return trimmed.slice(0, LOCAL_MAX);
}

function formatVisible(digits9: string): string {
  const p1 = digits9.slice(0, 2);
  const p2 = digits9.slice(2, 5);
  const p3 = digits9.slice(5, 7);
  const p4 = digits9.slice(7, 9);
  const tail = [p1, p2, p3, p4].filter(Boolean).join(" ");
  return PREFIX + tail;
}

export function normalizeUzPhone(canonicalOrRaw: string): {
  canonical: string;
  valid: boolean;
} {
  const d = toDigits9(canonicalOrRaw);
  return {
    canonical: d ? `+998${d}` : "",
    valid: d.length === LOCAL_MAX,
  };
}

export const PhoneInput = forwardRef<HTMLInputElement, Props>(function PhoneInput(
  {
    value,
    onChange,
    invalid,
    disabled,
    placeholder = "+998 90 123 45 67",
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
  const visible = digits9 ? formatVisible(digits9) : PREFIX;

  const emit = (nextDigits: string) => {
    onChange(nextDigits ? `+998${nextDigits}` : "");
  };

  const onInput: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const raw = e.target.value;
    // Anything before the "+998 " boundary was tampered with (user
    // backspaced past it, or blanked the field, or pasted junk that
    // stripped the prefix) — treat the whole thing as digits and
    // re-derive the tail. `toDigits9` also handles pastes that included
    // "998" upfront by trimming it once.
    if (!raw.startsWith(PREFIX)) {
      emit(toDigits9(raw));
      return;
    }
    emit(toDigits9(raw.slice(PREFIX.length)));
  };

  const onKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    const el = e.currentTarget;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    // Prevent Backspace/Delete from chewing into the "+998 " prefix.
    if (
      (e.key === "Backspace" && start === end && start <= PREFIX.length) ||
      (e.key === "Delete" && start === end && start < PREFIX.length)
    ) {
      e.preventDefault();
      el.setSelectionRange(PREFIX.length, PREFIX.length);
    }
  };

  const onFocus: React.FocusEventHandler<HTMLInputElement> = (e) => {
    // If the field is at its resting "+998 " state, park the caret
    // right after the prefix so the operator starts typing digits
    // without having to click past the mask.
    const el = e.currentTarget;
    if (el.value === PREFIX) {
      requestAnimationFrame(() => el.setSelectionRange(PREFIX.length, PREFIX.length));
    }
  };

  return (
    <input
      ref={ref}
      type="tel"
      inputMode="numeric"
      value={visible}
      onChange={onInput}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      disabled={disabled}
      autoFocus={autoFocus}
      placeholder={placeholder}
      name={name}
      autoComplete={autoComplete}
      className={cn(
        "nf-input font-mono text-[14px] tabular-nums",
        invalid && "border-red-500",
        className,
      )}
      aria-label={rest["aria-label"]}
    />
  );
});
