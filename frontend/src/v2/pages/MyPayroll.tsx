import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Check, Download, Wallet } from "lucide-react";
import { toast } from "../../components/ui";
import { useLang } from "../../store/lang";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum } from "../ui";
import {
  downloadMyPayroll,
  fmtCalendarDate,
  tashkentHM,
  tashkentISO,
  tashkentMonth,
  useMyPayroll,
  type MyPayrollResponse,
  type PayrollDay,
} from "../api/personal";

type T = ReturnType<typeof useT2>;

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Last 24 months (Tashkent calendar), newest first. */
function monthOptions(): string[] {
  const [y, m] = tashkentMonth().split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

function hm(ms: number) {
  const mins = Math.max(0, Math.floor(ms / 60000));
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

const DAY_TONE: Record<PayrollDay["status"], string> = {
  on_time: "b-ok",
  late: "b-bad",
  absent: "b-bad",
  weekend: "",
  free_absence: "b-info",
};

function addMinutes(hhmm: string, add: number) {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const total = h * 60 + m + add;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export default function MyPayroll() {
  const t = useT2();
  const lang = useLang((s) => s.lang);
  const [month, setMonth] = useState<string>(tashkentMonth());
  const [downloading, setDownloading] = useState<"xlsx" | "pdf" | null>(null);
  const q = useMyPayroll(month);
  const data = q.data;
  const months = useMemo(monthOptions, []);

  const download = async (fmt: "xlsx" | "pdf") => {
    setDownloading(fmt);
    try {
      await downloadMyPayroll(month, fmt);
    } catch {
      toast.error(t("v2.personal.payroll.downloadFailed"));
    } finally {
      setDownloading(null);
    }
  };

  return (
    <>
      <PageHeader title={t("v2.personal.payroll.title")}>
        <select
          className="input"
          aria-label={t("v2.personal.payroll.month")}
          style={{ width: 180 }}
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        >
          {months.map((m) => (
            <option key={m} value={m}>{cap(fmtCalendarDate(`${m}-01`, lang, { month: "long", year: "numeric" }).replace(/\s*г\.$/, ""))}</option>
          ))}
        </select>
        <button className="btn" type="button" disabled={!data || downloading != null} onClick={() => download("xlsx")}>
          <Download className="ic" />
          {downloading === "xlsx" ? t("common.loading") : t("payroll.download_xlsx")}
        </button>
        <button className="btn" type="button" disabled={!data || downloading != null} onClick={() => download("pdf")}>
          <Download className="ic" />
          {downloading === "pdf" ? t("common.loading") : t("payroll.download_pdf")}
        </button>
      </PageHeader>
      <main className="page">
        {q.isLoading ? (
          <section className="card"><LoadingBlock rows={5} onRetry={() => q.refetch()} /></section>
        ) : q.isError ? (
          <section className="card"><ErrorState error={q.error} onRetry={() => q.refetch()} /></section>
        ) : !data ? (
          <section className="card">
            <EmptyState icon={<Wallet className="ic ic-l" />} title={t("v2.personal.payroll.noData")} body={t("v2.personal.payroll.noDataBody")} />
          </section>
        ) : (
          <PayrollBody data={data} t={t} lang={lang} />
        )}
      </main>
    </>
  );
}

function PayrollBody({ data, t, lang }: { data: MyPayrollResponse; t: T; lang: "ru" | "uz" }) {
  const a = data.attendance;
  const s = data.sales;
  const both = data.both_gates_passed ?? (a.gate_passed && s.gate_passed);
  const monthName = fmtCalendarDate(`${data.year}-${String(data.month).padStart(2, "0")}-01`, lang, { month: "long" });
  const salesLeft = fmtNum(s.shortfall.amount_more_needed);
  const attLeft = a.shortfall.days_more_needed;

  let detail = "";
  if (!both) {
    if (a.gate_passed && !s.gate_passed) detail = t("v2.personal.payroll.attDoneSalesLeft", { amount: salesLeft });
    else if (!a.gate_passed && s.gate_passed) detail = t("v2.personal.payroll.salesDoneAttLeft", { n: attLeft });
    else detail = t("v2.personal.payroll.bothLeft", { n: attLeft, amount: salesLeft });
  }

  const today = tashkentISO();
  // Future days of the current month are not facts yet — hide them.
  const days = a.days.filter((d) => d.date <= today).reverse();
  const cols = "1.3fr 150px 110px 110px 120px 1fr";

  return (
    <>
      <section className="card row g24 wrap" style={{ padding: "20px 24px", alignItems: "center" }}>
        <div className="col g4" style={{ minWidth: 260 }}>
          <span className="lbl">{t("v2.personal.payroll.bonusFor", { month: monthName })}</span>
          <div className="row g8 wrap" style={{ alignItems: "baseline" }}>
            <span className="kpi" style={{ fontSize: 34, lineHeight: "40px", color: Number(data.total_earned) === 0 ? "var(--ink-3)" : undefined }}>
              {fmtNum(data.total_earned)}
            </span>
            <span className="c3">{t("v2.personal.payroll.canGet", { max: fmtNum(data.max_possible) })}</span>
          </div>
        </div>
        {both ? (
          <div className="banner b-ok grow" style={{ minWidth: 280 }}>
            <CheckCircle2 className="ic" />
            <span>{t("v2.personal.payroll.allDone")}</span>
          </div>
        ) : (
          <div className="banner b-warn grow" style={{ minWidth: 280 }}>
            <AlertTriangle className="ic" />
            <span>{t("v2.personal.payroll.needBoth")} {detail}</span>
          </div>
        )}
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <GateCard
          t={t}
          title={t("v2.personal.payroll.attendance")}
          passed={a.gate_passed}
          rate={a.rate_pct}
          gate={data.attendance_gate_pct}
          line={t("v2.personal.payroll.attLine", { a: a.days_attended, p: a.working_days_planned })}
          earned={a.block_earned}
          bonus={data.attendance_bonus_uzs}
          foot={
            <>
              {a.days_late > 0 ? (
                <p className="s c3">
                  {t("v2.personal.payroll.lateLine", { n: a.days_late })} <span className="num c-bad">−{fmtNum(a.late_penalty_total)}</span>.
                </p>
              ) : null}
              {!a.gate_passed ? <p className="s c3">{t("v2.personal.payroll.attShort", { n: attLeft })}</p> : null}
            </>
          }
        />
        <GateCard
          t={t}
          title={t("v2.personal.payroll.sales")}
          passed={s.gate_passed}
          rate={s.rate_pct}
          gate={data.sales_gate_pct}
          line={t("v2.personal.payroll.salesLine", { actual: fmtNum(s.actual_uzs), plan: fmtNum(s.plan_amount_uzs) })}
          earned={s.block_earned}
          bonus={data.sales_bonus_uzs}
          foot={
            !s.gate_passed && Number(s.shortfall.amount_more_needed) > 0 ? (
              <p className="s c3">{t("v2.personal.payroll.salesShort", { amount: salesLeft })}</p>
            ) : null
          }
        />
      </div>

      <section className="card tbl">
        <div className="card-h">
          <span className="h3">{t("v2.personal.payroll.days")}</span>
          <span className="xs c3">
            {t("v2.personal.payroll.shift", { start: data.shift_start, end: data.shift_end, grace: addMinutes(data.shift_start, data.grace_period_min) })}
          </span>
        </div>
        {days.length === 0 ? (
          <EmptyState title={t("v2.personal.payroll.noDays")} />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 760 }}>
              <div className="tr th" style={{ gridTemplateColumns: cols }}>
                <span>{t("v2.personal.payroll.colDate")}</span>
                <span>{t("v2.personal.payroll.colStatus")}</span>
                <span>{t("v2.personal.payroll.colIn")}</span>
                <span>{t("v2.personal.payroll.colOut")}</span>
                <span>{t("v2.personal.payroll.colDur")}</span>
                <span className="r">{t("v2.personal.payroll.colMinus")}</span>
              </div>
              {days.map((d) => {
                const ded = Number(d.deduction_uzs);
                const ongoing = !!d.checked_in_at && !d.checked_out_at && d.date === today;
                const dur = d.checked_in_at && d.checked_out_at
                  ? hm(new Date(d.checked_out_at).getTime() - new Date(d.checked_in_at).getTime())
                  : ongoing
                    ? hm(Date.now() - new Date(d.checked_in_at as string).getTime())
                    : "—";
                return (
                  <div key={d.date} className="tr" style={{ gridTemplateColumns: cols }}>
                    <span className="col" style={{ gap: 2 }}>
                      <span className="w5">{cap(fmtCalendarDate(d.date, lang, { weekday: "short", day: "numeric", month: "long" }))}</span>
                      {d.note && d.note !== t(`payroll.day.${d.status}`) ? <span className="xs c3 trunc">{d.note}</span> : null}
                    </span>
                    <span><span className={cx("badge", DAY_TONE[d.status])}>{t(`payroll.day.${d.status}`)}</span></span>
                    <span className="num">{tashkentHM(d.checked_in_at)}</span>
                    <span className="num">{d.checked_out_at ? tashkentHM(d.checked_out_at) : ongoing ? t("v2.personal.payroll.ongoing") : "—"}</span>
                    <span className="num c2">{dur}</span>
                    <span className="r num c-bad">{ded > 0 ? `−${fmtNum(ded)}` : ""}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function GateCard({
  t, title, passed, rate, gate, line, earned, bonus, foot,
}: {
  t: T; title: string; passed: boolean; rate: number; gate: number; line: string;
  earned: string; bonus: string; foot?: React.ReactNode;
}) {
  const bar = Math.max(0, Math.min(100, rate));
  const tone = passed ? "ok" : rate >= gate * 0.7 ? "warn" : "bad";
  return (
    <section className="card col g16" style={{ padding: "20px 24px" }}>
      <div className="row between">
        <span className="h3">{title}</span>
        {passed ? (
          <span className="badge b-ok"><Check className="ic ic-s" />{t("v2.personal.payroll.done")}</span>
        ) : (
          <span className="badge b-warn"><i className="dot" />{t("v2.personal.payroll.notDone")}</span>
        )}
      </div>
      <div className="row between wrap" style={{ alignItems: "baseline" }}>
        <span className="kpi">{rate}%</span>
        <span className="s c3">{line}</span>
      </div>
      <div style={{ position: "relative", padding: "4px 0" }}>
        <div className="bar"><i className={tone} style={{ width: `${bar}%` }} /></div>
        {gate > 0 && gate < 100 ? (
          <i aria-hidden="true" style={{ position: "absolute", left: `${gate}%`, top: 0, width: 2, height: 16, background: "var(--ink)" }} />
        ) : null}
      </div>
      <div className="row between s c3 wrap">
        <span>{t("v2.personal.payroll.threshold", { pct: gate })}</span>
        <span><EarnedLine t={t} earned={earned} bonus={bonus} /></span>
      </div>
      {foot}
    </section>
  );
}

function EarnedLine({ t, earned, bonus }: { t: T; earned: string; bonus: string }) {
  // Render numbers in mono inside the translated sentence.
  const parts = t("v2.personal.payroll.earned", { earned: "\u0000", bonus: "\u0001" }).split(/(\u0000|\u0001)/);
  return (
    <>
      {parts.map((p, i) =>
        p === "\u0000" ? <span key={i} className="num w6" style={{ color: Number(earned) > 0 ? "var(--ink)" : undefined }}>{fmtNum(earned)}</span>
        : p === "\u0001" ? <span key={i} className="num">{fmtNum(bonus)}</span>
        : <span key={i}>{p}</span>,
      )}
    </>
  );
}
