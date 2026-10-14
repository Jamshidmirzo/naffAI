import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Camera, RefreshCw } from "lucide-react";
import { useLang } from "../../store/lang";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx } from "../ui";
import {
  ATT_PHOTOS_PAGE,
  attFmtTime,
  attMediaUrl,
  attTashkentDate,
  attTashkentYesterday,
  useAttPhotoOperators,
  useAttPhotos,
  type AttPhotoRow,
} from "../api/team/attendance";
import { AttLightbox, AttSeg, attFmtDur } from "./AttendanceToday";

type T2 = ReturnType<typeof useT2>;

function dateHeader(date: string, t: T2, lang: string): string {
  if (date === attTashkentDate()) return t("attendance.photos.today");
  if (date === attTashkentYesterday()) return t("attendance.photos.yesterday");
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(lang === "uz" ? "uz-Latn-UZ" : "ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Half({ thumb, full, label, missing, onOpen }: { thumb: string | null; full: string | null; label: string; missing: string; onOpen: (u: string) => void }) {
  const abs = attMediaUrl(thumb ?? full);
  const big = attMediaUrl(full ?? thumb);
  if (!abs) {
    return <div className="ph grow" style={{ height: 104, borderRadius: 0, border: 0, fontSize: 12 }}>{missing}</div>;
  }
  return (
    <button
      type="button"
      className="grow"
      onClick={() => onOpen(big ?? abs)}
      title={label}
      aria-label={label}
      style={{ position: "relative", height: 104, padding: 0, border: 0, cursor: "zoom-in", background: "var(--surface-3)", flex: "1 1 0", minWidth: 0 }}
    >
      <img src={abs} alt={label} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      <span style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "2px 0", color: "#fff", fontSize: 10, fontWeight: 600, textAlign: "center", background: "linear-gradient(0deg, rgba(0,0,0,.7), transparent)" }}>
        {label}
      </span>
    </button>
  );
}

function PhotoCard({ row, t, onOpen }: { row: AttPhotoRow; t: T2; onOpen: (u: string) => void }) {
  return (
    <section className="card col" style={{ overflow: "hidden" }}>
      <div className="row" style={{ gap: 1, background: "var(--line)" }}>
        <Half thumb={row.checkin_photo_thumb} full={row.checkin_photo_url} label={t("attendance.photos.checkin")} missing={t("v2.team.attendance.photos.noIn")} onOpen={onOpen} />
        <Half thumb={row.checkout_photo_thumb} full={row.checkout_photo_url} label={t("attendance.photos.checkout")} missing={t("v2.team.attendance.photos.noOut")} onOpen={onOpen} />
      </div>
      <div className="col g4" style={{ padding: "10px 12px 12px" }}>
        <span className="s w6 trunc" title={row.operator_name}>{row.operator_name}</span>
        <span className="num xs c2">{attFmtTime(row.checked_in_at)} → {attFmtTime(row.checked_out_at)}</span>
        <span className="xs c3">{t("attendance.photos.duration")}: <b className="c2">{attFmtDur(t, row.duration_min)}</b></span>
        <div className="row g6 wrap" style={{ marginTop: 2 }}>
          {row.was_late ? <span className="badge b-hot" style={{ height: 20 }}>{t("attendance.photos.late_badge")}</span> : null}
          {row.auto_closed ? <span className="badge" style={{ height: 20 }}>{t("attendance.today.auto_2300")}</span> : null}
          <span className="lbl" style={{ fontSize: 10 }}>{row.source}</span>
        </div>
      </div>
    </section>
  );
}

export default function AttendancePhotos() {
  const t = useT2();
  const lang = useLang((s) => s.lang);
  const today = attTashkentDate();
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [operatorId, setOperatorId] = useState<number | "">("");
  const [offset, setOffset] = useState(0);
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => setOffset(0), [dateFrom, dateTo, operatorId]);

  const opsQ = useAttPhotoOperators();
  const q = useAttPhotos({ dateFrom, dateTo, operatorId, offset }, dateFrom === today && dateTo === today);
  const rows = q.data?.results ?? [];
  const total = q.data?.count ?? 0;

  const grouped = useMemo(() => {
    const map = new Map<string, AttPhotoRow[]>();
    for (const r of rows) {
      const list = map.get(r.date) ?? [];
      list.push(r);
      map.set(r.date, list);
    }
    return Array.from(map.entries());
  }, [rows]);

  const reset = () => {
    setDateFrom(today);
    setDateTo(today);
    setOperatorId("");
  };
  const page = (dir: 1 | -1) => {
    setOffset((o) => Math.max(0, o + dir * ATT_PHOTOS_PAGE));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <>
      <PageHeader title={t("v2.team.attendance.title")}>
        <AttSeg />
        <span className="grow" />
        <span className="col" style={{ alignItems: "flex-end" }}>
          <span className="lbl">{t("v2.team.attendance.photos.total")}</span>
          <span className="num w6" style={{ fontSize: 20, lineHeight: "24px" }}>{q.data ? total : "…"}</span>
        </span>
      </PageHeader>
      <main className="page" style={{ gap: 16 }}>
        <section className="card row g16 wrap" style={{ padding: "12px 16px", alignItems: "flex-end" }}>
          <div className="field">
            <label htmlFor="att-ph-from">{t("attendance.photos.filter_date_from")}</label>
            <input id="att-ph-from" className="input num" type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} style={{ width: 160, height: 36 }} />
          </div>
          <div className="field">
            <label htmlFor="att-ph-to">{t("attendance.photos.filter_date_to")}</label>
            <input id="att-ph-to" className="input num" type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} style={{ width: 160, height: 36 }} />
          </div>
          <div className="field">
            <label htmlFor="att-ph-op">{t("attendance.photos.filter_operator")}</label>
            <select id="att-ph-op" className="input" value={operatorId === "" ? "" : String(operatorId)} onChange={(e) => setOperatorId(e.target.value ? Number(e.target.value) : "")} style={{ width: 240, maxWidth: "100%", height: 36 }}>
              <option value="">{t("attendance.photos.filter_operator_all")}</option>
              {(opsQ.data ?? []).map((op) => (
                <option key={op.id} value={op.id}>{op.full_name}</option>
              ))}
            </select>
          </div>
          <span className="grow" />
          <button className="btn btn-ghost" type="button" onClick={reset}>{t("attendance.photos.filter_reset")}</button>
          <button className="btn btn-ghost btn-sq" type="button" aria-label={t("v2.team.attendance.photos.refresh")} title={t("v2.team.attendance.photos.refresh")} onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={cx("ic", q.isFetching && "animate-spin")} />
          </button>
        </section>

        {q.isPending ? (
          <section className="card"><LoadingBlock rows={4} onRetry={() => q.refetch()} /></section>
        ) : q.isError && !q.data ? (
          <section className="card"><ErrorState error={q.error} onRetry={() => q.refetch()} /></section>
        ) : rows.length === 0 ? (
          <section className="card"><EmptyState icon={<Camera className="ic ic-l" />} title={t("attendance.photos.empty")} body={t("v2.team.attendance.photos.emptyBody")} /></section>
        ) : (
          grouped.map(([date, group]) => (
            <div key={date} className="col g12">
              <div className="row g8">
                <span className="h3">{dateHeader(date, t, lang)}</span>
                <span className="badge" style={{ height: 20 }}><span className="num">{group.length}</span></span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12 }}>
                {group.map((row) => <PhotoCard key={row.log_id} row={row} t={t} onOpen={setLightbox} />)}
              </div>
            </div>
          ))
        )}

        {q.data && (q.data.next || q.data.previous) ? (
          <div className="row g12" style={{ justifyContent: "center" }}>
            <button className="btn btn-ghost btn-sm" type="button" aria-label={t("v2.team.attendance.photos.prev")} disabled={!q.data.previous || q.isFetching} onClick={() => page(-1)}>
              <ArrowLeft className="ic" />
            </button>
            <span className="num s c3">{offset + 1}–{Math.min(offset + rows.length, total)} / {total}</span>
            <button className="btn btn-ghost btn-sm" type="button" aria-label={t("v2.team.attendance.photos.next")} disabled={!q.data.next || q.isFetching} onClick={() => page(1)}>
              <ArrowRight className="ic" />
            </button>
          </div>
        ) : null}
      </main>
      {lightbox ? <AttLightbox url={lightbox} alt="attendance" onClose={() => setLightbox(null)} /> : null}
    </>
  );
}
