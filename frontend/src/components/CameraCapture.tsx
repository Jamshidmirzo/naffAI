import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, RefreshCw, RotateCcw, Upload, X } from "lucide-react";
import { compressImageFile } from "../lib/imageCompress";
import { useT } from "../lib/i18n";
import { toast } from "./ui";

interface Props {
  onCapture: (file: File) => void;
  onCancel: () => void;
  /** JPEG quality 0..1, default 0.82 (was 0.85) */
  jpegQuality?: number;
  /** target max side length in px, default 1024 (was 1280) — shrinks the
   *  photo payload from 2-5 MB down to ~120-350 KB, cuts upload time 3-5×
   *  on shop's flaky mobile Wi-Fi. */
  maxSide?: number;
}

type Facing = "user" | "environment";

/**
 * Full-screen camera capture with a manual snap button and a "flip camera"
 * toggle. Automatically falls back to a native file picker with `capture=user`
 * when `navigator.mediaDevices.getUserMedia` is unavailable or permission is
 * denied (iOS in-app browsers, permission-blocked users, some Android WebViews).
 *
 * Emits a JPEG `File` (from a downscaled canvas) so the backend upload stays
 * under a few hundred KB regardless of camera resolution.
 */
export default function CameraCapture({
  onCapture,
  onCancel,
  jpegQuality = 0.82,
  maxSide = 1024,
}: Props) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<Facing>("user");
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [snapshotBlob, setSnapshotBlob] = useState<Blob | null>(null);
  const [needsFallback, setNeedsFallback] = useState(false);
  const [starting, setStarting] = useState(true);
  // Guards the "Отправить" button from double-click / iOS Safari
  // resubmission — the second click was flooding the backend with the
  // same photo and triggering the anti-duplicate reject on the second
  // request. First-click wins, further clicks are ignored until parent
  // resets `snapshot` (retake) or the modal closes.
  const [submitting, setSubmitting] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    }
  }, []);

  const startStream = useCallback(
    async (face: Facing) => {
      setStarting(true);
      stopStream();
      if (!navigator.mediaDevices?.getUserMedia) {
        setNeedsFallback(true);
        setStarting(false);
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: face,
            width: { ideal: 1280 },
            height: { ideal: 1280 },
          },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setReady(true);
        setNeedsFallback(false);
      } catch (err) {
        console.warn("getUserMedia failed", err);
        setNeedsFallback(true);
      } finally {
        setStarting(false);
      }
    },
    [stopStream],
  );

  useEffect(() => {
    startStream(facing);
    return () => stopStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facing]);

  const flipCamera = () => setFacing((f) => (f === "user" ? "environment" : "user"));

  const doSnap = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) {
      toast.error(t("camera.not_ready"));
      return;
    }
    // Preserve aspect ratio, cap the longer side at `maxSide`.
    const scale = Math.min(1, maxSide / Math.max(vw, vh));
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Mirror front-camera image so the preview matches what the user sees.
    if (facing === "user") {
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(video, -w, 0, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(video, 0, 0, w, h);
    }
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          toast.error(t("camera.snapshot_failed"));
          return;
        }
        setSnapshot(URL.createObjectURL(blob));
        setSnapshotBlob(blob);
      },
      "image/jpeg",
      jpegQuality,
    );
  }, [facing, jpegQuality, maxSide, t]);

  const submitSnapshot = () => {
    if (!snapshotBlob || submitting) return;
    setSubmitting(true);
    const file = new File([snapshotBlob], `selfie-${Date.now()}.jpg`, {
      type: "image/jpeg",
    });
    stopStream();
    onCapture(file);
    // We deliberately don't clear `submitting` here — the parent unmounts
    // this component on success/failure. Keeping it true prevents a
    // double-fire if unmount is racy.
  };

  const retake = () => {
    if (snapshot) URL.revokeObjectURL(snapshot);
    setSnapshot(null);
    setSnapshotBlob(null);
    setSubmitting(false);
  };

  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f || pickerBusy) return;
    setPickerBusy(true);
    try {
      // Native picker path bypasses our canvas downscale — real phone
      // photos are 2-5 MB, so compress before firing `onCapture` too.
      const compressed = await compressImageFile(f, {
        maxSide,
        quality: jpegQuality,
      });
      onCapture(compressed);
    } catch (err) {
      console.warn("file compress failed, sending raw", err);
      onCapture(f);
    } finally {
      // e.target.value = "" so picking the same file again re-fires.
      e.target.value = "";
      setPickerBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black text-white"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => {
            stopStream();
            onCancel();
          }}
          className="grid place-items-center rounded-full bg-white/10 hover:bg-white/20 transition"
          style={{ width: 40, height: 40 }}
          aria-label={t("common.close")}
        >
          <X className="w-5 h-5" />
        </button>
        <div className="text-[14px] font-medium tracking-wide opacity-90">
          {snapshot ? t("camera.preview_title") : t("camera.title")}
        </div>
        {!snapshot && !needsFallback ? (
          <button
            onClick={flipCamera}
            className="grid place-items-center rounded-full bg-white/10 hover:bg-white/20 transition"
            style={{ width: 40, height: 40 }}
            aria-label={t("camera.flip")}
            title={t("camera.flip")}
          >
            <RefreshCw className="w-5 h-5" />
          </button>
        ) : (
          <div style={{ width: 40 }} />
        )}
      </div>

      <div className="relative flex-1 overflow-hidden">
        {snapshot ? (
          <img
            src={snapshot}
            alt="preview"
            className="absolute inset-0 w-full h-full object-contain bg-black"
          />
        ) : needsFallback ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
            <Camera className="w-14 h-14 opacity-70" />
            <div className="mt-4 text-[15px] font-semibold">
              {t("camera.fallback_title")}
            </div>
            <div className="mt-1.5 text-[13px] opacity-70 max-w-[280px]">
              {t("camera.fallback_hint")}
            </div>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="mt-6 inline-flex items-center gap-2 rounded-full px-5 py-3 bg-white text-black font-semibold"
            >
              <Upload className="w-4 h-4" />
              {t("camera.pick_file")}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="user"
              onChange={onFilePicked}
              className="hidden"
            />
          </div>
        ) : (
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="absolute inset-0 w-full h-full object-cover"
            style={{
              transform: facing === "user" ? "scaleX(-1)" : undefined,
              opacity: ready ? 1 : 0.3,
              transition: "opacity 200ms",
            }}
          />
        )}
        <canvas ref={canvasRef} className="hidden" />
        {!snapshot && !needsFallback && starting && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <div className="text-[13px] opacity-70">{t("camera.starting")}</div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-4 px-4 py-6">
        {snapshot ? (
          <>
            <button
              onClick={retake}
              className="inline-flex items-center gap-2 rounded-full px-5 py-3 bg-white/10 hover:bg-white/20 transition font-semibold"
            >
              <RotateCcw className="w-4 h-4" />
              {t("camera.retake")}
            </button>
            <button
              onClick={submitSnapshot}
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-full px-6 py-3.5 bg-white text-black font-bold disabled:opacity-60"
            >
              {submitting ? t("camera.sending") : t("camera.submit")}
            </button>
          </>
        ) : !needsFallback ? (
          <button
            onClick={doSnap}
            disabled={!ready}
            className="rounded-full bg-white grid place-items-center transition active:scale-95 disabled:opacity-50"
            style={{ width: 78, height: 78 }}
            aria-label={t("camera.snap")}
          >
            <div
              className="rounded-full border-4 border-black"
              style={{ width: 60, height: 60 }}
            />
          </button>
        ) : null}
      </div>
    </div>
  );
}
