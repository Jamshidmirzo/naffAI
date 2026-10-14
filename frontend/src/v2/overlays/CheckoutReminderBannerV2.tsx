import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { Clock, X } from "lucide-react";
import { useConfirm } from "../ui";
import { useT2 } from "../i18n";
import { minutesSince, useFmtDur, useShiftFlow } from "./shift";

/**
 * v2 checkout reminder (OpSheetShift «Напоминание об уходе · под шапкой»).
 * Visibility logic = old components/CheckoutReminderBanner.tsx:
 *   open_log && checkout_reminder_active && route not hidden && not dismissed
 *   for this log id (localStorage `checkout_reminder_dismissed_<id>`).
 * Fix (artboard Bugs): «Завершить смену» no longer just hides the banner and
 * scrolls — it asks «Завершить смену?» and then opens the real checkout flow
 * (same QR window / PC camera as the shift card). The banner stays until the
 * checkout happens (open_log disappears) or the operator closes it with ×.
 */

const HIDE_PATHS = new Set(["/scan", "/scan-photo", "/kiosk", "/login", "/my/sale-new"]);
const PREFIX = "checkout_reminder_dismissed_";

export default function CheckoutReminderBannerV2() {
  const t = useT2();
  const loc = useLocation();
  const confirm = useConfirm();
  const fmtDur = useFmtDur();
  const flow = useShiftFlow();
  const current = flow.current.data;

  const openLog = current?.open_log;
  const reminderActive = current?.checkout_reminder_active;

  const [dismissed, setDismissed] = useState<Record<number, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const acc: Record<number, boolean> = {};
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(PREFIX)) {
          const id = Number(key.slice(PREFIX.length));
          if (!Number.isNaN(id)) acc[id] = true;
        }
      }
      return acc;
    } catch {
      return {};
    }
  });

  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((v) => v + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const shouldShow = useMemo(() => {
    if (!openLog || !reminderActive) return false;
    if (HIDE_PATHS.has(loc.pathname)) return false;
    if (dismissed[openLog.id]) return false;
    return true;
  }, [openLog, reminderActive, loc.pathname, dismissed]);

  const onDismiss = () => {
    if (!openLog) return;
    try {
      localStorage.setItem(PREFIX + openLog.id, "1");
    } catch {
      /* quota / private mode — dismissal just won't survive reload */
    }
    setDismissed((prev) => ({ ...prev, [openLog.id]: true }));
  };

  const onFinish = async () => {
    if (!openLog) return;
    const ok = await confirm({
      title: t("v2.ov.shift.finishQ"),
      body: (
        <>
          {t("v2.ov.shift.finishBody", { dur: fmtDur(minutesSince(openLog.checked_in_at)) })} {t("v2.ov.shift.finishNext")}
        </>
      ),
      confirm: t("v2.ov.shift.finish"),
    });
    if (ok) flow.openQr(false);
  };

  return (
    <>
      {shouldShow && openLog ? (
        <div style={{ padding: "12px clamp(12px, 2vw, 24px) 0" }}>
          <div className="banner b-warn" role="alert" style={{ alignItems: "center", flexWrap: "wrap" }}>
            <Clock className="ic" style={{ flex: "none" }} />
            <span className="col grow" style={{ minWidth: 200 }}>
              <span className="w6">{t("v2.ov.rem.title")}</span>
              <span>{t("v2.ov.rem.body", { dur: fmtDur(minutesSince(openLog.checked_in_at)) })}</span>
            </span>
            <button className="btn btn-sm" type="button" onClick={onFinish} disabled={flow.pending}>
              {flow.pending ? t("v2.ov.shift.sending") : t("v2.ov.shift.finish")}
            </button>
            <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("v2.ov.rem.hide")} title={t("v2.ov.rem.hide")} onClick={onDismiss} style={{ color: "inherit" }}>
              <X className="ic" />
            </button>
          </div>
        </div>
      ) : null}
      {confirm.node}
      {flow.node}
    </>
  );
}
