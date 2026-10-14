import { useEffect, useRef, useState } from "react";
import { Camera, Check } from "lucide-react";
import { api } from "../../lib/api";
import { NAFFAI_NOTIF_EVENT, type NaffaiNotificationEventDetail } from "../../hooks/useNotificationStream";
import { useT2 } from "../i18n";
import { Layer } from "./shift";

/**
 * v2 manager snapshot request (artboard OpSnapshot + OpSheetShift error).
 * Logic copied from components/SnapshotRequestPrompt.tsx (its helpers are
 * not exported):
 *   - opens on SSE `naffai:notif` kind=snapshot_request;
 *   - camera is requested ONLY after the explicit «Разрешить» click;
 *   - getUserMedia 640×480 user-facing → 1.5 s exposure delay → canvas JPEG 0.85
 *     → multipart POST /operators/me/avatar/ (field `avatar`);
 *   - «done» closes after 1.5 s; the request auto-dismisses after 60 s.
 * v2 addition: «Повторить» on the error window (same capture call).
 */

type Stage = "idle" | "prompt" | "capturing" | "uploading" | "done" | "error";

const AUTO_DISMISS_MS = 60_000;
const CAPTURE_DELAY_MS = 1500;

export default function SnapshotRequestPromptV2() {
  const t = useT2();
  const [stage, setStage] = useState<Stage>("idle");
  const [requester, setRequester] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<"denied" | "failed" | null>(null);
  const [, tick] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dismissTimerRef = useRef<number | null>(null);
  const deadlineRef = useRef<number>(0);

  const stopStream = () => {
    try {
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
    } catch {
      /* ignore */
    }
    streamRef.current = null;
  };

  const close = (silent?: boolean) => {
    if (dismissTimerRef.current) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    stopStream();
    setStage("idle");
    setRequester(null);
    if (!silent) setErrorKind(null);
  };

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<NaffaiNotificationEventDetail>).detail;
      if (!detail || detail.kind !== "snapshot_request") return;
      const meta = (detail.metadata || {}) as Record<string, unknown>;
      setErrorKind(null);
      setStage("prompt");
      setRequester((meta.requested_by_name as string) || "");
      if (dismissTimerRef.current) window.clearTimeout(dismissTimerRef.current);
      deadlineRef.current = Date.now() + AUTO_DISMISS_MS;
      dismissTimerRef.current = window.setTimeout(() => close(true), AUTO_DISMISS_MS);
    };
    window.addEventListener(NAFFAI_NOTIF_EVENT, handler);
    return () => window.removeEventListener(NAFFAI_NOTIF_EVENT, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Countdown on the error window («менеджер ждёт ещё N с»).
  useEffect(() => {
    if (stage !== "error") return;
    const id = window.setInterval(() => tick((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [stage]);

  useEffect(() => () => stopStream(), []);

  const captureAndUpload = async () => {
    setStage("capturing");
    setErrorKind(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      // cold-start first frame is often black / overexposed
      await new Promise((r) => setTimeout(r, CAPTURE_DELAY_MS));

      const canvas = canvasRef.current!;
      const w = (video?.videoWidth ?? 640) || 640;
      const h = (video?.videoHeight ?? 480) || 480;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx || !video) throw new Error("canvas-unavailable");
      ctx.drawImage(video, 0, 0, w, h);

      const blob: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob-failed"))), "image/jpeg", 0.85);
      });

      stopStream();
      setStage("uploading");

      const fd = new FormData();
      fd.append("avatar", blob, `snapshot-${Date.now()}.jpg`);
      await api.post("/operators/me/avatar/", fd, { headers: { "Content-Type": "multipart/form-data" } });

      setStage("done");
      window.setTimeout(() => close(true), 1500);
    } catch (err) {
      stopStream();
      setStage("error");
      const name = (err as { name?: string } | undefined)?.name;
      setErrorKind(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "failed");
    }
  };

  if (stage === "idle" || requester === null) {
    return <canvas ref={canvasRef} style={{ display: "none" }} />;
  }

  const who = requester || t("v2.ov.snap.manager");
  const secondsLeft = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));

  return (
    <Layer z={1200}>
      <div className="scrim" />
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
        {stage === "error" ? (
          <section className="dlg" role="alertdialog" aria-modal="true" aria-labelledby="v2-snap-err" style={{ width: 440, maxWidth: "100%" }}>
            <div className="dlg-h">
              <div className="col g4">
                <h2 className="h2" id="v2-snap-err">{t("v2.ov.snap.failTitle")}</h2>
                <span className="s c3">{t("v2.ov.snap.from", { name: who })}</span>
              </div>
            </div>
            <div className="dlg-b">
              <p className="s c2" style={{ margin: 0 }}>
                {errorKind === "denied" ? t("v2.ov.snap.denied") : t("v2.ov.snap.failed")} {secondsLeft > 0 ? t("v2.ov.snap.wait", { n: secondsLeft }) : null}
              </p>
            </div>
            <div className="dlg-f">
              <button className="btn" type="button" onClick={() => close()}>{t("v2.ov.snap.close")}</button>
              <button className="btn btn-pri" type="button" onClick={captureAndUpload}>{t("v2.ov.snap.retry")}</button>
            </div>
          </section>
        ) : (
          <section className="modal col" role="dialog" aria-modal="true" aria-labelledby="v2-snap-title" style={{ maxHeight: "calc(100vh - 32px)", overflow: "auto" }}>
            <div className="col g8" style={{ padding: "24px 24px 16px" }}>
              <span className="badge b-info" style={{ alignSelf: "flex-start" }}>
                <Camera className="ic ic-s" />
                {t("v2.ov.snap.from", { name: who })}
              </span>
              <h2 className="h2" id="v2-snap-title">{t("v2.ov.snap.title")}</h2>
              <p className="s c2" style={{ margin: 0 }}>{t("v2.ov.snap.body")}</p>
            </div>
            <div style={{ padding: "0 24px" }}>
              {stage === "capturing" || stage === "uploading" ? (
                <div className="col g8" style={{ alignItems: "center" }}>
                  <video ref={videoRef} muted playsInline style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 11, background: "#15132B" }} />
                  <span className="s c3">{stage === "capturing" ? t("v2.ov.snap.capturing") : t("v2.ov.snap.uploading")}</span>
                </div>
              ) : stage === "done" ? (
                <div className="ph" style={{ aspectRatio: "16 / 9", borderStyle: "solid", background: "var(--ok-bg)", color: "var(--ok)" }}>
                  <Check className="ic ic-xl" />
                  <span className="s w6">{t("v2.ov.snap.done")}</span>
                </div>
              ) : (
                <div className="ph" style={{ aspectRatio: "16 / 9" }}>
                  <Camera className="ic ic-xl" />
                  <span>{t("v2.ov.snap.preview")}</span>
                </div>
              )}
            </div>
            <div className="row g8" style={{ padding: "20px 24px 24px", justifyContent: "flex-end" }}>
              {stage === "prompt" ? (
                <>
                  <button className="btn" type="button" onClick={() => close()}>{t("v2.ov.snap.notNow")}</button>
                  <button className="btn btn-pri" type="button" onClick={captureAndUpload}>{t("v2.ov.snap.allow")}</button>
                </>
              ) : null}
            </div>
          </section>
        )}
        <canvas ref={canvasRef} style={{ display: "none" }} />
      </div>
    </Layer>
  );
}
