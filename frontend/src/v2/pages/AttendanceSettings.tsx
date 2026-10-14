import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Save } from "lucide-react";
import { toast } from "../../components/ui";
import { apiErrorMessage } from "../../lib/api-types";
import { useT2 } from "../i18n";
import { ErrorState, LoadingBlock, PageHeader, cx } from "../ui";
import { useAttSettings, useAttSettingsSave, type AttSettings } from "../api/team/payroll";

type T = ReturnType<typeof useT2>;
type Key = keyof AttSettings;

/** Money fields are decimal strings from the API («1500000.00»); the form keeps digits only. */
const MONEY: Key[] = ["default_late_penalty_uzs", "default_attendance_bonus_uzs", "default_sales_bonus_uzs", "default_monthly_plan_uzs", "default_salary_uzs"];
const RANGES: Partial<Record<Key, [number, number]>> = {
  default_grace_period_min: [0, 240],
  default_weekly_free_absences: [0, 7],
  default_attendance_gate_pct: [0, 100],
  default_sales_gate_pct: [0, 100],
  nine_hour_reminder_hours: [0, 24],
};
const TIMES: Key[] = ["shift_start", "shift_end", "auto_close_at"];
const LABEL: Partial<Record<Key, string>> = {
  shift_start: "shiftStart",
  shift_end: "shiftEnd",
  auto_close_at: "autoClose",
  default_grace_period_min: "grace",
  default_late_penalty_uzs: "penalty",
  default_weekly_free_absences: "freeAbs",
  default_attendance_gate_pct: "attGate",
  default_attendance_bonus_uzs: "attBonus",
  default_sales_bonus_uzs: "salesBonus",
  default_sales_gate_pct: "salesGate",
  default_monthly_plan_uzs: "plan",
  nine_hour_reminder_hours: "nineHour",
};

function digits(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const s = String(v);
  // «1500000.00» → «1500000»
  const int = s.includes(".") ? s.slice(0, s.indexOf(".")) : s;
  return int.replace(/\D/g, "");
}

function spaced(d: string): string {
  return d.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** API → form: normalise money to digits, keep the legacy salary fallback for the bonus. */
function toForm(s: AttSettings): AttSettings {
  const f = { ...s };
  for (const k of MONEY) (f as Record<string, unknown>)[k] = digits(s[k] as string);
  if (!f.default_attendance_bonus_uzs) f.default_attendance_bonus_uzs = f.default_salary_uzs;
  if (f.nine_hour_reminder_hours === undefined || f.nine_hour_reminder_hours === null) f.nine_hour_reminder_hours = 9;
  return f;
}

function validate(f: AttSettings, t: T): Partial<Record<Key, string>> {
  const e: Partial<Record<Key, string>> = {};
  for (const k of TIMES) if (!/^\d{2}:\d{2}$/.test(String(f[k] ?? ""))) e[k] = t("v2.team.payroll.set.errTime");
  for (const k of MONEY) if (k !== "default_salary_uzs" && String(f[k] ?? "") === "") e[k] = t("v2.team.payroll.set.errRequired");
  for (const [k, [min, max]] of Object.entries(RANGES) as [Key, [number, number]][]) {
    const v = f[k] as unknown as number | "";
    if (v === "" || v === null || v === undefined || Number.isNaN(v)) e[k] = t("v2.team.payroll.set.errRequired");
    else if (v < min || v > max) e[k] = t("v2.team.payroll.set.errRange", { min, max });
  }
  return e;
}

export default function AttendanceSettings() {
  const t = useT2();
  const q = useAttSettings();
  const mut = useAttSettingsSave();
  const [base, setBase] = useState<AttSettings | null>(null);
  const [form, setForm] = useState<AttSettings | null>(null);

  useEffect(() => {
    if (q.data && !form) {
      const f = toForm(q.data);
      setBase(f);
      setForm(f);
    }
  }, [q.data, form]);

  const changed = useMemo(() => {
    if (!form || !base) return [] as Key[];
    return (Object.keys(form) as Key[]).filter((k) => form[k] !== base[k]);
  }, [form, base]);
  const dirty = changed.length > 0;
  const errors = useMemo(() => (form ? validate(form, t) : {}), [form, t]);
  const errKeys = Object.keys(errors) as Key[];

  // Warn before closing the tab with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  // Functional updates: several fields can change in one event without overwriting each other.
  const upd = <K extends Key>(k: K, v: AttSettings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const updMany = (patch: Partial<AttSettings>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const int = (s: string): number => (s === "" ? ("" as unknown as number) : parseInt(s.replace(/\D/g, ""), 10));

  const save = () => {
    if (!form || !dirty || errKeys.length) return;
    const payload: Partial<AttSettings> = {};
    for (const k of changed) (payload as Record<string, unknown>)[k] = form[k];
    mut.mutate(payload, {
      onSuccess: (d) => {
        const f = toForm(d);
        setBase(f);
        setForm(f);
        toast.success(t("v2.team.payroll.set.saved"));
      },
      onError: (e) => toast.error(apiErrorMessage(e)),
    });
  };

  const tabs = (
    <div className="seg" style={{ maxWidth: "100%", overflowX: "auto" }}>
      <Link to="/attendance/today">{t("v2.team.payroll.set.tabToday")}</Link>
      <Link to="/attendance/report">{t("v2.team.payroll.set.tabReport")}</Link>
      <Link to="/attendance/photos">{t("v2.team.payroll.set.tabPhotos")}</Link>
      <Link to="/attendance/kiosk">{t("v2.team.payroll.set.tabKiosk")}</Link>
      <Link className="is-on" to="/settings/attendance" aria-current="page">{t("v2.team.payroll.set.tabSettings")}</Link>
    </div>
  );

  if (q.isError && !form) {
    return (
      <>
        <PageHeader title={t("v2.team.payroll.set.title")}>{tabs}</PageHeader>
        <main className="page">
          <section className="card"><ErrorState error={q.error} onRetry={() => q.refetch()} /></section>
        </main>
      </>
    );
  }
  if (!form) {
    return (
      <>
        <PageHeader title={t("v2.team.payroll.set.title")}>{tabs}</PageHeader>
        <main className="page">
          <section className="card"><LoadingBlock rows={6} onRetry={() => q.refetch()} /></section>
        </main>
      </>
    );
  }

  const weekdays = t("v2.team.payroll.set.weekdays").split(",");
  const L = (k: Key) => t(`v2.team.payroll.set.${LABEL[k]}`);

  const numField = (k: Key, opts?: { full?: boolean }) => {
    const [min, max] = RANGES[k] ?? [0, undefined];
    const v = form[k] as unknown as number | "";
    return (
      <Field id={`as-${k}`} label={L(k)} hint={t(`v2.team.payroll.set.${LABEL[k]}Hint`)} err={errors[k]} full={opts?.full}>
        <input
          id={`as-${k}`}
          className={cx("input num", errors[k] && "is-bad")}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={v === undefined || v === null || Number.isNaN(v) ? "" : v}
          onChange={(e) => upd(k, int(e.target.value) as never)}
        />
      </Field>
    );
  };

  const moneyField = (k: Key, opts?: { full?: boolean; onChange?: (d: string) => void }) => (
    <Field id={`as-${k}`} label={L(k)} hint={t(`v2.team.payroll.set.${LABEL[k]}Hint`)} err={errors[k]} full={opts?.full}>
      <input
        id={`as-${k}`}
        className={cx("input num", errors[k] && "is-bad")}
        type="text"
        inputMode="numeric"
        value={spaced(String(form[k] ?? ""))}
        onChange={(e) => {
          const d = e.target.value.replace(/\D/g, "");
          if (opts?.onChange) opts.onChange(d);
          else upd(k, d as never);
        }}
      />
    </Field>
  );

  const timeField = (k: Key, hint?: string) => (
    <Field id={`as-${k}`} label={L(k)} hint={hint} err={errors[k]}>
      <input id={`as-${k}`} className={cx("input num", errors[k] && "is-bad")} type="time" value={String(form[k] ?? "")} onChange={(e) => upd(k, e.target.value as never)} />
    </Field>
  );

  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, padding: "16px 20px 20px" } as const;

  return (
    <>
      <PageHeader title={t("v2.team.payroll.set.title")}>
        {tabs}
        <span className="grow" />
        {dirty ? <span className="s c3">{t("v2.team.payroll.set.dirty")}</span> : null}
        {dirty ? (
          <button className="btn btn-ghost" type="button" disabled={mut.isPending} onClick={() => setForm(base)}>
            {t("v2.team.payroll.set.discard")}
          </button>
        ) : null}
        <button className="btn btn-pri" type="button" disabled={!dirty || errKeys.length > 0 || mut.isPending} onClick={save}>
          <Save className="ic" />
          {mut.isPending ? t("v2.team.payroll.set.saving") : t("v2.team.payroll.set.save")}
        </button>
      </PageHeader>
      <main className="page">
        <p className="s c3" style={{ marginTop: -6 }}>{t("v2.team.payroll.set.subtitle")}</p>
        <div className="row g16 wrap" style={{ alignItems: "flex-start" }}>
          <div className="col g16" style={{ flex: "1 1 380px", minWidth: 0 }}>
            <Card title={t("v2.team.payroll.set.secShift")}>
              <div style={grid}>
                {timeField("shift_start")}
                {timeField("shift_end")}
                <Field id="as-dayoff" label={t("v2.team.payroll.set.dayOff")} hint={t("v2.team.payroll.set.dayOffHint")}>
                  <select id="as-dayoff" className="input" value={form.default_weekly_day_off} onChange={(e) => upd("default_weekly_day_off", parseInt(e.target.value, 10))}>
                    {weekdays.map((w, i) => (
                      <option key={i} value={i}>{w}</option>
                    ))}
                  </select>
                </Field>
                {timeField("auto_close_at", t("v2.team.payroll.set.autoCloseHint"))}
              </div>
            </Card>
            <Card title={t("v2.team.payroll.set.secBonus")}>
              <div className="col g14" style={{ padding: "16px 20px 20px" }}>
                {moneyField("default_attendance_bonus_uzs", {
                  // One update for both keys: legacy default_salary_uzs is the
                  // backend fallback and must stay in sync (old page lost the bonus here).
                  onChange: (d) => updMany({ default_attendance_bonus_uzs: d, default_salary_uzs: d }),
                })}
              </div>
            </Card>
            <Card title={t("v2.team.payroll.set.secEnforce")}>
              <div className="col g16" style={{ padding: "16px 20px 20px" }}>
                <div className="row g16" style={{ alignItems: "flex-start" }}>
                  <span className="col g4 grow">
                    <span className="s w6" id="as-enforce-l">{t("v2.team.payroll.set.enforce")}</span>
                    <span className="xs c3">{t("v2.team.payroll.set.enforceHint")}</span>
                  </span>
                  <button
                    className={cx("switch", form.enforce_daily_checkin && "is-on")}
                    type="button"
                    role="switch"
                    aria-checked={!!form.enforce_daily_checkin}
                    aria-labelledby="as-enforce-l"
                    title={form.enforce_daily_checkin ? t("v2.team.payroll.set.on") : t("v2.team.payroll.set.off")}
                    onClick={() => upd("enforce_daily_checkin", !form.enforce_daily_checkin)}
                  >
                    <i />
                  </button>
                </div>
                {numField("nine_hour_reminder_hours")}
              </div>
            </Card>
          </div>
          <div className="col g16" style={{ flex: "1 1 380px", minWidth: 0 }}>
            <Card title={t("v2.team.payroll.set.secPenalties")}>
              <div style={grid}>
                {numField("default_grace_period_min")}
                {moneyField("default_late_penalty_uzs")}
                {numField("default_weekly_free_absences")}
                {numField("default_attendance_gate_pct")}
              </div>
            </Card>
            <Card title={t("v2.team.payroll.set.secSales")}>
              <div style={grid}>
                {moneyField("default_sales_bonus_uzs")}
                {numField("default_sales_gate_pct")}
                {moneyField("default_monthly_plan_uzs", { full: true })}
              </div>
            </Card>
          </div>
        </div>
        {errKeys.length > 0 ? (
          <div className="banner b-bad" role="alert">
            <AlertTriangle className="ic" />
            <span>{t("v2.team.payroll.set.errBanner", { list: errKeys.map((k) => `«${L(k)}» — ${errors[k]}`).join("; ") })}</span>
          </div>
        ) : null}
      </main>
    </>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card col">
      <div className="card-h"><span className="h3">{title}</span></div>
      {children}
    </section>
  );
}

function Field({ id, label, hint, err, full, children }: { id: string; label: string; hint?: string; err?: string; full?: boolean; children: ReactNode }) {
  return (
    <div className="field" style={full ? { gridColumn: "1 / -1" } : undefined}>
      <label htmlFor={id}>{label}</label>
      {children}
      {err ? <span className="err">{err}</span> : null}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}
