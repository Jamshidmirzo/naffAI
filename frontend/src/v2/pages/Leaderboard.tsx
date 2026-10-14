import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { Monitor, Trophy } from "lucide-react";
import { useAuth } from "../../store/auth";
import { normaliseRole } from "../../components/RoleGate";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtMln, fmtNum } from "../ui";
import { tashkentHM, useLbMe, useLeaderboard, type LbPeriod, type LbRow } from "../api/personal";

const REFRESH_SEC = 60;
type T = ReturnType<typeof useT2>;

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

const num = (v: number | string) => Number(v) || 0;

function useBoard(defaultPeriod: LbPeriod) {
  const [period, setPeriod] = useState<LbPeriod>(defaultPeriod);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), REFRESH_SEC * 1000);
    return () => clearInterval(id);
  }, []);
  const lb = useLeaderboard(period, tick);
  const me = useLbMe();
  return { period, setPeriod, lb, myId: me.data?.operator_id ?? null };
}

function PeriodSeg({ t, value, onChange }: { t: T; value: LbPeriod; onChange: (p: LbPeriod) => void }) {
  const items: [LbPeriod, string][] = [
    ["day", t("leaderboard.period_today")],
    ["week", t("leaderboard.period_week")],
    ["month", t("leaderboard.period_month")],
    ["all", t("leaderboard.period_all")],
  ];
  return (
    <div className="seg" role="tablist">
      {items.map(([v, l]) => (
        <button key={v} type="button" role="tab" aria-selected={value === v} className={cx(value === v && "is-on")} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Totals({ t, rows }: { t: T; rows: LbRow[] }) {
  const sum = rows.reduce((a, r) => a + num(r.total), 0);
  const cnt = rows.reduce((a, r) => a + num(r.count), 0);
  return (
    <div className="row g16 wrap s c3">
      <span>{t("leaderboard.total_operators")}: <span className="num w6" style={{ color: "var(--ink)" }}>{rows.length}</span></span>
      <span>{t("leaderboard.total_sales")}: <span className="num w6" style={{ color: "var(--ink)" }}>{fmtNum(cnt)}</span></span>
      <span>{t("leaderboard.total_amount")}: <span className="num w6" style={{ color: "var(--ink)" }}>{fmtNum(sum)} {t("v2.personal.lb.sumUnit")}</span></span>
    </div>
  );
}

export default function Leaderboard() {
  const role = normaliseRole(useAuth((s) => s.role));
  return role === "operator" ? <OperatorBoard /> : <ManagerBoard />;
}

/* ------------------------------ Operator (OpBoard) ------------------------------ */

function OperatorBoard() {
  const t = useT2();
  const { period, setPeriod, lb, myId } = useBoard("day");
  const rows = lb.data ?? [];
  const myIdx = myId == null ? -1 : rows.findIndex((r) => r.operator_id === myId);
  const periodWord = t(`v2.personal.lb.p.${period}`);
  const updated = lb.dataUpdatedAt ? tashkentHM(new Date(lb.dataUpdatedAt).toISOString()) : null;

  let bannerTitle = "";
  let bannerBody = "";
  if (myIdx === -1) {
    bannerTitle = t("v2.personal.lb.notIn", { period: periodWord });
    bannerBody = t("v2.personal.lb.notInBody");
  } else {
    const mine = rows[myIdx];
    if (myIdx === 0) {
      bannerTitle = t("v2.personal.lb.youLead", { n: num(mine.count), period: periodWord });
      if (rows[1]) bannerBody = t("v2.personal.lb.leadGap", { amount: fmtNum(num(mine.total) - num(rows[1].total)) });
    } else {
      bannerTitle = t("v2.personal.lb.youAt", { rank: myIdx + 1, n: num(mine.count), period: periodWord });
      bannerBody = t("v2.personal.lb.gap", { rank: myIdx, amount: fmtNum(Math.max(0, num(rows[myIdx - 1].total) - num(mine.total))) });
    }
  }

  const top = rows.slice(0, 3);
  const rest = rows.slice(3);
  const cols = "72px minmax(200px, 1fr) 120px 180px";

  return (
    <>
      <PageHeader title={t("v2.personal.lb.title")}>
        <PeriodSeg t={t} value={period} onChange={setPeriod} />
      </PageHeader>
      <main className="page">
        {lb.isLoading ? (
          <section className="card"><LoadingBlock rows={6} onRetry={() => lb.refetch()} /></section>
        ) : lb.isError ? (
          <section className="card"><ErrorState error={lb.error} onRetry={() => lb.refetch()} /></section>
        ) : (
          <>
            <section className="row g16 wrap" style={{ padding: "16px 20px", borderRadius: 14, background: "var(--brand-soft)" }}>
              <span className="rank" style={{ width: 40, height: 40, fontSize: 16, background: "var(--surface)", color: "var(--brand-text)" }}>
                {myIdx >= 0 ? myIdx + 1 : "—"}
              </span>
              <div className="col grow" style={{ gap: 2, minWidth: 220 }}>
                <span className="h3">{bannerTitle}</span>
                {bannerBody ? <span className="s c2">{bannerBody}</span> : null}
              </div>
              {updated ? <span className="s c3">{t("v2.personal.lb.updatedAt", { time: updated })}</span> : null}
            </section>

            {rows.length === 0 ? (
              <section className="card">
                <EmptyState icon={<Trophy className="ic ic-l" />} title={t("v2.personal.lb.empty")} body={t("v2.personal.lb.emptyBody")} />
              </section>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
                  {top.map((r, i) => (
                    <section key={r.operator_id} className={cx("card col g16", r.operator_id === myId && "pick-on")} style={{ padding: 20 }}>
                      <div className="row between">
                        <span className={cx("rank", i === 0 && "r1")}>{i + 1}</span>
                        <span className="row g6">
                          {r.operator_id === myId ? <span className="badge b-info">{t("v2.personal.lb.you")}</span> : null}
                          {r.is_trainee ? <span className="badge">{t("v2.personal.lb.trainee")}</span> : null}
                        </span>
                      </div>
                      <div className="row g12" style={{ minWidth: 0 }}>
                        <span className="ava ava-l">{initials(r.operator_name)}</span>
                        <span className="h3 trunc">{r.operator_name}</span>
                      </div>
                      <div className="row between" style={{ alignItems: "baseline" }}>
                        <span className="kpi">{fmtNum(r.count)}</span>
                        <span className="num s c2">{fmtNum(r.total)} {t("v2.personal.lb.sumUnit")}</span>
                      </div>
                    </section>
                  ))}
                </div>

                <section className="card tbl">
                  <div className="card-h"><Totals t={t} rows={rows} /></div>
                  {rest.length ? (
                    <div style={{ overflowX: "auto" }}>
                      <div style={{ minWidth: 560 }}>
                        <div className="tr th" style={{ gridTemplateColumns: cols }}>
                          <span>{t("v2.personal.lb.colRank")}</span>
                          <span>{t("v2.personal.lb.colOp")}</span>
                          <span className="r">{t("v2.personal.lb.colCount")}</span>
                          <span className="r">{t("v2.personal.lb.colSum")}</span>
                        </div>
                        {rest.map((r, i) => {
                          const isMe = r.operator_id === myId;
                          return (
                            <div key={r.operator_id} className={cx("tr", isMe && "is-sel")} style={{ gridTemplateColumns: cols }}>
                              <span><span className="rank">{i + 4}</span></span>
                              <span className="row g8" style={{ minWidth: 0 }}>
                                <span className="ava ava-s">{initials(r.operator_name)}</span>
                                <span className="w6 trunc">{r.operator_name}</span>
                                {isMe ? <span className="xs w6" style={{ color: "var(--brand-text)" }}>{t("v2.personal.lb.you")}</span> : null}
                                {r.is_trainee ? <span className="xs c3">{t("v2.personal.lb.trainee")}</span> : null}
                              </span>
                              <span className="r num w6">{fmtNum(r.count)}</span>
                              <span className="r num">{fmtNum(r.total)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </section>
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}

/* ------------------------------ Manager (MgBoard) ------------------------------ */

const PODIUM_BG: Record<number, CSSProperties> = {
  1: { background: "linear-gradient(160deg, var(--warn-bg), var(--surface) 70%)", borderColor: "var(--warn-solid)" },
  2: { background: "linear-gradient(160deg, var(--surface-3), var(--surface) 70%)" },
  3: { background: "linear-gradient(160deg, var(--hot-bg), var(--surface) 70%)" },
};

function useWide(min = 1100) {
  const q = `(min-width: ${min}px)`;
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const h = () => setWide(m.matches);
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, [q]);
  return wide;
}

function PodiumCard({ t, rank, row, isMe, span }: { t: T; rank: number; row: LbRow; isMe: boolean; span: boolean }) {
  const gold = rank === 1;
  return (
    <section
      className={cx("card col", isMe && "pick-on")}
      style={{ padding: gold ? 24 : 20, gap: 4, gridRow: gold && span ? "span 2" : undefined, minHeight: gold ? 0 : 180, ...PODIUM_BG[rank] }}
    >
      <div className="row g8">
        <span className={cx("rank", rank === 1 && "r1")} style={rank === 3 ? { background: "var(--hot-bg)", color: "var(--hot)" } : undefined}>{rank}</span>
        <span className="ava">{initials(row.operator_name)}</span>
        <span className="grow" />
        {isMe ? <span className="badge b-info">{t("v2.personal.lb.you")}</span> : null}
      </div>
      <span className="h3" style={{ marginTop: 12, fontSize: gold ? 22 : 18, lineHeight: gold ? "30px" : "24px", wordBreak: "break-word" }}>{row.operator_name}</span>
      {row.is_trainee ? <span className="xs c3">{t("v2.personal.lb.trainee")}</span> : null}
      <span className="grow" style={{ minHeight: 12 }} />
      <span className="display" style={{ fontSize: gold ? 44 : 32, lineHeight: gold ? "52px" : "40px", color: gold ? "var(--warn)" : "var(--ink)" }}>
        {fmtMln(row.total)}
      </span>
      <span className="num xs c3">{fmtNum(row.total)} {t("v2.personal.lb.sumUnit")}</span>
      <span className="num xs c3">{t("v2.personal.lb.salesN", { n: fmtNum(row.count) })}</span>
    </section>
  );
}

function ManagerBoard() {
  const t = useT2();
  const { period, setPeriod, lb, myId } = useBoard("month");
  const rows = lb.data ?? [];
  const top = rows.slice(0, 5);
  const tail = rows.slice(5);
  const wide = useWide();

  return (
    <>
      <PageHeader title={t("v2.personal.lb.title")} meta={t("v2.personal.lb.sub")}>
        <span className="xs c3">{t("v2.personal.lb.autoRefresh")}</span>
        <Link className="btn" to="/screen"><Monitor className="ic" />{t("v2.personal.lb.toTv")}</Link>
      </PageHeader>
      <main className="page">
        <div className="row between wrap g12">
          <PeriodSeg t={t} value={period} onChange={setPeriod} />
          {rows.length ? <Totals t={t} rows={rows} /> : null}
        </div>

        {lb.isLoading ? (
          <section className="card"><LoadingBlock rows={6} onRetry={() => lb.refetch()} /></section>
        ) : lb.isError ? (
          <section className="card"><ErrorState error={lb.error} onRetry={() => lb.refetch()} /></section>
        ) : rows.length === 0 ? (
          <section className="card">
            <EmptyState icon={<Trophy className="ic ic-l" />} title={t("v2.personal.lb.empty")} body={t("v2.personal.lb.emptyBody")} />
          </section>
        ) : (
          <>
            <div className="col g12">
              <span className="lbl">{t("v2.personal.lb.top5")}</span>
              <div style={{ display: "grid", gridTemplateColumns: wide ? "minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr)" : "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
                {top.map((r, i) => (
                  <PodiumCard key={r.operator_id} t={t} rank={i + 1} row={r} isMe={r.operator_id === myId} span={wide && top.length > 3} />
                ))}
              </div>
            </div>

            {tail.length ? (
              <section className="card col">
                <div className="card-h">
                  <span className="h3">{t("v2.personal.lb.rest")}</span>
                  <span className="xs c3">{t("v2.personal.lb.places", { from: 6, to: rows.length })}</span>
                </div>
                {tail.map((r, i) => {
                  const isMe = r.operator_id === myId;
                  return (
                    <div key={r.operator_id} className={cx("row-item", isMe && "is-sel")}>
                      <span className="num c3 w6" style={{ width: 40, flex: "none" }}>#{i + 6}</span>
                      <span className="ava">{initials(r.operator_name)}</span>
                      <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                        <span className="w6 trunc">
                          {r.operator_name}
                          {isMe ? <span className="badge b-info" style={{ marginLeft: 8 }}>{t("v2.personal.lb.you")}</span> : null}
                        </span>
                        <span className="num xs c3">
                          {t("v2.personal.lb.salesN", { n: fmtNum(r.count) })}
                          {r.is_trainee ? ` · ${t("v2.personal.lb.trainee")}` : ""}
                        </span>
                      </span>
                      <span className="num w6" style={{ fontSize: 15 }}>{fmtNum(r.total)} {t("v2.personal.lb.sumUnit")}</span>
                    </div>
                  );
                })}
              </section>
            ) : null}
          </>
        )}
      </main>
    </>
  );
}
