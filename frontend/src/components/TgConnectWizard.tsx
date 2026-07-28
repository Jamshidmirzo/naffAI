import { useState } from "react";
import { tgStart, tgVerifyCode, tgVerifyPassword } from "../lib/tgUserclient";
import { Button, Eyebrow, Modal, PhoneInput, normalizeUzPhone, toast } from "./ui";
import { apiErrorMessage } from "../lib/api-types";
import { useT } from "../lib/i18n";

type Step = 1 | 2 | 3;

export default function TgConnectWizard({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const t = useT();
  const [step, setStep] = useState<Step>(1);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const done = () => {
    onSuccess();
    onClose();
    toast.success(t("tg.connect_success"));
  };

  const handleStart = async () => {
    setError("");
    if (!consent) {
      setError(t("tg.connect_consent_required"));
      return;
    }
    setBusy(true);
    try {
      const canonical = normalizeUzPhone(phone).canonical;
      const res = await tgStart(canonical, consent);
      setSessionId(res.data.session_id);
      setStep(2);
    } catch (err: unknown) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyCode = async () => {
    if (!sessionId) return;
    setError("");
    setBusy(true);
    try {
      const res = await tgVerifyCode(sessionId, code);
      if (res.data.status === "pending_2fa") setStep(3);
      else done();
    } catch (err: unknown) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyPassword = async () => {
    if (!sessionId) return;
    setError("");
    setBusy(true);
    try {
      const res = await tgVerifyPassword(sessionId, password);
      if (res.data.status === "active") done();
    } catch (err: unknown) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={true} onClose={onClose} width={460}>
      <div className="p-7">
        <div className="flex items-center justify-between gap-3 mb-2">
          <div>
            <Eyebrow>{t("tg.connect_step_label", { n: step })}</Eyebrow>
            <div
              className="mt-1 font-semibold tracking-tight"
              style={{ fontSize: 20, letterSpacing: "-0.02em" }}
            >
              {step === 1 && t("tg.connect_title")}
              {step === 2 && t("tg.connect_step_code_title")}
              {step === 3 && t("tg.connect_step_2fa_title")}
            </div>
          </div>
        </div>

        {/* Progress dots */}
        <div className="flex gap-1.5 mb-6">
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className="flex-1 rounded-full"
              style={{
                height: 5,
                background: n <= step ? "var(--accent)" : "var(--faint)",
                transition: "background 300ms cubic-bezier(.2,.7,.2,1)",
              }}
            />
          ))}
        </div>

        {step === 1 && (
          <div className="flex flex-col gap-4">
            <div>
              <div className="nf-col mb-1.5">{t("tg.connect_phone_label")}</div>
              <PhoneInput
                value={phone}
                onChange={setPhone}
                autoFocus
                invalid={phone.length > 0 && !normalizeUzPhone(phone).valid}
              />
            </div>
            <label className="flex items-start gap-2.5 text-[12.5px] text-muted cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>{t("tg.connect_consent_text")}</span>
            </label>
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
            <div className="flex gap-2 justify-end mt-1">
              <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
              <Button
                onClick={handleStart}
                disabled={!normalizeUzPhone(phone).valid || !consent || busy}
              >
                {busy ? t("tg.connect_sending") : t("tg.connect_send_code")}
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-4">
            <div className="text-[13px] text-muted">
              {t("tg.connect_code_hint", { phone })}
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("tg.connect_code_label")}</div>
              <input
                className="nf-input font-mono tabular-nums text-[16px]"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="12345"
                inputMode="numeric"
                autoFocus
              />
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
            <div className="flex gap-2 justify-end mt-1">
              <Button variant="ghost" onClick={() => setStep(1)}>{t("common.back")}</Button>
              <Button onClick={handleVerifyCode} disabled={!code || busy}>
                {busy ? t("tg.connect_checking") : t("tg.connect_verify")}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-4">
            <div className="text-[13px] text-muted">
              {t("tg.connect_2fa_hint")}
            </div>
            <div>
              <div className="nf-col mb-1.5">{t("tg.connect_2fa_label")}</div>
              <input
                className="nf-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
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
            <div className="flex gap-2 justify-end mt-1">
              <Button variant="ghost" onClick={() => setStep(2)}>{t("common.back")}</Button>
              <Button onClick={handleVerifyPassword} disabled={!password || busy}>
                {busy ? t("tg.connect_checking") : t("tg.connect_finish")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
