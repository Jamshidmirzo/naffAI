import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Eye, EyeOff } from "lucide-react";
import { useAuth } from "../../store/auth";
import { useLang } from "../../store/lang";
import { useTheme } from "../../store/theme";
import { apiErrorMessage } from "../../lib/api-types";
import { useT2 } from "../i18n";
import { cx } from "../ui";
import { postLogin } from "../api/personal";

type Mode = "phone" | "text";

/** 9 local digits. A pasted full number (+998 …, 12 digits) loses its country code. */
function toLocal9(raw: string): string {
  const d = raw.replace(/\D+/g, "");
  return (d.length > 9 && d.startsWith("998") ? d.slice(3) : d).slice(0, 9);
}

/** «90 777 11 00» */
function fmtLocal(d: string): string {
  return [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)].filter(Boolean).join(" ");
}

/**
 * /login — outside the shell. Same request and side effects as the old page:
 * POST /auth/login/ → setAuth(token, username, role) → navigate("/").
 * Operator mode sends the canonical +998XXXXXXXXX, manager mode the raw login.
 */
export default function Login() {
  const t = useT2();
  const nav = useNavigate();
  const setAuth = useAuth((s) => s.setAuth);
  const lang = useLang();
  const theme = useTheme((s) => s.theme);

  const [mode, setMode] = useState<Mode>("phone");
  const [digits, setDigits] = useState("");
  const [textLogin, setTextLogin] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const phoneValid = digits.length === 9;
  const canSubmit = useMemo(() => {
    if (!password) return false;
    if (mode === "phone") return phoneValid;
    return textLogin.trim().length > 0;
  }, [mode, phoneValid, textLogin, password]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    const username = mode === "phone" ? `+998${digits}` : textLogin.trim();
    setBusy(true);
    setError("");
    try {
      const data = await postLogin(username, password);
      setAuth(data.token, data.username, data.role);
      nav("/");
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const showPhoneErr = mode === "phone" && phoneTouched && digits.length > 0 && !phoneValid;

  return (
    <div className="nf" data-theme={theme} style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)", position: "relative", isolation: "isolate" }}>
      <div className="aurora" aria-hidden>
        <i />
        <i />
        <i />
      </div>

      <div className="row between" style={{ padding: "20px clamp(16px, 4vw, 32px)", gap: 12, position: "relative", zIndex: 1 }}>
        <div className="wordmark" style={{ padding: 0 }}>
          <i className="logo-mark" aria-hidden />naff<b>AI</b>
        </div>
        <div className="seg" role="group" aria-label={t("v2.personal.login.lang")}>
          <button className={cx(lang.lang === "ru" && "is-on")} type="button" aria-pressed={lang.lang === "ru"} onClick={() => lang.set("ru")}>
            Русский
          </button>
          <button className={cx(lang.lang === "uz" && "is-on")} type="button" aria-pressed={lang.lang === "uz"} onClick={() => lang.set("uz")}>
            O‘zbekcha
          </button>
        </div>
      </div>

      <div style={{ flex: "1 1 auto", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px 16px 64px", position: "relative", zIndex: 1 }}>
        <form className="card glass col g20" style={{ width: 440, maxWidth: "100%", padding: "clamp(20px, 5vw, 32px)" }} onSubmit={onSubmit} noValidate>
          <div className="col g6">
            <h1 className="h1">{t("login.title")}</h1>
            <p className="c3">{t("v2.personal.login.subtitle")}</p>
          </div>

          <div className="seg seg-lg" role="tablist" aria-label={t("v2.personal.login.who")}>
            <button
              className={cx(mode === "phone" && "is-on")}
              type="button"
              role="tab"
              aria-selected={mode === "phone"}
              onClick={() => {
                setMode("phone");
                setError("");
              }}
            >
              {t("v2.personal.login.operator")}
            </button>
            <button
              className={cx(mode === "text" && "is-on")}
              type="button"
              role="tab"
              aria-selected={mode === "text"}
              onClick={() => {
                setMode("text");
                setError("");
              }}
            >
              {t("v2.personal.login.manager")}
            </button>
          </div>

          {mode === "phone" ? (
            <div className="field">
              <label htmlFor="lg-phone">{t("v2.personal.login.phone")}</label>
              <div className="row g8">
                <span className="pfx" style={{ height: 40, fontSize: 14, borderRadius: 8 }} aria-hidden>
                  +998
                </span>
                <input
                  className={cx("input num grow", showPhoneErr && "is-bad")}
                  id="lg-phone"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  autoFocus
                  placeholder="90 000 00 00"
                  value={fmtLocal(digits)}
                  onChange={(e) => setDigits(toLocal9(e.target.value))}
                  onBlur={() => setPhoneTouched(true)}
                  aria-invalid={showPhoneErr}
                  aria-describedby="lg-phone-hint"
                />
              </div>
              <span className="hint" id="lg-phone-hint" style={showPhoneErr ? { color: "var(--bad)" } : undefined}>
                {showPhoneErr ? t("v2.personal.login.phoneShort") : t("v2.personal.login.phoneHint")}
              </span>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="lg-login">{t("login.username")}</label>
              <input
                className="input"
                id="lg-login"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                autoFocus
                placeholder="username"
                value={textLogin}
                onChange={(e) => setTextLogin(e.target.value)}
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="lg-pass">{t("login.password")}</label>
            <div className="row g8">
              <input
                className="input grow"
                id="lg-pass"
                type={showPwd ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                className="btn btn-sq"
                type="button"
                style={{ height: 40, width: 40 }}
                aria-label={showPwd ? t("v2.personal.login.hidePwd") : t("v2.personal.login.showPwd")}
                aria-pressed={showPwd}
                onClick={() => setShowPwd((v) => !v)}
              >
                {showPwd ? <EyeOff className="ic" /> : <Eye className="ic" />}
              </button>
            </div>
          </div>

          {error ? (
            <div className="banner b-bad" role="alert">
              <AlertTriangle className="ic" />
              <span className="col g4">
                <span className="w6">{t("v2.personal.login.errorTitle")}</span>
                <span>{error}</span>
              </span>
            </div>
          ) : null}

          <button className="btn btn-pri btn-lg btn-block" type="submit" disabled={!canSubmit || busy}>
            {busy ? t("login.submitting") : t("login.submit")}
          </button>
          <p className="s c3">{t("v2.personal.login.forgot")}</p>
        </form>
      </div>
    </div>
  );
}
