import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, NavLink } from "react-router-dom";
import { Calendar, Camera, Clock, Lock, LogOut, Moon, QrCode, RefreshCw, User, UserX, X } from "lucide-react";
import { toast } from "../../components/ui";
import { useT2 } from "../i18n";
import { CountUp, Dialog, EmptyState, ErrorState, LoadingBlock, PageHeader, cx } from "../ui";
import {
  attFmtTime,
  attMediaUrl,
  attTashkentDate,
  useAttCloseShift,
  useAttDayReport,
  useAttPinStatus,
  useAttSettingsLite,
  type AttAbsent,
  type AttEvent,
} from "../api/team/attendance";

type T2 = ReturnType<typeof useT2>;

/* ── shared bits for the «Смена» pages (exported for Report/Photos/Kiosk) ── */

const ATT_TABS: Array<{ to: string; key: string }> = [
  { to: "/attendance/today", key: "today" },
  { to: "/attendance/report", key: "report" },
  { to: "/attendance/photos", key: "photos" },
  { to: "/attendance/kiosk", key: "kiosk" },
  { to: "/settings/attendance", key: "settings" },
];

/** «Сегодня · Отчёт · Фото · Киоск · Настройки» segmented tabs from the artboards. */
export function AttSeg() {
  const t = useT2();
  return (
    <nav className="seg" aria-label={t("v2.team.attendance.title")} style={{ maxWidth: "100%", overflowX: "auto" }}>
      {ATT_TABS.map((tab) => (
        <NavLink key={tab.to} to={tab.to} end className={({ isActive }) => cx(isActive && "is-on")}>
          {t(`v2.team.attendance.tab.${tab.key}`)}
        </NavLink>
      ))}
    </nav>
  );
}

/** Header badge «PIN введён в 14:02» — from the same status query PinGate uses. */
export function AttPinBadge() {
  const t = useT2();
  const q = useAttPinStatus();
  const d = q.data;
  if (!d?.pin_verified || !d.expires_at) return null;
  const exp = new Date(d.expires_at).getTime();
  const enteredIso = d.ttl_minutes ? new Date(exp - d.ttl_minutes * 60_000).toISOString() : null;
  return (
    <span className="badge" title={t("v2.team.attendance.pinUntil", { t: attFmtTime(d.expires_at) })}>
      <Lock className="ic ic-s" />
      <span className="num">
        {enteredIso ? t("v2.team.attendance.pinAt", { t: attFmtTime(enteredIso) }) : t("v2.team.attendance.pinUntil", { t: attFmtTime(d.expires_at) })}
      </span>
    </span>
  );
}

/** Full-screen photo viewer: Esc, backdrop click and × close it. */
export function AttLightbox({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  const t = useT2();
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,.88)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
    >
      <div style={{ position: "relative", maxWidth: "92vw", maxHeight: "92vh" }}>
        <img src={url} alt={alt} onClick={(e) => e.stopPropagation()} style={{ display: "block", maxWidth: "92vw", maxHeight: "92vh", borderRadius: 16 }} />
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={onClose}
          style={{ position: "absolute", top: -12, right: -12, width: 36, height: 36, borderRadius: "50%", background: "#fff", color: "#000", border: 0, display: "grid", placeItems: "center", cursor: "pointer" }}
        >
          <X size={18} />
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** Duration «4 ч 24 мин». */
export function attFmtDur(t: T2, totalMin: number | null | undefined): string {
  if (totalMin === null || totalMin === undefined || totalMin < 0) return "—";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? t("v2.team.attendance.hm", { h, m }) : t("v2.team.attendance.m", { m });
}

function SrcLabel({ src }: { src: string }) {
  return <span className="lbl" style={{ fontSize: 10 }}>{src}</span>;
}

/** Small square photo tile (or a «вход/уход» placeholder). */
function Thumb({ url, label, alt, size = 44, onOpen }: { url: string | null; label: string; alt: string; size?: number; onOpen: (u: string, a: string) => void }) {
  const t = useT2();
  if (!url) {
    return <span className="ph" style={{ width: size, height: size, fontSize: 9, flex: "none" }}>{label}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(url, alt)}
      title={t("v2.team.attendance.openPhoto")}
      aria-label={`${t("v2.team.attendance.openPhoto")}: ${alt}`}
      style={{ width: size, height: size, flex: "none", padding: 0, border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden", cursor: "zoom-in", background: "var(--surface-3)" }}
    >
      <img src={url} alt={alt} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
    </button>
  );
}

function liveMinutes(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return ms < 0 ? 0 : Math.floor(ms / 60000);
}

function ColCard({ title, dot, badge, count, loading, children, live }: { title: string; dot: string; badge?: string; count: number; loading: boolean; children: ReactNode; live?: boolean }) {
  return (
    <section className="card col">
      <div className="card-h">
        <span className="row g8"><span className={cx("dot", live && count > 0 && "live")} style={{ color: dot }} /><span className="h3">{title}</span></span>
        <span className={cx("badge", badge)}><span className="num">{loading ? "…" : count}</span></span>
      </div>
      {children}
    </section>
  );
}

/* ── page ─────────────────────────────────────────────────────────────── */

export default function AttendanceToday() {
  const t = useT2();
  const [date, setDate] = useState(attTashkentDate);
  const [closing, setClosing] = useState<{ id: number; name: string } | null>(null);
  const [note, setNote] = useState("");
  const [, setTick] = useState(0);
  const [lightbox, setLightbox] = useState<{ url: string; alt: string } | null>(null);

  const q = useAttDayReport(date);
  const settings = useAttSettingsLite();
  const close = useAttCloseShift(date);
  const report = q.data;

  // live durations tick every minute
  useEffect(() => {
    const id = window.setInterval(() => setTick((v) => v + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const { onShift, gone, absent } = useMemo(() => {
    const on: AttEvent[] = [];
    const g: AttEvent[] = [];
    (report?.present ?? []).forEach((e) => (e.checked_out_at || e.auto_closed ? g : on).push(e));
    return { onShift: on, gone: g, absent: (report?.absent ?? []) as AttAbsent[] };
  }, [report]);

  const openPhoto = (url: string, alt: string) => setLightbox({ url, alt });

  const submitClose = () => {
    if (!closing || close.isPending) return;
    close.mutate(
      { id: closing.id, note },
      {
        onSuccess: () => {
          toast.success(t("op_detail.shift_closed"));
          setClosing(null);
          setNote("");
        },
        onError: () => toast.error(t("op_detail.shift_close_failed")),
      },
    );
  };

  const grace = settings.data?.default_grace_period_min;
  const lateHint = typeof grace === "number" ? t("v2.team.attendance.kpiLateHint", { n: grace }) : t("attendance.today.kpi_late_hint");
  const updatedAt = q.dataUpdatedAt
    ? new Date(q.dataUpdatedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Tashkent" })
    : null;
  const loading = q.isPending;

  return (
    <>
      <PageHeader title={t("v2.team.attendance.title")}>
        <AttSeg />
        <AttPinBadge />
        <span className="grow" />
        <Link className="btn" to="/attendance/kiosk"><Camera className="ic" />{t("attendance.today.open_kiosk")}</Link>
        <Link className="btn btn-ghost" to="/kiosk" target="_blank" rel="noreferrer"><QrCode className="ic" />{t("attendance.today.open_scan")}</Link>
      </PageHeader>
      <main className="page">
        {q.isError && !report ? (
          <section className="card"><ErrorState error={q.error} onRetry={() => q.refetch()} /></section>
        ) : null}

        {report ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
            <section className="card pad col g4">
              <span className="lbl">{t("attendance.today.kpi_present")}</span>
              <span className="kpi" style={{ color: "var(--ok)" }}><CountUp value={report.counts.present} /></span>
              <span className="s c3">{t("v2.team.attendance.kpiPresentHint", { n: report.total_active_operators })}</span>
            </section>
            <section className="card pad col g4">
              <span className="lbl">{t("attendance.today.kpi_late")}</span>
              <span className="kpi" style={report.counts.late ? { color: "var(--bad)" } : undefined}><CountUp value={report.counts.late} /></span>
              <span className="s c3">{lateHint}</span>
            </section>
            <section className="card pad col g4">
              <span className="lbl">{t("attendance.today.kpi_absent")}</span>
              <span className="kpi"><CountUp value={report.counts.absent} /></span>
              <span className="s c3">{t("attendance.today.kpi_absent_hint")}</span>
            </section>
          </div>
        ) : null}

        <div className="row g8 wrap">
          <label className="s c3 row g6" htmlFor="att-today-date"><Calendar className="ic ic-s" />{t("v2.team.attendance.date")}:</label>
          <input
            id="att-today-date"
            className="input num"
            type="date"
            value={date}
            max={attTashkentDate()}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            style={{ width: 160, height: 36 }}
          />
          <button className="btn btn-sm" type="button" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={cx("ic", q.isFetching && "animate-spin")} />
            {t("attendance.today.refresh")}
          </button>
          {updatedAt ? (
            <span className="xs c3">
              {t("attendance.today.updated_at", { t: updatedAt })} · {t("v2.team.attendance.autoEvery")}
            </span>
          ) : null}
        </div>

        {/* On shift now — photo cards */}
        <ColCard title={t("attendance.today.col_on_shift")} dot="var(--ok-solid)" badge="b-ok" count={onShift.length} loading={loading} live>
          {loading ? (
            <LoadingBlock rows={3} onRetry={() => q.refetch()} />
          ) : onShift.length === 0 ? (
            <EmptyState icon={<User className="ic ic-l" />} title={t("attendance.today.none_yet")} />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 12, padding: 16 }}>
              {onShift.map((e) => {
                const photo = attMediaUrl(e.checkin_photo_url);
                return (
                  <div key={e.id} className="card col" style={{ overflow: "hidden" }}>
                    {photo ? (
                      <button
                        type="button"
                        onClick={() => openPhoto(photo, e.operator_name)}
                        aria-label={`${t("v2.team.attendance.openPhoto")}: ${e.operator_name}`}
                        style={{ height: 110, padding: 0, border: 0, borderBottom: "1px solid var(--line)", cursor: "zoom-in", background: "var(--surface-3)" }}
                      >
                        <img src={photo} alt={e.operator_name} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                      </button>
                    ) : (
                      <div className="ph" style={{ height: 110, borderRadius: 0, border: 0, borderBottom: "1px solid var(--line)" }}>
                        <User className="ic ic-l" />{t("v2.team.attendance.photoIn")}
                      </div>
                    )}
                    <div className="col g4" style={{ padding: "10px 12px 12px" }}>
                      <span className="s w6 trunc" title={e.operator_name}>{e.operator_name}</span>
                      <span className="xs c3 row g6 wrap">
                        {t("v2.team.attendance.arrived")} <span className="num c2 w6">{attFmtTime(e.checked_in_at)}</span>
                        {e.was_late ? <span className="badge b-bad" style={{ height: 18, fontSize: 11 }}>{t("v2.team.attendance.late")}</span> : null}
                      </span>
                      <span className="xs c3">{t("v2.team.attendance.durationShort")} <span className="num">{attFmtDur(t, liveMinutes(e.checked_in_at))}</span></span>
                      <div className="row g6" style={{ marginTop: 4 }}>
                        <span className="badge b-ok" style={{ height: 20 }}>{t("op_detail.on_shift")}</span>
                        <SrcLabel src={e.source} />
                        <span className="grow" />
                        <button
                          className="btn btn-sm btn-bad"
                          type="button"
                          style={{ height: 26, padding: "0 8px", fontSize: 12 }}
                          aria-label={t("v2.team.attendance.closeAria", { name: e.operator_name })}
                          onClick={() => {
                            setNote("");
                            setClosing({ id: e.id, name: e.operator_name });
                          }}
                        >
                          {t("op_detail.close_shift_btn")}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ColCard>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))", gap: 16, alignItems: "start" }}>
          {/* Already gone */}
          <ColCard title={t("attendance.today.col_gone")} dot="var(--ink-3)" count={gone.length} loading={loading}>
            {loading ? (
              <LoadingBlock rows={3} />
            ) : gone.length === 0 ? (
              <EmptyState icon={<LogOut className="ic ic-l" />} title={t("attendance.today.col_gone_empty")} />
            ) : (
              gone.map((e) => (
                <div key={e.id} className="row-item" style={{ alignItems: "flex-start", gap: 12 }}>
                  <div className="row g4">
                    <Thumb url={attMediaUrl(e.checkin_photo_url)} label={t("v2.team.attendance.photoInShort")} alt={`checkin ${e.operator_name}`} onOpen={openPhoto} />
                    <Thumb url={attMediaUrl(e.checkout_photo_url)} label={t("v2.team.attendance.photoOutShort")} alt={`checkout ${e.operator_name}`} onOpen={openPhoto} />
                  </div>
                  <div className="col g4 grow" style={{ minWidth: 0 }}>
                    <span className="s w6 trunc">{e.operator_name}</span>
                    <span className="xs c3 row g6 wrap">
                      <Clock className="ic ic-s" /><span className="num c2">{attFmtTime(e.checked_in_at)}</span>→
                      <LogOut className="ic ic-s" /><span className="num c2">{attFmtTime(e.checked_out_at)}</span>
                      {e.duration_min !== null ? <span>· {t("v2.team.attendance.durationShort")} <b className="num c2">{attFmtDur(t, e.duration_min)}</b></span> : null}
                    </span>
                    <div className="row g6 wrap">
                      {e.auto_closed ? <span className="badge" style={{ height: 20 }}><Moon className="ic ic-s" />{t("attendance.today.auto_2300")}</span> : null}
                      {e.was_late ? <span className="badge b-bad" style={{ height: 20 }}>{t("v2.team.attendance.late")}</span> : null}
                      <SrcLabel src={e.source} />
                    </div>
                  </div>
                </div>
              ))
            )}
          </ColCard>

          {/* Not come */}
          <ColCard title={t("attendance.today.col_absent")} dot="var(--bad-solid)" badge="b-bad" count={absent.length} loading={loading}>
            {loading ? (
              <LoadingBlock rows={3} />
            ) : absent.length === 0 ? (
              <EmptyState icon={<User className="ic ic-l" />} title={t("v2.team.attendance.absentEmpty")} />
            ) : (
              absent.map((op) => (
                <div key={op.id} className="row-item" style={{ minHeight: 52 }}>
                  <span className="icon-tile" style={{ width: 32, height: 32, borderRadius: "50%" }}><UserX className="ic ic-s" /></span>
                  <Link className="s w5 grow trunc" to={`/operators/${op.id}`} style={{ color: "inherit" }}>{op.full_name}</Link>
                </div>
              ))
            )}
          </ColCard>
        </div>
      </main>

      <Dialog
        open={!!closing}
        onClose={() => !close.isPending && setClosing(null)}
        title={t("op_detail.close_shift_title")}
        sub={closing ? t("v2.team.attendance.closeSub", { name: closing.name }) : undefined}
        width={440}
        footer={
          <>
            <button className="btn btn-ghost" type="button" onClick={() => setClosing(null)} disabled={close.isPending}>{t("common.cancel")}</button>
            <button className="btn btn-danger" type="button" onClick={submitClose} disabled={close.isPending}>
              {close.isPending ? "…" : t("op_detail.close_shift_title")}
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="att-close-note">{t("op_detail.comment_optional")}</label>
          <textarea
            id="att-close-note"
            className="input"
            rows={3}
            maxLength={280}
            value={note}
            placeholder={t("attendance.today.close_note_ph")}
            onChange={(e) => setNote(e.target.value)}
          />
          <span className="xs c3 num" style={{ alignSelf: "flex-end" }}>{note.length} / 280</span>
        </div>
      </Dialog>

      {lightbox ? <AttLightbox url={lightbox.url} alt={lightbox.alt} onClose={() => setLightbox(null)} /> : null}
    </>
  );
}
