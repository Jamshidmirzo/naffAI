import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, Calendar, Moon, User, X } from "lucide-react";
import { api } from "../lib/api";
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

export default function AttendanceToday() {
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [closingLog, setClosingLog] = useState<{ id: number; name: string } | null>(null);
  const [closeNote, setCloseNote] = useState("");

  const t = useT();
  usePageHeader({ title: t("attendance.today.title"), subtitle: t("attendance.today.subtitle") }, [t("attendance.today.title")]);

  const { data: report, isLoading, refetch } = useQuery<AttendanceReport>({
    queryKey: ["attendance-report", date],
    queryFn: () =>
      api.get<AttendanceReport>(`/attendance/report/?date=${date}`).then((r) => r.data),
    refetchInterval: 60_000,
  });

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
            <Link to="/scan" target="_blank">
              <Button>{t("attendance.today.open_scan")}</Button>
            </Link>
            <Button variant="ghost" onClick={() => toast(t("attendance.today.png_soon"))}>
              {t("op_detail.download_png")}
            </Button>
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

      {/* Date filter */}
      <section className="flex items-center gap-3">
        <span className="nf-col flex items-center gap-1.5">
          <Calendar className="w-3.5 h-3.5" /> {t("common.date")}:
        </span>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="nf-input py-2 px-3.5 w-auto text-[13px]"
        />
      </section>

      {/* Present operators table */}
      <section className="nf-card overflow-hidden">
        <div className="px-6 pt-5 pb-3 text-[15px] font-semibold tracking-tight">
          {t("attendance.today.on_shift_title")}
        </div>
        <div
          className="grid gap-2 px-6 pb-3 nf-col"
          style={{ gridTemplateColumns: "1.3fr .8fr .8fr .7fr .6fr .5fr .8fr" }}
        >
          <div>{t("common.operator")}</div>
          <div>{t("op_detail.att_arrived")}</div>
          <div>{t("op_detail.att_left")}</div>
          <div>{t("op_detail.att_duration")}</div>
          <div className="text-center">{t("op_detail.att_late")}</div>
          <div className="text-center">{t("op_detail.att_channel")}</div>
          <div className="text-right">{t("common.actions")}</div>
        </div>
        {isLoading ? (
          <div className="text-center text-muted py-12 text-[13px]">{t("common.loading")}</div>
        ) : (report?.present.length ?? 0) === 0 ? (
          <div className="text-center text-muted py-12 text-[13px]">
            {t("attendance.today.none_yet")}
          </div>
        ) : (
          <div>
            {(report?.present ?? []).map((e, i) => (
              <div
                key={e.id}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns: "1.3fr .8fr .8fr .7fr .6fr .5fr .8fr",
                  animationDelay: `${0.02 + i * 0.035}s`,
                  cursor: "default",
                }}
              >
                <div className="font-medium truncate flex items-center gap-2">
                  <span
                    className="w-2 h-2 rounded-full inline-block"
                    style={{
                      background: e.checked_out_at ? "var(--faint2)" : "var(--accent)",
                    }}
                  />
                  {e.operator_name}
                </div>
                <div className="text-muted tabular-nums">{fmtTime(e.checked_in_at)}</div>
                <div>
                  {e.checked_out_at ? (
                    <span className="text-muted tabular-nums">
                      {fmtTime(e.checked_out_at)}
                    </span>
                  ) : e.auto_closed ? (
                    <span className="text-muted text-[12px] inline-flex items-center gap-1">
                      <Moon className="w-3 h-3" /> {t("attendance.today.auto_2300")}
                    </span>
                  ) : (
                    <StatusBadge tone="hot">{t("op_detail.on_shift")}</StatusBadge>
                  )}
                </div>
                <div className="text-muted tabular-nums">
                  {e.duration_min !== null ? t("op_detail.minutes_short", { n: e.duration_min }) : "—"}
                </div>
                <div className="text-center">
                  {e.was_late ? (
                    <span
                      style={{ color: "var(--accent)" }}
                      className="inline-flex items-center gap-0.5 text-[12px] font-semibold"
                    >
                      <AlertTriangle className="w-3 h-3" /> {t("common.yes").toLowerCase()}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </div>
                <div className="text-center text-[11px] uppercase text-muted tracking-wide">
                  {e.source}
                </div>
                <div className="text-right">
                  {!e.checked_out_at && !e.auto_closed && (
                    <button
                      onClick={() =>
                        setClosingLog({ id: e.id, name: e.operator_name })
                      }
                      className="text-[12px] font-semibold px-2.5 py-1.5 rounded-full transition"
                      style={{
                        background: "rgba(220,60,40,.1)",
                        color: "var(--danger)",
                      }}
                    >
                      {t("op_detail.close_shift_btn")}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Absent list */}
      {report?.absent && report.absent.length > 0 && (
        <section className="nf-card overflow-hidden">
          <div className="px-6 pt-5 pb-3 text-[15px] font-semibold tracking-tight">
            {t("attendance.today.absent_title", { n: report.absent.length })}
          </div>
          <div>
            {report.absent.map((op, i) => (
              <div
                key={op.id}
                className="nf-row animate-nfFadeUp"
                style={{
                  gridTemplateColumns: "1fr",
                  padding: "12px 24px",
                  animationDelay: `${0.02 + i * 0.03}s`,
                  cursor: "default",
                }}
              >
                <div className="flex items-center gap-2.5">
                  <User className="w-3.5 h-3.5 text-muted" />
                  <span>{op.full_name}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

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
