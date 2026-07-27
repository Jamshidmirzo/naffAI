import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, Phone as PhoneIcon, UserRound } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../store/auth";
import { useLang } from "../store/lang";
import { apiErrorMessage } from "../lib/api-types";
import { Button, PhoneInput, TabPill, normalizeUzPhone } from "../components/ui";
import { BarsScene } from "../components/three/BarsScene";
import { useT } from "../lib/i18n";

const LOGIN_WEEK = [42, 58, 51, 74, 66, 91, 84];

type Mode = "phone" | "text";

export default function Login() {
  // We keep the login value in the "phone" canonical shape (+998XXXXXXXXX)
  // when the user is entering a number, and as a raw string when they
  // switch to text-mode (manager username like "shahzod"). Both go to
  // the same POST /auth/login/ endpoint — the backend resolves either.
  const [mode, setMode] = useState<Mode>("phone");
  const [phone, setPhone] = useState("");
  const [textLogin, setTextLogin] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const setAuth = useAuth((s) => s.setAuth);
  const lang = useLang();
  const nav = useNavigate();
  const t = useT();

  const phoneParsed = useMemo(() => normalizeUzPhone(phone), [phone]);
  const canSubmit = useMemo(() => {
    if (!password) return false;
    if (mode === "phone") return phoneParsed.valid;
    return textLogin.trim().length > 0;
  }, [mode, phoneParsed.valid, textLogin, password]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const username = mode === "phone" ? phoneParsed.canonical : textLogin.trim();
    setBusy(true);
    setError("");
    try {
      const { data } = await api.post("/auth/login/", { username, password });
      setAuth(data.token, data.username, data.role);
      nav("/");
    } catch (err: unknown) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 nf-hero" />
      <BarsScene
        values={LOGIN_WEEK}
        className="absolute inset-0"
        style={{ pointerEvents: "none", opacity: 0.55 }}
      />

      <div className="absolute top-6 right-6 z-10">
        <TabPill
          value={lang.lang}
          onChange={(v) => lang.set(v)}
          items={[
            { value: "ru", label: "RU" },
            { value: "uz", label: "UZ" },
          ]}
        />
      </div>

      <div className="relative z-10 min-h-screen grid place-items-center px-4 py-10">
        <form
          onSubmit={onSubmit}
          className="animate-nfPop"
          style={{
            width: 400,
            maxWidth: "100%",
            borderRadius: 30,
            padding: "38px 36px 30px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            boxShadow: "0 40px 90px -40px rgba(0,0,0,.4)",
          }}
        >
          {/* Logo */}
          <div className="flex items-center gap-2.5 mb-8">
            <div
              className="grid place-items-center text-white font-bold text-[15px]"
              style={{
                width: 30,
                height: 30,
                borderRadius: 9,
                background: "var(--accent-grad)",
                boxShadow: "0 8px 18px -8px var(--accent)",
              }}
            >
              n
            </div>
            <div className="text-[17px] font-semibold tracking-tight">naffAI</div>
          </div>

          <h1
            className="font-semibold tracking-tight"
            style={{ fontSize: 27, letterSpacing: "-0.03em", lineHeight: 1.1 }}
          >
            {t("login.title")}
          </h1>
          <p className="text-[13.5px] text-muted mt-1.5">
            {t("login.subtitle")}
          </p>

          <div className="mt-7 flex flex-col gap-4">
            {/* Mode switch: phone vs text (small, right-aligned) */}
            <div className="flex items-center justify-between">
              <label className="nf-col">
                {mode === "phone" ? t("login.op_hint_prefix") : t("login.username")}
              </label>
              <button
                type="button"
                onClick={() => setMode((m) => (m === "phone" ? "text" : "phone"))}
                className="text-[11.5px] text-muted hover:text-text transition inline-flex items-center gap-1"
              >
                {mode === "phone" ? (
                  <>
                    <UserRound className="w-3 h-3" /> {t("login.username")}
                  </>
                ) : (
                  <>
                    <PhoneIcon className="w-3 h-3" /> {t("login.op_hint_prefix")}
                  </>
                )}
              </button>
            </div>

            {mode === "phone" ? (
              <PhoneInput
                value={phone}
                onChange={setPhone}
                autoFocus
                aria-label={t("login.op_hint_prefix")}
                invalid={phone.length > 0 && !phoneParsed.valid}
              />
            ) : (
              <input
                className="nf-input"
                value={textLogin}
                onChange={(e) => setTextLogin(e.target.value)}
                autoComplete="username"
                autoFocus
                placeholder="username"
              />
            )}

            <div>
              <label className="nf-col mb-1.5 block">{t("login.password")}</label>
              <div className="relative">
                <input
                  className="nf-input pr-11"
                  type={showPwd ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPwd((v) => !v)}
                  className="absolute inset-y-0 right-3 flex items-center text-muted hover:text-text transition"
                  aria-label={showPwd ? "Hide" : "Show"}
                  tabIndex={-1}
                >
                  {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div
                className="text-[13px] rounded-xl px-3.5 py-2.5"
                style={{
                  background: "rgba(220,60,40,.08)",
                  color: "var(--danger)",
                  border: "1px solid rgba(220,60,40,.2)",
                }}
              >
                {error}
              </div>
            )}

            <Button
              type="submit"
              block
              disabled={!canSubmit || busy}
              className="!py-3.5 !text-[15px] !font-semibold"
            >
              {busy ? t("login.submitting") : t("login.submit")}
            </Button>
          </div>

          <div className="mt-5 pt-4 border-t border-[color:var(--border)] flex items-center justify-between">
            <button
              type="button"
              className="text-[12.5px] text-muted hover:text-text transition"
            >
              {t("common.forgot_password")}
            </button>
            <div className="text-[11px] text-muted">
              {mode === "phone"
                ? "+998 90 000 00 00"
                : "manager · qa · admin"}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
