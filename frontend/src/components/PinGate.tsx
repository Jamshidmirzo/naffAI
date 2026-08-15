import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { LockKeyhole, ShieldAlert, ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import { Button, toast } from "./ui";
import { useT } from "../lib/i18n";
import { apiErrorMessage } from "../lib/api-types";

/**
 * PIN-обёртка для attendance-раздела (2026-08-15 global-PIN redesign).
 *
 * Модель: **один общий PIN на всех менеджеров**, ставит и сбрасывает
 * только superadmin (через /settings/). Логика ветвления:
 *
 * - `superadmin` — рендерим children сразу (bypass, PIN не нужен).
 * - `manager / team_lead` + PIN ещё не задан суперадмином — сообщение
 *   «Обратитесь к супер-админу». Формы «задайте PIN» тут нет.
 * - `manager / team_lead` + PIN задан, но personal-сессия истекла /
 *   отсутствует — форма «Введите PIN» → POST /verify/ → children.
 * - Активная сессия (< 30 мин) — render children; за минуту до
 *   истечения показываем toast-предупреждение.
 * - 401 pin_required где-то посреди работы: глобальный axios-interceptor
 *   не разлогинивает; TanStack-запросы ретраятся после успешного verify
 *   (мы invalidate'ним всё после verify).
 */

interface PinStatus {
  role: string;
  has_pin: boolean;
  pin_required: boolean;
  pin_verified: boolean;
  expires_at: string | null;
  ttl_minutes: number;
  updated_at: string | null;
  updated_by: string | null;
}

interface Props {
  children: ReactNode;
}

export default function PinGate({ children }: Props) {
  const qc = useQueryClient();
  const t = useT();
  const location = useLocation();

  const statusQ = useQuery<PinStatus>({
    queryKey: ["attendance-pin-status"],
    queryFn: () =>
      api.get<PinStatus>("/attendance/pin/status/").then((r) => r.data),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  // Countdown / expiry warning.
  const warnedRef = useRef(false);
  useEffect(() => {
    warnedRef.current = false;
    if (!statusQ.data?.expires_at) return;
    const expiresMs = new Date(statusQ.data.expires_at).getTime();
    const tick = () => {
      const leftMs = expiresMs - Date.now();
      if (leftMs <= 0) {
        qc.invalidateQueries({ queryKey: ["attendance-pin-status"] });
      } else if (leftMs <= 60_000 && !warnedRef.current) {
        toast.error(t("pin.session_expires_soon"));
        warnedRef.current = true;
      }
    };
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, [statusQ.data?.expires_at, qc, t]);

  useEffect(() => {
    qc.invalidateQueries({ queryKey: ["attendance-pin-status"] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  if (statusQ.isLoading || !statusQ.data) {
    return (
      <div className="mx-auto max-w-md text-center py-14 text-muted text-[13px]">
        {t("common.loading")}
      </div>
    );
  }

  const s = statusQ.data;

  // Superadmin / оператор / кто-угодно без обязательного PIN'a — просто рендер.
  if (!s.pin_required) return <>{children}</>;

  // Manager с PIN, сессия ещё жива — пропускаем.
  if (s.has_pin && s.pin_verified) return <>{children}</>;

  // Manager, PIN ещё не установлен суперадмином — заглушка «обратитесь к суперадмину».
  if (!s.has_pin) return <PinNotSetNotice />;

  // Manager, PIN задан, но personal-сессия истекла — форма ввода.
  return (
    <PinEnterForm
      onDone={() => {
        qc.invalidateQueries({ queryKey: ["attendance-pin-status"] });
        // Инвалидируем все attendance-запросы, чтобы упавшие в 401
        // pin_required перезапросились автоматически.
        qc.invalidateQueries({
          predicate: (q) => {
            const key = q.queryKey?.[0];
            return typeof key === "string" && key.startsWith("attendance");
          },
        });
      }}
    />
  );
}

// ------------------------- NOTICE (PIN not set) -----------------------------

function PinNotSetNotice() {
  const t = useT();
  return (
    <PinShell
      icon={<ShieldAlert className="w-4 h-4" />}
      title={t("pin.contact_admin_title")}
      subtitle={t("pin.contact_admin_subtitle")}
    >
      <div
        className="mt-1 rounded-xl px-3.5 py-3 text-[12.5px] flex items-start gap-2.5"
        style={{
          background: "rgba(220,60,40,.08)",
          color: "var(--danger)",
          border: "1px solid rgba(220,60,40,.2)",
        }}
      >
        <LockKeyhole className="w-4 h-4 mt-0.5 shrink-0" />
        <div>{t("pin.contact_admin_subtitle")}</div>
      </div>
    </PinShell>
  );
}

// ------------------------- ENTER FORM --------------------------------------

function PinEnterForm({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setErr("");
    if (!/^\d{4}$/.test(pin)) {
      setErr(t("pin.only_digits"));
      return;
    }
    setBusy(true);
    try {
      await api.post("/attendance/pin/verify/", { pin });
      onDone();
    } catch (e) {
      setErr(apiErrorMessage(e as AxiosError));
      setPin("");
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <PinShell
      icon={<ShieldCheck className="w-4 h-4" />}
      title={t("pin.enter_title")}
      subtitle={t("pin.enter_subtitle")}
    >
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <PinField
          value={pin}
          onChange={setPin}
          placeholder={t("pin.enter_ph")}
          inputRef={inputRef}
          onSubmit={() => submit()}
        />
        {err && (
          <div
            className="text-[12.5px] rounded-xl px-3.5 py-2.5"
            style={{
              background: "rgba(220,60,40,.08)",
              color: "var(--danger)",
              border: "1px solid rgba(220,60,40,.2)",
            }}
          >
            {err}
          </div>
        )}
        <div className="flex justify-end pt-1">
          <Button type="submit" disabled={busy || pin.length !== 4}>
            {busy ? "…" : t("pin.enter_btn")}
          </Button>
        </div>
      </form>
      <div className="mt-4 text-[11.5px] text-muted leading-snug">
        {t("pin.reset_hint")}
      </div>
    </PinShell>
  );
}

// ------------------------- SHELL + FIELD -----------------------------------

function PinShell({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[400px] mt-10">
      <div className="nf-card p-7">
        <div className="flex items-center gap-2.5 mb-1">
          <div
            className="grid place-items-center text-white"
            style={{
              width: 30,
              height: 30,
              borderRadius: 10,
              background: "var(--accent-grad)",
            }}
          >
            {icon}
          </div>
          <div className="text-[16px] font-semibold tracking-tight">{title}</div>
        </div>
        <p className="text-[12.5px] text-muted mt-1 mb-5">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

function PinField({
  value,
  onChange,
  placeholder,
  inputRef,
  id,
  onEnterMoveTo,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  inputRef?: React.MutableRefObject<HTMLInputElement | null>;
  id?: string;
  onEnterMoveTo?: () => void;
  onSubmit?: () => void;
}) {
  return (
    <input
      ref={(el) => {
        if (inputRef) inputRef.current = el;
      }}
      id={id}
      className="nf-input font-mono text-center tabular-nums tracking-[0.4em] text-[22px]"
      value={value}
      onChange={(e) => {
        const only = e.target.value.replace(/\D/g, "").slice(0, 4);
        onChange(only);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (value.length === 4 && onSubmit) {
            e.preventDefault();
            onSubmit();
          } else if (value.length === 4 && onEnterMoveTo) {
            e.preventDefault();
            onEnterMoveTo();
          }
        }
      }}
      inputMode="numeric"
      autoComplete="off"
      placeholder={placeholder}
      maxLength={4}
    />
  );
}

// Экспорт хелпера — используется страницей настроек PIN.
export { PinField };
