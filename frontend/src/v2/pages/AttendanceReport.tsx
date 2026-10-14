import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Calendar, ChevronDown, ChevronUp, Download, Search, Users } from "lucide-react";
import { toast } from "../../components/ui";
import { apiErrorMessage } from "../../lib/api-types";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx } from "../ui";
import {
  attDownloadPeriodXlsx,
  attTashkentDate,
  attTashkentMonthStart,
  useAttOperatorsList,
  useAttPeriodReport,
  type AttHeatStatus,
  type AttPeriodStats,
} from "../api/team/attendance";
import { AttSeg } from "./AttendanceToday";

type T2 = ReturnType<typeof useT2>;

/* ── heatmap card (exported: the operator card can reuse it) ─────────── */

const HEAT: Record<AttHeatStatus, { bg: string; fg: string; key: string; legendKey: string }> = {
  on_time: { bg: "var(--ok-solid)", fg: "#FFFFFF", key: "attendance.stats.status_on_time", legendKey: "attendance.stats.status_on_time" },
  late: { bg: "var(--warn-solid)", fg: "#15132B", key: "attendance.stats.status_late", legendKey: "attendance.stats.status_late" },
  absent: { bg: "var(--bad-solid)", fg: "#FFFFFF", key: "attendance.stats.status_absent", legendKey: "attendance.stats.legend_absent_short" },
  weekend: { bg: "var(--line-2)", fg: "var(--ink-3)", key: "attendance.stats.status_weekend", legendKey: "attendance.stats.status_weekend" },
  auto_closed: {
    bg: "repeating-linear-gradient(45deg, #D97706, #D97706 4px, #F59E0B 4px, #F59E0B 8px)",
    fg: "#FFFFFF",
    key: "attendance.stats.status_auto_closed",
    legendKey: "attendance.stats.status_auto_closed",
  },
  manually_closed: { bg: "var(--brand)", fg: "#FFFFFF", key: "attendance.stats.status_manually_closed", legendKey: "attendance.stats.legend_closed_by_tl" },
};
const HEAT_ORDER: AttHeatStatus[] = ["on_time", "late", "absent", "weekend", "auto_closed", "manually_closed"];

/** Five summary wells + presence calendar (v2 version of components/AttendanceStatsCard). */
export function AttStatsCard({ stats }: { stats: Omit<AttPeriodStats, "operator_id" | "operator_name"> }) {
  const t = useT2();
  const well = (label: string, value: string, cls?: string) => (
    <div className="well col g4" style={{ alignItems: "center", textAlign: "center" }}>
      <span className="xs c3">{label}</span>
      <span className={cx("num w7", cls)} style={{ fontSize: 17 }}>{value}</span>
    </div>
  );
  return (
    <div className="card col g16" style={{ padding: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
        {well(t("attendance.stats.presence"), `${stats.days_present} / ${t("v2.team.attendance.report.days", { n: stats.days_expected })}`)}
        {well(t("attendance.stats.absences"), t("v2.team.attendance.report.days", { n: stats.days_absent }), "c-bad")}
        {well(t("attendance.stats.late_avg"), t("v2.team.attendance.report.lateVal", { n: stats.late_count, m: stats.avg_late_minutes }), "c-warn")}
        {well(t("attendance.stats.avg_shift"), t("attendance.stats.min_short", { n: stats.avg_shift_minutes }), "c-brand")}
        {well(t("attendance.stats.total_hours"), t("attendance.stats.hours_short", { n: stats.total_worked_hours }), "c-ok")}
      </div>
      <div className="col g8">
        <span className="h3">{t("v2.team.attendance.report.heatmap")}</span>
        <div className="row g6 wrap" style={{ padding: 10, borderRadius: 11, background: "var(--surface-2)", border: "1px solid var(--line)" }}>
          {stats.heatmap.map((d) => {
            const h = HEAT[d.status] ?? HEAT.weekend;
            const [y, m, day] = d.date.split("-");
            return (
              <span
                key={d.date}
                className="num"
                title={`${day}.${m}.${y}: ${t(h.key)}`}
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 6, fontSize: 10, fontWeight: 700, color: h.fg, background: h.bg }}
              >
                {day}
              </span>
            );
          })}
        </div>
        <div className="row g16 wrap xs c2">
          {HEAT_ORDER.map((k) => (
            <span key={k} className="row g6">
              <i style={{ display: "block", width: 14, height: 14, borderRadius: 4, background: HEAT[k].bg }} />
              {t(HEAT[k].legendKey)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── operators multi-select ──────────────────────────────────────────── */

function OperatorsPicker({ options, selected, onChange }: { options: Array<{ id: number; name: string }>; selected: number[]; onChange: (ids: number[]) => void }) {
  const t = useT2();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? options.filter((o) => o.name.toLowerCase().includes(n)) : options;
  }, [options, q]);
  const toggle = (id: number) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="btn btn-sm" type="button" aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen((v) => !v)}>
        {t("v2.team.attendance.report.operators")}{" "}
        <span className="xs c3">{selected.length ? t("v2.team.attendance.report.selected", { n: selected.length }) : t("v2.team.attendance.report.all")}</span>
        <ChevronDown className="ic ic-s" />
      </button>
      {open ? (
        <div className="card col" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 30, width: 280, maxWidth: "calc(100vw - 32px)", boxShadow: "var(--shadow)" }}>
          {options.length > 8 ? (
            <div style={{ padding: 8, borderBottom: "1px solid var(--line)" }}>
              <div className="inwrap">
                <Search className="ic" />
                <input className="input" type="search" autoFocus value={q} placeholder={t("v2.team.attendance.report.search")} aria-label={t("v2.team.attendance.report.search")} onChange={(e) => setQ(e.target.value)} />
              </div>
            </div>
          ) : null}
          <div role="listbox" aria-multiselectable="true" style={{ maxHeight: 280, overflowY: "auto", padding: 4 }}>
            {filtered.length === 0 ? <div className="xs c3" style={{ padding: 12 }}>{t("v2.team.attendance.report.nobody")}</div> : null}
            {filtered.map((o) => (
              <label key={o.id} className="row g8 s" style={{ padding: "7px 10px", borderRadius: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} />
                <span className="trunc">{o.name}</span>
              </label>
            ))}
          </div>
          {selected.length ? (
            <div style={{ padding: 8, borderTop: "1px solid var(--line)" }}>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => onChange([])}>{t("v2.team.attendance.report.clear")}</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ── page ─────────────────────────────────────────────────────────────── */

type SortKey = keyof Omit<AttPeriodStats, "heatmap" | "operator_id">;
const GRID = "minmax(180px, 1.3fr) 120px 120px 120px 120px 110px 110px 32px";

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}

export default function AttendanceReport() {
  const t = useT2();
  // Tashkent-local defaults (the old page used UTC toISOString → off by one day in the evening).
  const [dateFrom, setDateFrom] = useState(attTashkentMonthStart);
  const [dateTo, setDateTo] = useState(attTashkentDate);
  const [opIds, setOpIds] = useState<number[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [sortField, setSortField] = useState<SortKey>("operator_name");
  const [sortAsc, setSortAsc] = useState(true);
  const [exporting, setExporting] = useState(false);

  const opsQ = useAttOperatorsList();
  const options = useMemo(() => (opsQ.data ?? []).map((o) => ({ id: o.id, name: o.full_name })), [opsQ.data]);
  const rangeBad = !!dateFrom && !!dateTo && dateFrom > dateTo;
  const q = useAttPeriodReport(rangeBad ? "" : dateFrom, rangeBad ? "" : dateTo, opIds);

  const rows = useMemo(() => {
    const list = [...(q.data?.rows ?? [])];
    return list.sort((a, b) => {
      const va = a[sortField];
      const vb = b[sortField];
      if (typeof va === "string" && typeof vb === "string") return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortAsc ? (va as number) - (vb as number) : (vb as number) - (va as number);
    });
  }, [q.data, sortField, sortAsc]);

  const sortBy = (f: SortKey) => {
    if (sortField === f) setSortAsc((v) => !v);
    else {
      setSortField(f);
      setSortAsc(true);
    }
  };

  const doExport = async () => {
    if (exporting || rangeBad) return;
    setExporting(true);
    try {
      await attDownloadPeriodXlsx(dateFrom, dateTo, opIds);
    } catch (e) {
      toast.error(`${t("v2.team.attendance.report.exportFail")}: ${apiErrorMessage(e)}`);
    } finally {
      setExporting(false);
    }
  };

  const cols: Array<{ key: SortKey; label: string; right?: boolean }> = [
    { key: "operator_name", label: t("common.operator") },
    { key: "days_present", label: t("attendance.report.col_present"), right: true },
    { key: "late_count", label: t("attendance.report.col_late"), right: true },
    { key: "auto_closed_count", label: t("attendance.report.col_auto_closed"), right: true },
    { key: "manually_closed_count", label: t("attendance.report.col_manual_closed"), right: true },
    { key: "avg_shift_minutes", label: t("attendance.report.col_avg_shift"), right: true },
    { key: "total_worked_hours", label: t("attendance.report.col_total_hours"), right: true },
  ];

  const dateInput = (id: string, label: string, value: string, set: (v: string) => void) => (
    <input id={id} className="input num" type="date" aria-label={label} value={value} max={attTashkentDate()} onChange={(e) => e.target.value && set(e.target.value)} style={{ width: 150, height: 36 }} />
  );

  return (
    <>
      <PageHeader title={t("v2.team.attendance.title")}>
        <AttSeg />
        <span className="grow" />
        <button className="btn" type="button" onClick={doExport} disabled={exporting || rangeBad}>
          <Download className="ic" />
          {exporting ? t("v2.team.attendance.report.exporting") : t("attendance.report.export_excel")}
        </button>
      </PageHeader>
      <main className="page" style={{ gap: 16 }}>
        <section className="card row g16 wrap" style={{ padding: "12px 16px" }}>
          <span className="row g8 wrap">
            <Calendar className="ic c3" />
            {dateInput("att-rep-from", t("v2.team.attendance.report.dateFrom"), dateFrom, setDateFrom)}
            <span className="c3">—</span>
            {dateInput("att-rep-to", t("v2.team.attendance.report.dateTo"), dateTo, setDateTo)}
          </span>
          <span className="row g8">
            <Users className="ic c3" />
            <OperatorsPicker options={options} selected={opIds} onChange={setOpIds} />
          </span>
          <span className="grow" />
          <span className="xs c3">{t("v2.team.attendance.report.rowHint")}</span>
        </section>

        {rangeBad ? (
          <div className="banner b-warn"><Calendar className="ic" /><span>{t("v2.team.attendance.report.rangeBad")}</span></div>
        ) : null}

        <section className="card tbl" style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 900 }}>
            <div className="tr th" style={{ gridTemplateColumns: GRID }}>
              {cols.map((c) => {
                const on = sortField === c.key;
                const Icon = on ? (sortAsc ? ArrowUp : ArrowDown) : ArrowUpDown;
                return (
                  <button
                    key={c.key}
                    className={cx("th-s", on && "is-on", c.right && "r")}
                    type="button"
                    onClick={() => sortBy(c.key)}
                    aria-sort={on ? (sortAsc ? "ascending" : "descending") : "none"}
                  >
                    {c.label} <Icon className="ic ic-s" style={on ? undefined : ({ opacity: 0.6 } as CSSProperties)} />
                  </button>
                );
              })}
              <span />
            </div>

            {rangeBad ? null : q.isPending ? (
              <LoadingBlock rows={5} onRetry={() => q.refetch()} />
            ) : q.isError ? (
              <ErrorState error={q.error} onRetry={() => q.refetch()} />
            ) : rows.length === 0 ? (
              <EmptyState icon={<Calendar className="ic ic-l" />} title={t("attendance.report.no_data_range")} body={t("v2.team.attendance.report.emptyBody")} />
            ) : (
              rows.map((r) => <ReportRow key={r.operator_id} r={r} t={t} open={expanded === r.operator_id} onToggle={() => setExpanded((c) => (c === r.operator_id ? null : r.operator_id))} />)
            )}
          </div>
        </section>
      </main>
    </>
  );
}

function ReportRow({ r, t, open, onToggle }: { r: AttPeriodStats; t: T2; open: boolean; onToggle: () => void }) {
  return (
    <>
      <div
        className={cx("tr", open && "is-sel")}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onToggle())}
        style={{ gridTemplateColumns: GRID, cursor: "pointer" }}
      >
        <span className="row g8" style={{ minWidth: 0 }}><span className="ava ava-s">{initials(r.operator_name)}</span><span className="w6 trunc">{r.operator_name}</span></span>
        <span className="r num">{r.days_present} / {r.days_expected}</span>
        <span className={cx("r num", r.late_count > 0 ? "c-brand w6" : "c3")}>
          {r.late_count > 0 ? t("v2.team.attendance.report.lateVal", { n: r.late_count, m: r.avg_late_minutes }) : "0"}
        </span>
        <span className="r num c2">{r.auto_closed_count}</span>
        <span className="r num c2">{r.manually_closed_count}</span>
        <span className="r num">{t("op_detail.minutes_short", { n: r.avg_shift_minutes })}</span>
        <span className={cx("r num w6", r.total_worked_hours > 0 ? "c-brand" : "c3")}>{t("attendance.report.hours_short", { n: r.total_worked_hours })}</span>
        <span className={cx("r", open ? "c2" : "c3")}>{open ? <ChevronUp className="ic ic-s" /> : <ChevronDown className="ic ic-s" />}</span>
      </div>
      {open ? (
        <div style={{ padding: "16px 20px", background: "var(--surface-2)", borderBottom: "1px solid var(--line)" }}>
          <AttStatsCard stats={r} />
        </div>
      ) : null}
    </>
  );
}
