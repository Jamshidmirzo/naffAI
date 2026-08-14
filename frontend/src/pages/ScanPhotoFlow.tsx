import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Clock, Camera, XCircle, LogIn, LogOut } from "lucide-react";
import { api, API_BASE_URL } from "../lib/api";
import { useAuth } from "../store/auth";
import { apiErrorMessage } from "../lib/api-types";
import { useT } from "../lib/i18n";
import { Button, Eyebrow } from "../components/ui";
import CameraCapture from "../components/CameraCapture";

/**
 * Mobile-first check-in / check-out flow driven by the operator's QR
 * URL (?qr=<token>). Never asks for a login: the QR + camera photo are
 * the credential.
 *
 * Flow:
 *  1. On mount → GET /attendance/qr-preview/?qr=... to greet by name
 *     and pick "check_in" vs "check_out" so the button colour matches.
 *  2. Tap "Открыть камеру" → CameraCapture full-screen overlay → snap
 *     → CameraCapture emits a File.
 *  3. Submit → POST /attendance/me/scan-with-photo/ (multipart).
 *  4. On success: play a Framer Motion success animation with the
 *     recorded time / duration, auto-dismiss after 4s.
 *  5. On error: red toast text; user can retake the photo.
 */

type QrPreview = {
  operator: { id: number; full_name: string };
  on_shift: boolean;
  checked_in_at: string | null;
  expected_action: "check_in" | "check_out";
};

type ScanResult = {
  action: "check_in" | "check_out";
  operator: { id: number; full_name: string };
  was_late?: boolean;
  checked_in_at?: string;
  checked_out_at?: string;
  duration_min?: number;
  token?: string;
  username?: string;
  role?: string;
  photo_url?: string;
};

function fmtTime(iso?: string | null) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function fmtDuration(minutes?: number): string {
  if (!minutes || minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

export default function ScanPhotoFlow() {
  const t = useT();
  const [search] = useSearchParams();
  const qr = search.get("qr") || "";
  const [preview, setPreview] = useState<QrPreview | null>(null);
  const [previewError, setPreviewError] = useState<string>("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const setAuth = useAuth((s) => s.setAuth);
  const autoCloseTimer = useRef<number | null>(null);

  // Load QR preview once so the greeting shows the operator's name.
  useEffect(() => {
    if (!qr) {
      setPreviewError(t("scan_photo.no_qr"));
      return;
    }
    (async () => {
      try {
        const r = await api.get<QrPreview>(
          `/attendance/qr-preview/?qr=${encodeURIComponent(qr)}`,
        );
        setPreview(r.data);
      } catch (e) {
        setPreviewError(apiErrorMessage(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qr]);

  // Auto-close success card after 4s so the operator sees confirmation and
  // the widget becomes ready for the next event.
  useEffect(() => {
    if (!result) return;
    if (autoCloseTimer.current) window.clearTimeout(autoCloseTimer.current);
    autoCloseTimer.current = window.setTimeout(() => setResult(null), 4200);
    return () => {
      if (autoCloseTimer.current) window.clearTimeout(autoCloseTimer.current);
    };
  }, [result]);

  const isCheckIn = preview?.expected_action !== "check_out";
  const accent = isCheckIn ? "#16a34a" : "#f97316";

  const bgHex = useMemo(() => (isCheckIn ? "rgba(22,163,74,.10)" : "rgba(249,115,22,.10)"), [isCheckIn]);

  const submitPhoto = async (file: File) => {
    setPending(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("qr_payload", qr);
      fd.append("photo", file);
      const r = await api.post<ScanResult>(
        "/attendance/me/scan-with-photo/",
        fd,
        {
          headers: { "Content-Type": "multipart/form-data" },
        },
      );
      const data = r.data;
      // If backend issued a token for the operator, cache it — matches the
      // legacy /scan flow (they may then open their /my page).
      if (data.action === "check_in" && data.token && data.username && data.role) {
        setAuth(data.token, data.username, data.role);
      }
      setResult(data);
      // Refresh preview so the "expected_action" updates for a possible
      // second scan on the same device.
      if (qr) {
        try {
          const r2 = await api.get<QrPreview>(
            `/attendance/qr-preview/?qr=${encodeURIComponent(qr)}`,
          );
          setPreview(r2.data);
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setPending(false);
      setCameraOpen(false);
    }
  };

  if (previewError) {
    return (
      <div className="min-h-dvh grid place-items-center p-6 text-center">
        <div className="max-w-[340px]">
          <XCircle className="w-14 h-14 mx-auto text-red-500" />
          <div className="mt-4 text-[18px] font-semibold">
            {t("scan_photo.error_title")}
          </div>
          <div className="mt-2 text-[13.5px] text-muted">{previewError}</div>
          <div className="mt-6">
            <Link to="/login" className="nf-btn nf-btn--primary">
              {t("scan_photo.login_fallback")}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="min-h-dvh grid place-items-center text-center px-4">
        <div className="text-[14px] text-muted">{t("common.loading")}</div>
      </div>
    );
  }

  return (
    <div
      className="min-h-dvh"
      style={{
        paddingTop: "max(env(safe-area-inset-top), 20px)",
        paddingBottom: "max(env(safe-area-inset-bottom), 20px)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
        background: "var(--bg)",
      }}
    >
      <div className="max-w-[440px] mx-auto px-5">
        <div className="text-center">
          <Eyebrow>{isCheckIn ? "ПРИХОД НА СМЕНУ" : "ЗАВЕРШЕНИЕ СМЕНЫ"}</Eyebrow>
          <h1 className="mt-3 text-[26px] font-bold tracking-tight">
            {preview.operator.full_name}
          </h1>
          {preview.on_shift && preview.checked_in_at && (
            <div className="mt-2 text-[13.5px] text-muted inline-flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              {t("scan_photo.on_shift_since", { t: fmtTime(preview.checked_in_at) })}
            </div>
          )}
        </div>

        <div
          className="mt-8 rounded-3xl p-6 text-center"
          style={{ background: bgHex, border: "1px solid var(--border)" }}
        >
          <div
            className="mx-auto grid place-items-center rounded-full"
            style={{ width: 96, height: 96, background: "var(--surface)" }}
          >
            <Camera className="w-10 h-10" style={{ color: accent }} />
          </div>
          <div className="mt-4 text-[15px] font-semibold">
            {isCheckIn
              ? t("scan_photo.step_take_selfie_in")
              : t("scan_photo.step_take_selfie_out")}
          </div>
          <div className="mt-1.5 text-[13px] text-muted max-w-[280px] mx-auto">
            {t("scan_photo.face_required_hint")}
          </div>

          <button
            onClick={() => {
              setError("");
              setCameraOpen(true);
            }}
            disabled={pending}
            className="mt-6 w-full grid place-items-center rounded-2xl font-bold text-white transition-all active:scale-[.98] disabled:opacity-60"
            style={{
              height: 60,
              fontSize: 17,
              background: isCheckIn
                ? "linear-gradient(180deg, #16a34a, #15803d)"
                : "linear-gradient(180deg, #f97316, #ea580c)",
              boxShadow: isCheckIn
                ? "0 12px 30px -12px rgba(22,163,74,.55)"
                : "0 12px 30px -12px rgba(249,115,22,.55)",
            }}
          >
            <span className="inline-flex items-center gap-2">
              {isCheckIn ? <LogIn className="w-5 h-5" /> : <LogOut className="w-5 h-5" />}
              {isCheckIn
                ? t("scan_photo.open_camera_in")
                : t("scan_photo.open_camera_out")}
            </span>
          </button>

          {error && (
            <div
              className="mt-4 text-[12.5px] rounded-xl px-3 py-2 text-left"
              style={{
                background: "rgba(220,60,40,.10)",
                color: "#dc2626",
              }}
            >
              <XCircle className="w-4 h-4 inline mr-1 -mt-0.5" />
              {error}
            </div>
          )}

          {pending && (
            <div className="mt-3 text-[12.5px] text-muted">
              {t("scan_photo.uploading")}
            </div>
          )}
        </div>

        <div className="mt-6 text-center">
          <Link
            to="/login"
            className="text-[12.5px] text-muted underline underline-offset-4"
          >
            {t("scan_photo.login_fallback")}
          </Link>
        </div>
      </div>

      {cameraOpen && (
        <CameraCapture
          onCapture={(f) => submitPhoto(f)}
          onCancel={() => setCameraOpen(false)}
        />
      )}

      <AnimatePresence>
        {result && (
          <SuccessOverlay
            result={result}
            onDismiss={() => setResult(null)}
            isCheckIn={result.action === "check_in"}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function SuccessOverlay({
  result,
  onDismiss,
  isCheckIn,
}: {
  result: ScanResult;
  onDismiss: () => void;
  isCheckIn: boolean;
}) {
  const t = useT();
  const accent = isCheckIn ? "#16a34a" : "#f97316";
  const bg = isCheckIn ? "rgba(22,163,74,.16)" : "rgba(249,115,22,.16)";
  const iso = isCheckIn ? result.checked_in_at : result.checked_out_at;
  const time = fmtTime(iso);
  const dur = fmtDuration(result.duration_min);
  const photoUrl = result.photo_url
    ? result.photo_url.startsWith("http")
      ? result.photo_url
      : `${API_BASE_URL.replace(/\/api$/, "")}${result.photo_url}`
    : null;

  return (
    <motion.div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{
        background: "rgba(0,0,0,.55)",
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onDismiss}
    >
      <motion.div
        className="w-full max-w-[380px] rounded-3xl p-8 text-center relative"
        style={{ background: "var(--surface)" }}
        initial={{ scale: 0.85, y: 20, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        transition={{ type: "spring", damping: 18, stiffness: 220 }}
        onClick={(e) => e.stopPropagation()}
      >
        <motion.div
          className="mx-auto grid place-items-center rounded-full"
          style={{ width: 112, height: 112, background: bg }}
          initial={{ scale: 0 }}
          animate={{ scale: [0, 1.15, 1] }}
          transition={{ duration: 0.55, times: [0, 0.7, 1] }}
        >
          <CheckCircle2 className="w-16 h-16" style={{ color: accent }} />
        </motion.div>

        <motion.div
          className="mt-5 text-[12px] font-bold uppercase tracking-widest"
          style={{ color: accent }}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
        >
          {isCheckIn ? t("scan_photo.done_checkin") : t("scan_photo.done_checkout")}
        </motion.div>

        <motion.div
          className="mt-2 text-[22px] font-bold tracking-tight"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.32 }}
        >
          {result.operator.full_name}
        </motion.div>

        <motion.div
          className="mt-3 text-[15px]"
          style={{ color: "var(--muted)" }}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
        >
          {isCheckIn
            ? t("scan_photo.checkin_at", { t: time })
            : t("scan_photo.checkout_at", { t: time })}
          {!isCheckIn && dur ? (
            <div className="mt-1 text-[13.5px]">
              {t("scan_photo.duration_label", { d: dur })}
            </div>
          ) : null}
          {isCheckIn && result.was_late && (
            <div
              className="mt-3 inline-block rounded-full px-3 py-1 text-[12px] font-semibold"
              style={{
                background: "rgba(220,38,38,.12)",
                color: "#dc2626",
              }}
            >
              {t("scan_photo.late_badge")}
            </div>
          )}
        </motion.div>

        {photoUrl && (
          <motion.img
            src={photoUrl}
            alt="photo"
            className="mt-5 mx-auto rounded-2xl object-cover"
            style={{ width: 100, height: 100 }}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.5 }}
          />
        )}

        <div className="mt-7">
          <Button onClick={onDismiss}>{t("common.done")}</Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
