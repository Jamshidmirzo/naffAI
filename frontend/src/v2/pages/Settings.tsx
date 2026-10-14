import { useState, type FormEvent, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { AlertTriangle, KeyRound, Lock, LockKeyholeOpen } from "lucide-react";
import { toast } from "../../components/ui";
import { apiErrorMessage } from "../../lib/api-types";
import { useAuth } from "../../store/auth";
import { isSuperadmin } from "../../components/RoleGate";
import { useT2 } from "../i18n";
import { Dialog, ErrorState, LoadingBlock, PageHeader, cx } from "../ui";
import {
  useSetDistribution,
  useSetDistributionPatch,
  useSetPinReset,
  useSetPinSave,
  useSetPinStatus,
  type SetDistributionPatch,
} from "../api/admin";

/* ------------------------------------------------------------------ */
/* Settings sub-navigation (artboards MgSettingsGeneral/MgSettings/MgPartners).
   Exported so /statuses and /partners render the same column. */

const SUBNAV: Array<{ to: string; key: string; end?: boolean }> = [
  { to: "/settings", key: "general", end: true },
  { to: "/settings/attendance", key: "attendance" },
  { to: "/statuses", key: "statuses" },
  { to: "/sheet-sources", key: "sheets" },
  { to: "/catalog", key: "catalog" },
  { to: "/partners", key: "partners" },
  { to: "/bot", key: "bot" },
  { to: "/users", key: "users" },
  { to: "/training/manage", key: "training" },
];

export function SettingsSubNav() {
  const t = useT2();
  return (
    <nav className="sub-nav" aria-label={t("v2.admin.subnav.aria")}>
      {SUBNAV.map((s) => (
        <NavLink key={s.to} to={s.to} end={s.end} className={({ isActive }) => cx(isActive && "is-on")}>
          {t(`v2.admin.subnav.${s.key}`)}
        </NavLink>
      ))}
    </nav>
  );
}

/** Two-column settings layout: sub-nav + content column. */
export function SettingsLayout({ children, maxWidth = 860 }: { children: ReactNode; maxWidth?: number }) {
  return (
    <div className="row g24" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
      <SettingsSubNav />
      <div className="col g16 grow" style={{ minWidth: 0, maxWidth, flexBasis: 320 }}>
        {children}
      </div>
    </div>
  );
}

function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      className={cx("switch", on && "is-on")}
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      style={disabled ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  );
}

/* ------------------------------------------------------------------ */

export default function Settings() {
  const t = useT2();
  const rawRole = useAuth((s) => s.role);
  const q = useSetDistribution();
  const patch = useSetDistributionPatch();
  const d = q.data;

  const change = (p: SetDistributionPatch) =>
    patch.mutate(p, {
      onSuccess: (data) => {
        if (p.auto_distribution_enabled !== undefined)
          toast.success(t(data.auto_distribution_enabled ? "settings.auto_distribution.enabled_toast" : "settings.auto_distribution.disabled_toast"));
        if (p.morning_gate_enabled !== undefined)
          toast.success(t(data.morning_gate_enabled ? "settings.morning_gate.enabled_toast" : "settings.morning_gate.disabled_toast"));
      },
      onError: (e) => toast.error(apiErrorMessage(e)),
    });

  const updated = d
    ? d.updated_by
      ? t("settings.updated_with_user", { date: fmtDateTime(d.updated_at), name: d.updated_by.full_name })
      : t("settings.updated_no_user", { date: fmtDateTime(d.updated_at) })
    : null;
  const busy = q.isLoading || patch.isPending;

  return (
    <>
      <PageHeader title={t("settings.title")}>
        <span className="s c3">{t("v2.admin.settings.journal")}</span>
      </PageHeader>
      <main className="page">
        <SettingsLayout>
          <p className="s c3">{t("settings.subtitle")}</p>

          {q.isLoading ? (
            <section className="card"><LoadingBlock rows={3} onRetry={() => q.refetch()} /></section>
          ) : q.isError ? (
            <section className="card"><ErrorState error={q.error} onRetry={() => q.refetch()} /></section>
          ) : d ? (
            <>
              <section className="card col">
                <div className="card-h">
                  <div className="col">
                    <span className="h3">{t("settings.auto_distribution.title")}</span>
                    {updated ? <span className="xs c3">{updated}</span> : null}
                  </div>
                  <Switch
                    on={d.auto_distribution_enabled}
                    disabled={busy}
                    label={t("settings.auto_distribution.aria")}
                    onChange={(v) => change({ auto_distribution_enabled: v })}
                  />
                </div>
                <div className="col g12" style={{ padding: "14px 20px 16px" }}>
                  <p className="s c2">{t("settings.auto_distribution.hint")}</p>
                  {!d.auto_distribution_enabled ? (
                    <div className="banner b-bad">
                      <AlertTriangle className="ic" />
                      <span>{t("settings.disabled_warning")}</span>
                    </div>
                  ) : null}
                </div>
              </section>

              <section className="card col">
                <div className="card-h">
                  <div className="row g8">
                    <Lock className="ic ic-s c3" />
                    <span className="h3">{t("settings.morning_gate.title")}</span>
                  </div>
                  <Switch
                    on={d.morning_gate_enabled}
                    disabled={busy}
                    label={t("settings.morning_gate.aria")}
                    onChange={(v) => change({ morning_gate_enabled: v })}
                  />
                </div>
                <div className="col g12" style={{ padding: "14px 20px 16px" }}>
                  <p className="s c2">
                    {t("v2.admin.settings.morningHint")}{" "}
                    <Link className="w6 c-brand" to="/statuses">{t("v2.admin.settings.statusesLink")}</Link>{" "}
                    {t("v2.admin.settings.morningHintTail")}
                  </p>
                  {!d.morning_gate_enabled ? (
                    <div className="banner b-bad">
                      <AlertTriangle className="ic" />
                      <span>{t("settings.morning_gate.disabled_warning")}</span>
                    </div>
                  ) : null}
                </div>
              </section>
            </>
          ) : null}

          {isSuperadmin(rawRole) ? <PinCard /> : null}
        </SettingsLayout>
      </main>
    </>
  );
}

/* ------------------------- attendance PIN (superadmin) ------------------------- */

function PinCard() {
  const t = useT2();
  const q = useSetPinStatus();
  const reset = useSetPinReset();
  const [setOpen, setSetOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const s = q.data;
  const hasPin = !!s?.has_pin;
  const updatedLine = s?.updated_at
    ? s.updated_by
      ? t("settings.pin.updated_by", { date: fmtDateTime(s.updated_at), name: s.updated_by })
      : t("settings.pin.updated_at", { date: fmtDateTime(s.updated_at) })
    : null;

  return (
    <section className="card col">
      <div className="card-h">
        <div className="col">
          <span className="row g8"><KeyRound className="ic ic-s c3" /><span className="h3">{t("settings.pin.title")}</span></span>
          {updatedLine ? <span className="xs c3">{updatedLine}</span> : null}
        </div>
        {s ? (
          <span className={cx("badge", hasPin ? "b-ok" : "b-bad")}>
            <i className="dot" />
            {hasPin ? t("settings.pin.status_set") : t("v2.admin.settings.pinNotSetBadge")}
          </span>
        ) : null}
      </div>
      {q.isLoading ? (
        <LoadingBlock rows={1} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="col g12" style={{ padding: "14px 20px 16px" }}>
          <p className="s c2">{t("settings.pin.hint")}</p>
          {!hasPin ? (
            <div className="banner b-bad">
              <Lock className="ic" />
              <span>{t("settings.pin.status_not_set")}</span>
            </div>
          ) : null}
          <div className="row g8 wrap">
            <button className={cx("btn btn-sm", !hasPin && "btn-pri")} type="button" onClick={() => setSetOpen(true)}>
              <KeyRound className="ic ic-s" />
              {hasPin ? t("settings.pin.change_btn") : t("settings.pin.set_btn")}
            </button>
            {hasPin ? (
              <button className="btn btn-sm btn-bad" type="button" onClick={() => setResetOpen(true)}>
                <LockKeyholeOpen className="ic ic-s" />
                {t("settings.pin.reset_btn")}
              </button>
            ) : null}
          </div>
        </div>
      )}

      {setOpen ? <PinSetDialog isChange={hasPin} onClose={() => setSetOpen(false)} /> : null}

      <Dialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title={t("pin.reset_all_confirm_title")}
        danger
        width={460}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setResetOpen(false)}>{t("common.cancel")}</button>
            <button
              className="btn btn-danger"
              type="button"
              disabled={reset.isPending}
              onClick={() =>
                reset.mutate(undefined, {
                  onSuccess: () => {
                    setResetOpen(false);
                    toast.success(t("pin.reset_ok"));
                  },
                  onError: (e) => toast.error(apiErrorMessage(e)),
                })
              }
            >
              {reset.isPending ? "…" : t("settings.pin.reset_btn")}
            </button>
          </>
        }
      >
        <p className="s c2">{t("pin.reset_all_confirm_body")}</p>
      </Dialog>
    </section>
  );
}

function PinSetDialog({ isChange, onClose }: { isChange: boolean; onClose: () => void }) {
  const t = useT2();
  const save = useSetPinSave();
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [mismatch, setMismatch] = useState(false);

  const digits = (v: string) => v.replace(/\D/g, "").slice(0, 4);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setErr("");
    setMismatch(false);
    if (!/^\d{4}$/.test(pin)) {
      setErr(t("pin.only_digits"));
      return;
    }
    if (pin !== confirm) {
      setMismatch(true);
      return;
    }
    save.mutate(pin, {
      onSuccess: () => {
        toast.success(t("pin.set_ok"));
        onClose();
      },
      onError: (e2) => setErr(apiErrorMessage(e2)),
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={460}
      title={isChange ? t("pin.change_title") : t("pin.set_global_title")}
      sub={isChange ? t("pin.change_subtitle") : t("pin.set_global_subtitle")}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-pri" type="submit" form="v2-pin-set" disabled={save.isPending || pin.length !== 4 || confirm.length !== 4}>
            {save.isPending ? "…" : t("pin.save")}
          </button>
        </>
      }
    >
      <form id="v2-pin-set" className="col g12" onSubmit={submit}>
        <div className="field">
          <label htmlFor="v2-pin-new">{t("pin.new_ph")}</label>
          <input
            id="v2-pin-new"
            className="input num"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            autoFocus
            value={pin}
            maxLength={4}
            style={{ letterSpacing: ".4em" }}
            onChange={(e) => setPin(digits(e.target.value))}
          />
          {pin.length > 0 && pin.length < 4 ? <span className="hint">{t("v2.admin.settings.pinDigitsLeft", { n: 4 - pin.length })}</span> : null}
        </div>
        <div className="field">
          <label htmlFor="v2-pin-confirm">{t("pin.confirm_ph")}</label>
          <input
            id="v2-pin-confirm"
            className={cx("input num", mismatch && "is-bad")}
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={confirm}
            maxLength={4}
            style={{ letterSpacing: ".4em" }}
            onChange={(e) => {
              setConfirm(digits(e.target.value));
              setMismatch(false);
            }}
          />
          {mismatch ? <span className="err">{t("pin.mismatch")}</span> : null}
        </div>
        {err ? (
          <div className="banner b-bad">
            <AlertTriangle className="ic" />
            <span>{err}</span>
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
