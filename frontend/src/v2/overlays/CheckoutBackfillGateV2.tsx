import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { api } from "../../lib/api";
import { apiErrorMessage } from "../../lib/api-types";
import { useLang } from "../../store/lang";
import { useMe } from "../../hooks/useMe";
import { useT2 } from "../i18n";
import { Layer, hm, useFmtDur, useMeCurrent } from "./shift";

/**
 * v2 «Во сколько вы вчера ушли?» (artboard OpBackfill). Logic of the old
 * components/CheckoutBackfillGate.tsx:
 *   - shown while /attendance/me/current/.pending_backfill_log is set (poll 30 s);
 *   - z 310 — above the check-in gate (300);
 *   - default = check-in + 8 h; client checks ≥ 30 min and ≤ 14 h;
 *   - POST /attendance/me/backfill-checkout/ {log_id, checked_out_at: local naive ISO};
 *   - no skip, closes only on success.
 * v2 additions: the leave date can be the next day (after midnight) when the
 * API would accept it — i.e. the auto-close moment is on a later date — and
 * the «≤ auto-close» rule of the backend is checked up front. The title says
 * «вчера» only when the shift really was yesterday.
 */

const MAX_BACKFILL_HOURS = 14;

function isoDateLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(dateIso: string, n: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  return isoDateLocal(new Date(y, m - 1, d + n));
}

function hhmmOf(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" + "HH:MM" → local naive ISO, parsed by the backend as Tashkent time. */
function combineDateTime(dateIsoLocal: string, hhmm: string): string {
  return `${dateIsoLocal}T${hhmm}:00`;
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase() || "?";
}

export default function CheckoutBackfillGateV2() {
  const t = useT2();
  const qc = useQueryClient();
  const lang = useLang((s) => s.lang);
  const locale = lang === "uz" ? "uz-UZ" : "ru-RU";
  const fmtDur = useFmtDur();
  const me = useMe();

  const { data: current } = useMeCurrent(30_000);
  const pending = current?.pending_backfill_log ?? null;

  const inDate = pending ? isoDateLocal(new Date(pending.checked_in_at)) : "";
  const autoClosed = pending?.auto_closed_at ? new Date(pending.auto_closed_at) : null;
  // After-midnight leave is only valid when the backend's upper bound
  // (the auto-close moment) itself is on a later calendar day.
  const nextDayAllowed = !!pending && (!autoClosed || isoDateLocal(autoClosed) > inDate);

  // Default = check-in + 8 h, but not later than the auto-close moment.
  const defaults = useMemo(() => {
    if (!pending) return { date: "", hhmm: "18:00" };
    const d = new Date(pending.checked_in_at);
    d.setHours(d.getHours() + 8);
    const ac = pending.auto_closed_at ? new Date(pending.auto_closed_at) : null;
    const pick = ac && ac.getTime() < d.getTime() ? ac : d;
    const ci = isoDateLocal(new Date(pending.checked_in_at));
    const pickDate = isoDateLocal(pick);
    const allowNext = !ac || isoDateLocal(ac) > ci;
    if (pickDate !== ci && !(allowNext && pickDate === addDays(ci, 1))) return { date: ci, hhmm: "18:00" };
    return { date: pickDate, hhmm: hhmmOf(pick) };
  }, [pending]);

  // Reset when the pending log changes (two forgotten days in a row).
  const [edit, setEdit] = useState<{ logId: number; date?: string; hhmm?: string } | null>(null);
  const own = edit && pending && edit.logId === pending.id ? edit : null;
  const activeDate = own?.date ?? defaults.date;
  const activeHhmm = own?.hhmm ?? defaults.hhmm;

  const submit = useMutation({
    mutationFn: async () => {
      if (!pending) throw new Error("no_pending");
      return api
        .post("/attendance/me/backfill-checkout/", { log_id: pending.id, checked_out_at: combineDateTime(activeDate, activeHhmm) })
        .then((r) => r.data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me-attendance-current"] });
      setEdit(null);
    },
  });

  if (!pending) return null;

  const ci = new Date(pending.checked_in_at);
  const co = activeHhmm ? new Date(combineDateTime(activeDate, activeHhmm)) : new Date(NaN);
  const minutes = Math.round((co.getTime() - ci.getTime()) / 60_000);
  const timeOk = Number.isFinite(minutes);
  const okMin = timeOk && minutes >= 30;
  const okMax = timeOk && minutes <= MAX_BACKFILL_HOURS * 60;
  const okAuto = timeOk && (!autoClosed || co.getTime() <= autoClosed.getTime());
  const valid = okMin && okMax && okAuto;

  const yesterday = isoDateLocal(new Date(Date.now() - 86_400_000));
  const isYesterday = inDate === yesterday;
  const dayMonth = ci.toLocaleDateString(locale, { day: "numeric", month: "long" });
  const weekdayDate = ci.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
  const fmtOpt = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y} · ${dt.toLocaleDateString(locale, { weekday: "short" })}`;
  };
  const nextDate = addDays(inDate, 1);
  const name = me.data?.operator_name || me.data?.display_name || me.data?.username || "";

  const Rule = ({ ok, text }: { ok: boolean; text: string }) => (
    <span className="err" style={{ color: ok ? "var(--ink-3)" : "var(--bad)" }}>
      {ok ? <Check className="ic ic-s c-ok" /> : <X className="ic ic-s" />}
      {text}
    </span>
  );

  return (
    <Layer z={310} style={{ background: "var(--bg)", overflowY: "auto" }}>
      <div role="dialog" aria-modal="true" aria-labelledby="v2-bf-title" style={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
        <i className="ikat" style={{ height: 10, flex: "none" }} aria-hidden />
        <div className="row between g12" style={{ padding: "16px clamp(16px, 3vw, 32px)" }}>
          <div className="wordmark" style={{ padding: 0 }}><i className="ikat ikat-mark" aria-hidden />naff<b>AI</b></div>
          {name ? (
            <div className="row g8" style={{ minWidth: 0 }}>
              <span className="ava">{initials(name)}</span>
              <span className="s w6 trunc">{name}</span>
            </div>
          ) : null}
        </div>

        <div style={{ flex: "1 1 auto", display: "flex", alignItems: "center", justifyContent: "center", padding: "16px 16px 64px" }}>
          <section className="card col g20" style={{ width: 620, maxWidth: "100%", padding: "clamp(20px, 3vw, 32px)" }}>
            <div className="col g8">
              <span className="badge b-warn" style={{ alignSelf: "flex-start" }}>
                <i className="dot" />
                {isYesterday ? t("v2.ov.bf.badgeYesterday") : t("v2.ov.bf.badgeDate", { date: dayMonth })}
              </span>
              <h1 className="h1" id="v2-bf-title" style={{ fontSize: 26, lineHeight: "34px" }}>
                {isYesterday ? t("v2.ov.bf.titleYesterday") : t("v2.ov.bf.titleDate", { date: dayMonth })}
              </h1>
              <p className="c2" style={{ margin: 0 }}>
                {autoClosed ? t("v2.ov.bf.autoClosed", { time: hm(autoClosed.toISOString()) }) : t("v2.ov.bf.forgot")}{" "}
                {t("v2.ov.bf.came", { date: weekdayDate, time: hm(pending.checked_in_at) })}
              </p>
            </div>

            <div className="row g12" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
              <div className="field grow" style={{ minWidth: 200 }}>
                <label htmlFor="v2-bf-date">{t("v2.ov.bf.date")}</label>
                <select
                  id="v2-bf-date"
                  className="input input-lg num"
                  value={activeDate}
                  disabled={!nextDayAllowed}
                  onChange={(e) => setEdit({ logId: pending.id, date: e.target.value, hhmm: activeHhmm })}
                >
                  <option value={inDate}>{fmtOpt(inDate)}</option>
                  {nextDayAllowed ? <option value={nextDate}>{fmtOpt(nextDate)}</option> : null}
                </select>
                {nextDayAllowed ? <span className="hint">{t("v2.ov.bf.afterMidnight", { date: fmtOpt(nextDate).slice(0, 5) })}</span> : null}
              </div>
              <div className="field" style={{ width: 180, maxWidth: "100%" }}>
                <label htmlFor="v2-bf-time">{t("v2.ov.bf.time")}</label>
                <input
                  id="v2-bf-time"
                  className="input input-lg num"
                  type="time"
                  value={activeHhmm}
                  onChange={(e) => setEdit({ logId: pending.id, date: activeDate, hhmm: e.target.value })}
                />
              </div>
            </div>

            <div className="well row between g12">
              <span className="s c2">{t("v2.ov.bf.result")}</span>
              <span className="num w6" style={{ fontSize: 18, color: valid ? undefined : "var(--bad)" }}>
                {timeOk ? (minutes < 0 ? "—" : fmtDur(minutes)) : "—"}
              </span>
            </div>

            <div className="col g6">
              <span className="lbl">{t("v2.ov.bf.checks")}</span>
              <Rule ok={okMin} text={t("v2.ov.bf.chkMin")} />
              <Rule ok={okMax} text={t("v2.ov.bf.chkMax", { h: MAX_BACKFILL_HOURS })} />
              {autoClosed ? <Rule ok={okAuto} text={t("v2.ov.bf.chkAuto", { time: hm(autoClosed.toISOString()) })} /> : null}
            </div>

            {submit.isError ? (
              <div className="banner b-bad" role="alert">{apiErrorMessage(submit.error)}</div>
            ) : null}

            <button className="btn btn-pri btn-lg btn-block" type="button" onClick={() => submit.mutate()} disabled={!valid || submit.isPending}>
              {submit.isPending ? t("v2.ov.bf.saving") : t("v2.ov.bf.confirm")}
            </button>
            <p className="xs c3" style={{ margin: 0 }}>{t("v2.ov.bf.noSkip")}</p>
          </section>
        </div>
      </div>
    </Layer>
  );
}
