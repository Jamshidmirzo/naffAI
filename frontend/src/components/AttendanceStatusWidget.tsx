import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Clock, LogIn, LogOut, Timer, XCircle } from "lucide-react";
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

/**
 * Compact "current shift" widget for the operator dashboard.
 *
 *  - Green "Начать смену" when no open log.
 *  - Orange "Завершить смену" + live-ticking duration otherwise.
 *  - Tap → CameraCapture overlay → POST /attendance/me/toggle/ with photo.
 *  - Success animation, then auto-refresh /me/current.
 */
export default function AttendanceStatusWidget() {
  const t = useT();
  const qc = useQueryClient();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [tick, setTickState] = useState(0);
  const [lastResult, setLastResult] = useState<
    { action: "check_in" | "check_out"; time: string; duration_min?: number; photo_url?: string; was_late?: boolean }
    | null
  >(null);

  const { data: current, refetch } = useQuery<MeCurrent>({
    queryKey: ["me-attendance-current"],
    queryFn: () => api.get<MeCurrent>("/attendance/me/current/").then((r) => r.data),
    refetchInterval: 60_000,
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
      // Force a refresh of the widget + any dashboard cards that watch
      // current attendance.
      await refetch();
      qc.invalidateQueries({ queryKey: ["me-attendance-current"] });
    } catch (e) {
      toast.error(apiErrorMessage(e));
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
        onClick={() => setCameraOpen(true)}
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
