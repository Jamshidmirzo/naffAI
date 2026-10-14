import { useEffect, useRef, useState } from "react";
import { animate, useReducedMotion } from "framer-motion";
import { fmtNum } from "./format";

/**
 * A number that counts up to its value on first show and glides to the new
 * value when data refreshes. Formats like fmtNum; non-numeric values (null,
 * "", NaN) render exactly as fmtNum would. Respects reduced motion.
 */
export function CountUp({ value, duration = 0.8 }: { value: number | string | null | undefined; duration?: number }) {
  const target = value === null || value === undefined || value === "" ? NaN : Number(value);
  const valid = Number.isFinite(target);
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(valid && !reduce ? 0 : target);
  const from = useRef(0);

  useEffect(() => {
    if (!valid) return;
    if (reduce) {
      setShown(target);
      from.current = target;
      return;
    }
    const ctl = animate(from.current, target, {
      duration,
      ease: [0.2, 0.8, 0.2, 1],
      onUpdate: (v) => setShown(v),
    });
    from.current = target;
    return () => ctl.stop();
  }, [target, valid, reduce, duration]);

  if (!valid) return <>{fmtNum(value)}</>;
  const whole = Number.isInteger(target);
  return <>{fmtNum(whole ? Math.round(shown) : Math.round(shown * 10) / 10)}</>;
}

/** Same as CountUp for display strings: counts plain whole numbers ("12", "14 500 000"), leaves anything else ("3,4%", "1 / 24", "—") as is. */
export function CountText({ text }: { text: string | number | null | undefined }) {
  if (typeof text === "number") return <CountUp value={text} />;
  const s = (text ?? "").trim();
  if (/^\d[\d\s ]*$/.test(s)) return <CountUp value={Number(s.replace(/[\s ]/g, ""))} />;
  return <>{text}</>;
}
