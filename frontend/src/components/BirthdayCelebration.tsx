import { useEffect, useState } from "react";
import confetti from "canvas-confetti";
import { toast } from "./ui";
import { useMe } from "../hooks/useMe";
import { useAuth } from "../store/auth";
import { normaliseRole } from "./RoleGate";
import { useT } from "../lib/i18n";

/**
 * Праздничное поздравление именинника-оператора.
 *
 * Триггерится только для роли `operator`, только когда backend
 * (`/api/auth/me/`) вернул `is_birthday_today = true`. Показывает три
 * визуала:
 *
 *   1. Confetti — canvas-confetti (~2kb gzip), один раз на календарный
 *      день (localStorage guard). Если оператор перезагрузил вкладку —
 *      только banner, без повторного салюта (не хотим спамить).
 *   2. Toast — «С днём рождения!» один раз на день (тот же guard).
 *   3. Gradient banner — фиксированный сверху весь день. Закрываемый;
 *      dismiss тоже persist в localStorage per-day.
 *
 * Ключи localStorage:
 *   - `birthday_shown_${YYYY-MM-DD}` — confetti+toast уже показаны.
 *   - `birthday_banner_dismissed_${YYYY-MM-DD}` — banner закрыт.
 *
 * Managers/team-leads это не видят вообще: у них operator_id=null →
 * is_birthday_today=false → компонент рендерит null.
 */
export function BirthdayCelebration() {
  const me = useMe();
  const role = normaliseRole(useAuth((s) => s.role));
  const t = useT();

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(`birthday_banner_dismissed_${today}`) === "1";
    } catch {
      return false;
    }
  });

  const isBirthdayOperator =
    role === "operator" && me.data?.is_birthday_today === true;

  // Fire confetti + toast one time per day.
  useEffect(() => {
    if (!isBirthdayOperator) return;
    const key = `birthday_shown_${today}`;
    let already = false;
    try {
      already = localStorage.getItem(key) === "1";
    } catch {
      /* ignore */
    }
    if (already) return;

    // Confetti: два залпа с боков — компактный, не блокирует UI.
    const shoot = (originX: number) => {
      confetti({
        particleCount: 90,
        spread: 70,
        origin: { x: originX, y: 0.6 },
        colors: ["#f472b6", "#fb923c", "#fbbf24", "#a78bfa", "#60a5fa"],
        disableForReducedMotion: true,
      });
    };
    // Небольшая задержка чтобы UI успел смонтировать canvas + toast.
    const t1 = window.setTimeout(() => shoot(0.2), 250);
    const t2 = window.setTimeout(() => shoot(0.8), 550);

    const name = me.data?.operator_name || me.data?.display_name || "";
    toast.success(t("birthday.toast", { name }));

    try {
      localStorage.setItem(key, "1");
    } catch {
      /* ignore */
    }
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [isBirthdayOperator, today, me.data?.operator_name, me.data?.display_name, t]);

  if (!isBirthdayOperator || dismissed) return null;

  const name = me.data?.operator_name || me.data?.display_name || "";

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
        padding: "10px 20px",
        background:
          "linear-gradient(90deg, rgba(251,113,133,0.18), rgba(251,146,60,0.18), rgba(250,204,21,0.18))",
        borderBottom: "1px solid rgba(251,146,60,0.35)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontSize: 14,
        fontWeight: 500,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 20 }}>🎂</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        {t("birthday.banner", { name })}
      </span>
      <button
        type="button"
        onClick={() => {
          setDismissed(true);
          try {
            localStorage.setItem(`birthday_banner_dismissed_${today}`, "1");
          } catch {
            /* ignore */
          }
        }}
        aria-label={t("common.close")}
        style={{
          background: "transparent",
          border: "none",
          fontSize: 18,
          cursor: "pointer",
          color: "var(--muted)",
          padding: "0 4px",
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}

export default BirthdayCelebration;
