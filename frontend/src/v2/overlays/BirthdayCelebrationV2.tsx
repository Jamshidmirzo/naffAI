import { useEffect, useState } from "react";
import confetti from "canvas-confetti";
import { Cake, X } from "lucide-react";
import { toast } from "../../components/ui";
import { useMe } from "../../hooks/useMe";
import { useAuth } from "../../store/auth";
import { normaliseRole } from "../../components/RoleGate";
import { useT2 } from "../i18n";

/**
 * v2 birthday strip (OpMorning's warm strip). Logic = old
 * components/BirthdayCelebration.tsx: only for role operator with
 * /auth/me/.is_birthday_today; confetti + toast once per calendar day
 * (`birthday_shown_<YYYY-MM-DD>`), strip all day until closed
 * (`birthday_banner_dismissed_<YYYY-MM-DD>`).
 * Rendered in the flow of the main column (under the header area).
 */
export default function BirthdayCelebrationV2() {
  const me = useMe();
  const role = normaliseRole(useAuth((s) => s.role));
  const t = useT2();

  const today = new Date().toISOString().slice(0, 10);

  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(`birthday_banner_dismissed_${today}`) === "1";
    } catch {
      return false;
    }
  });

  const isBirthdayOperator = role === "operator" && me.data?.is_birthday_today === true;
  const name = me.data?.operator_name || me.data?.display_name || "";

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
    const shoot = (originX: number) =>
      confetti({ particleCount: 90, spread: 70, origin: { x: originX, y: 0.6 }, colors: ["#2D2A8C", "#F2B01E", "#C62F57", "#11805A", "#E8771C"], disableForReducedMotion: true });
    const t1 = window.setTimeout(() => shoot(0.2), 250);
    const t2 = window.setTimeout(() => shoot(0.8), 550);
    toast.success(t("v2.ov.bday.toast", { name }));
    try {
      localStorage.setItem(key, "1");
    } catch {
      /* ignore */
    }
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBirthdayOperator, today, name]);

  if (!isBirthdayOperator || dismissed) return null;

  return (
    <div style={{ padding: "12px clamp(12px, 2vw, 24px) 0" }}>
      <div
        className="row g12"
        role="status"
        aria-live="polite"
        style={{ padding: "10px 16px", borderRadius: 12, background: "var(--warn-bg)", color: "var(--warn)", boxShadow: "var(--shadow)" }}
      >
        <Cake className="ic" aria-hidden />
        <span className="s w6 grow">{t("v2.ov.bday.banner", { name })}</span>
        <button
          className="btn btn-ghost btn-sq btn-sm"
          type="button"
          aria-label={t("v2.ov.bday.hide")}
          title={t("v2.ov.bday.hide")}
          style={{ color: "var(--warn)" }}
          onClick={() => {
            setDismissed(true);
            try {
              localStorage.setItem(`birthday_banner_dismissed_${today}`, "1");
            } catch {
              /* ignore */
            }
          }}
        >
          <X className="ic" />
        </button>
      </div>
    </div>
  );
}
