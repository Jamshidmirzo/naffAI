import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import qrcode from "qrcode-generator";
import {
  Camera,
  CheckCircle2,
  Clock,
  LogIn,
  LogOut,
  QrCode as QrCodeIcon,
  Smartphone,
  Timer,
  X,
} from "lucide-react";
import { api, API_BASE_URL } from "../lib/api";
import { apiErrorMessage } from "../lib/api-types";
import { useT } from "../lib/i18n";
import { toast } from "./ui";
import CameraCapture from "./CameraCapture";

type OpenLog = {
  id: number;
  checked_in_at: string;
  was_late: boolean;
  checkin_photo_url?: string | null;
} | null;

type MeCurrent = {
  open_log: OpenLog;
  operator_id?: number;
  today_events: Array<{
    id: number;
    checked_in_at: string;
    checked_out_at: string | null;
    was_late: boolean;
    auto_closed: boolean;
  }>;
};

type MeQrToken = {
  operator_id: number;
  operator_name: string;
  payload: string;
  url: string;
  nonce_prefix: string;
};

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtLiveDuration(fromIso: string): string {
  const ms = Date.now() - new Date(fromIso).getTime();
  if (ms < 0) return "0 мин";
  const total = Math.floor(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h <= 0) return `${m} мин`;
  return `${h} ч ${m} мин`;
}

const QR_CELL = 8;
const QR_MARGIN = 2;

function renderQrToCanvas(canvas: HTMLCanvasElement, text: string) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const size = (count + QR_MARGIN * 2) * QR_CELL;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#101013";
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect(
          (c + QR_MARGIN) * QR_CELL,
          (r + QR_MARGIN) * QR_CELL,
          QR_CELL,
          QR_CELL,
        );
      }
    }
  }
}

/**
 * Compact "current shift" widget for the operator dashboard.
 *
 *  - Green "Начать смену" when no open log.
 *  - Orange "Завершить смену" + live-ticking duration otherwise.
 *  - Tap → **QR modal** (default) — операторские рабочие компы обычно
 *    без камеры, поэтому первичный сценарий: показываем оператору его
 *    персональный QR, он сканирует его камерой телефона → на телефоне
 *    открывается `/scan?qr=<token>` (ScanPhotoFlow), там уже реальное
 *    фото + submit без логина.
 *  - Опциональная secondary-кнопка "Камера этого ПК" → CameraCapture
 *    как раньше, для рабочих мест с веб-камерой.
 *  - На успешный submit (через любой из двух путей) — refresh /me/current.
 *
 * Live-обновление через QR-flow работает не мгновенно (нет push-канала),
 * но `refetchInterval: 15s` (сжат с 60s пока модалка открыта) быстро
 * увидит новый open_log и модалка закроется автоматически.
 */
export default function AttendanceStatusWidget() {
  const t = useT();
  const qc = useQueryClient();
  const [qrOpen, setQrOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [tick, setTickState] = useState(0);
  const [lastResult, setLastResult] = useState<
    { action: "check_in" | "check_out"; time: string; duration_min?: number; photo_url?: string; was_late?: boolean }
    | null
  >(null);

  // Poll faster while the QR modal is open — otherwise the "shift
  // now started" state can lag up to a minute before the modal closes
  // itself. 15s keeps it snappy without hammering the API.
  const { data: current, refetch } = useQuery<MeCurrent>({
    queryKey: ["me-attendance-current"],
    queryFn: () => api.get<MeCurrent>("/attendance/me/current/").then((r) => r.data),
    refetchInterval: qrOpen ? 5_000 : 60_000,
    retry: false,
  });

  // Live ticker for the "on shift for X" counter.
  useEffect(() => {
    const id = window.setInterval(() => setTickState((v) => v + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!lastResult) return;
    const id = window.setTimeout(() => setLastResult(null), 4200);
    return () => window.clearTimeout(id);
  }, [lastResult]);

  const isOn = !!current?.open_log;
  const openLog = current?.open_log;

  // When the modal is open, watch for the shift status flipping — that
  // means the operator's phone-side scan succeeded on the backend.
  const openLogIdRef = useRef<number | null>(openLog?.id ?? null);
  useEffect(() => {
    if (!qrOpen) {
      openLogIdRef.current = openLog?.id ?? null;
      return;
    }
    const prev = openLogIdRef.current;
    const now = openLog?.id ?? null;
    if (prev !== now) {
      // Shift state changed while modal was up → the QR-scan flow
      // completed. Auto-close, show local success confirmation.
      const isCheckIn = !prev && now;
      const isCheckOut = prev && !now;
      if (isCheckIn && openLog) {
        setLastResult({
          action: "check_in",
          time: openLog.checked_in_at,
          was_late: openLog.was_late,
          photo_url: openLog.checkin_photo_url || undefined,
        });
      } else if (isCheckOut) {
        setLastResult({
          action: "check_out",
          time: new Date().toISOString(),
        });
      }
      setQrOpen(false);
      openLogIdRef.current = now;
    }
  }, [qrOpen, openLog]);

  const liveDur = useMemo(() => {
    if (!openLog) return "";
    // `tick` is intentionally read so the memo recomputes.
    void tick;
    return fmtLiveDuration(openLog.checked_in_at);
  }, [openLog, tick]);

  const submitPhoto = async (file: File) => {
    setPending(true);
    try {
      const fd = new FormData();
      fd.append("photo", file);
      fd.append("require_photo", "1");
      const r = await api.post("/attendance/me/toggle/", fd, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 60_000,
      });
      const data = r.data as {
        action: "check_in" | "check_out";
        checked_in_at?: string;
        checked_out_at?: string;
        duration_min?: number;
        was_late?: boolean;
        photo_url?: string;
      };
      const time = data.action === "check_in" ? data.checked_in_at : data.checked_out_at;
      setLastResult({
        action: data.action,
        time: time || new Date().toISOString(),
        duration_min: data.duration_min,
        was_late: data.was_late,
        photo_url: data.photo_url,
      });
      await refetch();
      qc.invalidateQueries({ queryKey: ["me-attendance-current"] });
    } catch (e) {
      // Handle "photo_duplicate" gracefully — usually it means the
      // previous submit actually succeeded server-side; nudge the user
      // to check their current status.
      toast.error(apiErrorMessage(e), {
        action: {
          label: t("att_widget.check_status"),
          onClick: () => {
            refetch();
          },
        },
      });
    } finally {
      setPending(false);
      setCameraOpen(false);
    }
  };

  return (
    <div
      className="nf-card p-5 relative overflow-hidden"
      style={{
        background: isOn
          ? "linear-gradient(135deg, rgba(249,115,22,.08), rgba(249,115,22,.02))"
          : "linear-gradient(135deg, rgba(22,163,74,.08), rgba(22,163,74,.02))",
        border: "1px solid var(--border)",
        borderRadius: 20,
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div
            className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider"
            style={{ color: isOn ? "#f97316" : "#16a34a" }}
          >
            {isOn ? <Timer className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
            {isOn ? t("att_widget.on_shift") : t("att_widget.off_shift")}
          </div>
          <div className="mt-1.5 text-[18px] font-bold tracking-tight">
            {isOn
              ? t("att_widget.on_shift_since", { t: fmtTime(openLog!.checked_in_at) })
              : t("att_widget.tap_to_start")}
          </div>
          {isOn && (
            <div className="mt-1 text-[12.5px] text-muted tabular-nums">
              {t("att_widget.duration_label")}: <b className="text-text">{liveDur}</b>
              {openLog?.was_late && (
                <span
                  className="ml-2 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold"
                  style={{ background: "rgba(220,38,38,.12)", color: "#dc2626" }}
                >
                  {t("scan_photo.late_badge")}
                </span>
              )}
            </div>
          )}
        </div>
        {openLog?.checkin_photo_url && (
          <img
            src={
              openLog.checkin_photo_url.startsWith("http")
                ? openLog.checkin_photo_url
                : `${API_BASE_URL.replace(/\/api$/, "")}${openLog.checkin_photo_url}`
            }
            alt="checkin"
            className="rounded-xl object-cover shrink-0"
            style={{ width: 52, height: 52 }}
          />
        )}
      </div>

      <button
        onClick={() => setQrOpen(true)}
        disabled={pending}
        className="mt-5 w-full grid place-items-center rounded-2xl font-bold text-white transition-all active:scale-[.98] disabled:opacity-70"
        style={{
          height: 54,
          fontSize: 15.5,
          background: isOn
            ? "linear-gradient(180deg, #f97316, #ea580c)"
            : "linear-gradient(180deg, #16a34a, #15803d)",
          boxShadow: isOn
            ? "0 10px 24px -12px rgba(249,115,22,.55)"
            : "0 10px 24px -12px rgba(22,163,74,.55)",
        }}
      >
        {pending ? (
          t("att_widget.sending")
        ) : (
          <span className="inline-flex items-center gap-2">
            {isOn ? <LogOut className="w-4.5 h-4.5" /> : <LogIn className="w-4.5 h-4.5" />}
            {isOn ? t("att_widget.btn_check_out") : t("att_widget.btn_check_in")}
          </span>
        )}
      </button>

      {qrOpen && (
        <QrScanModal
          isCheckIn={!isOn}
          onClose={() => setQrOpen(false)}
          onFallbackCamera={() => {
            setQrOpen(false);
            setCameraOpen(true);
          }}
        />
      )}

      {cameraOpen && (
        <CameraCapture
          onCapture={submitPhoto}
          onCancel={() => setCameraOpen(false)}
        />
      )}

      <AnimatePresence>
        {lastResult && (
          <motion.div
            className="fixed inset-0 z-[200] flex items-center justify-center p-4"
            style={{ background: "rgba(0,0,0,.55)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setLastResult(null)}
          >
            <motion.div
              className="w-full max-w-[360px] rounded-3xl p-8 text-center relative"
              style={{ background: "var(--surface)" }}
              initial={{ scale: 0.85, y: 20, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: "spring", damping: 18, stiffness: 220 }}
              onClick={(e) => e.stopPropagation()}
            >
              <motion.div
                className="mx-auto grid place-items-center rounded-full"
                style={{
                  width: 96,
                  height: 96,
                  background:
                    lastResult.action === "check_in"
                      ? "rgba(22,163,74,.15)"
                      : "rgba(249,115,22,.15)",
                }}
                initial={{ scale: 0 }}
                animate={{ scale: [0, 1.15, 1] }}
                transition={{ duration: 0.55, times: [0, 0.7, 1] }}
              >
                <CheckCircle2
                  className="w-14 h-14"
                  style={{
                    color: lastResult.action === "check_in" ? "#16a34a" : "#f97316",
                  }}
                />
              </motion.div>
              <div className="mt-4 text-[13px] font-bold uppercase tracking-wide">
                {lastResult.action === "check_in"
                  ? t("scan_photo.done_checkin")
                  : t("scan_photo.done_checkout")}
              </div>
              <div className="mt-1 text-[15.5px] text-muted">
                {lastResult.action === "check_in"
                  ? t("scan_photo.checkin_at", { t: fmtTime(lastResult.time) })
                  : t("scan_photo.checkout_at", { t: fmtTime(lastResult.time) })}
              </div>
              {lastResult.duration_min && lastResult.action === "check_out" ? (
                <div className="mt-1 text-[13.5px] text-muted">
                  {t("scan_photo.duration_label", {
                    d: `${Math.floor(lastResult.duration_min / 60)} ч ${lastResult.duration_min % 60} мин`,
                  })}
                </div>
              ) : null}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Full-screen modal showing the operator's own QR + instructions.
 *
 * Fetches the operator-scoped payload from `/attendance/me/qr-token/`
 * and renders it as a client-side QR canvas. The QR encodes a URL like
 * `${QR_CHECKIN_URL}?qr=<hmac-payload>` — scanning it with a phone
 * camera opens the ScanPhotoFlow directly, no login required.
 *
 * Secondary: "Использовать камеру этого ПК" bailout button for rare
 * machines that do have a webcam.
 */
function QrScanModal({
  isCheckIn,
  onClose,
  onFallbackCamera,
}: {
  isCheckIn: boolean;
  onClose: () => void;
  onFallbackCamera: () => void;
}) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const { data: token, isPending, isError, error } = useQuery<MeQrToken>({
    queryKey: ["me-attendance-qr-token"],
    queryFn: () =>
      api
        // Pass current SPA origin so the backend builds the QR against
        // this host (demo.naff.flek.uz vs naff.flek.uz) instead of the
        // static QR_CHECKIN_URL — the API base itself is fixed to prod
        // and can't be used as a hint. Backend validates against a
        // whitelist to prevent phishing-URL injection.
        .get<MeQrToken>("/attendance/me/qr-token/", {
          params: { origin: window.location.origin },
        })
        .then((r) => r.data),
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    if (canvasRef.current && token?.url) {
      renderQrToCanvas(canvasRef.current, token.url);
    }
  }, [token?.url]);

  const accent = isCheckIn ? "#16a34a" : "#f97316";
  const accentBg = isCheckIn ? "rgba(22,163,74,.10)" : "rgba(249,115,22,.10)";

  return (
    <motion.div
      className="fixed inset-0 z-[180] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,.6)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className="w-full max-w-[440px] rounded-3xl p-6 relative"
        style={{ background: "var(--surface)" }}
        initial={{ scale: 0.9, y: 20, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        transition={{ type: "spring", damping: 20, stiffness: 220 }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 grid place-items-center rounded-full hover:bg-[color:var(--faint)] transition"
          style={{ width: 36, height: 36 }}
          aria-label={t("common.close")}
        >
          <X className="w-4.5 h-4.5" />
        </button>

        <div className="text-center">
          <div
            className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest"
            style={{ color: accent }}
          >
            <Smartphone className="w-3.5 h-3.5" />
            {isCheckIn
              ? t("attendance.kiosk.qr_expected_checkin")
              : t("attendance.kiosk.qr_expected_checkout")}
          </div>
          <div
            className="mt-2 font-bold tracking-tight"
            style={{ fontSize: 20, letterSpacing: "-0.02em" }}
          >
            {t("att_widget.qr_modal_title")}
          </div>
          <div className="mt-1.5 text-[13px] text-muted max-w-[320px] mx-auto">
            {t("att_widget.qr_modal_hint")}
          </div>
        </div>

        <div
          className="mt-5 mx-auto grid place-items-center"
          style={{
            width: 300,
            height: 300,
            maxWidth: "82vw",
            maxHeight: "82vw",
            padding: 14,
            background: "#fff",
            borderRadius: 20,
            border: "1px solid var(--border)",
            boxShadow: "0 16px 40px -20px rgba(0,0,0,.2)",
          }}
        >
          {isPending && (
            <div className="text-[13px] text-muted">
              {t("attendance.kiosk.loading_qr")}
            </div>
          )}
          {isError && (
            <div className="text-[13px] text-red-500 text-center px-2">
              {apiErrorMessage(error)}
            </div>
          )}
          {token && (
            <canvas
              ref={canvasRef}
              style={{
                width: "100%",
                height: "100%",
                imageRendering: "pixelated",
              }}
              aria-label="QR"
            />
          )}
        </div>

        <div
          className="mt-5 rounded-2xl px-4 py-3 text-[12.5px] leading-relaxed"
          style={{ background: accentBg, color: "var(--text)" }}
        >
          <div className="font-semibold mb-1" style={{ color: accent }}>
            {t("att_widget.qr_steps_title")}
          </div>
          <ol className="pl-5 space-y-0.5 list-decimal">
            <li>{t("att_widget.qr_step_1")}</li>
            <li>{t("att_widget.qr_step_2")}</li>
            <li>{t("att_widget.qr_step_3")}</li>
          </ol>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onFallbackCamera}
            className="inline-flex items-center gap-2 text-[12.5px] text-muted hover:text-text transition underline underline-offset-4"
          >
            <Camera className="w-3.5 h-3.5" />
            {t("att_widget.use_pc_camera")}
          </button>
          <div
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest"
            style={{ color: "var(--muted)" }}
          >
            <QrCodeIcon className="w-3 h-3" />
            {t("att_widget.qr_waiting")}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
