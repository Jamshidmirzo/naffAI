import { useEffect, useState } from "react";
import { LogIn, LogOut } from "lucide-react";
import { API_BASE_URL } from "../../lib/api";
import { useConfirm } from "../ui";
import { useT2 } from "../i18n";
import { hm, minutesSince, useFmtDur, useShiftFlow } from "./shift";

/**
 * v2 shift card for /my (OpProfile «Смена»). Same logic as
 * components/AttendanceStatusWidget.tsx: the button opens the personal QR
 * window (phone scan), with the PC camera as fallback; polling 60 s / 5 s
 * while the QR window is open; result card after check-in/out.
 * v2 addition: «Завершить смену» asks for confirmation first.
 * Keeps the `data-attendance-widget` anchor used by /my's shift badge.
 */
export default function AttendanceStatusV2() {
  const t = useT2();
  const confirm = useConfirm();
  const fmtDur = useFmtDur();
  const flow = useShiftFlow();
  const { data: current, isPending: loading } = flow.current;
  const openLog = current?.open_log ?? null;
  const isOn = !!openLog;

  const [, tick] = useState(0);
  useEffect(() => {
    if (!openLog) return;
    const id = window.setInterval(() => tick((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [openLog]);

  const onClick = async () => {
    if (!openLog) {
      flow.openQr(true);
      return;
    }
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

  let clock = "";
  if (openLog) {
    const sec = Math.max(0, Math.floor((Date.now() - Date.parse(openLog.checked_in_at)) / 1000));
    clock = `${String(Math.floor(sec / 3600)).padStart(2, "0")}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  }
  const photo = openLog?.checkin_photo_url
    ? openLog.checkin_photo_url.startsWith("http")
      ? openLog.checkin_photo_url
      : `${API_BASE_URL.replace(/\/api$/, "")}${openLog.checkin_photo_url}`
    : null;

  return (
    <section className="card col" data-attendance-widget>
      <div className="card-h">
        <span className="h3">{t("v2.ov.shift.title")}</span>
        {loading ? null : isOn ? (
          <span className="badge b-ok"><i className="dot" />{t("v2.ov.shift.on")}</span>
        ) : (
          <span className="badge b-warn"><i className="dot" />{t("v2.ov.shift.off")}</span>
        )}
      </div>
      <div className="row g16 wrap" style={{ padding: "16px 20px", alignItems: "center" }}>
        {photo ? (
          <img src={photo} alt={t("v2.ov.shift.photoAlt")} style={{ width: 52, height: 52, borderRadius: 12, objectFit: "cover", flex: "none" }} />
        ) : null}
        <div className="col g4 grow" style={{ minWidth: 140 }}>
          {openLog ? (
            <>
              <span className="kpi num">{clock}</span>
              <span className="s c3">
                {t("v2.ov.shift.since", { time: hm(openLog.checked_in_at) })}
                {openLog.was_late ? null : `, ${t("v2.ov.shift.onTime")}`}
                {openLog.was_late ? <span className="badge b-bad" style={{ marginLeft: 8 }}>{t("v2.ov.shift.late")}</span> : null}
              </span>
            </>
          ) : (
            <>
              <span className="s w6">{t("v2.ov.shift.startHint")}</span>
              <span className="s c3">{t("v2.ov.shift.startSub")}</span>
            </>
          )}
        </div>
        <button className={isOn ? "btn btn-bad" : "btn btn-ok"} type="button" onClick={onClick} disabled={flow.pending || loading}>
          {flow.pending ? (
            t("v2.ov.shift.sending")
          ) : (
            <>
              {isOn ? <LogOut className="ic" /> : <LogIn className="ic" />}
              {isOn ? t("v2.ov.shift.finish") : t("v2.ov.shift.start")}
            </>
          )}
        </button>
      </div>
      {confirm.node}
      {flow.node}
    </section>
  );
}
