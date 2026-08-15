import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  Calendar,
  Camera,
  Clock,
  LogOut as LogOutIcon,
  Moon,
  RefreshCw,
  UserX,
  X,
} from "lucide-react";
import { api, API_BASE_URL } from "../lib/api";
import {
  Button,
  Eyebrow,
  Modal,
  StatusBadge,
  toast,
} from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";
import { DashKpiCard } from "../components/dashboard/KpiCard";

interface AttendanceEvent {
  id: number;
  operator_id: number;
  operator_name: string;
  checked_in_at: string;
  checked_out_at: string | null;
  was_late: boolean;
  duration_min: number | null;
  auto_closed: boolean;
  source: "qr" | "tg" | "manual";
  checkin_photo_url?: string | null;
  checkout_photo_url?: string | null;
}

interface AbsentOperator {
  id: number;
  full_name: string;
}

interface AttendanceReport {
  total_active_operators: number;
  present: AttendanceEvent[];
  late: AttendanceEvent[];
  absent: AbsentOperator[];
  counts: { present: number; late: number; absent: number };
}

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tashkent",
  });
}

function fmtLiveDuration(iso: string, nowTick: number) {
  void nowTick;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "0 мин";
  const total = Math.floor(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

function absoluteMediaUrl(u?: string | null): string | null {
  if (!u) return null;
  if (u.startsWith("http")) return u;
  return `${API_BASE_URL.replace(/\/api$/, "")}${u}`;
}

/**
 * Photo thumbnail w/ click-to-lightbox behaviour. Kept inline (no
 * dependency) — a plain fixed backdrop + centred image is enough for the
 * "manager wants to see who came in" use case.
 */
function PhotoThumb({ url, alt }: { url: string | null; alt: string }) {
  const [open, setOpen] = useState(false);
  if (!url) return null;
  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className="grid place-items-center rounded-lg overflow-hidden transition hover:ring-2 hover:ring-[var(--accent)]"
        style={{ width: 36, height: 36 }}
        title={alt}
      >
        <img src={url} alt={alt} className="w-full h-full object-cover" />
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[300] grid place-items-center p-6"
          style={{ background: "rgba(0,0,0,.85)" }}
          onClick={() => setOpen(false)}
        >
          <div className="relative max-w-[90vw] max-h-[90vh]">
            <img
              src={url}
              alt={alt}
              className="max-w-[90vw] max-h-[90vh] rounded-2xl"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              onClick={() => setOpen(false)}
              className="absolute -top-3 -right-3 rounded-full bg-white text-black grid place-items-center"
              style={{ width: 36, height: 36 }}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// Tashkent-local YYYY-MM-DD — критично! Backend считает «день» по
// таймзоне Ташкента, а `new Date().toISOString()` даёт UTC. При UTC ≤
// 19:00 (Tashkent 00:00) день совпадает, но поздним вечером Ташкента
// мы бы запрашивали УЖЕ ЗАВТРАШНИЙ день по UTC → фильтр показывал бы
// пустой отчёт. Из-за этого менеджер вечером видел «никто не пришёл».
function tashkentLocalDate(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tashkent" });
}

export default function AttendanceToday() {
  const [date, setDate] = useState(tashkentLocalDate);
  const [closingLog, setClosingLog] = useState<{ id: number; name: string } | null>(null);
  const [closeNote, setCloseNote] = useState("");
  const [tick, setTickState] = useState(0);

  const t = useT();
  usePageHeader({ title: t("attendance.today.title"), subtitle: t("attendance.today.subtitle") }, [t("attendance.today.title")]);

  const {
    data: report,
    isLoading,
    isFetching,
    dataUpdatedAt,
    refetch,
  } = useQuery<AttendanceReport>({
    queryKey: ["attendance-report", date],
    queryFn: () =>
      api.get<AttendanceReport>(`/attendance/report/?date=${date}`).then((r) => r.data),
    refetchInterval: 30_000,
    // Возвращение из другой вкладки/окна → сразу обновить, чтобы
    // менеджер не смотрел на устаревший срез.
    refetchOnWindowFocus: true,
  });

  // Tick every 60s so live durations update.
  useEffect(() => {
    const id = window.setInterval(() => setTickState((v) => v + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const { onShift, gone, notCome } = useMemo(() => {
    const on: AttendanceEvent[] = [];
    const g: AttendanceEvent[] = [];
    (report?.present ?? []).forEach((e) => {
      if (e.checked_out_at || e.auto_closed) g.push(e);
      else on.push(e);
    });
    return { onShift: on, gone: g, notCome: report?.absent ?? [] };
  }, [report]);

  const handleCloseSubmit = async () => {
    if (!closingLog) return;
    try {
      await api.post(`/attendance/logs/${closingLog.id}/close/`, { note: closeNote });
      toast.success(t("op_detail.shift_closed"));
      setClosingLog(null);
      setCloseNote("");
      refetch();
    } catch {
      toast.error(t("op_detail.shift_close_failed"));
    }
  };

  return (
    <div className="mx-auto max-w-[1180px] flex flex-col gap-5">
      {/* Hero + QR */}
      <section
        className="nf-hero animate-nfFadeUp"
        style={{
          borderRadius: 24,
          padding: "26px 32px",
          border: "1px solid var(--border)",
        }}
      >
        <div className="grid gap-5 md:grid-cols-[112px,1fr,auto] items-center">
          <div
            className="grid place-items-center"
            style={{
              width: 112,
              height: 112,
              borderRadius: 20,
              background: "var(--surface)",
              border: "1px solid var(--border)",
            }}
          >
            <div className="text-center">
              <div
                className="grid grid-cols-3 gap-0.5 mx-auto"
                style={{ width: 60, height: 60 }}
              >
                {Array.from({ length: 9 }).map((_, i) => (
                  <div
                    key={i}
                    style={{
                      background: i % 3 === 0 || i === 4 ? "var(--text)" : "transparent",
                      borderRadius: 2,
                    }}
                  />
                ))}
              </div>
              <div className="mt-1 text-[9px] font-semibold text-muted uppercase tracking-wide">
                QR
              </div>
            </div>
          </div>
          <div>
            <Eyebrow>QR CHECK-IN</Eyebrow>
            <div
              className="font-semibold mt-2"
              style={{ fontSize: 24, letterSpacing: "-0.025em" }}
            >
              {t("attendance.today.qr_title")}
            </div>
            <div className="text-[13px] text-muted mt-1.5 max-w-md">
              {t("attendance.today.qr_hint")}
            </div>
          </div>
          <div className="flex flex-col gap-2 items-end">
            <Link to="/attendance/kiosk">
              <Button>
                <Camera className="w-3.5 h-3.5" /> {t("attendance.today.open_kiosk")}
              </Button>
            </Link>
            <Link to="/kiosk" target="_blank">
              <Button variant="ghost">{t("attendance.today.open_scan")}</Button>
            </Link>
          </div>
        </div>
      </section>

      {/* KPIs */}
      {report && (
        <section className="grid gap-[13px] grid-cols-1 md:grid-cols-3">
          <DashKpiCard
            index={0}
            label={t("attendance.today.kpi_present")}
            value={report.counts.present}
            format={(n) => `${Math.round(n)} / ${report.total_active_operators}`}
            hint={t("attendance.today.kpi_present_hint")}
          />
          <DashKpiCard
            index={1}
            label={t("attendance.today.kpi_late")}
            value={report.counts.late}
            format={(n) => `${Math.round(n)}`}
            hint={t("attendance.today.kpi_late_hint")}
          />
          <DashKpiCard
            index={2}
            label={t("attendance.today.kpi_absent")}
            value={report.counts.absent}
            format={(n) => `${Math.round(n)}`}
            hint={t("attendance.today.kpi_absent_hint")}
          />
        </section>
      )}

      {/* Date filter + last-updated line so the manager always знает,
          что смотрит на свежий срез (auto-refresh 30 s + on-focus). */}
      <section className="flex items-center gap-3 flex-wrap">
        <span className="nf-col flex items-center gap-1.5">
          <Calendar className="w-3.5 h-3.5" /> {t("common.date")}:
        </span>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="nf-input py-2 px-3.5 w-auto text-[13px]"
        />
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-text transition disabled:opacity-50"
          title={t("attendance.today.refresh")}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
          {t("attendance.today.refresh")}
        </button>
        {dataUpdatedAt > 0 && (
          <span className="text-[11.5px] text-muted tabular-nums">
            {t("attendance.today.updated_at", {
              t: new Date(dataUpdatedAt).toLocaleTimeString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                timeZone: "Asia/Tashkent",
              }),
            })}
          </span>
        )}
      </section>

      {/* Three columns: on-shift / gone / not-come */}
      <section className="grid gap-4 grid-cols-1 lg:grid-cols-3">
        <ColumnCard
          title={t("attendance.today.col_on_shift")}
          accent="#16a34a"
          count={onShift.length}
          isLoading={isLoading}
        >
          {onShift.length === 0 ? (
            <EmptyRow text={t("attendance.today.none_yet")} />
          ) : (
            onShift.map((e) => (
              <RowOnShift
                key={e.id}
                event={e}
                tick={tick}
                onCloseShift={() =>
                  setClosingLog({ id: e.id, name: e.operator_name })
                }
              />
            ))
          )}
        </ColumnCard>

        <ColumnCard
          title={t("attendance.today.col_gone")}
          accent="#f97316"
          count={gone.length}
          isLoading={isLoading}
        >
          {gone.length === 0 ? (
            <EmptyRow text={t("attendance.today.col_gone_empty")} />
          ) : (
            gone.map((e) => <RowGone key={e.id} event={e} />)
          )}
        </ColumnCard>

        <ColumnCard
          title={t("attendance.today.col_absent")}
          accent="#dc2626"
          count={notCome.length}
          isLoading={isLoading}
        >
          {notCome.length === 0 ? (
            <EmptyRow text={t("attendance.today.col_absent_empty")} />
          ) : (
            notCome.map((op) => <RowAbsent key={op.id} op={op} />)
          )}
        </ColumnCard>
      </section>

      {/* Manual close modal */}
      <Modal
        open={!!closingLog}
        onClose={() => setClosingLog(null)}
        width={440}
      >
        <div className="p-7">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <div className="text-[18px] font-semibold tracking-tight">
                {t("op_detail.close_shift_title")}
              </div>
              <div className="text-[13px] text-muted mt-1">
                {closingLog?.name} {t("attendance.today.close_now_hint")}
              </div>
            </div>
            <button
              onClick={() => setClosingLog(null)}
              className="grid place-items-center rounded-full hover:bg-[color:var(--faint)] transition"
              style={{ width: 32, height: 32 }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div>
            <div className="nf-col mb-1.5">{t("op_detail.comment_optional")}</div>
            <textarea
              value={closeNote}
              onChange={(e) => setCloseNote(e.target.value)}
              className="nf-input min-h-[80px]"
              placeholder={t("attendance.today.close_note_ph")}
              maxLength={280}
              rows={3}
            />
          </div>
          <div className="mt-6 flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setClosingLog(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={handleCloseSubmit}>
              {t("op_detail.close_shift_title")}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function ColumnCard({
  title,
  accent,
  count,
  isLoading,
  children,
}: {
  title: string;
  accent: string;
  count: number;
  isLoading: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="nf-card overflow-hidden" style={{ borderRadius: 18 }}>
      <div
        className="flex items-center justify-between px-5 py-4 border-b"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: accent }}
          />
          <div className="text-[14.5px] font-semibold tracking-tight truncate">
            {title}
          </div>
        </div>
        <span
          className="rounded-full px-2.5 py-0.5 text-[11.5px] font-bold tabular-nums"
          style={{
            background: `${accent}15`,
            color: accent,
          }}
        >
          {isLoading ? "…" : count}
        </span>
      </div>
      <div className="divide-y" style={{ borderColor: "var(--border)" }}>
        {isLoading ? <div className="p-6 text-[13px] text-muted text-center">…</div> : children}
      </div>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="p-6 text-[13px] text-muted text-center">{text}</div>;
}

function RowOnShift({
  event,
  tick,
  onCloseShift,
}: {
  event: AttendanceEvent;
  tick: number;
  onCloseShift: () => void;
}) {
  const t = useT();
  return (
    <div className="p-4 flex items-start gap-3 hover:bg-[color:var(--faint)] transition">
      <PhotoThumb
        url={absoluteMediaUrl(event.checkin_photo_url)}
        alt={`checkin ${event.operator_name}`}
      />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold truncate">
          {event.operator_name}
        </div>
        <div className="mt-0.5 text-[12px] text-muted flex items-center gap-1.5">
          <Clock className="w-3 h-3" />
          {t("op_detail.att_arrived")}: <b className="text-text tabular-nums">{fmtTime(event.checked_in_at)}</b>
          {event.was_late && (
            <span
              className="ml-1 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
              style={{ background: "rgba(220,38,38,.12)", color: "#dc2626" }}
            >
              <AlertTriangle className="w-2.5 h-2.5" />
              {t("common.yes").toLowerCase()}
            </span>
          )}
        </div>
        <div className="mt-1 text-[12px] text-muted tabular-nums">
          {t("op_detail.att_duration")}: {fmtLiveDuration(event.checked_in_at, tick)}
        </div>
        <div className="mt-2">
          <StatusBadge tone="hot">{t("op_detail.on_shift")}</StatusBadge>
          <span className="ml-2 text-[10.5px] uppercase tracking-widest text-muted">
            {event.source}
          </span>
        </div>
      </div>
      <button
        onClick={onCloseShift}
        className="text-[11.5px] font-semibold px-2.5 py-1.5 rounded-full transition shrink-0"
        style={{
          background: "rgba(220,60,40,.1)",
          color: "var(--danger)",
        }}
      >
        {t("op_detail.close_shift_btn")}
      </button>
    </div>
  );
}

function RowGone({ event }: { event: AttendanceEvent }) {
  const t = useT();
  return (
    <div className="p-4 flex items-start gap-3 hover:bg-[color:var(--faint)] transition">
      <div className="flex items-center gap-1.5">
        <PhotoThumb
          url={absoluteMediaUrl(event.checkin_photo_url)}
          alt={`checkin ${event.operator_name}`}
        />
        <PhotoThumb
          url={absoluteMediaUrl(event.checkout_photo_url)}
          alt={`checkout ${event.operator_name}`}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold truncate">
          {event.operator_name}
        </div>
        <div className="mt-0.5 text-[12px] text-muted flex items-center flex-wrap gap-x-2">
          <span className="inline-flex items-center gap-1">
            <Clock className="w-3 h-3" />
            <span className="tabular-nums">{fmtTime(event.checked_in_at)}</span>
          </span>
          <span>→</span>
          <span className="inline-flex items-center gap-1">
            <LogOutIcon className="w-3 h-3" />
            <span className="tabular-nums">{fmtTime(event.checked_out_at)}</span>
          </span>
        </div>
        {event.duration_min !== null && (
          <div className="mt-1 text-[12px] text-muted tabular-nums">
            {t("op_detail.att_duration")}:{" "}
            <b className="text-text">
              {Math.floor(event.duration_min / 60)} ч {event.duration_min % 60} мин
            </b>
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {event.auto_closed && (
            <span className="text-muted text-[11px] inline-flex items-center gap-1">
              <Moon className="w-3 h-3" /> {t("attendance.today.auto_2300")}
            </span>
          )}
          {event.was_late && (
            <span
              className="rounded-full px-2 py-0.5 text-[10.5px] font-bold"
              style={{ background: "rgba(220,38,38,.12)", color: "#dc2626" }}
            >
              ⚠ {t("scan_photo.late_badge")}
            </span>
          )}
          <span className="text-[10.5px] uppercase tracking-widest text-muted">
            {event.source}
          </span>
        </div>
      </div>
    </div>
  );
}

function RowAbsent({ op }: { op: AbsentOperator }) {
  return (
    <div className="p-4 flex items-center gap-3">
      <div
        className="grid place-items-center rounded-full"
        style={{
          width: 36,
          height: 36,
          background: "rgba(220,38,38,.10)",
        }}
      >
        <UserX className="w-4 h-4 text-red-500" />
      </div>
      <div className="text-[14px] font-medium truncate flex-1">{op.full_name}</div>
    </div>
  );
}
