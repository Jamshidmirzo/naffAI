import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, Pause, Phone, Play, Search, User, X } from "lucide-react";
import { useLang } from "../../store/lang";
import { useT2 } from "../i18n";
import { Dialog, EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum } from "../ui";
import { useCallsList, useCallsOperators, useCallsStats, type CallRow } from "../api/managerDaily";

/* ── helpers ─────────────────────────────────────────────────────────── */

function isoDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DATE_PRESETS: { key: string; labelKey: string; range: () => { from: string; to: string } }[] = [
  { key: "today", labelKey: "reports.activity.presets.today", range: () => ({ from: isoDay(), to: isoDay() }) },
  { key: "yesterday", labelKey: "reports.activity.presets.yesterday", range: () => ({ from: isoDay(-1), to: isoDay(-1) }) },
  { key: "week", labelKey: "reports.activity.presets.week", range: () => ({ from: isoDay(-6), to: isoDay() }) },
  { key: "month_30", labelKey: "reports.activity.presets.month", range: () => ({ from: isoDay(-29), to: isoDay() }) },
  {
    key: "this_month",
    labelKey: "reports.activity.presets.this_month",
    range: () => {
      const now = new Date();
      return { from: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`, to: isoDay() };
    },
  },
];

/** Outcome tabs: same groups and codes as the old page. */
const OUTCOME_TABS: { key: string; labelKey: string; outcomes: string[] }[] = [
  { key: "", labelKey: "calls.filter.outcome_all", outcomes: [] },
  { key: "talked", labelKey: "calls.filter.outcome_talked", outcomes: ["talked_interested", "talked_callback"] },
  { key: "no_answer", labelKey: "calls.filter.outcome_no_answer", outcomes: ["no_answer"] },
  { key: "rejected", labelKey: "calls.filter.outcome_rejected", outcomes: ["rejected"] },
  { key: "other", labelKey: "calls.filter.outcome_other", outcomes: ["wrong_number", "tg_only"] },
  { key: "empty", labelKey: "calls.filter.outcome_empty", outcomes: ["empty"] },
];

const OUTCOME_TONE: Record<string, string> = {
  talked_interested: "b-ok",
  talked_callback: "b-info",
  no_answer: "",
  wrong_number: "b-bad",
  rejected: "b-bad",
  tg_only: "b-info",
  "": "b-warn",
};

function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function useFmtWhen() {
  const lang = useLang((s) => s.lang);
  const locale = lang === "uz" ? "uz-Latn-UZ" : "ru-RU";
  return (iso: string | null | undefined, seconds = false) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const day = d.toLocaleDateString(locale, { day: "numeric", month: "short" }).replace(".", "");
    const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });
    return `${day}, ${time}`;
  };
}

function OutcomeBadge({ code }: { code: string }) {
  const t = useT2();
  const known = code in OUTCOME_TONE;
  return (
    <span className={cx("badge", OUTCOME_TONE[code] ?? "")} style={{ alignSelf: "flex-start" }}>
      {known ? t(`v2.calls.out.${code || "empty"}`) : code || "—"}
    </span>
  );
}

/** Lead name → the leads list searched by this phone (there is no lead page route). */
function LeadLink({ row }: { row: CallRow }) {
  const t = useT2();
  const phone = row.lead_phone || row.phone_number;
  if (row.lead && phone) {
    return (
      <Link className="trunc c-brand" to={`/leads?search=${encodeURIComponent(phone)}`} title={t("v2.calls.openLead")} onClick={(e) => e.stopPropagation()}>
        {row.lead_name || "—"}
      </Link>
    );
  }
  return <span className="trunc">{row.lead_name || "—"}</span>;
}

/** Compact audio player as on the artboard: ▶ + progress + time. */
function AudioPill({ src, fallbackSec, large }: { src: string; fallbackSec: number | null; large?: boolean }) {
  const t = useT2();
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const total = dur ?? fallbackSec ?? 0;
  const pct = total > 0 ? Math.min(100, (pos / total) * 100) : 0;
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const a = ref.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => setFailed(true));
    else a.pause();
  };
  const seek = (e: React.MouseEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    const a = ref.current;
    if (!a || !total) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total;
  };
  const audio = (
    <audio
      ref={ref}
      src={src}
      preload="none"
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onEnded={() => setPlaying(false)}
      onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
      onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
      onError={() => setFailed(true)}
    />
  );
  if (failed) return <span className="xs c3">{t("v2.calls.recErr")}</span>;
  const timeText = playing || pos > 0 ? `${fmtDuration(pos)} / ${fmtDuration(total)}` : fmtDuration(total);
  if (large) {
    return (
      <div className="well row g8">
        {audio}
        <button className="btn btn-pri btn-sq btn-sm" type="button" aria-label={playing ? t("v2.calls.pause") : t("v2.calls.play")} onClick={toggle} style={{ color: "var(--brand-ink)" }}>
          {playing ? <Pause className="ic" /> : <Play className="ic" />}
        </button>
        <span className="bar grow" onClick={seek} style={{ cursor: "pointer" }}><i style={{ width: `${pct}%` }} /></span>
        <span className="num xs c3">{timeText}</span>
      </div>
    );
  }
  return (
    <span className="row g8" onClick={(e) => e.stopPropagation()} style={{ height: 30, padding: "0 10px 0 4px", borderRadius: 99, background: "var(--surface-3)", minWidth: 0 }}>
      {audio}
      <button className="btn btn-sq btn-sm" type="button" aria-label={playing ? t("v2.calls.pause") : t("v2.calls.play")} onClick={toggle} style={{ width: 24, height: 24, borderRadius: "50%", padding: 0, flex: "none" }}>
        {playing ? <Pause className="ic ic-s" /> : <Play className="ic ic-s" />}
      </button>
      <span className="bar grow" onClick={seek} style={{ height: 4, cursor: "pointer" }}><i style={{ width: `${pct}%` }} /></span>
      <span className="num xs c3" style={{ whiteSpace: "nowrap" }}>{timeText}</span>
    </span>
  );
}

/** «Операторы» dropdown: search, checkboxes, reset, «выбрано N из M». */
function OperatorPicker({ options, selected, onChange }: { options: { id: number; name: string }[]; selected: number[]; onChange: (ids: number[]) => void }) {
  const t = useT2();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const shown = options.filter((o) => o.name.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (id: number) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div ref={box} style={{ position: "relative" }}>
      <button className="btn" type="button" aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen((v) => !v)} style={open ? { borderColor: "var(--brand)" } : undefined}>
        <User className="ic" />
        {t("calls.filter.operators")}
        {selected.length ? <span className="cnt">{selected.length}</span> : null}
        <ChevronDown className="ic" />
      </button>
      {open ? (
        <section className="card col" style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", width: 280, zIndex: 20, boxShadow: "var(--shadow)" }}>
          <div style={{ padding: 10 }}>
            <div className="inwrap">
              <Search className="ic" />
              <input className="input" type="search" autoFocus placeholder={t("v2.calls.search")} aria-label={t("v2.calls.searchOp")} value={q} onChange={(e) => setQ(e.target.value)} style={{ height: 34 }} />
            </div>
          </div>
          <div className="col" role="listbox" aria-multiselectable="true" style={{ maxHeight: 280, overflowY: "auto" }}>
            {shown.length === 0 ? <span className="s c3" style={{ padding: "7px 14px" }}>{t("v2.calls.noOps")}</span> : null}
            {shown.map((o) => (
              <label key={o.id} className="row g8 s" style={{ padding: "7px 14px", cursor: "pointer" }}>
                <input className="check" type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} />
                <span className="trunc">{o.name}</span>
              </label>
            ))}
          </div>
          <div className="row between" style={{ padding: "10px 14px", borderTop: "1px solid var(--line)" }}>
            <button className="btn btn-ghost btn-sm" type="button" disabled={!selected.length} onClick={() => onChange([])}>{t("v2.calls.reset")}</button>
            <span className="xs c3">{t("v2.calls.selectedOf", { n: selected.length, m: options.length })}</span>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/* ── page ────────────────────────────────────────────────────────────── */

const COLS = "132px minmax(0, 1.1fr) minmax(0, 1.3fr) 100px minmax(0, 1fr) 210px";

export default function Calls() {
  const t = useT2();
  const fmtWhen = useFmtWhen();
  const [searchParams, setSearchParams] = useSearchParams();
  const dateFrom = searchParams.get("date_from") || "";
  const dateTo = searchParams.get("date_to") || "";
  const outcomeTab = searchParams.get("outcome_tab") || "";
  const operatorIds = searchParams.getAll("operator").map(Number).filter(Boolean);

  // Default range: last 7 days, as on the old page.
  useEffect(() => {
    if (!dateFrom && !dateTo) {
      const next = new URLSearchParams(searchParams);
      const r = DATE_PRESETS[2].range();
      next.set("date_from", r.from);
      next.set("date_to", r.to);
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (patch: Record<string, string | string[] | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      next.delete(k);
      if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
      if (Array.isArray(v)) v.forEach((val) => next.append(k, String(val)));
      else next.set(k, String(v));
    }
    setSearchParams(next);
  };

  const outcomes = useMemo(() => OUTCOME_TABS.find((o) => o.key === outcomeTab)?.outcomes ?? [], [outcomeTab]);
  const opKey = operatorIds.join(",");

  const listParams = useMemo(() => {
    const p = new URLSearchParams();
    if (dateFrom) p.set("date_from", dateFrom);
    if (dateTo) p.set("date_to", dateTo);
    for (const id of operatorIds) p.append("operator", String(id));
    for (const o of outcomes) p.append("outcome", o);
    p.set("limit", "50");
    return p.toString();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, opKey, outcomes.join(",")]);

  const statsParams = useMemo(() => {
    const p = new URLSearchParams();
    if (dateFrom) p.set("date_from", dateFrom);
    if (dateTo) p.set("date_to", dateTo);
    for (const id of operatorIds) p.append("operator", String(id));
    return p.toString();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, opKey]);

  const todayParams = useMemo(() => new URLSearchParams({ date_from: isoDay(), date_to: isoDay() }).toString(), []);

  const [cursor, setCursor] = useState<number | null>(null);
  const [accumulated, setAccumulated] = useState<CallRow[]>([]);
  useEffect(() => {
    setCursor(null);
    setAccumulated([]);
  }, [listParams]);

  const listQuery = useCallsList(listParams, cursor);
  const statsQuery = useCallsStats(statsParams);
  const todayQuery = useCallsStats(todayParams);
  const opsQuery = useCallsOperators();
  const operatorOptions = opsQuery.data ?? [];

  useEffect(() => {
    const data = listQuery.data;
    if (!data) return;
    setAccumulated((prev) => {
      const seen = new Set(prev.map((r) => r.id));
      const merged = [...prev];
      for (const row of data.results) if (!seen.has(row.id)) merged.push(row);
      return merged;
    });
  }, [listQuery.data]);

  const nextCursor = listQuery.data?.next_cursor ?? null;
  const total = listQuery.data?.total ?? 0;
  const stats = statsQuery.data;

  const [detailId, setDetailId] = useState<number | null>(null);
  const detail = useMemo(() => accumulated.find((r) => r.id === detailId) || null, [detailId, accumulated]);

  const nameOf = (id: number) => operatorOptions.find((o) => o.id === id)?.name ?? `#${id}`;

  const kpi = (label: string, value: string, sub?: string) => (
    <section className="card col g4 pad">
      <span className="lbl">{label}</span>
      <span className="kpi">{value}</span>
      {sub ? <span className="s c3">{sub}</span> : null}
    </section>
  );

  // Rows are the accumulated pages; while the very first page loads (or the
  // filters just changed) show a skeleton, never stale zeros.
  const firstLoad = accumulated.length === 0 && (listQuery.isLoading || listQuery.isFetching);

  return (
    <>
      <PageHeader
        title={t("calls.title")}
        meta={t("calls.subtitle")}
      >
        {todayQuery.data ? (
          <span className="badge b-info">
            {t("v2.calls.today")}: <span className="num">{fmtNum(todayQuery.data.total_calls)}</span>
          </span>
        ) : null}
      </PageHeader>
      <main className="page">
        {statsQuery.isError && !stats ? (
          <section className="card"><ErrorState error={statsQuery.error} onRetry={() => statsQuery.refetch()} /></section>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
            {stats ? (
              <>
                {kpi(t("calls.kpi.total"), fmtNum(stats.total_calls))}
                {kpi(t("calls.kpi.avg_duration"), fmtDuration(stats.avg_duration_seconds))}
                {kpi(t("calls.kpi.with_recording"), `${Math.round(stats.recording_pct)}%`, `${fmtNum(stats.with_recording)} ${t("v2.calls.pcs")}`)}
                {kpi(t("calls.kpi.answered"), `${Math.round(stats.answered_pct)}%`, `${fmtNum(stats.answered)} ${t("v2.calls.pcs")}`)}
              </>
            ) : (
              [0, 1, 2, 3].map((i) => (
                <section key={i} className="card col g8 pad">
                  <i className="sk" style={{ display: "block", height: 11, width: 110 }} />
                  <i className="sk" style={{ display: "block", height: 30, width: 90 }} />
                </section>
              ))
            )}
          </div>
        )}

        <section className="card col g12" style={{ padding: "14px 16px" }}>
          <div className="row g8 wrap">
            {DATE_PRESETS.map((p) => {
              const r = p.range();
              const on = dateFrom === r.from && dateTo === r.to;
              return (
                <button key={p.key} className={cx("chip", on && "is-on")} type="button" aria-pressed={on} onClick={() => update({ date_from: r.from, date_to: r.to })}>
                  {t(p.labelKey)}
                </button>
              );
            })}
            <span className="grow" />
            <input className="input num" type="date" aria-label={t("v2.calls.from")} value={dateFrom} max={dateTo || undefined} onChange={(e) => update({ date_from: e.target.value })} style={{ width: 150, height: 36 }} />
            <span className="c3">—</span>
            <input className="input num" type="date" aria-label={t("v2.calls.to")} value={dateTo} min={dateFrom || undefined} onChange={(e) => update({ date_to: e.target.value })} style={{ width: 150, height: 36 }} />
            <OperatorPicker options={operatorOptions} selected={operatorIds} onChange={(ids) => update({ operator: ids.map(String) })} />
          </div>
          <div className="row g8 wrap">
            {OUTCOME_TABS.map((o) => (
              <button key={o.key} className={cx("chip", outcomeTab === o.key && "is-on")} type="button" aria-pressed={outcomeTab === o.key} onClick={() => update({ outcome_tab: o.key || null })}>
                {t(o.labelKey)}
              </button>
            ))}
            <span className="grow" />
            {operatorIds.length ? (
              <span className="row g6 s c2 wrap">
                {t("v2.calls.selected")}
                {operatorIds.map((id) => (
                  <span key={id} className="chip" style={{ height: 26 }}>
                    {nameOf(id)}
                    <button type="button" aria-label={t("v2.calls.removeOp", { name: nameOf(id) })} onClick={() => update({ operator: operatorIds.filter((x) => x !== id).map(String) })} style={{ border: 0, background: "none", padding: 0, display: "inline-flex", color: "inherit" }}>
                      <X className="ic ic-s" />
                    </button>
                  </span>
                ))}
              </span>
            ) : null}
          </div>
        </section>

        <section className="card tbl">
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 900 }}>
              <div className="tr th" style={{ gridTemplateColumns: COLS }}>
                <span>{t("calls.col.time")}</span>
                <span>{t("calls.col.operator")}</span>
                <span>{t("calls.col.lead")}</span>
                <span className="r">{t("calls.col.duration")}</span>
                <span>{t("calls.col.outcome")}</span>
                <span>{t("calls.col.recording")}</span>
              </div>
              {listQuery.isError && accumulated.length === 0 ? (
                <ErrorState error={listQuery.error} onRetry={() => listQuery.refetch()} />
              ) : firstLoad ? (
                <LoadingBlock rows={6} onRetry={() => listQuery.refetch()} />
              ) : accumulated.length === 0 ? (
                <EmptyState icon={<Phone className="ic ic-l" />} title={t("calls.empty")} body={t("v2.calls.emptyBody")} />
              ) : (
                accumulated.map((row) => (
                  <div
                    key={row.id}
                    className={cx("tr", detailId === row.id && "is-sel")}
                    role="button"
                    tabIndex={0}
                    onClick={() => setDetailId(row.id)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setDetailId(row.id))}
                    style={{ gridTemplateColumns: COLS, cursor: "pointer" }}
                  >
                    <span className="num s c2">{fmtWhen(row.started_at || row.created_at)}</span>
                    <span className="trunc w5">{row.operator_name || "—"}</span>
                    <span className="col" style={{ minWidth: 0 }}>
                      <LeadLink row={row} />
                      <span className="num xs c3" style={{ whiteSpace: "nowrap" }}>{row.phone_number || row.lead_phone || ""}</span>
                    </span>
                    <span className="r num">{fmtDuration(row.duration_seconds)}</span>
                    <span><OutcomeBadge code={row.outcome} /></span>
                    <span style={{ minWidth: 0 }}>
                      {row.has_recording && row.recording_url ? <AudioPill src={row.recording_url} fallbackSec={row.duration_seconds} /> : <span className="xs c3">{t("calls.recording_none")}</span>}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
          {total > 0 ? (
            <div className="row between" style={{ padding: "12px 16px", borderTop: "1px solid var(--line)" }}>
              <span className="num s c3">{fmtNum(accumulated.length)} / {fmtNum(total)}</span>
              {nextCursor != null ? (
                <button className="btn btn-ghost btn-sm" type="button" disabled={listQuery.isFetching} onClick={() => setCursor(nextCursor)}>
                  {listQuery.isFetching ? "…" : t("calls.load_more")}
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      </main>

      <Dialog
        open={!!detail}
        onClose={() => setDetailId(null)}
        width={520}
        title={t("calls.details")}
        sub={
          detail ? (
            <>
              {detail.operator_name || "—"} → <LeadLink row={detail} />
              {detail.phone_number || detail.lead_phone ? <> · <span className="num">{detail.phone_number || detail.lead_phone}</span></> : null}
            </>
          ) : null
        }
        footer={<button className="btn" type="button" onClick={() => setDetailId(null)}>{t("common.close")}</button>}
      >
        {detail ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
              <div className="col g4"><span className="lbl">{t("calls.details.started")}</span><span className="num s">{fmtWhen(detail.started_at, true)}</span></div>
              <div className="col g4"><span className="lbl">{t("calls.details.ended")}</span><span className="num s">{fmtWhen(detail.ended_at, true)}</span></div>
              <div className="col g4"><span className="lbl">{t("calls.details.duration")}</span><span className="num s">{fmtDuration(detail.duration_seconds)}</span></div>
              <div className="col g4"><span className="lbl">{t("calls.details.outcome")}</span><OutcomeBadge code={detail.outcome} /></div>
            </div>
            {detail.has_recording && detail.recording_url ? (
              <AudioPill key={detail.id} src={detail.recording_url} fallbackSec={detail.duration_seconds} large />
            ) : (
              <div className="col g4"><span className="lbl">{t("calls.col.recording")}</span><span className="s c3">{t("calls.recording_soon")}</span></div>
            )}
            <div className="col g4">
              <span className="lbl">{t("calls.details.comment")}</span>
              <span className="s" style={{ whiteSpace: "pre-wrap" }}>{detail.comment || t("calls.details.no_comment")}</span>
            </div>
          </>
        ) : null}
      </Dialog>
    </>
  );
}
