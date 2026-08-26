import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Clock, AlertTriangle } from "lucide-react";
import { api } from "../lib/api";
import { apiErrorMessage } from "../lib/api-types";
import { useT } from "../lib/i18n";

/**
 * Fullscreen backfill-модал «Во сколько вы вчера ушли?» (enforcement
 * wave 2026-08-26).
 *
 * Показывается когда `/attendance/me/current/.pending_backfill_log` не
 * null — то есть за последние 3 дня у оператора есть auto_closed лог,
 * который он ещё не подтвердил вручную. Приоритет ВЫШЕ чем у CheckinGate:
 * сначала закрываем вчерашний долг, потом сегодняшний check-in.
 *
 * Time-picker: HH:MM. Default = 18:00 (типичный конец смены). Клиентская
 * валидация:
 *   - checked_out_at > checked_in_at + 30 минут;
 *   - checked_out_at < checked_in_at + 14 часов (или max_backfill_hours,
 *     точное значение проверяется backend'ом — здесь берём консервативно 14).
 *
 * НЕТ кнопки «пропустить». Модал закрывается только успешным submit'ом.
 */

type PendingBackfill = {
  id: number;
  checked_in_at: string;
  auto_closed_at: string | null;
};

type MeCurrent = {
  open_log: unknown;
  pending_backfill_log: PendingBackfill | null;
  require_checkin_enabled?: boolean;
};

const MAX_BACKFILL_HOURS = 14;

function isoDateLocal(iso: string): string {
  // "YYYY-MM-DD" — локальная дата от isoTime.
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtDateShort(iso: string, lang: "ru" | "uz"): string {
  return new Date(iso).toLocaleDateString(lang === "uz" ? "uz-UZ" : "ru-RU", {
    day: "2-digit",
    month: "short",
  });
}

function fmtTimeShort(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Combine "YYYY-MM-DD" (from checked_in_at) + "HH:MM" (from time-picker)
 * → local ISO string. Backend `parse_datetime` принимает naive и считает
 * его локальным (Tashkent).
 */
function combineDateTime(dateIsoLocal: string, hhmm: string): string {
  return `${dateIsoLocal}T${hhmm}:00`;
}

export default function CheckoutBackfillGate() {
  const t = useT();
  const qc = useQueryClient();

  const { data: current } = useQuery<MeCurrent>({
    queryKey: ["me-attendance-current"],
    queryFn: () => api.get<MeCurrent>("/attendance/me/current/").then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  });

  const pending = current?.pending_backfill_log;
  // Default = check_in + 8h, clamped to 18:00 by default для типичной
  // смены 10:00 → 18:00. Если check_in вечером, берём +8 часов честно.
  const defaultHhmm = useMemo(() => {
    if (!pending) return "18:00";
    const d = new Date(pending.checked_in_at);
    d.setHours(d.getHours() + 8);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  }, [pending]);

  const [hhmm, setHhmm] = useState<string | null>(null);
  // Reset picker когда pending лог сменился (например, оператор быстро
  // отбил два дня подряд).
  const activeHhmm = hhmm ?? defaultHhmm;

  const submit = useMutation({
    mutationFn: async () => {
      if (!pending) throw new Error("no_pending");
      const dateLocal = isoDateLocal(pending.checked_in_at);
      const checkedOutAt = combineDateTime(dateLocal, activeHhmm);
      return api
        .post("/attendance/me/backfill-checkout/", {
          log_id: pending.id,
          checked_out_at: checkedOutAt,
        })
        .then((r) => r.data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me-attendance-current"] });
      setHhmm(null);
    },
  });

  if (!pending) return null;

  const durationInfo = (() => {
    // Показываем оператору, сколько получилось часов, чтобы не ввёл 03:00
    // случайно. Пустая строка если время невалидно.
    try {
      const dateLocal = isoDateLocal(pending.checked_in_at);
      const co = new Date(combineDateTime(dateLocal, activeHhmm));
      const ci = new Date(pending.checked_in_at);
      const minutes = Math.round((co.getTime() - ci.getTime()) / 60_000);
      if (minutes < 30) return { valid: false, text: t("backfill.err_too_short") };
      if (minutes > MAX_BACKFILL_HOURS * 60) {
        return { valid: false, text: t("backfill.err_too_long") };
      }
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return {
        valid: true,
        text: t("backfill.duration_hint", { h, m }),
      };
    } catch {
      return { valid: false, text: "" };
    }
  })();

  return (
    <motion.div
      className="fixed inset-0 z-[310] flex items-center justify-center p-4"
      // Приоритет выше CheckinGate (z-300).
      style={{ background: "rgba(0,0,0,.75)", backdropFilter: "blur(6px)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
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
            style={{ color: "#f97316" }}
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            {t("backfill.eyebrow")}
          </div>
          <div
            className="mt-2 font-bold tracking-tight"
            style={{ fontSize: 22, letterSpacing: "-0.02em" }}
          >
            {t("backfill.title")}
          </div>
          <div className="mt-2 text-[13.5px] text-muted max-w-[340px] mx-auto leading-snug">
            {t("backfill.subtitle", {
              date: fmtDateShort(pending.checked_in_at, "ru"),
              time: fmtTimeShort(pending.checked_in_at),
            })}
          </div>
        </div>

        <div
          className="mt-5 rounded-2xl p-5 flex items-center gap-4"
          style={{
            background: "rgba(249,115,22,.08)",
            border: "1px solid rgba(249,115,22,.25)",
          }}
        >
          <Clock className="w-8 h-8 shrink-0" style={{ color: "#f97316" }} />
          <div className="flex-1">
            <div className="text-[11px] uppercase tracking-wider font-semibold text-muted mb-1">
              {t("backfill.picker_label")}
            </div>
            <input
              type="time"
              className="nf-input tabular-nums text-[22px] font-bold"
              style={{ padding: "8px 12px" }}
              value={activeHhmm}
              onChange={(e) => setHhmm(e.target.value)}
            />
          </div>
        </div>

        <div
          className="mt-3 text-[12.5px] text-center"
          style={{ color: durationInfo.valid ? "var(--muted)" : "#dc2626" }}
        >
          {durationInfo.text}
        </div>

        {submit.isError && (
          <div
            className="mt-3 text-[13px] rounded-xl px-3.5 py-2.5"
            style={{
              background: "rgba(220,60,40,.08)",
              color: "var(--danger)",
              border: "1px solid rgba(220,60,40,.2)",
            }}
          >
            {apiErrorMessage(submit.error)}
          </div>
        )}

        <button
          onClick={() => submit.mutate()}
          disabled={!durationInfo.valid || submit.isPending}
          className="mt-5 w-full grid place-items-center rounded-2xl font-bold text-white transition-all active:scale-[.98] disabled:opacity-60 disabled:cursor-not-allowed"
          style={{
            height: 54,
            fontSize: 15.5,
            background: "linear-gradient(180deg, #f97316, #ea580c)",
            boxShadow: "0 10px 24px -12px rgba(249,115,22,.55)",
          }}
        >
          {submit.isPending ? t("common.saving") : t("backfill.btn_confirm")}
        </button>

        <div className="mt-3 text-[11.5px] text-muted text-center">
          {t("backfill.no_skip_hint")}
        </div>
      </motion.div>
    </motion.div>
  );
}
