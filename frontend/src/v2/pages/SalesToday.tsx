import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useT2 } from "../i18n";
import { CountUp, EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtMln, fmtNum } from "../ui";
import { useSalesChannelsToday, useSalesDailyTarget, useSalesKpiToday, useSalesTodayList, type SaleListRow } from "../api/managerDaily";

const COLS = "90px minmax(0,1.6fr) minmax(0,1.4fr) minmax(0,160px) 150px 130px";
const MAX_ROWS = 30;

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hhmm(iso: string | number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function statusOf(s: SaleListRow, t: (k: string) => string) {
  if (s.is_returned) return { label: t("v2.sales.st.returned"), tone: "b-bad" };
  if (s.status === "rejected") return { label: t("v2.sales.st.rejected"), tone: "b-bad" };
  if (s.status === "pending") return { label: t("v2.sales.st.pending"), tone: "b-warn" };
  return { label: t("v2.sales.st.paid"), tone: "b-ok" };
}

function partnersOf(s: SaleListRow): string {
  const lines = s.partner_lines ?? [];
  if (lines.length > 1) return lines.map((l) => l.partner_name).join(" + ");
  return s.channel_name || lines[0]?.partner_name || "—";
}

export default function SalesToday() {
  const t = useT2();
  const today = useMemo(localToday, []);
  const kpi = useSalesKpiToday();
  const sales = useSalesTodayList(today);
  const channels = useSalesChannelsToday();
  const target = useSalesDailyTarget();

  const rows = sales.data?.results ?? [];
  const total = Number(kpi.data?.today.total ?? 0);
  const count = kpi.data?.today.count ?? rows.length;
  const returns = rows.filter((s) => s.is_returned).length;
  const uniqOps = new Set(rows.map((s) => s.operator_name).filter(Boolean)).size;
  const avgCheck = count > 0 ? total / count : 0;
  const planCount = target.data?.target_daily_count ?? null;
  const planPct = planCount ? Math.round((count / planCount) * 100) : null;

  const channelBreakdown = useMemo(() => {
    const list = channels.data ?? [];
    const sum = list.reduce((a, r) => a + Number(r.total), 0);
    return list.slice(0, 6).map((r) => ({
      name: r.channel_name,
      total: Number(r.total),
      pct: sum ? Math.round((Number(r.total) / sum) * 100) : 0,
    }));
  }, [channels.data]);

  const updatedAt = Math.max(kpi.dataUpdatedAt || 0, sales.dataUpdatedAt || 0);

  return (
    <>
      <PageHeader
        title={t("v2.today.title")}
        back="/"
        meta={
          <>
            {t("v2.today.since")} <span className="num">09:00</span>
            {updatedAt ? (
              <>
                {" · "}
                {t("v2.today.updated")} <span className="num">{hhmm(updatedAt)}</span>
              </>
            ) : null}
          </>
        }
      >
        <Link className="btn" to="/sales">{t("v2.today.allSales")}</Link>
      </PageHeader>

      <main className="page">
        <div className="row g20 wrap" style={{ alignItems: "stretch" }}>
          <section className="card col g20 between" style={{ flex: "3 1 520px", padding: "22px 24px", minWidth: 0 }} aria-busy={kpi.isLoading}>
            {kpi.isLoading ? (
              <LoadingBlock rows={2} />
            ) : kpi.isError ? (
              <ErrorState error={kpi.error} onRetry={() => kpi.refetch()} />
            ) : (
              <>
                <div className="col g4">
                  <span className="lbl">{t("v2.today.revenue")}</span>
                  <span className="display" style={{ fontSize: 40, lineHeight: "48px" }}>{fmtNum(total)}</span>
                  <span className="s c3">
                    {t("v2.today.sum")} · <span className="num">{count}</span> {t("v2.today.salesWord")}
                    {returns > 0 ? (
                      <>
                        {" · "}
                        <span className="c-bad">{t("sales_today.returns_count", { n: returns })}</span>
                      </>
                    ) : null}
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 24 }}>
                  <div className="col g4">
                    <span className="lbl">{t("sales_today.mini_units")}</span>
                    <span className="kpi" style={{ fontSize: 22 }}><CountUp value={count} /></span>
                  </div>
                  <div className="col g4">
                    <span className="lbl">{t("sales_today.mini_avg_check")}</span>
                    <span className="kpi" style={{ fontSize: 22 }}>{avgCheck ? fmtMln(avgCheck) : "—"}</span>
                  </div>
                  <div className="col g4">
                    <span className="lbl">{t("sales_today.mini_operators")}</span>
                    <span className="kpi" style={{ fontSize: 22 }}><CountUp value={uniqOps} /></span>
                  </div>
                  {planPct !== null ? (
                    <div className="col g4" title={t("v2.today.planHint", { n: planCount ?? 0 })}>
                      <span className="lbl">{t("sales_today.mini_plan")}</span>
                      <span className="kpi" style={{ fontSize: 22, color: planPct >= 100 ? "var(--ok)" : "var(--warn)" }}>{planPct}%</span>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </section>

          <aside className="card col" style={{ flex: "2 1 340px", minWidth: 0 }}>
            <div className="card-h">
              <span className="h3">{t("v2.today.partners")}</span>
              <span className="xs c3">{t("v2.today.partnersHint")}</span>
            </div>
            {channels.isLoading ? (
              <LoadingBlock rows={3} />
            ) : channels.isError ? (
              <ErrorState error={channels.error} onRetry={() => channels.refetch()} />
            ) : channelBreakdown.length === 0 ? (
              <div className="s c3" style={{ padding: "14px 20px" }}>{t("sales_today.empty_short")}</div>
            ) : (
              <div className="col g12" style={{ padding: "14px 20px" }}>
                {channelBreakdown.map((c) => (
                  <div key={c.name || "—"} className="col g4">
                    <div className="row between s">
                      <span className="trunc">{c.name || "—"}</span>
                      <span style={{ flex: "none" }}>
                        <span className="num w6">{c.pct}%</span> <span className="num xs c3">{fmtMln(c.total)}</span>
                      </span>
                    </div>
                    <div className="bar" role="progressbar" aria-valuenow={c.pct} aria-valuemin={0} aria-valuemax={100} aria-label={c.name}>
                      <i style={{ width: `${c.pct}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </aside>
        </div>

        <section className="card tbl">
          <div className="card-h">
            <span className="h3">{t("sales_today.sold_today")}</span>
            <span className="xs c3">
              <span className="num">{rows.length}</span> {t("v2.today.listHint")}
            </span>
          </div>
          <div className="scroll-x">
            <div style={{ minWidth: 820 }}>
              <div className="tr th" style={{ gridTemplateColumns: COLS }}>
                <span>{t("v2.sales.col.time")}</span>
                <span>{t("v2.sales.col.model")}</span>
                <span>{t("v2.sales.col.operator")}</span>
                <span>{t("v2.sales.col.partner")}</span>
                <span className="r">{t("v2.sales.col.sum")}</span>
                <span>{t("v2.sales.col.status")}</span>
              </div>
              {sales.isLoading ? (
                <LoadingBlock rows={6} onRetry={() => sales.refetch()} />
              ) : sales.isError ? (
                <ErrorState error={sales.error} onRetry={() => sales.refetch()} />
              ) : rows.length === 0 ? (
                <EmptyState title={t("sales_today.empty")} body={t("v2.today.emptyBody")} />
              ) : (
                rows.slice(0, MAX_ROWS).map((s) => {
                  const st = statusOf(s, t);
                  return (
                    <Link key={s.id} className="tr" to={`/sales/${s.id}`} style={{ gridTemplateColumns: COLS, minHeight: 40, color: "inherit" }}>
                      <span className="num s c2">{hhmm(s.sold_at)}</span>
                      <span className="w6 trunc">{s.phone_model || "—"}</span>
                      <span className="trunc">{s.operator_name || "—"}</span>
                      <span className="c2 trunc">{partnersOf(s)}</span>
                      <span className={cx("r num w6", s.is_returned && "c-bad", s.status === "rejected" && !s.is_returned && "c3")}>
                        {s.is_returned ? "−" : ""}
                        {fmtNum(s.total_price ?? s.amount)}
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
          </div>
          <div className="row between wrap g8 xs c3" style={{ padding: "10px 16px", borderTop: "1px solid var(--line)" }}>
            <span>{t("v2.today.footer", { n: MAX_ROWS })}</span>
            <Link className="c-brand w6" to={`/sales?date_from=${today}&date_to=${today}&limit=50`}>
              {t("v2.today.allForDay")}
            </Link>
          </div>
        </section>
      </main>
    </>
  );
}
