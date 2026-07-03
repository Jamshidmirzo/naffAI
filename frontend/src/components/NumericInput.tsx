import { useRef } from "react";

interface Props {
  value: string;
  onChange: (raw: string) => void;
  className?: string;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  min?: number;
}

// Formats raw digit string to "50 000 000" style while typing.
// Stores raw digits in state; cursor position is preserved via ref trick.
export default function NumericInput({ value, onChange, className, placeholder, autoFocus, disabled, min }: Props) {
  const ref = useRef<HTMLInputElement>(null);

  const formatted = value
    ? Number(value).toLocaleString("ru-RU").replace(/,/g, " ")
    : "";

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const el = e.target;
    const raw = el.value.replace(/[\s ]/g, "").replace(/[^\d]/g, "");

    // Track how many digits were before the cursor so we can restore position
    const beforeCursor = el.value.slice(0, el.selectionStart ?? 0);
    const digitsBeforeCursor = beforeCursor.replace(/[^\d]/g, "").length;

    onChange(raw);

    // Restore cursor after React re-renders the formatted value
    requestAnimationFrame(() => {
      if (!ref.current) return;
      const newVal = ref.current.value;
      let count = 0;
      let pos = 0;
      for (let i = 0; i < newVal.length; i++) {
        if (/\d/.test(newVal[i])) count++;
        if (count === digitsBeforeCursor) { pos = i + 1; break; }
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
    />
  );
}
