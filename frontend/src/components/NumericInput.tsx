import { useRef } from "react";
import { formatNumber } from "../lib/format";

interface Props {
  value: string;
  onChange: (raw: string) => void;
  className?: string;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  min?: number;
  /**
   * Maximum number of raw digits accepted. Excess digits are silently
   * dropped in the change handler so operators can't paste-in a giant
   * number or hold-down-key past the cap. Defaults to 12 (up to ~1 trln
   * UZS) — callers that want stricter caps (e.g. per-sale amount at
   * 10 digits ~= 10 bln) pass a smaller value.
   */
  maxDigits?: number;
}

// Formats raw digit string to "50 000 000" style while typing.
// Stores raw digits in state; cursor position is preserved via ref trick.
export default function NumericInput({
  value,
  onChange,
  className,
  placeholder,
  autoFocus,
  disabled,
  min,
  maxDigits = 12,
}: Props) {
  const ref = useRef<HTMLInputElement>(null);

  const formatted = value ? formatNumber(Number(value)) : "";

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const el = e.target;
    // Strip everything except ASCII digits — letters, `e`, `+`, `-`,
    // punctuation, unicode spaces all evaporate here so the operator
    // literally cannot type non-digits into the field.
    let raw = el.value.replace(/[\s ]/g, "").replace(/[^\d]/g, "");
    // Hard cap the digit count. Silently truncating the tail is gentler
    // than rejecting the whole keystroke — the operator sees the value
    // stop growing, matching native browser `maxLength` UX.
    if (raw.length > maxDigits) raw = raw.slice(0, maxDigits);

    // Track how many digits were before the cursor so we can restore
    // position after re-formatting. Clamp to the accepted digit count so
    // the caret can't jump past the truncated tail after we cut excess.
    const beforeCursor = el.value.slice(0, el.selectionStart ?? 0);
    let digitsBeforeCursor = beforeCursor.replace(/[^\d]/g, "").length;
    if (digitsBeforeCursor > raw.length) digitsBeforeCursor = raw.length;

    onChange(raw);

    // Restore cursor after React re-renders the formatted value
    requestAnimationFrame(() => {
      if (!ref.current) return;
      const newVal = ref.current.value;
      let count = 0;
      let pos = 0;
      for (let i = 0; i < newVal.length; i++) {
        if (/\d/.test(newVal[i])) count++;
        if (count === digitsBeforeCursor) {
          pos = i + 1;
          break;
        }
      }
      if (digitsBeforeCursor === 0) pos = 0;
      ref.current.setSelectionRange(pos, pos);
    });
  }

  return (
    <input
      ref={ref}
      className={className}
      inputMode="numeric"
      placeholder={placeholder}
      value={formatted}
      autoFocus={autoFocus}
      disabled={disabled}
      min={min}
      onChange={handleChange}
      onKeyDown={(e) => {
        // Block letter keys before they even fire onChange — some IMEs
        // and mobile keyboards fire beforeinput without triggering the
        // native input filter, so this belt-and-braces guard makes the
        // "no letters" rule impossible to circumvent by fast typing.
        if (
          e.key.length === 1 &&
          !/[0-9]/.test(e.key) &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey
        ) {
          e.preventDefault();
        }
      }}
    />
  );
}
