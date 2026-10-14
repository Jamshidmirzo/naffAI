import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { Camera, Check, Clock, Eye, Lock, LogOut, PlayCircle } from "lucide-react";
import { api } from "../../lib/api";
import { apiErrorMessage } from "../../lib/api-types";
import { useAuth } from "../../store/auth";
import { useLang } from "../../store/lang";
import { useMe } from "../../hooks/useMe";
import { useT2 } from "../i18n";
import { Layer, QrBox, QrSteps, QrWaiting, useMeCurrent, useShiftFlow, type MeQrToken } from "./shift";

/**
 * v2 «Начни смену» gate (artboard OpCheckin). Logic is the old
 * components/CheckinGate.tsx:
 *   - shown only when require_checkin_enabled && !open_log && !pending_backfill_log
 *     and the route is not whitelisted;
 *   - polls /attendance/me/current/ every 5 s, closes by itself when open_log appears;
 *   - «start» button = POST /attendance/me/toggle/ without photo; on
 *     `photo_required` the button hides and only QR / photo paths remain;
 *   - the personal QR (/attendance/me/qr-token/?origin=…) is always visible.
 * Added from the widget: «Сделать снимок» via CameraCapture → toggle with photo.
 * No close button, no click-outside: the only exit is a successful check-in.
 */

const WHITELIST_PATHS = new Set(["/scan", "/scan-photo", "/kiosk", "/login"]);

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase() || "?";
}

export default function CheckinGateV2() {
  const t = useT2();
  const qc = useQueryClient();
  const loc = useLocation();
  const nav = useNavigate();
  const lang = useLang((s) => s.lang);
  const me = useMe();
  const logout = useAuth((s) => s.logout);
  const [selfErr, setSelfErr] = useState<string | null>(null);
  const [needsPhoto, setNeedsPhoto] = useState(false);

  // Photo path + result card live above the gate (z 300) but below backfill (310).
  const flow = useShiftFlow({ z: 302 });

  const selfCheckin = useMutation({
    mutationFn: async () => (await api.post("/attendance/me/toggle/", {})).data,
    onSuccess: () => {
      setSelfErr(null);
      qc.invalidateQueries({ queryKey: ["me-attendance-current"] });
    },
    onError: (err: unknown) => {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === "photo_required") {
        setNeedsPhoto(true);
        setSelfErr(null);
      } else {
        setSelfErr(apiErrorMessage(err));
      }
    },
  });

  const { data: current } = useMeCurrent(5_000);

  const shouldShow = useMemo(() => {
    if (!current) return false;
    if (!current.require_checkin_enabled) return false;
    if (current.open_log) return false;
    if (current.pending_backfill_log) return false;
    if (WHITELIST_PATHS.has(loc.pathname)) return false;
    return true;
  }, [current, loc.pathname]);

  const spaOrigin = typeof window !== "undefined" ? window.location.origin : "ssr";
  const qrq = useQuery<MeQrToken>({
    queryKey: ["me-attendance-qr-token", spaOrigin],
    queryFn: () => api.get<MeQrToken>("/attendance/me/qr-token/", { params: { origin: spaOrigin } }).then((r) => r.data),
    enabled: shouldShow,
    staleTime: 60_000,
    retry: false,
  });

  // Gate was up and open_log appeared (self button, phone scan or PC camera) →
  // «Смена начата». The camera path already set its own result.
  const wasShown = useRef(false);
  const showResult = flow.showResult;
  const hasResult = flow.hasResult;
  useEffect(() => {
    const ol = current?.open_log;
    if (wasShown.current && ol) {
      qc.invalidateQueries({ queryKey: ["me-attendance-current"] });
      if (!hasResult) showResult({ action: "check_in", time: ol.checked_in_at, was_late: ol.was_late, photo_url: ol.checkin_photo_url || undefined });
    }
    wasShown.current = shouldShow;
  }, [current?.open_log, shouldShow, qc, hasResult, showResult]);

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!shouldShow) return;
    const id = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(id);
  }, [shouldShow]);

  if (!shouldShow) return flow.node;

  const name = me.data?.operator_name || me.data?.display_name || me.data?.username || "";
  const dateStr = now.toLocaleDateString(lang === "uz" ? "uz-UZ" : "ru-RU", { weekday: "long", day: "numeric", month: "long" });
  const timeStr = now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

  return (
    <>
      <Layer z={300} style={{ background: "var(--bg)", overflowY: "auto" }}>
        <div role="dialog" aria-modal="true" aria-labelledby="v2-gate-title" style={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
          <i className="ikat" style={{ height: 10, flex: "none" }} aria-hidden />
          <div className="row between g12" style={{ padding: "16px clamp(16px, 3vw, 32px)", flexWrap: "wrap" }}>
            <div className="wordmark" style={{ padding: 0 }}><i className="ikat ikat-mark" aria-hidden />naff<b>AI</b></div>
            <div className="row g12">
              <span className="ava">{initials(name)}</span>
              <span className="col" style={{ minWidth: 0 }}>
                <span className="s w6 trunc">{name}</span>
                <span className="xs c3">{t("v2.ov.gate.operator")}</span>
              </span>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => {
                  logout();
                  nav("/login", { replace: true });
                }}
              >
                <LogOut className="ic" />
                {t("v2.ov.gate.logout")}
              </button>
            </div>
          </div>

          <div style={{ flex: "1 1 auto", display: "flex", alignItems: "center", justifyContent: "center", padding: "16px 16px 64px" }}>
            <section className="card" style={{ width: 960, maxWidth: "100%", padding: "clamp(20px, 3vw, 32px)", display: "flex", flexDirection: "row-reverse", flexWrap: "wrap", gap: 32, alignItems: "stretch" }}>
              {/* DOM order = text first (mobile), row-reverse puts the QR on the left on desktop */}
              {/* Right: why + actions */}
              <div className="col g20" style={{ flex: "1 1 360px", minWidth: 0 }}>
                <div className="col g8">
                  <span className="badge" style={{ alignSelf: "flex-start" }}>
                    <Lock className="ic ic-s" />
                    {t("v2.ov.gate.locked")}
                  </span>
                  <h1 className="h1" id="v2-gate-title" style={{ fontSize: 28, lineHeight: "34px" }}>{t("v2.ov.gate.title")}</h1>
                  <p className="c2" style={{ margin: 0 }}>
                    {t("v2.ov.gate.now", { date: dateStr.charAt(0).toUpperCase() + dateStr.slice(1), time: timeStr })}
                  </p>
                </div>

                <div className="well col g8">
                  <div className="row g8"><Check className="ic c-ok" /><span className="s">{t("v2.ov.gate.i1")}</span></div>
                  <div className="row g8"><Clock className="ic c-warn" /><span className="s">{t("v2.ov.gate.i2")}</span></div>
                  <div className="row g8"><Eye className="ic c3" /><span className="s">{t("v2.ov.gate.i3")}</span></div>
                </div>

                <div className="col g8" style={{ marginTop: "auto" }}>
                  {!needsPhoto ? (
                    <>
                      <button className="btn btn-ok btn-lg btn-block" type="button" onClick={() => selfCheckin.mutate()} disabled={selfCheckin.isPending}>
                        <PlayCircle className="ic" />
                        {selfCheckin.isPending ? t("v2.ov.gate.starting") : t("v2.ov.gate.startNoPhoto")}
                      </button>
                      {selfErr ? <span className="err" role="alert">{selfErr}</span> : null}
                      <span className="s c3" style={{ marginTop: 8 }}>{t("v2.ov.gate.cameraQ")}</span>
                    </>
                  ) : (
                    <div className="banner b-warn" role="status">{t("v2.ov.gate.photoRequired")}</div>
                  )}
                  <button className={needsPhoto ? "btn btn-ok btn-lg btn-block" : "btn btn-lg btn-block"} type="button" onClick={flow.openCamera} disabled={flow.pending}>
                    <Camera className="ic" />
                    {flow.pending ? t("v2.ov.shift.sending") : t("v2.ov.gate.camera")}
                  </button>
                </div>
              </div>
              {/* Left: personal QR (always visible, as in the old gate) */}
              <div className="col g12" style={{ flex: "1 1 340px", minWidth: 0 }}>
                <div className="col g16" style={{ alignItems: "center", padding: "24px 20px", borderRadius: 12, border: "1px dashed var(--line-2)", background: "var(--surface-3)" }}>
                  <QrBox token={qrq.data} isPending={qrq.isPending} isError={qrq.isError} error={qrq.error} size={240} />
                  <span className="s w6" style={{ color: "var(--ink-2)" }}>{t("v2.ov.qr.mine")}</span>
                  <div style={{ alignSelf: "stretch" }}>
                    <QrSteps />
                  </div>
                  <div style={{ alignSelf: "stretch" }}>
                    <QrWaiting />
                  </div>
                </div>
              </div>

            </section>
          </div>
        </div>
      </Layer>
      {flow.node}
    </>
  );
}
