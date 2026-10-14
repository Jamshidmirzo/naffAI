import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import qrcode from "qrcode-generator";
import { Camera, Check, RefreshCw, X } from "lucide-react";
import { api } from "../../lib/api";
import { apiErrorMessage } from "../../lib/api-types";
import { toast } from "../../components/ui";
import CameraCapture from "../../components/CameraCapture";
import { useTheme } from "../../store/theme";
import { useT2 } from "../i18n";

/**
 * Shared pieces of the attendance flow used by the v2 check-in gate, the
 * checkout reminder banner and the shift card on /my. Behaviour is copied
 * 1:1 from components/AttendanceStatusWidget.tsx (QR modal → phone scan,
 * fallback to the PC camera → POST /attendance/me/toggle/ with photo).
 */

export type OpenLog = {
  id: number;
  checked_in_at: string;
  was_late: boolean;
  checkin_photo_url?: string | null;
  checkout_reminder_sent_at?: string | null;
} | null;

export type MeCurrent = {
  open_log: OpenLog;
  operator_id?: number;
  today_events?: Array<{ id: number; checked_in_at: string; checked_out_at: string | null; was_late: boolean; auto_closed: boolean }>;
  require_checkin_enabled?: boolean;
  checkout_reminder_active?: boolean;
  pending_backfill_log?: { id: number; checked_in_at: string; auto_closed_at: string | null } | null;
};

export type MeQrToken = {
  operator_id: number;
  operator_name: string;
  payload: string;
  url: string;
  nonce_prefix: string;
};

export type ShiftResult = {
  action: "check_in" | "check_out";
  time: string;
  duration_min?: number;
  photo_url?: string;
  was_late?: boolean;
};

/** Same key/endpoint as every old attendance component — one shared cache. */
export function useMeCurrent(refetchInterval: number) {
  return useQuery<MeCurrent>({
    queryKey: ["me-attendance-current"],
    queryFn: () => api.get<MeCurrent>("/attendance/me/current/").then((r) => r.data),
    refetchInterval,
    retry: false,
  });
}

export function hm(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/** «8 ч 12 мин» from minutes. */
export function useFmtDur() {
  const t = useT2();
  return (minutes: number) => {
    const m = Math.max(0, Math.floor(minutes));
    const h = Math.floor(m / 60);
    return h > 0 ? t("v2.ov.shift.dur", { h, m: m % 60 }) : t("v2.ov.shift.durMin", { m });
  };
}

export function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
}

/** Fixed full-screen layer portaled to <body>, carrying the Атлас tokens. */
export function Layer({ z, children, style }: { z: number; children: ReactNode; style?: CSSProperties }) {
  const theme = useTheme((s) => s.theme);
  return createPortal(
    <div className="nf" data-theme={theme} style={{ position: "fixed", inset: 0, zIndex: z, background: "transparent", ...style }}>
      {children}
    </div>,
    document.body,
  );
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
      if (qr.isDark(r, c)) ctx.fillRect((c + QR_MARGIN) * QR_CELL, (r + QR_MARGIN) * QR_CELL, QR_CELL, QR_CELL);
    }
  }
}

/** White QR tile with loading / error states. */
export function QrBox({ token, isPending, isError, error, size = 240 }: { token?: MeQrToken; isPending: boolean; isError: boolean; error: unknown; size?: number }) {
  const t = useT2();
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (ref.current && token?.url) renderQrToCanvas(ref.current, token.url);
  }, [token?.url]);
  return (
    <div
      style={{
        width: size,
        height: size,
        maxWidth: "72vw",
        maxHeight: "72vw",
        padding: 10,
        background: "#FFFFFF",
        borderRadius: 14,
        border: "1px solid var(--line)",
        display: "grid",
        placeItems: "center",
        alignSelf: "center",
        flex: "none",
      }}
    >
      {token ? (
        <canvas ref={ref} aria-label="QR" style={{ width: "100%", height: "100%", imageRendering: "pixelated" }} />
      ) : isError ? (
        <span className="s" style={{ color: "var(--bad)", textAlign: "center", padding: 8 }}>{apiErrorMessage(error)}</span>
      ) : isPending ? (
        <span className="s" style={{ color: "var(--ink-3)" }}>{t("v2.ov.qr.loading")}</span>
      ) : null}
    </div>
  );
}

export function QrSteps() {
  const t = useT2();
  return (
    <ol className="col g6 s" style={{ paddingLeft: 20, margin: 0 }}>
      <li>{t("v2.ov.qr.step1")}</li>
      <li>{t("v2.ov.qr.step2")}</li>
      <li>{t("v2.ov.qr.step3")}</li>
    </ol>
  );
}

export function QrWaiting() {
  const t = useT2();
  return (
    <div className="row g8 s c3">
      <RefreshCw className="ic v2-ov-spin" />
      {t("v2.ov.qr.waiting")}
      <style>{`@keyframes v2-ov-spin{to{transform:rotate(-360deg)}}.v2-ov-spin{animation:v2-ov-spin 2.4s linear infinite}@media (prefers-reduced-motion: reduce){.v2-ov-spin{animation:none}}`}</style>
    </div>
  );
}

/**
 * QR window (OpSheetShift «Отметка через телефон»). Fetch is identical to
 * the widget's QrScanModal: origin-keyed, never cached.
 */
export function ShiftQrDialog({ isCheckIn, onClose, onFallbackCamera, z = 180 }: { isCheckIn: boolean; onClose: () => void; onFallbackCamera: () => void; z?: number }) {
  const t = useT2();
  const spaOrigin = typeof window !== "undefined" ? window.location.origin : "ssr";
  const { data: token, isPending, isError, error } = useQuery<MeQrToken>({
    queryKey: ["me-attendance-qr-token", spaOrigin],
    queryFn: () => api.get<MeQrToken>("/attendance/me/qr-token/", { params: { origin: spaOrigin } }).then((r) => r.data),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <Layer z={z}>
      <div className="scrim" onClick={onClose} />
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "none" }}>
        <section className="dlg" role="dialog" aria-modal="true" aria-labelledby="v2-qr-title" style={{ width: 440, maxWidth: "100%", maxHeight: "calc(100vh - 32px)", overflow: "auto", pointerEvents: "auto" }}>
          <div className="dlg-h">
            <div className="col g4">
              <span className="lbl" style={{ color: "var(--brand-text)" }}>{isCheckIn ? t("v2.ov.qr.in") : t("v2.ov.qr.out")}</span>
              <h2 className="h2" id="v2-qr-title">{t("v2.ov.qr.title")}</h2>
              <span className="s c3">{t("v2.ov.qr.hint")}</span>
            </div>
            <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("common.close")} onClick={onClose}>
              <X className="ic" />
            </button>
          </div>
          <div className="dlg-b">
            <QrBox token={token} isPending={isPending} isError={isError} error={error} size={220} />
            <QrSteps />
            <QrWaiting />
          </div>
          <div className="dlg-f">
            <button className="btn btn-ghost" type="button" onClick={onFallbackCamera}>
              <Camera className="ic" />
              {t("v2.ov.qr.pcCamera")}
            </button>
          </div>
        </section>
      </div>
    </Layer>
  );
}

/** «Смена начата / завершена» card (OpSheetShift), auto-closes like the old widget (4.2 s). */
export function ShiftResultCard({ result, onClose, z = 200 }: { result: ShiftResult; onClose: () => void; z?: number }) {
  const t = useT2();
  const fmtDur = useFmtDur();
  const [left, setLeft] = useState(4);
  useEffect(() => {
    const id = window.setInterval(() => setLeft((v) => Math.max(0, v - 1)), 1000);
    return () => window.clearInterval(id);
  }, []);
  const isIn = result.action === "check_in";
  const meta: string[] = [];
  if (!isIn && result.duration_min) meta.push(t("v2.ov.done.worked", { dur: fmtDur(result.duration_min) }));
  meta.push(t("v2.ov.done.closes", { n: left }));
  return (
    <Layer z={z}>
      <div className="scrim" onClick={onClose} />
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "none" }}>
        <section className="card col" role="status" aria-live="polite" onClick={(e) => e.stopPropagation()} style={{ width: 400, maxWidth: "100%", overflow: "hidden", alignItems: "center", textAlign: "center", paddingBottom: 20, gap: 6, pointerEvents: "auto", boxShadow: "var(--shadow)" }}>
          <span className="icon-tile t-ok" style={{ width: 52, height: 52, borderRadius: 16, marginTop: 18 }}>
            <Check className="ic ic-l" />
          </span>
          <span className="lbl" style={{ color: "var(--ok)", marginTop: 8 }}>{isIn ? t("v2.ov.done.in") : t("v2.ov.done.out")}</span>
          <span className="display" style={{ fontSize: 20 }}>
            {isIn ? t("v2.ov.done.inAt") : t("v2.ov.done.outAt")} <span className="num">{hm(result.time)}</span>
          </span>
          {isIn && result.was_late ? <span className="badge b-bad">{t("v2.ov.shift.late")}</span> : null}
          <span className="s c3" style={{ padding: "0 20px" }}>{meta.join(" · ")}</span>
        </section>
      </div>
    </Layer>
  );
}

/**
 * The widget's state machine: QR window → (phone scan detected by polling
 * open_log) or PC camera → toggle with photo → result card.
 * `z` is the base layer for its windows (the gate passes a value above itself).
 */
export function useShiftFlow({ z = 180 }: { z?: number } = {}) {
  const t = useT2();
  const qc = useQueryClient();
  const [qr, setQr] = useState<{ isCheckIn: boolean } | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [lastResult, setLastResult] = useState<ShiftResult | null>(null);

  // Poll faster while the QR window is open (5 s) — same as the old widget.
  const current = useMeCurrent(qr ? 5_000 : 60_000);
  const openLog = current.data?.open_log ?? null;

  useEffect(() => {
    if (!lastResult) return;
    const id = window.setTimeout(() => setLastResult(null), 4200);
    return () => window.clearTimeout(id);
  }, [lastResult]);

  // Shift state flipped while the QR window was up → phone-side scan succeeded.
  const openLogIdRef = useRef<number | null>(openLog?.id ?? null);
  useEffect(() => {
    if (!qr) {
      openLogIdRef.current = openLog?.id ?? null;
      return;
    }
    const prev = openLogIdRef.current;
    const now = openLog?.id ?? null;
    if (prev !== now) {
      if (!prev && now && openLog) {
        setLastResult({ action: "check_in", time: openLog.checked_in_at, was_late: openLog.was_late, photo_url: openLog.checkin_photo_url || undefined });
      } else if (prev && !now) {
        setLastResult({ action: "check_out", time: new Date().toISOString() });
      }
      setQr(null);
      openLogIdRef.current = now;
    }
  }, [qr, openLog]);

  const submitPhoto = async (file: File) => {
    setPending(true);
    try {
      const fd = new FormData();
      fd.append("photo", file);
      fd.append("require_photo", "1");
      const r = await api.post("/attendance/me/toggle/", fd, { headers: { "Content-Type": "multipart/form-data" }, timeout: 60_000 });
      const data = r.data as { action: "check_in" | "check_out"; checked_in_at?: string; checked_out_at?: string; duration_min?: number; was_late?: boolean; photo_url?: string };
      const time = data.action === "check_in" ? data.checked_in_at : data.checked_out_at;
      setLastResult({ action: data.action, time: time || new Date().toISOString(), duration_min: data.duration_min, was_late: data.was_late, photo_url: data.photo_url });
      await current.refetch();
      qc.invalidateQueries({ queryKey: ["me-attendance-current"] });
    } catch (e) {
      // "photo_duplicate" usually means the previous submit already went through.
      toast.error(apiErrorMessage(e), { action: { label: t("v2.ov.shift.checkStatus"), onClick: () => void current.refetch() } });
    } finally {
      setPending(false);
      setCameraOpen(false);
    }
  };

  const node = (
    <>
      {qr ? (
        <ShiftQrDialog
          isCheckIn={qr.isCheckIn}
          z={z}
          onClose={() => setQr(null)}
          onFallbackCamera={() => {
            setQr(null);
            setCameraOpen(true);
          }}
        />
      ) : null}
      {cameraOpen ? (
        <Layer z={z + 5}>
          <CameraCapture onCapture={submitPhoto} onCancel={() => setCameraOpen(false)} />
        </Layer>
      ) : null}
      {lastResult ? <ShiftResultCard result={lastResult} z={z + 10} onClose={() => setLastResult(null)} /> : null}
    </>
  );

  return {
    current,
    openLog,
    pending,
    openQr: (isCheckIn: boolean) => setQr({ isCheckIn }),
    openCamera: () => setCameraOpen(true),
    showResult: setLastResult,
    hasResult: !!lastResult,
    node,
  };
}
