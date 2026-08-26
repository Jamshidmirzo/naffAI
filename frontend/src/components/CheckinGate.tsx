import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import qrcode from "qrcode-generator";
import { QrCode as QrCodeIcon, Smartphone } from "lucide-react";
import { useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { apiErrorMessage } from "../lib/api-types";
import { useT } from "../lib/i18n";

/**
 * Fullscreen «Отметьтесь чтобы работать» gate для операторов (enforcement
 * wave 2026-08-26).
 *
 * Показывается ТОЛЬКО когда:
 *   - `require_checkin_enabled === true` в /attendance/me/current/;
 *   - `open_log === null` (оператор не на смене);
 *   - `pending_backfill_log === null` (у CheckoutBackfillGate приоритет);
 *   - маршрут НЕ в whitelist'e для отметки (/scan, /scan-photo).
 *
 * Backend НИКАКИЕ endpoints не блокирует по require_checkin_enabled —
 * enforcement только на UI, поэтому оператор физически может обойти через
 * F12/curl. Это осознанный компромисс за простоту (см. план).
 *
 * Модал НЕ закрывается кликом-снаружи и не имеет крестика. Poll'им
 * /attendance/me/current/ каждые 5 секунд — как только open_log
 * появляется (оператор отсканировал QR с телефона и снял селфи), гейт
 * пропадает сам.
 */

type OpenLog = {
  id: number;
  checked_in_at: string;
  was_late: boolean;
  checkin_photo_url?: string | null;
  checkout_reminder_sent_at?: string | null;
} | null;

type MeCurrent = {
  open_log: OpenLog;
  operator_id?: number;
  require_checkin_enabled?: boolean;
  checkout_reminder_active?: boolean;
  pending_backfill_log?: { id: number } | null;
};

type MeQrToken = {
  operator_id: number;
  operator_name: string;
  payload: string;
  url: string;
  nonce_prefix: string;
};

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

// Whitelist маршрутов, где гейт не должен мешать — фактическая страница
// отметки должна работать. `/scan` — публичный photo-flow (HMAC QR
// payload), `/scan-photo` — legacy alias.
const WHITELIST_PATHS = new Set(["/scan", "/scan-photo", "/kiosk", "/login"]);

export default function CheckinGate() {
  const t = useT();
  const qc = useQueryClient();
  const loc = useLocation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const { data: current } = useQuery<MeCurrent>({
    queryKey: ["me-attendance-current"],
    queryFn: () => api.get<MeCurrent>("/attendance/me/current/").then((r) => r.data),
    // Держим poll быстрым пока гейт скорее всего активен — оператор
    // ждёт закрытия модалки.
    refetchInterval: 5_000,
    retry: false,
  });

  const shouldShow = useMemo(() => {
    if (!current) return false;
    if (!current.require_checkin_enabled) return false;
    if (current.open_log) return false;
    // Приоритет у backfill-gate — если он активен, checkin-gate уступает.
    if (current.pending_backfill_log) return false;
    if (WHITELIST_PATHS.has(loc.pathname)) return false;
    return true;
  }, [current, loc.pathname]);

  // QR token fetch — только когда гейт активен, чтобы не бить API даром.
  const spaOrigin =
    typeof window !== "undefined" ? window.location.origin : "ssr";
  const { data: token, isPending, isError, error } = useQuery<MeQrToken>({
    queryKey: ["me-attendance-qr-token", spaOrigin],
    queryFn: () =>
      api
        .get<MeQrToken>("/attendance/me/qr-token/", {
          params: { origin: spaOrigin },
        })
        .then((r) => r.data),
    enabled: shouldShow,
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    if (canvasRef.current && token?.url) {
      renderQrToCanvas(canvasRef.current, token.url);
    }
  }, [token?.url, shouldShow]);

  // Автозакрытие: как только open_log появился в poll'e — сообщаем прочим
  // виджетам через invalidateQueries (AttendanceStatusWidget использует
  // тот же ключ). Модал схлопнется сам, т.к. shouldShow=false.
  useEffect(() => {
    if (current?.open_log) {
      qc.invalidateQueries({ queryKey: ["me-attendance-current"] });
    }
  }, [current?.open_log, qc]);

  if (!shouldShow) return null;

  return (
    <motion.div
      className="fixed inset-0 z-[300] flex items-center justify-center p-4"
      // ~91% чёрный overlay — плотнее чем у обычных модалок, чтобы было
      // очевидно, что за ним ничего не кликается.
      style={{ background: "rgba(0,0,0,.72)", backdropFilter: "blur(6px)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      // click-outside намеренно НЕ закрывает — операторы находят «щёлк
      // мимо» и работают без отметки. Единственный exit — успешный QR-скан.
    >
      <motion.div
        className="w-full max-w-[440px] rounded-3xl p-7 relative"
        style={{ background: "var(--surface)" }}
        initial={{ scale: 0.92, y: 24, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        transition={{ type: "spring", damping: 22, stiffness: 240 }}
      >
        <div className="text-center">
          <div
            className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest"
            style={{ color: "#16a34a" }}
          >
            <Smartphone className="w-3.5 h-3.5" />
            {t("checkin_gate.eyebrow")}
          </div>
          <div
            className="mt-2 font-bold tracking-tight"
            style={{ fontSize: 22, letterSpacing: "-0.02em" }}
          >
            {t("checkin_gate.title")}
          </div>
          <div className="mt-2 text-[13.5px] text-muted max-w-[340px] mx-auto leading-snug">
            {t("checkin_gate.subtitle")}
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
          style={{ background: "rgba(22,163,74,.10)", color: "var(--text)" }}
        >
          <div className="font-semibold mb-1" style={{ color: "#16a34a" }}>
            {t("checkin_gate.steps_title")}
          </div>
          <ol className="pl-5 space-y-0.5 list-decimal">
            <li>{t("att_widget.qr_step_1")}</li>
            <li>{t("att_widget.qr_step_2")}</li>
            <li>{t("att_widget.qr_step_3")}</li>
          </ol>
        </div>

        <div
          className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest"
          style={{ color: "var(--muted)" }}
        >
          <QrCodeIcon className="w-3 h-3" />
          {t("att_widget.qr_waiting")}
        </div>
      </motion.div>
    </motion.div>
  );
}
