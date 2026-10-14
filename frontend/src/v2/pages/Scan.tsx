import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import qrcode from "qrcode-generator";
import { AlertTriangle, Camera, Check, Clock, Download, LogIn, LogOut, RefreshCw, X } from "lucide-react";
import { API_BASE_URL } from "../../lib/api";
import { apiErrorMessage } from "../../lib/api-types";
import { useAuth } from "../../store/auth";
import { useTheme } from "../../store/theme";
import CameraCapture from "../../components/CameraCapture";
import { useT2 } from "../i18n";
import { LoadingBlock } from "../ui";
import { fetchQrPreview, postScanWithPhoto, type QrPreview, type ScanResult } from "../api/personal";

/**
 * /scan — public, outside the shell.
 *   /scan?qr=<token> → selfie check-in / check-out (old ScanPhotoFlow).
 *   /scan            → poster with a generic QR (old KioskMode).
 */
export default function Scan() {
  const [search] = useSearchParams();
  const theme = useTheme((s) => s.theme);
  const qr = search.get("qr");
  return (
    <div
      className="nf"
      data-theme={theme}
      style={{
        minHeight: "100dvh",
        background: "var(--bg)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        padding: "max(env(safe-area-inset-top), 20px) 16px max(env(safe-area-inset-bottom), 20px)",
      }}
    >
      <div style={{ width: 420, maxWidth: "100%", marginTop: "clamp(0px, 6vh, 64px)" }}>{qr ? <PhotoFlow qr={qr} /> : <Poster />}</div>
    </div>
  );
}

function Card({ children, center }: { children: ReactNode; center?: boolean }) {
  return (
    <section className="card col" style={{ overflow: "hidden" }}>
      <div className="col g16" style={{ padding: 24, ...(center ? { alignItems: "center", textAlign: "center" } : {}) }}>
        {children}
      </div>
    </section>
  );
}

const TZ = "Asia/Tashkent";

/** DRF ValidationError lists come through as «['text']» — show just the text. */
function cleanMsg(err: unknown) {
  const m = apiErrorMessage(err);
  const inner = /^\[\s*['"](.+?)['"]\s*\]$/.exec(m.trim());
  return inner ? inner[1] : m;
}

function fmtTime(iso?: string | null) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
  } catch {
    return "";
  }
}

function PhotoFlow({ qr }: { qr: string }) {
  const t = useT2();
  const setAuth = useAuth((s) => s.setAuth);
  const [preview, setPreview] = useState<QrPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setPreviewError("");
    fetchQrPreview(qr)
      .then((d) => alive && setPreview(d))
      .catch((e) => alive && setPreviewError(cleanMsg(e)));
    return () => {
      alive = false;
    };
  }, [qr]);

  // Success card closes itself after ~4 s (as before), ready for the next scan.
  useEffect(() => {
    if (!result) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setResult(null), 4200);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [result]);

  const submitPhoto = async (file: File) => {
    if (pending) return; // guard against double-tap
    setPending(true);
    setError("");
    try {
      const data = await postScanWithPhoto(qr, file);
      // Backend may issue a token on check-in — cache it like the old flow.
      if (data.action === "check_in" && data.token && data.username && data.role) {
        setAuth(data.token, data.username, data.role);
      }
      setResult(data);
      try {
        setPreview(await fetchQrPreview(qr));
      } catch {
        /* ignore */
      }
    } catch (e) {
      setError(cleanMsg(e));
    } finally {
      setPending(false);
      setCameraOpen(false);
    }
  };

  if (previewError) {
    return (
      <Card center>
        <span className="icon-tile t-bad" style={{ width: 64, height: 64, borderRadius: 18 }}>
          <X className="ic ic-xl" />
        </span>
        <h1 className="display" style={{ fontSize: 20, lineHeight: "28px" }}>{t("scan_photo.error_title")}</h1>
        <p className="s c2">{previewError}</p>
        <Link className="btn btn-pri btn-block" to="/login">{t("scan_photo.login_fallback")}</Link>
      </Card>
    );
  }

  if (!preview) {
    return (
      <section className="card">
        <LoadingBlock rows={3} />
      </section>
    );
  }

  if (result) return <Success result={result} onDone={() => setResult(null)} />;

  const isCheckIn = preview.expected_action !== "check_out";
  return (
    <>
      <Card>
        <span className="lbl" style={{ color: isCheckIn ? "var(--brand-text)" : "var(--hot)" }}>
          {isCheckIn ? t("v2.personal.scan.lblIn") : t("v2.personal.scan.lblOut")}
        </span>
        <h1 className="display" style={{ fontSize: 22, lineHeight: "30px" }}>{preview.operator.full_name}</h1>
        {!isCheckIn ? <span className="badge b-hot" style={{ alignSelf: "flex-start" }}>{t("scan.checkout_confirm_title")}</span> : null}
        {preview.on_shift && preview.checked_in_at ? (
          <span className="row g6 s c3">
            <Clock className="ic ic-s" />
            {t("scan_photo.on_shift_since", { t: fmtTime(preview.checked_in_at) })}
          </span>
        ) : null}
        <p className="s c2">
          {isCheckIn ? t("scan_photo.step_take_selfie_in") : t("scan_photo.step_take_selfie_out")}. {t("scan_photo.face_required_hint")}
        </p>
        <div className="ph" style={{ aspectRatio: "3 / 4", width: "100%", maxHeight: "42vh" }} aria-hidden>
          <Camera className="ic ic-xl" />
          {t("v2.personal.scan.cameraHere")}
        </div>
        {error ? (
          <div className="banner b-bad" role="alert">
            <AlertTriangle className="ic" />
            <span>{error}</span>
          </div>
        ) : null}
        {pending ? <span className="s c3" aria-live="polite">{t("scan_photo.uploading")}</span> : null}
        <button
          className={isCheckIn ? "btn btn-ok btn-lg btn-block" : "btn btn-lg btn-block"}
          style={isCheckIn ? undefined : { background: "var(--hot-solid)", borderColor: "var(--hot-solid)", color: "#fff" }}
          type="button"
          disabled={pending}
          onClick={() => {
            setError("");
            setCameraOpen(true);
          }}
        >
          {isCheckIn ? <LogIn className="ic" /> : <LogOut className="ic" />}
          {error ? t("v2.personal.scan.retry") : isCheckIn ? t("scan_photo.open_camera_in") : t("scan_photo.open_camera_out")}
        </button>
        <Link className="btn btn-ghost btn-block" to="/login">{t("scan_photo.login_fallback")}</Link>
      </Card>
      {cameraOpen ? <CameraCapture onCapture={(f) => submitPhoto(f)} onCancel={() => setCameraOpen(false)} /> : null}
    </>
  );
}

function Success({ result, onDone }: { result: ScanResult; onDone: () => void }) {
  const t = useT2();
  const isIn = result.action === "check_in";
  const time = fmtTime(isIn ? result.checked_in_at : result.checked_out_at);
  const mins = result.duration_min ?? 0;
  const dur = mins > 0 ? (mins >= 60 ? t("v2.personal.scan.durHM", { h: Math.floor(mins / 60), m: mins % 60 }) : t("v2.personal.scan.durM", { m: mins })) : "";
  const photoUrl = result.photo_url
    ? result.photo_url.startsWith("http")
      ? result.photo_url
      : `${API_BASE_URL.replace(/\/api$/, "")}${result.photo_url}`
    : null;
  return (
    <Card center>
      <span className={isIn ? "icon-tile t-ok" : "icon-tile t-hot"} style={{ width: 64, height: 64, borderRadius: 18 }}>
        <Check className="ic ic-xl" />
      </span>
      <span className="lbl" style={{ color: isIn ? "var(--ok)" : "var(--hot)" }}>{isIn ? t("v2.personal.scan.doneIn") : t("v2.personal.scan.doneOut")}</span>
      <span className="h3">{result.operator.full_name}</span>
      <h1 className="display" style={{ fontSize: 22, lineHeight: "30px" }} aria-live="polite">
        {isIn ? t("scan_photo.checkin_at", { t: time }) : t("scan_photo.checkout_at", { t: time })}
      </h1>
      {isIn ? (
        <span className={result.was_late ? "badge b-bad" : "badge b-ok"}>{result.was_late ? t("v2.personal.scan.late") : t("v2.personal.scan.onTime")}</span>
      ) : dur ? (
        <span className="s c2">{t("scan_photo.duration_label", { d: dur })}</span>
      ) : null}
      {photoUrl ? <img src={photoUrl} alt={t("v2.personal.scan.selfie")} style={{ width: 120, height: 150, objectFit: "cover", borderRadius: 11, border: "1px solid var(--line)" }} /> : null}
      <p className="s c3">{t("v2.personal.scan.putAway")}</p>
      <button className="btn btn-block" type="button" onClick={onDone}>{t("common.done")}</button>
    </Card>
  );
}

/* ───────── poster mode (no ?qr=) ───────── */

const QR_CELL = 8;
const QR_MARGIN = 2;

function renderQrToCanvas(canvas: HTMLCanvasElement, text: string) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const size = (count + QR_MARGIN * 2) * QR_CELL;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#101013";
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + QR_MARGIN) * QR_CELL, (r + QR_MARGIN) * QR_CELL, QR_CELL, QR_CELL);
    }
  }
}

function Poster() {
  const t = useT2();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [tick, setTick] = useState(0);
  const target = useMemo(() => (typeof window === "undefined" ? "https://naff.flek.uz/scan" : `${window.location.origin}/scan`), []);

  useEffect(() => {
    if (canvasRef.current) renderQrToCanvas(canvasRef.current, target);
  }, [target, tick]);

  const downloadPng = () => {
    if (!canvasRef.current) return;
    const a = document.createElement("a");
    a.href = canvasRef.current.toDataURL("image/png");
    a.download = "naffai-qr.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <Card center>
      <span className="lbl" style={{ color: "var(--brand-text)" }}>{t("v2.personal.scan.kioskLbl")}</span>
      <h1 className="display" style={{ fontSize: 22, lineHeight: "30px" }}>{t("v2.personal.scan.kioskTitle")}</h1>
      <p className="s c3">{t("v2.personal.scan.kioskBody")}</p>
      <div style={{ width: 260, maxWidth: "100%", aspectRatio: "1 / 1", borderRadius: 16, background: "#fff", padding: 14, border: "1px solid var(--line)" }}>
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", imageRendering: "pixelated" }} aria-label={t("v2.personal.scan.kioskQr")} />
      </div>
      <div className="well xs c3" style={{ padding: "8px 12px", wordBreak: "break-all" }}>
        {t("v2.personal.scan.kioskLink")}: <span className="num" style={{ color: "var(--ink)" }}>{target}</span>
      </div>
      <div className="row g8 wrap" style={{ justifyContent: "center" }}>
        <button className="btn" type="button" onClick={downloadPng}>
          <Download className="ic" />
          {t("v2.personal.scan.download")}
        </button>
        <button className="btn btn-ghost" type="button" onClick={() => setTick((v) => v + 1)}>
          <RefreshCw className="ic" />
          {t("v2.personal.scan.redraw")}
        </button>
      </div>
      <Link className="btn btn-ghost btn-block" to="/login">
        <LogIn className="ic" />
        {t("scan_photo.login_fallback")}
      </Link>
    </Card>
  );
}
