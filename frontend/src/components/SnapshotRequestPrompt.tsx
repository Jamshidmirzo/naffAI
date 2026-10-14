/**
 * SnapshotRequestPrompt — modal that pops up for the operator when a
 * manager pressed «📷 Попросить снимок» on their card. Listens to the
 * global `naffai:notif` event dispatched by `useNotificationStream`.
 *
 * Flow:
 *   1. Backend creates `Notification(kind=snapshot_request)` on this user.
 *   2. Redis publish → SSE → `naffai:notif` CustomEvent.
 *   3. We render a consent-modal: «Менеджер просит снимок. Разрешить
 *      камеру?».
 *   4. On click «Да, сделать» → `getUserMedia({video:true})` → live
 *      preview `<video>`, затем автоматически через 1.5 сек делается
 *      canvas-snapshot, `canvas.toBlob('image/jpeg')`, multipart
 *      POST `/operators/me/avatar/`.
 *   5. Modal показывает «✓ Отправлено», streams закрываются.
 *
 * Приватность: НИКАКИХ тихих снимков. Разрешение камеры запрашивается
 * ТОЛЬКО после явного клика «Да, сделать». До клика — камера не
 * активируется, даже если permission «granted» уже выдан. Таймаут
 * 60 секунд — если оператор не ответил, модалка сама закрывается.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  NAFFAI_NOTIF_EVENT,
  type NaffaiNotificationEventDetail,
} from "../hooks/useNotificationStream";

type Stage = "idle" | "prompt" | "capturing" | "uploading" | "done" | "error";

const AUTO_DISMISS_MS = 60_000;
const CAPTURE_DELAY_MS = 1500;

interface PromptState {
  requesterName: string;
}

export default function SnapshotRequestPrompt() {
  const [stage, setStage] = useState<Stage>("idle");
  const [state, setState] = useState<PromptState | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dismissTimerRef = useRef<number | null>(null);

  // Subscribe to SSE events — show modal on snapshot_request.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<NaffaiNotificationEventDetail>).detail;
      if (!detail || detail.kind !== "snapshot_request") return;
      const meta = (detail.metadata || {}) as Record<string, unknown>;
      const requesterName =
        (meta.requested_by_name as string) || "Менеджер";
      setErrorMsg("");
      setStage("prompt");
      setState({ requesterName });

      // 60-sec auto-dismiss
      if (dismissTimerRef.current) window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = window.setTimeout(() => {
        close(true);
      }, AUTO_DISMISS_MS);
    };
    window.addEventListener(NAFFAI_NOTIF_EVENT, handler);
    return () => window.removeEventListener(NAFFAI_NOTIF_EVENT, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopStream = () => {
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
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
    setState(null);
    if (!silent) setErrorMsg("");
  };

  const captureAndUpload = async () => {
    setStage("capturing");
    setErrorMsg("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      // small delay чтобы камера экспонировалась (на холодном старте
      // первый кадр чёрный / overexposed)
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
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("toBlob-failed"))),
          "image/jpeg",
          0.85,
        );
      });

      stopStream();
      setStage("uploading");

      const fd = new FormData();
      fd.append("avatar", blob, `snapshot-${Date.now()}.jpg`);
      await api.post("/operators/me/avatar/", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      setStage("done");
      window.setTimeout(() => close(true), 1500);
    } catch (err) {
      stopStream();
      setStage("error");
      const name = (err as { name?: string } | undefined)?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setErrorMsg("Доступ к камере запрещён в браузере.");
      } else {
        setErrorMsg("Не удалось сделать снимок. Попробуйте ещё раз.");
      }
    }
  };

  if (stage === "idle" || !state) {
    // canvas остаётся в DOM, чтобы ref был готов, но visually hidden
    return <canvas ref={canvasRef} style={{ display: "none" }} />;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(10,15,25,0.72)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1200,
        padding: 20,
      }}
    >
      <div
        style={{
          background: "var(--bg, #fff)",
          color: "var(--text, #0f172a)",
          borderRadius: 20,
          maxWidth: 460,
          width: "100%",
          padding: 28,
          boxShadow: "0 24px 60px rgba(0,0,0,.4)",
        }}
      >
        <div style={{ fontSize: 36, textAlign: "center" }}>📷</div>
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            textAlign: "center",
            marginTop: 10,
          }}
        >
          Запрос снимка
        </div>
        <div
          style={{
            fontSize: 14,
            textAlign: "center",
            opacity: 0.8,
            marginTop: 8,
          }}
        >
          {state.requesterName} просит сделать снимок с камеры.
          Он станет вашим аватаром.
        </div>

        {(stage === "capturing" || stage === "uploading") && (
          <div style={{ marginTop: 18, display: "flex", flexDirection: "column", alignItems: "center" }}>
            <video
              ref={videoRef}
              muted
              playsInline
              style={{
                width: "100%",
                maxWidth: 320,
                borderRadius: 14,
                background: "#000",
                aspectRatio: "4 / 3",
                objectFit: "cover",
              }}
            />
            <div style={{ marginTop: 10, fontSize: 13, opacity: 0.75 }}>
              {stage === "capturing" ? "Делаем снимок…" : "Загрузка…"}
            </div>
          </div>
        )}

        {stage === "done" && (
          <div
            style={{
              marginTop: 20,
              textAlign: "center",
              fontSize: 15,
              color: "#16a34a",
              fontWeight: 600,
            }}
          >
            ✓ Снимок отправлен
          </div>
        )}

        {stage === "error" && (
          <div
            style={{
              marginTop: 18,
              padding: "10px 14px",
              borderRadius: 12,
              background: "rgba(220,38,38,.1)",
              color: "#dc2626",
              fontSize: 13,
            }}
          >
            {errorMsg || "Ошибка"}
          </div>
        )}

        {stage === "prompt" && (
          <div
            style={{
              marginTop: 22,
              display: "flex",
              gap: 10,
              justifyContent: "center",
              flexWrap: "wrap",
            }}
          >
            <button
              onClick={() => close()}
              style={{
                padding: "10px 18px",
                borderRadius: 12,
                border: "1px solid var(--border, #e2e8f0)",
                background: "transparent",
                color: "inherit",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              Отменить
            </button>
            <button
              onClick={captureAndUpload}
              style={{
                padding: "10px 20px",
                borderRadius: 12,
                border: "none",
                background: "linear-gradient(180deg, #2563eb, #1d4ed8)",
                color: "#fff",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Да, сделать
            </button>
          </div>
        )}

        {(stage === "error") && (
          <div style={{ marginTop: 16, textAlign: "center" }}>
            <button
              onClick={() => close()}
              style={{
                padding: "8px 16px",
                borderRadius: 10,
                border: "1px solid var(--border, #e2e8f0)",
                background: "transparent",
                color: "inherit",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Закрыть
            </button>
          </div>
        )}

        <canvas ref={canvasRef} style={{ display: "none" }} />
      </div>
    </div>
  );
}
