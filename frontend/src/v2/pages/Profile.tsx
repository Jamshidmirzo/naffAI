import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Camera, Check, Copy, Eye, EyeOff, LogIn, LogOut, QrCode, RefreshCw, Send, Upload } from "lucide-react";
import { useAuth } from "../../store/auth";
import { useTheme } from "../../store/theme";
import { useLang } from "../../store/lang";
import { useDesign } from "../../store/design";
import { useSaleSound } from "../../store/saleSound";
import { normaliseRole } from "../../components/RoleGate";
import { tgStart, tgVerifyCode, tgVerifyPassword } from "../../lib/tgUserclient";
import { normalizeUzPhone, toast } from "../../components/ui";
import { apiErrorMessage } from "../../lib/api-types";
import { useT2 } from "../i18n";
import { cx, Dialog, ErrorState, LoadingBlock, PageHeader, useConfirm } from "../ui";
import {
  useAttendanceToggle,
  useChangePassword,
  useClearMySticker,
  useInvalidateMe,
  useMyAttendance,
  useMyPreferences,
  useMySticker,
  usePinStatus,
  useProfileMe,
  useSaveBirthDate,
  useSetMySticker,
  useStickerPalette,
  useTgBotLinkCode,
  useTgBotUnlink,
  useTgUserRevoke,
  useTgUserStatus,
  useUpdateDailyLesson,
  useUploadAvatar,
  type ProfileMe,
} from "../api/personal";
import { TG_STATUS_KEY } from "../../lib/tgUserclient";
import { useQueryClient } from "@tanstack/react-query";

type T = ReturnType<typeof useT2>;

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || "?"
  );
}

function roleLabel(t: T, role: string): string {
  if (role === "operator") return t("profile.role_operator");
  if (role === "super_manager") return t("role.super_manager");
  if (role === "manager" || role === "team_lead" || role === "superadmin") return t("profile.role_manager");
  return role;
}

function hhmm(iso: string | Date) {
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function useNow(ms: number, on = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms, on]);
  return now;
}

function errData(e: unknown): Record<string, unknown> | undefined {
  return (e as { response?: { data?: Record<string, unknown> } })?.response?.data;
}

/* ------------------------------------------------------------------ */

export default function Profile() {
  const t = useT2();
  const auth = useAuth();
  const me = useProfileMe();
  const role = me.data?.role || auth.role || "";
  const isOp = !!me.data?.operator_id;
  const isMgr = normaliseRole(role) === "manager" || normaliseRole(role) === "super_manager";

  if (me.isLoading) {
    return (
      <>
        <PageHeader title={t("profile.title")} />
        <main className="page"><section className="card"><LoadingBlock rows={5} onRetry={() => me.refetch()} /></section></main>
      </>
    );
  }
  if (me.isError || !me.data) {
    return (
      <>
        <PageHeader title={t("profile.title")} />
        <main className="page"><section className="card"><ErrorState error={me.error} onRetry={() => me.refetch()} /></section></main>
      </>
    );
  }

  const data = me.data;
  return (
    <>
      <PageHeader title={t("profile.title")} meta={isOp ? undefined : t("v2.personal.profile.metaManager")} />
      <main className="page">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 16, alignItems: "start" }}>
          <div className="col g16">
            <HeroCard me={data} role={role} isOp={isOp} />
            {isOp ? <ShiftCard /> : null}
            {isOp ? <PersonalCard me={data} /> : null}
            {isMgr ? <PinCard /> : null}
          </div>
          <div className="col g16">
            <InterfaceCard isOp={isOp} />
            {!isOp ? <PasswordCard /> : null}
            <TelegramBotCard me={data} refetchMe={() => me.refetch()} />
            {isOp ? <TelegramAccountCard /> : null}
          </div>
        </div>
      </main>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Hero: avatar, name, role, sticker                                    */
/* ------------------------------------------------------------------ */

function HeroCard({ me, role, isOp }: { me: ProfileMe; role: string; isOp: boolean }) {
  const t = useT2();
  const auth = useAuth();
  const sticker = useMySticker(isOp);
  const upload = useUploadAvatar();
  const [camOpen, setCamOpen] = useState(false);
  const name = me.operator_name || me.display_name || me.username || auth.username || "?";
  const st = sticker.data?.sticker;

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    upload.mutate(f, {
      onSuccess: () => toast.success(t("v2.personal.profile.avatarSaved")),
      onError: () => toast.error(t("v2.personal.profile.avatarFailed")),
    });
  };

  return (
    <section className="card row g20" style={{ padding: 24, alignItems: "center" }}>
      {me.avatar_url ? (
        <img src={me.avatar_url} alt="" style={{ width: 72, height: 72, borderRadius: "50%", objectFit: "cover", flex: "none" }} />
      ) : (
        <span className="ava ava-xl">{initials(name)}</span>
      )}
      <div className="col g4 grow" style={{ minWidth: 0 }}>
        <h2 className="h2 trunc">{name}</h2>
        <span className="s c3 row g6 wrap">
          <span>{role ? roleLabel(t, role) : "—"}</span>
          {st ? (
            <>
              <span>·</span>
              <span title={st.is_rare ? t("profile.rare_sticker") : t("profile.sticker")} style={{ fontSize: 16, lineHeight: 1 }}>{st.emoji}</span>
              {st.is_rare ? <span className="badge b-hot" style={{ height: 20 }}>rare</span> : null}
            </>
          ) : null}
        </span>
        {!isOp ? <span className="num s c2">{t("v2.personal.profile.login", { login: me.username })}</span> : null}
        {isOp ? (
          <div className="row g8 wrap" style={{ marginTop: 8 }}>
            <label className={cx("btn btn-sm", upload.isPending && "is-disabled")} style={{ cursor: upload.isPending ? "default" : "pointer" }}>
              <Upload className="ic ic-s" />
              {upload.isPending ? t("v2.personal.profile.uploading") : t("v2.personal.profile.uploadPhoto")}
              <input type="file" accept="image/*" hidden disabled={upload.isPending} onChange={onFile} />
            </label>
            <button className="btn btn-sm" type="button" onClick={() => setCamOpen(true)} disabled={upload.isPending}>
              <Camera className="ic ic-s" />
              {t("v2.personal.profile.takePhoto")}
            </button>
          </div>
        ) : null}
      </div>
      {camOpen ? <AvatarCameraDialog onClose={() => setCamOpen(false)} /> : null}
    </section>
  );
}

function AvatarCameraDialog({ onClose }: { onClose: () => void }) {
  const t = useT2();
  const upload = useUploadAvatar();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [shot, setShot] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [live, setLive] = useState(false);

  const stop = () => {
    try {
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
    } catch {
      /* ignore */
    }
    streamRef.current = null;
    setLive(false);
  };

  const start = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
      streamRef.current = stream;
      setLive(true);
      window.setTimeout(async () => {
        if (videoRef.current && streamRef.current) {
          videoRef.current.srcObject = streamRef.current;
          try {
            await videoRef.current.play();
          } catch {
            /* ignore */
          }
        }
      }, 0);
    } catch (err) {
      const n = (err as { name?: string } | undefined)?.name;
      setError(n === "NotAllowedError" || n === "SecurityError" ? t("v2.personal.profile.camDenied") : t("v2.personal.profile.camUnavailable"));
    }
  };

  useEffect(() => {
    void start();
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!shot) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(shot);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [shot]);

  const snap = async () => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;
    c.width = v.videoWidth || 640;
    c.height = v.videoHeight || 480;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const blob: Blob | null = await new Promise((r) => c.toBlob((b) => r(b), "image/jpeg", 0.85));
    stop();
    if (blob) setShot(blob);
  };

  const retake = () => {
    setShot(null);
    void start();
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    stop();
    setShot(f);
  };

  const save = () => {
    if (!shot) return;
    setError("");
    upload.mutate(shot, {
      onSuccess: () => {
        toast.success(t("v2.personal.profile.avatarSaved"));
        onClose();
      },
      onError: () => setError(t("v2.personal.profile.avatarFailedLong")),
    });
  };

  const close = () => {
    stop();
    onClose();
  };

  return (
    <Dialog
      open
      onClose={close}
      title={t("v2.personal.profile.photoTitle")}
      sub={t("v2.personal.profile.photoSub")}
      footer={
        <>
          <button className="btn" type="button" onClick={close}>{t("common.cancel")}</button>
          {shot ? (
            <button className="btn btn-pri" type="button" onClick={save} disabled={upload.isPending}>
              {upload.isPending ? t("common.saving") : t("v2.personal.profile.savePhoto")}
            </button>
          ) : (
            <button className="btn btn-pri" type="button" onClick={snap} disabled={!live}>
              <Camera className="ic" />
              {t("v2.personal.profile.snap")}
            </button>
          )}
        </>
      }
    >
      <div className="row g16 wrap" style={{ alignItems: "flex-start" }}>
        <div style={{ width: 160, height: 160, borderRadius: "50%", overflow: "hidden", flex: "none", background: "var(--surface-3)" }}>
          {preview ? (
            <img src={preview} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : live ? (
            <video ref={videoRef} muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />
          ) : (
            <div className="ph" style={{ width: "100%", height: "100%", borderRadius: "50%" }}>{t("v2.personal.profile.noPhoto")}</div>
          )}
        </div>
        <div className="col g8 grow">
          {shot ? <button className="btn" type="button" onClick={retake}><RefreshCw className="ic" />{t("v2.personal.profile.retake")}</button> : null}
          <label className="btn" style={{ cursor: "pointer" }}>
            <Upload className="ic" />
            {t("v2.personal.profile.pickFile")}
            <input type="file" accept="image/*" hidden onChange={onFile} />
          </label>
        </div>
      </div>
      {error ? (
        <div className="banner b-bad" style={{ marginTop: 12 }}>
          <span>{error}</span>
        </div>
      ) : null}
      <canvas ref={canvasRef} style={{ display: "none" }} />
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Shift (operator)                                                     */
/* ------------------------------------------------------------------ */

function ShiftCard() {
  const t = useT2();
  const nav = useNavigate();
  const cur = useMyAttendance(true);
  const toggle = useAttendanceToggle();
  const [cooldown, setCooldown] = useState(0);
  const open = cur.data?.open_log ?? null;
  const now = useNow(1000, !!open || cooldown > 0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setInterval(() => setCooldown((v) => Math.max(0, v - 1)), 1000);
    return () => window.clearInterval(id);
  }, [cooldown]);

  const run = () =>
    toggle.mutate(undefined, {
      onSuccess: (d) => {
        setCooldown(30);
        if (d.action === "check_in") toast.success(d.was_late ? t("v2.personal.profile.checkInLate") : t("v2.personal.profile.checkIn"));
        else {
          const h = d.duration_min ? Math.round((d.duration_min / 60) * 10) / 10 : null;
          toast.success(h !== null ? t("v2.personal.profile.checkOutDur", { h: String(h).replace(".", ",") }) : t("v2.personal.profile.checkOut"));
        }
      },
      onError: (e) => {
        const d = errData(e) as { error?: string; detail?: string } | undefined;
        const msg = d?.error || d?.detail || t("v2.personal.profile.checkError");
        toast.error(msg);
        if (/секунд|soniya/i.test(String(msg))) setCooldown(30);
      },
    });

  let elapsed = "";
  if (open) {
    const s = Math.max(0, Math.floor((now - new Date(open.checked_in_at).getTime()) / 1000));
    const p = (n: number) => String(n).padStart(2, "0");
    elapsed = `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  }

  return (
    <section className="card col">
      <div className="card-h">
        <span className="h3">{t("v2.personal.profile.shift")}</span>
        {cur.data ? (
          open ? (
            <span className={cx("badge", open.was_late ? "b-bad" : "b-ok")}><i className="dot" />{open.was_late ? t("v2.personal.profile.shiftLate") : t("v2.personal.profile.shiftOn")}</span>
          ) : (
            <span className="badge"><i className="dot" />{t("v2.personal.profile.shiftOff")}</span>
          )
        ) : null}
      </div>
      {cur.isLoading ? (
        <LoadingBlock rows={1} />
      ) : cur.isError ? (
        <ErrorState error={cur.error} onRetry={() => cur.refetch()} />
      ) : (
        <div className="row g16 wrap" style={{ padding: "16px 20px", alignItems: "center" }}>
          <div className="col g4 grow">
            {open ? (
              <>
                <span className="kpi">{elapsed}</span>
                <span className="s c3">
                  {t("v2.personal.profile.cameAt")} <span className="num">{hhmm(open.checked_in_at)}</span>
                  {", "}
                  {open.was_late ? <span className="c-bad">{t("v2.personal.profile.late")}</span> : t("v2.personal.profile.onTime")}
                </span>
              </>
            ) : (
              <>
                <span className="s w6">{t("v2.personal.profile.shiftClosed")}</span>
                <span className="s c3">{t("v2.personal.profile.shiftStartHint")}</span>
              </>
            )}
          </div>
          <button className="btn" type="button" onClick={() => nav("/scan")}>
            <QrCode className="ic" />
            {t("v2.personal.profile.qr")}
          </button>
          <button
            className={cx("btn", cooldown > 0 ? "" : open ? "btn-bad" : "btn-ok")}
            type="button"
            onClick={run}
            disabled={toggle.isPending || cooldown > 0}
          >
            {toggle.isPending ? (
              t("common.loading")
            ) : cooldown > 0 ? (
              <span className="num">{t("v2.personal.profile.cooldown", { n: cooldown })}</span>
            ) : open ? (
              <>
                <LogOut className="ic" />
                {t("v2.personal.profile.endShift")}
              </>
            ) : (
              <>
                <LogIn className="ic" />
                {t("v2.personal.profile.startShift")}
              </>
            )}
          </button>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Personal data (operator): birth date + password                      */
/* ------------------------------------------------------------------ */

function PersonalCard({ me }: { me: ProfileMe }) {
  const t = useT2();
  const save = useSaveBirthDate();
  const [value, setValue] = useState(me.birth_date || "");
  const [pwdOpen, setPwdOpen] = useState(false);
  useEffect(() => setValue(me.birth_date || ""), [me.birth_date]);
  const dirty = (value || "") !== (me.birth_date || "");
  const [err, setErr] = useState("");

  const submit = (v: string | null) => {
    setErr("");
    save.mutate(v, {
      onSuccess: () => toast.success(t("profile.saved")),
      onError: (e) => {
        const d = errData(e)?.birth_date;
        const msg = (Array.isArray(d) ? d[0] : d) || t("profile.settings_save_failed");
        setErr(String(msg));
        toast.error(String(msg));
      },
    });
  };

  return (
    <section className="card col">
      <div className="card-h"><span className="h3">{t("v2.personal.profile.personal")}</span></div>
      <div className="col g16" style={{ padding: "16px 20px 20px" }}>
        <div className="field">
          <label htmlFor="pf-bd">{t("profile.birth_date_title")}</label>
          <div className="row g8 wrap">
            <input
              className={cx("input num grow", err && "is-bad")}
              id="pf-bd"
              type="date"
              value={value}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setValue(e.target.value)}
              style={{ minWidth: 180 }}
            />
            {dirty ? (
              <button className="btn btn-pri" type="button" onClick={() => submit(value || null)} disabled={save.isPending}>
                {save.isPending ? t("common.saving") : t("common.save")}
              </button>
            ) : null}
            {!dirty && me.birth_date ? (
              <button className="btn btn-ghost" type="button" onClick={() => submit(null)} disabled={save.isPending}>
                {t("common.remove")}
              </button>
            ) : null}
          </div>
          {err ? <span className="err">{err}</span> : <span className="hint">{t("v2.personal.profile.bdHint")}</span>}
        </div>
        <div className="row between g12">
          <div className="col">
            <span className="s w6">{t("common.password")}</span>
            <span className="xs c3">{t("profile.password_change_min")}</span>
          </div>
          <button className="btn" type="button" onClick={() => setPwdOpen(true)}>{t("profile.change_password")}</button>
        </div>
      </div>
      {pwdOpen ? <PasswordDialog onClose={() => setPwdOpen(false)} /> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Password                                                             */
/* ------------------------------------------------------------------ */

function PwdInput({ id, value, onChange, bad, autoComplete, autoFocus }: { id: string; value: string; onChange: (v: string) => void; bad?: boolean; autoComplete?: string; autoFocus?: boolean }) {
  const t = useT2();
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <input
        id={id}
        className={cx("input", bad && "is-bad")}
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        style={{ width: "100%", paddingRight: 40 }}
      />
      <button
        className="btn btn-ghost btn-sq btn-sm"
        type="button"
        tabIndex={-1}
        onClick={() => setShow((v) => !v)}
        aria-label={show ? t("profile.hide_password") : t("profile.show_password")}
        style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)" }}
      >
        {show ? <EyeOff className="ic ic-s" /> : <Eye className="ic ic-s" />}
      </button>
    </div>
  );
}

function usePasswordForm(onDone: () => void) {
  const t = useT2();
  const change = useChangePassword();
  const [oldPwd, setOld] = useState("");
  const [newPwd, setNew] = useState("");
  const [confirm, setConfirm] = useState("");
  const [srv, setSrv] = useState<{ old?: string; new?: string; other?: string }>({});

  const newErr = newPwd && newPwd.length < 8 ? t("v2.personal.profile.pwdNeedMore", { n: 8 - newPwd.length }) : srv.new;
  const confirmErr = confirm && confirm !== newPwd ? t("profile.password_mismatch") : undefined;
  const can = !!oldPwd && !!newPwd && !!confirm && newPwd.length >= 8 && confirm === newPwd && !change.isPending;

  const reset = () => {
    setOld("");
    setNew("");
    setConfirm("");
    setSrv({});
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!can) return;
    setSrv({});
    change.mutate(
      { old_password: oldPwd, new_password: newPwd },
      {
        onSuccess: () => {
          toast.success(t("profile.password_updated"));
          reset();
          onDone();
        },
        onError: (err) => {
          const d = errData(err);
          const first = (v: unknown) => (Array.isArray(v) ? String(v[0]) : typeof v === "string" ? v : undefined);
          const o = first(d?.old_password);
          const n = first(d?.new_password);
          const other = o || n ? undefined : first(d?.detail) || t("profile.password_change_failed");
          setSrv({ old: o, new: n, other });
        },
      },
    );
  };

  const fields = (layout: "stack" | "pair") => {
    const cur = (
      <div className="field">
        <label htmlFor="pw-old">{t("profile.current_password")}</label>
        <PwdInput id="pw-old" value={oldPwd} onChange={(v) => { setOld(v); setSrv((s) => ({ ...s, old: undefined })); }} bad={!!srv.old} autoComplete="current-password" autoFocus={layout === "stack"} />
        {srv.old ? <span className="err">{srv.old}</span> : null}
      </div>
    );
    const nw = (
      <div className="field grow">
        <label htmlFor="pw-new">{t("profile.new_password")}</label>
        <PwdInput id="pw-new" value={newPwd} onChange={(v) => { setNew(v); setSrv((s) => ({ ...s, new: undefined })); }} bad={!!newErr} autoComplete="new-password" />
        {newErr ? <span className="err">{newErr}</span> : null}
      </div>
    );
    const cf = (
      <div className="field grow">
        <label htmlFor="pw-confirm">{layout === "pair" ? t("v2.personal.profile.pwdAgain") : t("profile.password_confirm")}</label>
        <PwdInput id="pw-confirm" value={confirm} onChange={setConfirm} bad={!!confirmErr} autoComplete="new-password" />
        {confirmErr ? <span className="err">{confirmErr}</span> : null}
      </div>
    );
    return (
      <>
        {cur}
        {layout === "pair" ? <div className="row g12 wrap" style={{ alignItems: "flex-start" }}>{nw}{cf}</div> : <>{nw}{cf}</>}
        {srv.other ? <div className="banner b-bad"><span>{srv.other}</span></div> : null}
      </>
    );
  };

  return { fields, submit, can, pending: change.isPending, reset };
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const t = useT2();
  const f = usePasswordForm(onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      width={440}
      title={t("profile.change_password")}
      sub={t("profile.password_change_min")}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-pri" type="button" disabled={!f.can} onClick={() => f.submit()}>
            {f.pending ? t("common.saving") : t("profile.password_change_submit")}
          </button>
        </>
      }
    >
      <form className="col g12" onSubmit={f.submit}>
        {f.fields("stack")}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function PasswordCard() {
  const t = useT2();
  const f = usePasswordForm(() => undefined);
  return (
    <section className="card col">
      <div className="card-h"><span className="h3">{t("common.password")}</span></div>
      <form className="col g12" style={{ padding: "16px 20px" }} onSubmit={f.submit}>
        {f.fields("pair")}
        <div className="row g8">
          <button className="btn btn-pri" type="submit" disabled={!f.can}>
            {f.pending ? t("common.saving") : t("profile.change_password")}
          </button>
          <span className="xs c3">{t("v2.personal.profile.pwdMin")}</span>
        </div>
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* PIN status (manager / super) — read-only                             */
/* ------------------------------------------------------------------ */

function PinCard() {
  const t = useT2();
  const pin = usePinStatus(true);
  const d = pin.data;
  if (!d || !d.pin_required) return null;
  return (
    <section className="card col">
      <div className="card-h"><span className="h3">{t("v2.personal.profile.pinTitle")}</span></div>
      <div className="li" style={{ minHeight: 56 }}>
        <span className="col grow">
          <span>{d.pin_verified ? t("v2.personal.profile.pinOpen") : t("v2.personal.profile.pinClosed")}</span>
          <span className="xs c3">
            {d.pin_verified && d.expires_at
              ? t("v2.personal.profile.pinExpires", { time: hhmm(d.expires_at) })
              : t("v2.personal.profile.pinClosedHint")}
          </span>
        </span>
        <span className={cx("badge", d.pin_verified ? "b-ok" : "")}><i className="dot" />{d.pin_verified ? t("v2.personal.profile.pinOpenShort") : t("v2.personal.profile.pinClosedShort")}</span>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Interface: theme, language, sound, daily analysis, sticker, design   */
/* ------------------------------------------------------------------ */

function Seg<V extends string>({ value, items, onChange, label }: { value: V; items: { value: V; label: ReactNode }[]; onChange: (v: V) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {items.map((it) => (
        <button key={it.value} type="button" className={cx(value === it.value && "is-on")} aria-pressed={value === it.value} onClick={() => value !== it.value && onChange(it.value)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button className={cx("switch", on && "is-on")} type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} style={disabled ? { opacity: 0.6 } : undefined}>
      <i />
    </button>
  );
}

function InterfaceCard({ isOp }: { isOp: boolean }) {
  const t = useT2();
  const theme = useTheme();
  const lang = useLang();
  const sound = useSaleSound();
  const design = useDesign();
  const prefs = useMyPreferences(isOp);
  const upd = useUpdateDailyLesson();
  const sticker = useMySticker(isOp);
  const [daily, setDaily] = useState(true);
  const [stickerOpen, setStickerOpen] = useState(false);
  useEffect(() => {
    if (prefs.data) setDaily(!prefs.data.daily_lesson_opt_out);
  }, [prefs.data]);

  const setDailyPref = (next: boolean) => {
    setDaily(next);
    upd.mutate(next, {
      onSuccess: () => toast.success(t("profile.saved")),
      onError: () => {
        setDaily(!next);
        toast.error(t("profile.settings_save_failed"));
      },
    });
  };

  const st = sticker.data?.sticker;
  return (
    <section className="card col">
      <div className="card-h"><span className="h3">{t("v2.personal.profile.interface")}</span></div>
      <div className="li" style={{ minHeight: 60 }}>
        <span className="col grow"><span>{t("profile.theme")}</span><span className="xs c3">{t("v2.personal.profile.themeHint")}</span></span>
        <Seg label={t("profile.theme")} value={theme.theme} onChange={(v) => theme.set(v)} items={[{ value: "light", label: t("profile.theme_light") }, { value: "dark", label: t("profile.theme_dark") }]} />
      </div>
      <div className="li" style={{ minHeight: 60 }}>
        <span className="col grow"><span>{t("profile.language")}</span><span className="xs c3">{t("v2.personal.profile.langHint")}</span></span>
        <Seg
          label={t("profile.language")}
          value={lang.lang}
          onChange={(v) => {
            lang.set(v);
            toast.success(t("profile.lang_switched"));
          }}
          items={[{ value: "ru", label: t("profile.lang_ru") }, { value: "uz", label: t("profile.lang_uz") }]}
        />
      </div>
      <div className="li" style={{ minHeight: 60 }}>
        <span className="col grow"><span>{t("v2.personal.profile.design")}</span><span className="xs c3">{t("v2.personal.profile.designHint")}</span></span>
        <Seg label={t("v2.personal.profile.design")} value={design.design} onChange={(v) => design.set(v)} items={[{ value: "v2", label: t("v2.personal.profile.designNew") }, { value: "v1", label: t("v2.personal.profile.designOld") }]} />
      </div>
      <div className="li" style={{ minHeight: 60 }}>
        <span className="col grow"><span>{t("v2.personal.profile.sound")}</span><span className="xs c3">{t("v2.personal.profile.soundHint")}</span></span>
        <Switch on={!sound.muted} onChange={(on) => sound.set(!on)} label={t("v2.personal.profile.sound")} />
      </div>
      {isOp ? (
        <div className="li" style={{ minHeight: 60 }}>
          <span className="col grow"><span>{t("profile.daily_analysis")}</span><span className="xs c3">{t("profile.daily_analysis_hint")}</span></span>
          <Switch on={daily} onChange={setDailyPref} label={t("profile.daily_analysis")} disabled={prefs.isLoading || upd.isPending} />
        </div>
      ) : null}
      {isOp ? (
        <div className="li" style={{ minHeight: 60 }}>
          <span className="col grow"><span>{t("profile.my_sticker")}</span><span className="xs c3">{st ? t("profile.sticker_shown_next_to_name") : t("profile.sticker_none")}</span></span>
          {st ? <span style={{ fontSize: 22, lineHeight: 1 }}>{st.emoji}</span> : null}
          <button className="btn btn-sm" type="button" onClick={() => setStickerOpen(true)}>{st ? t("common.edit") : t("common.select")}</button>
        </div>
      ) : null}
      {stickerOpen ? <StickerDialog current={st?.emoji ?? null} onClose={() => setStickerOpen(false)} /> : null}
    </section>
  );
}

function StickerDialog({ current, onClose }: { current: string | null; onClose: () => void }) {
  const t = useT2();
  const palette = useStickerPalette(true);
  const setM = useSetMySticker();
  const clear = useClearMySticker();
  const [sel, setSel] = useState<string | null>(current);
  const [error, setError] = useState("");
  const taken = new Map<string, string>();
  (palette.data?.taken ?? []).forEach((x) => taken.set(x.emoji, x.operator_name));
  const busy = setM.isPending || clear.isPending;

  const choose = () => {
    if (!sel) return;
    setError("");
    setM.mutate(sel, {
      onSuccess: () => {
        toast.success(t("profile.saved"));
        onClose();
      },
      onError: (e) => setError(apiErrorMessage(e)),
    });
  };
  const remove = () => {
    setError("");
    clear.mutate(undefined, { onSuccess: onClose, onError: (e) => setError(apiErrorMessage(e)) });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={520}
      title={t("profile.my_sticker")}
      footer={
        <>
          {current ? <button className="btn btn-ghost" type="button" onClick={remove} disabled={busy} style={{ marginRight: "auto" }}>{t("v2.personal.profile.stickerRemove")}</button> : null}
          <button className="btn" type="button" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-pri" type="button" onClick={choose} disabled={busy || !sel || sel === current}>{t("common.select")}</button>
        </>
      }
    >
      {palette.isLoading ? (
        <LoadingBlock rows={2} />
      ) : palette.isError ? (
        <ErrorState error={palette.error} onRetry={() => palette.refetch()} />
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(44px, 1fr))", gap: 6, maxHeight: 320, overflowY: "auto", padding: 2 }}>
            {(palette.data?.palette ?? []).map((emoji) => {
              const owner = taken.get(emoji);
              const disabled = !!owner && emoji !== current;
              return (
                <button
                  key={emoji}
                  type="button"
                  className={cx("btn", sel === emoji && "pick-on")}
                  disabled={disabled || busy}
                  title={disabled ? t("v2.personal.profile.stickerTaken", { name: owner ?? "" }) : emoji === current ? t("v2.personal.profile.stickerCurrent") : t("v2.personal.profile.stickerFree")}
                  onClick={() => setSel(emoji)}
                  style={{ height: 44, padding: 0, fontSize: 20, opacity: disabled ? 0.35 : 1 }}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
          <span className="hint" style={{ display: "block", marginTop: 8 }}>{t("v2.personal.profile.stickerHint")}</span>
        </>
      )}
      {error ? <span className="err" style={{ display: "block", marginTop: 8 }}>{error}</span> : null}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Telegram bot linking (all roles)                                     */
/* ------------------------------------------------------------------ */

function TelegramBotCard({ me, refetchMe }: { me: ProfileMe; refetchMe: () => void }) {
  const t = useT2();
  const confirm = useConfirm();
  const gen = useTgBotLinkCode();
  const unlink = useTgBotUnlink();
  const invalidateMe = useInvalidateMe();
  const linked = !!me.telegram_user_id;
  const [code, setCode] = useState<{ code: string; expires_at: string; bot: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const waiting = !!code && !linked;
  const now = useNow(1000, waiting);

  // While waiting for /link in the bot: poll /auth/me so the card flips by itself.
  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(() => refetchMe(), 4000);
    return () => window.clearInterval(id);
  }, [waiting, refetchMe]);

  const wasWaiting = useRef(false);
  useEffect(() => {
    if (linked && wasWaiting.current) {
      toast.success(t("profile.telegram_linked"));
      setCode(null);
      invalidateMe();
    }
    wasWaiting.current = waiting;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, waiting]);

  const getCode = () =>
    gen.mutate(undefined, {
      onSuccess: (d) => setCode({ code: d.code, expires_at: d.expires_at, bot: d.bot_username || "naffai_bot" }),
      onError: (e) => toast.error(apiErrorMessage(e)),
    });

  const doUnlink = async () => {
    const ok = await confirm({ title: t("v2.personal.profile.tgUnlinkQ"), body: t("v2.personal.profile.tgUnlinkBody"), confirm: t("profile.tg_notif_unlink"), danger: true });
    if (!ok) return;
    unlink.mutate(undefined, {
      onSuccess: () => {
        setCode(null);
        refetchMe();
        toast.success(t("profile.tg_notif_unlinked"));
      },
      onError: (e) => toast.error(apiErrorMessage(e)),
    });
  };

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(`/link ${code.code}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const left = code ? Math.max(0, Math.floor((new Date(code.expires_at).getTime() - now) / 1000)) : 0;
  const expired = !!code && left <= 0;
  const mmss = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;

  return (
    <section className="card col">
      <div className="card-h">
        <span className="h3">{t("profile.tg_notif_title")}</span>
        {linked ? (
          <span className="badge b-ok"><i className="dot" />{t("v2.personal.profile.tgLinked")}</span>
        ) : waiting && !expired ? (
          <span className="badge b-warn"><i className="dot" />{t("v2.personal.profile.tgWaiting")}</span>
        ) : (
          <span className="badge"><i className="dot" />{t("v2.personal.profile.tgNotLinked")}</span>
        )}
      </div>
      <div className="col g12" style={{ padding: "16px 20px 20px" }}>
        {linked ? (
          <div className="row g12">
            <span className="icon-tile t-ok"><Check className="ic" /></span>
            <span className="col grow">
              <span className="s w6">{t("profile.tg_notif_active")}</span>
              <span className="num xs c3">chat_id: {me.telegram_user_id}</span>
            </span>
            <button className="btn btn-bad btn-sm" type="button" onClick={doUnlink} disabled={unlink.isPending}>{t("profile.tg_notif_unlink")}</button>
          </div>
        ) : (
          <>
            <span className="s c3">{t("profile.tg_notif_hint")}</span>
            {code && !expired ? (
              <div className="well col g12" style={{ borderColor: "var(--brand)" }}>
                <div className="row g12 wrap">
                  <span className="num grow" style={{ fontSize: 26, fontWeight: 700, letterSpacing: ".18em" }}>{code.code}</span>
                  <button className="btn btn-sm" type="button" onClick={copy}>
                    {copied ? <Check className="ic ic-s" /> : <Copy className="ic ic-s" />}
                    {copied ? t("common.copied") : t("common.copy")}
                  </button>
                </div>
                <div className="col g6 s">
                  <span className="row g8 wrap">
                    <span className="rank" style={{ width: 22, height: 22, fontSize: 11 }}>1</span>
                    {t("profile.tg_notif_step1")}{" "}
                    <a className="num c-brand w6" href={`https://t.me/${code.bot}`} target="_blank" rel="noopener noreferrer">@{code.bot}</a>
                  </span>
                  <span className="row g8 wrap">
                    <span className="rank" style={{ width: 22, height: 22, fontSize: 11 }}>2</span>
                    {t("profile.tg_notif_step2")}{" "}
                    <span className="num w6" style={{ padding: "2px 6px", borderRadius: 5, background: "var(--surface-3)" }}>/link {code.code}</span>
                  </span>
                </div>
                <div className="row between xs c3 wrap g8">
                  <span className="row g6"><RefreshCw className="ic ic-s" />{t("v2.personal.profile.tgWaitingBot")}</span>
                  <span>{t("v2.personal.profile.tgCodeLeft")} <span className="num">{mmss}</span></span>
                </div>
                <span className="xs c-warn">{t("profile.tg_notif_expires")}</span>
              </div>
            ) : null}
            {expired ? <div className="banner b-warn"><span>{t("v2.personal.profile.tgCodeExpired")}</span></div> : null}
            <div className="row g8">
              <button className={cx("btn btn-sm", code && !expired ? "btn-ghost" : "")} type="button" onClick={getCode} disabled={gen.isPending}>
                <Send className="ic ic-s" />
                {gen.isPending ? t("common.loading") : code ? t("v2.personal.profile.tgNewCode") : t("profile.tg_notif_get_code")}
              </button>
            </div>
          </>
        )}
      </div>
      {confirm.node}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Telegram account (userclient, operator)                              */
/* ------------------------------------------------------------------ */

function TelegramAccountCard() {
  const t = useT2();
  const confirm = useConfirm();
  const st = useTgUserStatus(true);
  const revoke = useTgUserRevoke();
  const [wizard, setWizard] = useState(false);
  const d = st.data;
  const job = d?.latest_backfill_job;

  const disconnect = async () => {
    if (!d?.session_id) return;
    const ok = await confirm({ title: t("v2.personal.profile.tgAccDisconnectQ"), body: t("v2.personal.profile.tgAccDisconnectBody"), confirm: t("profile.tg_disconnect"), danger: true });
    if (!ok) return;
    revoke.mutate(d.session_id, {
      onSuccess: () => {
        st.refetch();
        toast.success(t("profile.tg_disconnected"));
      },
      onError: (e) => toast.error(apiErrorMessage(e)),
    });
  };

  return (
    <section className="card col">
      <div className="card-h">
        <span className="h3">{t("v2.personal.profile.tgAccTitle")}</span>
        {d?.status === "active" ? <span className="badge b-ok"><i className="dot" />{t("profile.tg_connected")}</span> : d?.status === "error" ? <span className="badge b-bad"><i className="dot" />{t("v2.personal.profile.tgAccError")}</span> : null}
      </div>
      <div className="col g12" style={{ padding: "16px 20px 20px" }}>
        <span className="s c3">{t("profile.tg_hint")}</span>
        {st.isLoading ? (
          <span className="s c3">{t("profile.tg_checking")}</span>
        ) : st.isError ? (
          <ErrorState error={st.error} onRetry={() => st.refetch()} />
        ) : d?.status === "active" ? (
          <>
            <span className="s c2">
              <span className="num">@{d.tg_username}</span>
              {d.last_connected_at ? <> · {new Date(d.last_connected_at).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}</> : null}
            </span>
            {job ? (
              <span className={cx("xs", job.status === "error" ? "c-bad" : job.status === "done" ? "c3" : "c-brand")}>
                {job.status === "running"
                  ? t("profile.tg_backfill_running", { chats: job.chats_scanned, msgs: job.messages_saved })
                  : job.status === "pending"
                    ? t("profile.tg_backfill_pending")
                    : job.status === "done"
                      ? t("profile.tg_backfill_done", { chats: job.chats_scanned, msgs: job.messages_saved })
                      : job.last_error}
              </span>
            ) : null}
            <button className="btn btn-bad btn-sm" type="button" style={{ alignSelf: "flex-start" }} onClick={disconnect} disabled={revoke.isPending}>{t("profile.tg_disconnect")}</button>
          </>
        ) : d?.status === "error" ? (
          <>
            <div className="banner b-bad"><span>{d.last_error || t("profile.tg_unknown_error")}</span></div>
            <button className="btn btn-sm" type="button" style={{ alignSelf: "flex-start" }} onClick={() => setWizard(true)}>{t("profile.tg_reconnect")}</button>
          </>
        ) : (
          <button className="btn btn-pri btn-sm" type="button" style={{ alignSelf: "flex-start" }} onClick={() => setWizard(true)}>{t("profile.tg_connect")}</button>
        )}
      </div>
      {wizard ? <TgConnectDialog onClose={() => setWizard(false)} onSuccess={() => st.refetch()} /> : null}
      {confirm.node}
    </section>
  );
}

function TgConnectDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const t = useT2();
  const qc = useQueryClient();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [digits, setDigits] = useState("");
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const phone = normalizeUzPhone(digits);

  const done = () => {
    qc.invalidateQueries({ queryKey: TG_STATUS_KEY() });
    onSuccess();
    onClose();
    toast.success(t("tg.connect_success"));
  };

  const run = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    if (!consent) {
      setError(t("tg.connect_consent_required"));
      return;
    }
    void run(async () => {
      const res = await tgStart(phone.canonical, consent);
      setSessionId(res.data.session_id);
      setStep(2);
    });
  };
  const verifyCode = () =>
    sessionId &&
    void run(async () => {
      const res = await tgVerifyCode(sessionId, code);
      if (res.data.status === "pending_2fa") setStep(3);
      else done();
    });
  const verifyPwd = () =>
    sessionId &&
    void run(async () => {
      const res = await tgVerifyPassword(sessionId, password);
      if (res.data.status === "active") done();
    });

  const titles = { 1: t("v2.personal.profile.tgStepPhone"), 2: t("tg.connect_step_code_title"), 3: t("tg.connect_step_2fa_title") };
  const back = (s: 1 | 2) => {
    setError("");
    setStep(s);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={460}
      title={titles[step]}
      sub={t("tg.connect_step_label", { n: step })}
      footer={
        step === 1 ? (
          <>
            <button className="btn" type="button" onClick={onClose}>{t("common.cancel")}</button>
            <button className="btn btn-pri" type="button" onClick={start} disabled={!phone.valid || !consent || busy}>{busy ? t("tg.connect_sending") : t("tg.connect_send_code")}</button>
          </>
        ) : step === 2 ? (
          <>
            <button className="btn" type="button" onClick={() => back(1)}>{t("common.back")}</button>
            <button className="btn btn-pri" type="button" onClick={verifyCode} disabled={!code || busy}>{busy ? t("tg.connect_checking") : t("tg.connect_verify")}</button>
          </>
        ) : (
          <>
            <button className="btn" type="button" onClick={() => back(2)}>{t("common.back")}</button>
            <button className="btn btn-pri" type="button" onClick={verifyPwd} disabled={!password || busy}>{busy ? t("tg.connect_checking") : t("tg.connect_finish")}</button>
          </>
        )
      }
    >
      <div className="col g12">
        {step === 1 ? (
          <>
            <div className="field">
              <label htmlFor="tg-phone">{t("tg.connect_phone_label")}</label>
              <div className="row g8">
                <span className="pfx" style={{ height: 40, fontSize: 14, borderRadius: 9 }} aria-hidden="true">+998</span>
                <input
                  id="tg-phone"
                  className={cx("input num grow", digits.length > 0 && !phone.valid && "is-bad")}
                  type="tel"
                  inputMode="numeric"
                  autoFocus
                  placeholder="90 123 45 67"
                  value={digits}
                  onChange={(e) => setDigits(e.target.value.replace(/\D+/g, "").slice(0, 9))}
                />
              </div>
            </div>
            <label className="row g8 s" style={{ alignItems: "flex-start", cursor: "pointer" }}>
              <input className="check" type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 2 }} />
              <span>{t("tg.connect_consent_text")}</span>
            </label>
          </>
        ) : step === 2 ? (
          <>
            <span className="s c3">{t("tg.connect_code_hint", { phone: phone.canonical })}</span>
            <div className="field">
              <label htmlFor="tg-code">{t("tg.connect_code_label")}</label>
              <input id="tg-code" className={cx("input num", error && "is-bad")} inputMode="numeric" autoFocus placeholder="12345" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
          </>
        ) : (
          <>
            <span className="s c3">{t("tg.connect_2fa_hint")}</span>
            <div className="field">
              <label htmlFor="tg-2fa">{t("tg.connect_2fa_label")}</label>
              <input id="tg-2fa" className={cx("input", error && "is-bad")} type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </>
        )}
        {error ? <span className="err">{error}</span> : null}
      </div>
    </Dialog>
  );
}
