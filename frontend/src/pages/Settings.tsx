import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, KeyRound, LockKeyholeOpen, ShieldCheck } from "lucide-react";
import { AxiosError } from "axios";
import { api } from "../lib/api";
import { Button, Modal, Toggle, toast } from "../components/ui";
import { PinField } from "../components/PinGate";
import { apiErrorMessage } from "../lib/api-types";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";
import { useAuth } from "../store/auth";
import { isSuperadmin } from "../components/RoleGate";

interface DistributionSettings {
  auto_distribution_enabled: boolean;
  updated_at: string | null;
  updated_by: { id: number; full_name: string } | null;
}

function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export default function Settings() {
  const t = useT();
  usePageHeader(
    { title: t("settings.title"), subtitle: t("settings.subtitle") },
    ["settings"],
  );
  const qc = useQueryClient();
  const rawRole = useAuth((s) => s.role);
  const iAmSuperadmin = isSuperadmin(rawRole);

  const settingsQ = useQuery<DistributionSettings>({
    queryKey: ["settings", "distribution"],
    queryFn: () =>
      api.get<DistributionSettings>("/settings/distribution/").then((r) => r.data),
  });

  const patchMut = useMutation({
    mutationFn: (value: boolean) =>
      api
        .patch<DistributionSettings>("/settings/distribution/", {
          auto_distribution_enabled: value,
        })
        .then((r) => r.data),
    onSuccess: (data) => {
      qc.setQueryData(["settings", "distribution"], data);
      qc.invalidateQueries({ queryKey: ["settings", "distribution"] });
      toast.success(
        data.auto_distribution_enabled
          ? t("settings.auto_distribution.enabled_toast")
          : t("settings.auto_distribution.disabled_toast"),
      );
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err)),
  });

  const data = settingsQ.data;

  return (
    <div className="mx-auto max-w-[820px] flex flex-col gap-5">
      <section className="nf-card p-7 animate-nfFadeUp">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold tracking-tight">
              {t("settings.auto_distribution.title")}
            </div>
            <p className="text-[13px] text-muted mt-1.5 leading-relaxed">
              {t("settings.auto_distribution.hint")}
            </p>
            {data && (
              <div className="text-[11.5px] text-muted mt-3">
                {data.updated_by
                  ? t("settings.updated_with_user", {
                      date: fmtDateTime(data.updated_at),
                      name: data.updated_by.full_name,
                    })
                  : t("settings.updated_no_user", {
                      date: fmtDateTime(data.updated_at),
                    })}
              </div>
            )}
          </div>
          <div className="shrink-0 pt-1">
            <Toggle
              on={!!data?.auto_distribution_enabled}
              onChange={(v) => patchMut.mutate(v)}
              disabled={settingsQ.isLoading || patchMut.isPending}
              aria-label={t("settings.auto_distribution.aria")}
            />
          </div>
        </div>

        {data && !data.auto_distribution_enabled && (
          <div
            className="mt-5 flex items-start gap-2.5 rounded-xl px-3.5 py-2.5 text-[12.5px]"
            style={{
              background: "rgba(220,60,40,.08)",
              color: "var(--danger)",
              border: "1px solid rgba(220,60,40,.2)",
            }}
          >
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>{t("settings.disabled_warning")}</div>
          </div>
        )}
      </section>

      {/* PIN «Посещаемости» — только для superadmin. Секция скрыта у
          менеджеров/тимлидов, чтобы не путать: обычный менеджер не имеет
          прав ни установить, ни сбросить общий PIN. */}
      {iAmSuperadmin && <AttendancePinSection />}
    </div>
  );
}

// ------------------------- Attendance PIN section --------------------------

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

function AttendancePinSection() {
  const t = useT();
  const qc = useQueryClient();
  const [setOpen, setSetOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  const statusQ = useQuery<PinStatus>({
    queryKey: ["attendance-pin-status"],
    queryFn: () =>
      api.get<PinStatus>("/attendance/pin/status/").then((r) => r.data),
    staleTime: 30_000,
  });

  const resetMut = useMutation({
    mutationFn: () => api.post("/attendance/pin/reset/"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attendance-pin-status"] });
      setResetOpen(false);
      toast.success(t("pin.reset_ok"));
    },
    onError: (err: unknown) => toast.error(apiErrorMessage(err)),
  });

  const s = statusQ.data;
  const hasPin = !!s?.has_pin;
  const updatedLine = s?.updated_at
    ? s.updated_by
      ? t("settings.pin.updated_by", {
          date: fmtDateTime(s.updated_at),
          name: s.updated_by,
        })
      : t("settings.pin.updated_at", { date: fmtDateTime(s.updated_at) })
    : null;

  return (
    <section className="nf-card p-7 animate-nfFadeUp">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold tracking-tight flex items-center gap-2">
            <KeyRound className="w-4 h-4" />
            {t("settings.pin.title")}
          </div>
          <p className="text-[13px] text-muted mt-1.5 leading-relaxed">
            {t("settings.pin.hint")}
          </p>

          {s && (
            <div className="mt-3.5 flex flex-col gap-1">
              <div
                className="inline-flex items-center gap-1.5 text-[12.5px] font-medium"
                style={{ color: hasPin ? "var(--ok, #16a34a)" : "var(--danger)" }}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                {hasPin
                  ? t("settings.pin.status_set")
                  : t("settings.pin.status_not_set")}
              </div>
              {updatedLine && (
                <div className="text-[11.5px] text-muted">{updatedLine}</div>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 pt-1 flex flex-col gap-2 items-stretch min-w-[180px]">
          <Button onClick={() => setSetOpen(true)}>
            <KeyRound className="w-3.5 h-3.5" />
            {hasPin
              ? t("settings.pin.change_btn")
              : t("settings.pin.set_btn")}
          </Button>
          {hasPin && (
            <button
              type="button"
              onClick={() => setResetOpen(true)}
              className="nf-btn"
              style={{
                background: "rgba(220,60,40,.1)",
                color: "var(--danger)",
                padding: "8px 14px",
                fontSize: 12.5,
              }}
            >
              <LockKeyholeOpen className="w-3.5 h-3.5" />
              {t("settings.pin.reset_btn")}
            </button>
          )}
        </div>
      </div>

      {!hasPin && (
        <div
          className="mt-5 flex items-start gap-2.5 rounded-xl px-3.5 py-2.5 text-[12.5px]"
          style={{
            background: "rgba(220,60,40,.08)",
            color: "var(--danger)",
            border: "1px solid rgba(220,60,40,.2)",
          }}
        >
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>{t("settings.pin.status_not_set")}</div>
        </div>
      )}

      <PinSetModal
        open={setOpen}
        onClose={() => setSetOpen(false)}
        isChange={hasPin}
        onSuccess={() => {
          qc.invalidateQueries({ queryKey: ["attendance-pin-status"] });
          setSetOpen(false);
          toast.success(t("pin.set_ok"));
        }}
      />

      <Modal open={resetOpen} onClose={() => setResetOpen(false)} width={420}>
        <div className="p-7">
          <div className="text-[18px] font-semibold tracking-tight flex items-center gap-2">
            <LockKeyholeOpen className="w-4 h-4" />
            {t("pin.reset_all_confirm_title")}
          </div>
          <div className="text-[13px] text-muted mt-2 leading-relaxed">
            {t("pin.reset_all_confirm_body")}
          </div>
          <div className="mt-6 flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setResetOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => resetMut.mutate()}
              disabled={resetMut.isPending}
            >
              {resetMut.isPending ? "…" : t("settings.pin.reset_btn")}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}

// ------------------------- PIN set / change modal --------------------------

function PinSetModal({
  open,
  onClose,
  isChange,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  isChange: boolean;
  onSuccess: () => void;
}) {
  const t = useT();
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setPin("");
    setConfirmPin("");
    setErr("");
    setBusy(false);
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setErr("");
    if (!/^\d{4}$/.test(pin)) {
      setErr(t("pin.only_digits"));
      return;
    }
    if (pin !== confirmPin) {
      setErr(t("pin.mismatch"));
      return;
    }
    setBusy(true);
    try {
      await api.post("/attendance/pin/set/", { new_pin: pin });
      reset();
      onSuccess();
    } catch (e) {
      setErr(apiErrorMessage(e as AxiosError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      width={440}
    >
      <div className="p-7">
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
            <KeyRound className="w-4 h-4" />
          </div>
          <div className="text-[16px] font-semibold tracking-tight">
            {isChange ? t("pin.change_title") : t("pin.set_global_title")}
          </div>
        </div>
        <p className="text-[12.5px] text-muted mt-1 mb-5">
          {isChange ? t("pin.change_subtitle") : t("pin.set_global_subtitle")}
        </p>

        <form onSubmit={submit} className="flex flex-col gap-3.5">
          <PinField
            value={pin}
            onChange={setPin}
            placeholder={t("pin.new_ph")}
            onEnterMoveTo={() => document.getElementById("pin-confirm-2")?.focus()}
          />
          <PinField
            value={confirmPin}
            onChange={setConfirmPin}
            placeholder={t("pin.confirm_ph")}
            id="pin-confirm-2"
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
          <div className="mt-1 flex gap-2 justify-end">
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                reset();
                onClose();
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={busy || pin.length !== 4 || confirmPin.length !== 4}
            >
              {busy ? "…" : t("pin.save")}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
