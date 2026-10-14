import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Download, Filter, Plus, RotateCcw, Search, X } from "lucide-react";
import { toast } from "../../components/ui";
import { useT2 } from "../i18n";
import { PageHeader, EmptyState, ErrorState, LoadingBlock, cx, fmtNum } from "../ui";
import {
  downloadSalesXlsx,
  useSalesList,
  useSalesOperatorOptions,
  useSalesPartnerOptions,
  useSalesSheetSourceOptions,
  useSalesSummary,
  type SaleListRow,
  type SalesOption,
} from "../api/managerDaily";

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
const DEFAULT_LIMIT = 50;
const COLS = "100px minmax(0,1.5fr) minmax(0,.8fr) minmax(0,1fr) minmax(0,1.5fr) 155px 115px 105px";

type StatusFilter = "" | "returned" | "gift" | "regular";

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DATE_PRESETS: { key: string; label: string; range: () => { from: string; to: string } }[] = [
  { key: "today", label: "v2.sales.preset.today", range: () => ({ from: iso(new Date()), to: iso(new Date()) }) },
  {
    key: "yesterday",
    label: "v2.sales.preset.yesterday",
    range: () => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return { from: iso(d), to: iso(d) };
    },
  },
  {
    key: "week",
    label: "v2.sales.preset.week",
    range: () => {
      const from = new Date();
      from.setDate(from.getDate() - 6);
      return { from: iso(from), to: iso(new Date()) };
    },
  },
  {
    key: "this_month",
    label: "v2.sales.preset.thisMonth",
    range: () => {
      const n = new Date();
      return { from: iso(new Date(n.getFullYear(), n.getMonth(), 1)), to: iso(n) };
    },
  },
  {
    key: "last_month",
    label: "v2.sales.preset.lastMonth",
    range: () => {
      const n = new Date();
      return { from: iso(new Date(n.getFullYear(), n.getMonth() - 1, 1)), to: iso(new Date(n.getFullYear(), n.getMonth(), 0)) };
    },
  },
];

function fmtWhen(isoStr: string): string {
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm} ${hh}:${mi}`;
}

function fmtDay(s: string): string {
  const [y, m, d] = s.split("-");
  return y && m && d ? `${d}.${m}` : s;
}

function initials(name: string | null | undefined): string {
  if (!name) return "—";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "—";
}

/** Status badge: возврат / отклонена / ожидает / оплачено. */
function saleStatusBadge(s: Pick<SaleListRow, "is_returned" | "status">, t: (k: string) => string) {
  if (s.is_returned) return { label: t("v2.sales.st.returned"), tone: "b-bad" };
  if (s.status === "rejected") return { label: t("v2.sales.st.rejected"), tone: "b-bad" };
  if (s.status === "pending") return { label: t("v2.sales.st.pending"), tone: "b-hot" };
  return { label: t("v2.sales.st.paid"), tone: "b-ok" };
}

/** Partner column: «Alif + Uzum» for a split, else the single channel. */
function salePartners(s: Pick<SaleListRow, "partner_lines" | "channel_name">): string {
  const lines = s.partner_lines ?? [];
  if (lines.length > 1) return lines.map((l) => l.partner_name).join(" + ");
  return s.channel_name || lines[0]?.partner_name || "—";
}

/** Compact multi-select: «Партнёры: все» / «Партнёры: 2 выбрано», search above 8 options. */
function MultiPick({ label, options, selected, onChange, loading }: { label: string; options: SalesOption[]; selected: number[]; onChange: (ids: number[]) => void; loading?: boolean }) {
  const t = useT2();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? options.filter((o) => o.name.toLowerCase().includes(needle)) : options;
  }, [q, options]);
  const sel = new Set(selected);
  const toggle = (id: number) => onChange(sel.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const caption = selected.length ? t("v2.sales.picked", { label, n: selected.length }) : t("v2.sales.pickedAll", { label });
  return (
    <div className="field" ref={ref} style={{ position: "relative" }}>
      <span className="flabel">{label}</span>
      <div className="row" style={{ position: "relative" }}>
        <button
          className="input row g8"
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          style={{ width: 200, borderColor: selected.length ? "var(--brand)" : undefined, paddingRight: selected.length ? 34 : undefined }}
        >
          <span className={cx("grow trunc", !selected.length && "c2")} style={{ textAlign: "left" }}>{caption}</span>
          {!selected.length ? <ChevronDown className="ic ic-s c3" /> : null}
        </button>
        {selected.length ? (
          <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("v2.sales.clearPick", { label })} onClick={() => onChange([])} style={{ position: "absolute", right: 4, width: 28, height: 28 }}>
            <X className="ic ic-s" />
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="card col" role="listbox" aria-multiselectable="true" style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, width: 260, maxHeight: 320, zIndex: 30, boxShadow: "var(--shadow)", overflow: "hidden" }}>
          {options.length > 8 ? (
            <div style={{ padding: 8, borderBottom: "1px solid var(--line)" }}>
              <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("v2.sales.pickSearch")} aria-label={t("v2.sales.pickSearch")} style={{ height: 34 }} />
            </div>
          ) : null}
          <div className="col" style={{ overflowY: "auto", padding: 4 }}>
            {loading ? <span className="s c3" style={{ padding: 10 }}>{t("common.loading")}</span> : null}
            {!loading && list.length === 0 ? <span className="s c3" style={{ padding: 10 }}>{t("v2.sales.pickNothing")}</span> : null}
            {list.map((o) => (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={sel.has(o.id)}
                className="row g8 s"
                onClick={() => toggle(o.id)}
                style={{ padding: "8px 10px", border: 0, borderRadius: 8, background: sel.has(o.id) ? "var(--brand-soft)" : "transparent", textAlign: "left", cursor: "pointer", color: "var(--ink)" }}
              >
                <span style={{ width: 16, flex: "none" }}>{sel.has(o.id) ? <Check className="ic ic-s c-brand" /> : null}</span>
                <span className="trunc grow">{o.name}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function Sales() {
  const t = useT2();
  const [sp, setSp] = useSearchParams();
  const [downloading, setDownloading] = useState(false);

  const limit = Number(sp.get("limit") || DEFAULT_LIMIT);
  const offset = Number(sp.get("offset") || 0);
  const search = sp.get("search") || "";
  const dateFrom = sp.get("date_from") || "";
  const dateTo = sp.get("date_to") || "";
  const statusVal = (sp.get("status_filter") || "") as StatusFilter;
  const partnerIds = sp.getAll("partner_ids").map(Number).filter(Boolean);
  const operatorIds = sp.getAll("operator_ids").map(Number).filter(Boolean);
  const sheetSourceId = sp.get("sheet_source_id") || "";

  const filterCount = (dateFrom ? 1 : 0) + (dateTo ? 1 : 0) + (partnerIds.length ? 1 : 0) + (operatorIds.length ? 1 : 0) + (sheetSourceId ? 1 : 0);
  const [filtersOpen, setFiltersOpen] = useState(filterCount > 0);

  // Local search box, debounced into the URL.
  const [searchDraft, setSearchDraft] = useState(search);
  useEffect(() => setSearchDraft(search), [search]);

  useEffect(() => {
    if (!sp.has("limit")) {
      const next = new URLSearchParams(sp);
      next.set("limit", String(DEFAULT_LIMIT));
      setSp(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (patch: Record<string, string | string[] | null>, opts?: { keepOffset?: boolean }) => {
    const next = new URLSearchParams(sp);
    for (const [key, value] of Object.entries(patch)) {
      next.delete(key);
      if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) continue;
      if (Array.isArray(value)) value.forEach((v) => next.append(key, String(v)));
      else next.set(key, String(value));
    }
    if (!opts?.keepOffset) next.delete("offset");
    if (!next.has("limit")) next.set("limit", String(DEFAULT_LIMIT));
    setSp(next);
  };

  useEffect(() => {
    if (searchDraft === search) return;
    const id = window.setTimeout(() => update({ search: searchDraft }), 300);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);

  const resetFilters = () => {
    const next = new URLSearchParams();
    next.set("limit", String(limit));
    if (search) next.set("search", search);
    if (statusVal) next.set("status_filter", statusVal);
    setSp(next);
  };

  // status_filter → is_returned / is_gift (same mapping as the old page)
  const apiParams = useMemo(() => {
    const p = new URLSearchParams(sp);
    p.delete("status_filter");
    if (statusVal === "returned") p.set("is_returned", "true");
    if (statusVal === "gift") p.set("is_gift", "true");
    if (statusVal === "regular") p.set("is_returned", "false");
    return p;
  }, [sp, statusVal]);

  const sales = useSalesList(apiParams);

  const summaryParams = useMemo(() => {
    const p = new URLSearchParams();
    if (dateFrom) p.set("date_from", dateFrom);
    if (dateTo) p.set("date_to", dateTo);
    for (const id of operatorIds) p.append("operator_ids", String(id));
    for (const id of partnerIds) p.append("partner_ids", String(id));
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, operatorIds.join(","), partnerIds.join(",")]);
  const summaryQ = useSalesSummary(summaryParams, Boolean(dateFrom || dateTo));

  const partnersQ = useSalesPartnerOptions();
  const operatorsQ = useSalesOperatorOptions();
  const sourcesQ = useSalesSheetSourceOptions();
  const partnerOptions = partnersQ.data ?? [];
  const operatorOptions = operatorsQ.data ?? [];
  const sourceOptions = sourcesQ.data ?? [];

  const downloadExcel = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadSalesXlsx(apiParams);
    } catch {
      toast.error(t("v2.sales.exportFailed"));
    } finally {
      setDownloading(false);
    }
  };

  const total = sales.data?.count ?? 0;
  const rows = sales.data?.results ?? [];
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + limit, total);
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  const statusTabs: { key: StatusFilter; label: string }[] = [
    { key: "", label: t("v2.sales.tab.all") },
    { key: "regular", label: t("v2.sales.tab.regular") },
    { key: "returned", label: t("v2.sales.tab.returned") },
    { key: "gift", label: t("v2.sales.tab.gift") },
  ];

  const nameOf = (opts: SalesOption[], id: number) => opts.find((o) => o.id === id)?.name ?? `#${id}`;

  return (
    <>
      <PageHeader
        title={t("sales.title")}
        meta={
          <span className="seg" role="tablist" aria-label={t("v2.sales.statusAria")}>
            {statusTabs.map((s) => (
              <button key={s.key || "all"} type="button" role="tab" aria-selected={statusVal === s.key} className={cx(statusVal === s.key && "is-on")} onClick={() => update({ status_filter: s.key || null })}>
                {s.label}
              </button>
            ))}
          </span>
        }
      >
        <button className="btn" type="button" onClick={downloadExcel} disabled={downloading} aria-busy={downloading}>
          <Download className="ic" />
          {downloading ? t("v2.sales.exporting") : "Excel"}
        </button>
        <Link className="btn btn-pri" to="/sales/new">
          <Plus className="ic" />
          {t("v2.sales.new")}
        </Link>
      </PageHeader>

      <main className="page" style={{ gap: 16 }}>
        <section className="card col" aria-label={t("v2.sales.filters")}>
          <div className="row g8 wrap" style={{ padding: "12px 16px" }}>
            <div className="inwrap" style={{ width: 300, maxWidth: "100%" }}>
              <Search className="ic" />
              <input className="input" type="search" placeholder={t("v2.sales.searchPh")} aria-label={t("v2.sales.searchAria")} value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} />
            </div>
            {DATE_PRESETS.map((p) => {
              const r = p.range();
              const on = dateFrom === r.from && dateTo === r.to;
              return (
                <button key={p.key} type="button" className={cx("chip", on && "is-on")} aria-pressed={on} onClick={() => update({ date_from: r.from, date_to: r.to })}>
                  {t(p.label)}
                </button>
              );
            })}
            <span className="grow" />
            <button
              className={cx("btn", (filtersOpen || filterCount > 0) && "is-on")}
              type="button"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((v) => !v)}
              style={filterCount > 0 ? { borderColor: "var(--brand)", color: "var(--brand-text)" } : undefined}
            >
              <Filter className="ic ic-s" />
              {t("v2.sales.filters")}
              {filterCount > 0 ? <span className="cnt" style={{ background: "var(--brand)" }}>{filterCount}</span> : null}
            </button>
          </div>
          {filtersOpen ? (
            <>
              <hr className="hr" />
              <div className="row g12 wrap" style={{ padding: "12px 16px 14px", alignItems: "flex-end" }}>
                <div className="field" style={{ width: 160 }}>
                  <label htmlFor="sales-df">{t("v2.sales.dateFrom")}</label>
                  <input className="input" id="sales-df" type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => update({ date_from: e.target.value })} />
                </div>
                <div className="field" style={{ width: 160 }}>
                  <label htmlFor="sales-dt">{t("v2.sales.dateTo")}</label>
                  <input className="input" id="sales-dt" type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => update({ date_to: e.target.value })} />
                </div>
                <MultiPick label={t("v2.sales.partners")} options={partnerOptions} selected={partnerIds} loading={partnersQ.isLoading} onChange={(ids) => update({ partner_ids: ids.map(String) })} />
                <MultiPick label={t("v2.sales.operators")} options={operatorOptions} selected={operatorIds} loading={operatorsQ.isLoading} onChange={(ids) => update({ operator_ids: ids.map(String) })} />
                <div className="field">
                  <label htmlFor="sales-src">{t("v2.sales.source")}</label>
                  <select className="input" id="sales-src" style={{ width: 200 }} value={sheetSourceId} onChange={(e) => update({ sheet_source_id: e.target.value || null })}>
                    <option value="">{t("v2.sales.allSources")}</option>
                    {sourceOptions.map((s) => (
                      <option key={s.id} value={String(s.id)}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <span className="grow" />
                {filterCount > 0 ? (
                  <button className="btn btn-ghost" type="button" onClick={resetFilters}>
                    <RotateCcw className="ic ic-s" />
                    {t("v2.sales.reset")}
                  </button>
                ) : null}
              </div>
              {partnerIds.length || operatorIds.length ? (
                <div className="col g6" style={{ padding: "0 16px 12px" }}>
                  {partnerIds.length ? (
                    <div className="row g6 wrap xs">
                      <span className="c3">{t("v2.sales.partners")}:</span>
                      {partnerIds.map((id) => <span key={id} className="badge b-info">{nameOf(partnerOptions, id)}</span>)}
                    </div>
                  ) : null}
                  {operatorIds.length ? (
                    <div className="row g6 wrap xs">
                      <span className="c3">{t("v2.sales.operators")}:</span>
                      {operatorIds.map((id) => <span key={id} className="badge b-info">{nameOf(operatorOptions, id)}</span>)}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </section>

        {dateFrom || dateTo ? (
          <section className="card col" aria-label={t("v2.sales.summary")}>
            <div className="card-h">
              <span className="row g12 wrap" style={{ alignItems: "baseline" }}>
                <span className="h3">{t("v2.sales.summary")}</span>
                {summaryQ.data ? (
                  <span className="s c3">
                    <span className="num">{fmtNum(summaryQ.data.total_count)}</span> {t("v2.sales.salesWord")} · <span className="num w6 c-brand">{fmtNum(summaryQ.data.total_amount)}</span> {t("v2.sales.sum")}
                  </span>
                ) : null}
              </span>
              <span className="xs c3">
                {dateFrom ? fmtDay(dateFrom) : "…"} – {dateTo ? fmtDay(dateTo) : "…"} · {t("v2.sales.summaryHint")}
              </span>
            </div>
            {summaryQ.isLoading ? (
              <LoadingBlock rows={3} />
            ) : summaryQ.isError ? (
              <ErrorState error={summaryQ.error} onRetry={() => summaryQ.refetch()} />
            ) : summaryQ.data ? (
              <div className="row g24 wrap" style={{ padding: "14px 16px", alignItems: "flex-start" }}>
                <div className="col g6 grow" style={{ minWidth: 260 }}>
                  <span className="lbl" style={{ marginBottom: 4 }}>{t("v2.sales.byOperator")}</span>
                  {summaryQ.data.by_operator.length === 0 ? (
                    <span className="s c3">{t("v2.sales.noData")}</span>
                  ) : (
                    summaryQ.data.by_operator.map((r) => (
                      <div key={r.operator_id ?? r.name} className="row between s" style={{ minHeight: 22 }}>
                        <span className="trunc">{r.name}</span>
                        <span className="num c3" style={{ flex: "none", marginLeft: 12 }}>
                          {r.count} {t("v2.sales.pcs")} · {fmtNum(r.amount)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
                <span style={{ width: 1, alignSelf: "stretch", background: "var(--line)" }} />
                <div className="col g6 grow" style={{ minWidth: 260 }}>
                  <span className="lbl" style={{ marginBottom: 4 }}>{t("v2.sales.byModel")}</span>
                  {summaryQ.data.by_model.length === 0 ? (
                    <span className="s c3">{t("v2.sales.noData")}</span>
                  ) : (
                    summaryQ.data.by_model.slice(0, 10).map((r) => (
                      <div key={r.model} className="row between s" style={{ minHeight: 22 }}>
                        <span className="trunc">{r.model}</span>
                        <span className="num c3" style={{ flex: "none", marginLeft: 12 }}>
                          {r.count} {t("v2.sales.pcs")} · {fmtNum(r.amount)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="card tbl scroll-x" aria-busy={sales.isFetching}>
          <div style={{ minWidth: 1060 }}>
            <div className="tr th" style={{ gridTemplateColumns: COLS }}>
              <span>{t("v2.sales.col.time")}</span>
              <span>{t("v2.sales.col.operator")}</span>
              <span>{t("v2.sales.col.source")}</span>
              <span>{t("v2.sales.col.partner")}</span>
              <span>{t("v2.sales.col.model")}</span>
              <span>IMEI</span>
              <span className="r">{t("v2.sales.col.sum")}</span>
              <span>{t("v2.sales.col.status")}</span>
            </div>
            {sales.isLoading ? (
              <LoadingBlock rows={8} onRetry={() => sales.refetch()} />
            ) : sales.isError ? (
              <ErrorState error={sales.error} onRetry={() => sales.refetch()} />
            ) : rows.length === 0 ? (
              <EmptyState
                title={t("v2.sales.emptyTitle")}
                body={t("v2.sales.emptyBody")}
                action={
                  filterCount > 0 || search || statusVal ? (
                    <button className="btn" type="button" onClick={() => setSp(new URLSearchParams({ limit: String(limit) }))}>
                      <RotateCcw className="ic ic-s" />
                      {t("v2.sales.resetAll")}
                    </button>
                  ) : undefined
                }
              />
            ) : (
              rows.map((s) => {
                const st = saleStatusBadge(s, t);
                const extraOps = (s.operator_lines?.length ?? 0) - 1;
                const net = s.total_price ?? s.amount;
                return (
                  <Link key={s.id} className="tr" to={`/sales/${s.id}`} style={{ gridTemplateColumns: COLS, color: "inherit" }}>
                    <span className="num s c2">{fmtWhen(s.sold_at)}</span>
                    <span className="row g8" style={{ minWidth: 0 }}>
                      <span className="ava ava-s">{initials(s.operator_name)}</span>
                      <span className="trunc">{s.operator_name || "—"}</span>
                      {extraOps > 0 ? (
                        <span className="badge" style={{ height: 18, padding: "0 5px", fontSize: 11 }} title={t("v2.sales.splitOps")}>
                          +{extraOps}
                        </span>
                      ) : null}
                    </span>
                    <span className="c2 trunc">{s.sheet_source_name || "—"}</span>
                    <span className="trunc" title={salePartners(s)}>{salePartners(s)}</span>
                    <span className="w6 trunc">{s.phone_model || "—"}</span>
                    <span className="num xs c2 trunc">{s.imei || "—"}</span>
                    <span className={cx("r num w6", s.is_returned && "c-bad", s.status === "rejected" && !s.is_returned && "c3")}>
                      {s.is_returned ? "−" : ""}
                      {fmtNum(net)}
                    </span>
                    <span>
                      <span className={cx("badge", st.tone)}>
                        <i className="dot" />
                        {st.label}
                      </span>
                    </span>
                  </Link>
                );
              })
            )}
          </div>
        </section>

        {total > 0 ? (
          <div className="row between wrap g12">
            <span className="row g8 s c3">
              {t("v2.sales.perPage")}
              <select className="input" aria-label={t("v2.sales.perPageAria")} style={{ width: 90, height: 36 }} value={String(limit)} onChange={(e) => update({ limit: e.target.value })}>
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={String(n)}>{n}</option>
                ))}
              </select>
              <span className="num c2" style={{ marginLeft: 8 }}>
                {t("v2.sales.range", { a: rangeStart, b: rangeEnd, n: total })}
              </span>
            </span>
            <div className="row g8">
              <button className="btn" type="button" disabled={!hasPrev} onClick={() => update({ offset: String(Math.max(0, offset - limit)) }, { keepOffset: true })}>
                <ChevronLeft className="ic ic-s" />
                {t("v2.sales.prev")}
              </button>
              <button className="btn" type="button" disabled={!hasNext} onClick={() => update({ offset: String(offset + limit) }, { keepOffset: true })}>
                {t("v2.sales.next")}
                <ChevronRight className="ic ic-s" />
              </button>
            </div>
          </div>
        ) : null}
      </main>
    </>
  );
}
