import { useState, type FormEvent } from "react";
import { CalendarPlus } from "lucide-react";
import { toast } from "../../components/ui";
import { useLang } from "../../store/lang";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx } from "../ui";
import { fmtCalendarDate, tashkentDateOf, tashkentISO, useCreateDayOff, useMyDayOffs, type DayOffRow } from "../api/personal";

const TONE: Record<DayOffRow["status"], string> = { pending: "b-warn", approved: "b-ok", rejected: "b-bad" };

export default function MyDayOff() {
  const t = useT2();
  const lang = useLang((s) => s.lang);
  // All bounds are in Tashkent calendar days, not UTC.
  const min = tashkentISO();
  const max = tashkentISO(60);
  const [date, setDate] = useState(tashkentISO(1));
  const [reason, setReason] = useState("");
  const q = useMyDayOffs();
  const create = useCreateDayOff();

  const dateBad = !!date && (date < min || date > max);
  const rows = q.data?.results ?? [];
  const today = tashkentISO();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!date || dateBad || create.isPending) return;
    create.mutate(
      { date, reason },
      {
        onSuccess: () => {
          toast.success(t("my_day_off.submitted"));
          setReason("");
        },
        onError: (err: unknown) => {
          const e2 = err as { response?: { data?: { detail?: string } } };
          toast.error(e2.response?.data?.detail || t("my_day_off.submit_failed"));
        },
      },
    );
  };

  const dayLabel = (ymd: string) =>
    `${fmtCalendarDate(ymd, lang, { day: "2-digit", month: "2-digit" })}, ${fmtCalendarDate(ymd, lang, { weekday: "long" })}`;
  const sentLabel = (iso: string) => {
    const d = tashkentDateOf(iso);
    if (d === today) return t("v2.personal.dayoff.sentToday");
    return t("v2.personal.dayoff.sentOn", { date: fmtCalendarDate(d, lang, { day: "2-digit", month: "2-digit" }) });
  };

  return (
    <>
      <PageHeader title={t("v2.personal.dayoff.title")} meta={t("v2.personal.dayoff.sub")} />
      <main className="page">
        <div className="split">
          <form className="panel card col" style={{ flex: "1 1 360px", maxWidth: 520 }} onSubmit={submit}>
            <div className="card-h"><span className="h3">{t("my_day_off.form_title")}</span></div>
            <div className="col g16" style={{ padding: 20 }}>
              <div className="field">
                <label htmlFor="do-date">{t("my_day_off.date_label")}</label>
                <input
                  className={cx("input num", dateBad && "is-bad")}
                  id="do-date"
                  type="date"
                  value={date}
                  min={min}
                  max={max}
                  onChange={(e) => setDate(e.target.value)}
                  aria-invalid={dateBad || undefined}
                />
                {date && !dateBad ? <span className="hint">{dayLabel(date)}</span> : null}
                {dateBad ? <span className="err">{t("v2.personal.dayoff.dateErr")}</span> : null}
              </div>
              <div className="field">
                <label htmlFor="do-reason">{t("my_day_off.reason_label")}</label>
                <textarea
                  className="input"
                  id="do-reason"
                  rows={3}
                  style={{ height: "auto", padding: "10px 12px", resize: "vertical" }}
                  value={reason}
                  maxLength={2000}
                  placeholder={t("my_day_off.reason_ph")}
                  onChange={(e) => setReason(e.target.value)}
                />
                <span className="hint">{t("v2.personal.dayoff.hint")}</span>
              </div>
              <button className="btn btn-pri btn-lg" type="submit" disabled={!date || dateBad || create.isPending}>
                {create.isPending ? t("common.loading") : t("my_day_off.submit_btn")}
              </button>
            </div>
          </form>

          <section className="list card col">
            <div className="card-h">
              <span className="h3">{t("v2.personal.dayoff.mine")}</span>
              {rows.length ? <span className="xs c3">{t("v2.personal.dayoff.count", { n: rows.length })}</span> : null}
            </div>
            {q.isLoading ? (
              <LoadingBlock rows={3} onRetry={() => q.refetch()} />
            ) : q.isError ? (
              <ErrorState error={q.error} onRetry={() => q.refetch()} />
            ) : rows.length === 0 ? (
              <EmptyState icon={<CalendarPlus className="ic ic-l" />} title={t("my_day_off.empty")} body={t("v2.personal.dayoff.emptyBody")} />
            ) : (
              rows.map((r) => (
                <div key={r.id} className="row-item" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
                  <div className="col" style={{ width: 170, flex: "none", gap: 2 }}>
                    <span className="w6">{dayLabel(r.date)}</span>
                    <span className="xs c3">{sentLabel(r.created_at)}</span>
                  </div>
                  <div className="col grow" style={{ gap: 2, minWidth: 180 }}>
                    <span className={cx("s", !r.reason && "c3")} style={{ wordBreak: "break-word" }}>{r.reason || t("v2.personal.dayoff.noReason")}</span>
                    {r.status !== "pending" && r.decision_note ? (
                      <span className="xs c3">
                        {r.decided_by_name ? `${r.decided_by_name}: ` : `${t("my_day_off.decision_prefix")}: `}
                        {r.decision_note}
                      </span>
                    ) : null}
                  </div>
                  <span className={cx("badge", TONE[r.status])}><i className="dot" />{t(`my_day_off.status_${r.status}`)}</span>
                </div>
              ))
            )}
          </section>
        </div>
      </main>
    </>
  );
}
