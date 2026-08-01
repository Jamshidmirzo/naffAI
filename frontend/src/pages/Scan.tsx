import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, Download, LogIn, RefreshCw, XCircle } from "lucide-react";
import qrcode from "qrcode-generator";
import { Button, Eyebrow } from "../components/ui";
import { useAttendanceScan, type ScanResponse } from "../hooks/useAttendanceScan";
import { apiErrorMessage } from "../lib/api-types";

/**
 * Two-mode screen:
 *
 * 1. **Check-in mode** — the URL carries `?qr=<hmac-token>` (a phone camera
 *    just decoded an operator's QR). We POST to `/attendance/scan/`,
 *    show "checked in" or "checked out", and (on check_in) redirect the
 *    operator into their own workstation with a freshly-issued token.
 *
 * 2. **Kiosk mode** — no `?qr=`. Renders a public QR that opens the login
 *    page on the operator's phone.
 */

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
      if (qr.isDark(r, c)) {
        ctx.fillRect(
          (c + QR_MARGIN) * QR_CELL,
          (r + QR_MARGIN) * QR_CELL,
          QR_CELL,
          QR_CELL,
        );
      }
    }
  }
}

export default function Scan() {
  const [search] = useSearchParams();
  const qrPayload = search.get("qr");
  if (qrPayload) return <CheckInMode qrPayload={qrPayload} />;
  return <KioskMode />;
}

function CheckInMode({ qrPayload }: { qrPayload: string }) {
  const { scan } = useAttendanceScan();
  const nav = useNavigate();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "success"; data: ScanResponse }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    scan(qrPayload)
      .then((data) => {
        if (!alive) return;
        setState({ kind: "success", data });
        // On check-in the hook stored a fresh auth token — send the
        // operator into their workstation after a short "success" beat.
        if (data.action === "check_in" && data.token) {
          setTimeout(() => nav("/my"), 1400);
        }
      })
      .catch((err) => {
        if (!alive) return;
        setState({ kind: "error", message: apiErrorMessage(err) });
      });
    return () => {
      alive = false;
    };
    // qrPayload is stable per URL — intentionally ignoring `scan`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrPayload]);

  return (
    <div className="min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 nf-hero" />
      <div className="relative z-10 min-h-screen grid place-items-center px-4 py-10">
        <div
          className="animate-nfPop text-center"
          style={{
            width: 420,
            maxWidth: "100%",
            borderRadius: 34,
            padding: "36px 32px 32px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            boxShadow: "0 40px 90px -40px rgba(0,0,0,.4)",
          }}
        >
          <Eyebrow>QR CHECK-IN</Eyebrow>
          {state.kind === "loading" && (
            <>
              <h1
                className="font-semibold mt-3"
                style={{ fontSize: 24, letterSpacing: "-0.025em" }}
              >
                Отмечаем…
              </h1>
              <p className="text-[13px] text-muted mt-2">
                Секунду, проверяем ваш QR
              </p>
            </>
          )}
          {state.kind === "success" && (() => {
            const isIn = state.data.action === "check_in";
            const bg = isIn ? "rgba(34,197,94,.16)" : "rgba(59,130,246,.16)";
            const fg = isIn ? "#16a34a" : "#2563eb";
            const iso = isIn ? state.data.checked_in_at : state.data.checked_out_at;
            const timeText = iso
              ? new Date(iso).toLocaleTimeString("ru-RU", {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "";
            return (
              <>
                <div
                  className="mt-4 mx-auto grid place-items-center animate-nfPop"
                  style={{
                    width: 96,
                    height: 96,
                    borderRadius: 999,
                    background: bg,
                  }}
                >
                  <CheckCircle2 className="w-14 h-14" style={{ color: fg }} />
                </div>
                <div
                  className="mt-5 mx-auto text-[11px] font-bold uppercase tracking-widest"
                  style={{ color: fg }}
                >
                  {isIn ? "✅ ПРИХОД" : "🏁 УХОД"}
                </div>
                <h1
                  className="font-bold mt-1"
                  style={{ fontSize: 28, letterSpacing: "-0.025em" }}
                >
                  {state.data.operator.full_name}
                </h1>
                {timeText && (
                  <div
                    className="mt-2 text-[18px] font-semibold tabular-nums"
                    style={{ color: "var(--muted)" }}
                  >
                    {timeText}
                  </div>
                )}
                {state.data.was_late && isIn && (
                  <div
                    className="mt-3 inline-block rounded-full px-3 py-1 text-[12px] font-semibold"
                    style={{
                      background: "rgba(220,38,38,.14)",
                      color: "#dc2626",
                    }}
                  >
                    ⚠ ОПОЗДАНИЕ
                  </div>
                )}
                {!isIn && state.data.duration_min ? (
                  <div className="mt-3 text-[13.5px] text-muted">
                    Смена: <b className="text-text">{Math.round(state.data.duration_min / 60 * 10) / 10} ч</b>
                    <span className="opacity-60"> · {state.data.duration_min} мин</span>
                  </div>
                ) : null}
                {isIn && state.data.token && (
                  <p className="mt-4 text-[12px] text-muted">
                    Открываем ваш кабинет…
                  </p>
                )}
                {!isIn && (
                  <div className="mt-6">
                    <Link to="/login" className="nf-btn nf-btn--primary" style={{ padding: "10px 18px" }}>
                      На главную
                    </Link>
                  </div>
                )}
              </>
            );
          })()}
          {state.kind === "error" && (
            <>
              <div className="mt-4 mx-auto grid place-items-center" style={{ width: 72, height: 72, borderRadius: 999, background: "rgba(220,60,40,.14)" }}>
                <XCircle className="w-9 h-9" style={{ color: "var(--danger)" }} />
              </div>
              <h1
                className="font-semibold mt-4"
                style={{ fontSize: 22, letterSpacing: "-0.025em" }}
              >
                QR не сработал
              </h1>
              <p className="text-[13px] text-muted mt-2 max-w-[320px] mx-auto">
                {state.message ||
                  "Попросите менеджера сгенерировать новый QR — старый мог быть отозван."}
              </p>
              <div className="mt-6 flex flex-wrap gap-2 justify-center">
                <Link to="/login" className="nf-btn nf-btn--primary" style={{ padding: "10px 18px" }}>
                  Войти по паролю
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function KioskMode() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [tick, setTick] = useState(0);

  const target = useMemo(() => {
    if (typeof window === "undefined") return "https://naffai.uz/login";
    return `${window.location.origin}/login?src=qr`;
  }, []);

  useEffect(() => {
    if (canvasRef.current) renderQrToCanvas(canvasRef.current, target);
  }, [target, tick]);

  const downloadPng = () => {
    if (!canvasRef.current) return;
    const url = canvasRef.current.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = "naffai-qr.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 nf-hero" />

      <div className="absolute top-6 right-6 z-10">
        <Link
          to="/login"
          className="nf-btn nf-btn--ghost text-[13px]"
          style={{ padding: "9px 14px" }}
        >
          <LogIn className="w-3.5 h-3.5" /> Войти по паролю
        </Link>
      </div>

      <div className="relative z-10 min-h-screen grid place-items-center px-4 py-10">
        <div
          className="animate-nfPop text-center"
          style={{
            width: 420,
            maxWidth: "100%",
            borderRadius: 34,
            padding: "36px 32px 32px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            boxShadow: "0 40px 90px -40px rgba(0,0,0,.4)",
          }}
        >
          <Eyebrow>QR CHECK-IN</Eyebrow>
          <h1
            className="font-semibold mt-2"
            style={{ fontSize: 26, letterSpacing: "-0.025em", lineHeight: 1.15 }}
          >
            Отсканируйте QR
            <br />
            своим телефоном
          </h1>
          <p className="text-[13px] text-muted mt-2 max-w-[280px] mx-auto">
            Откроется вход в систему. Войдите под своим логином и отметьте начало смены.
          </p>

          <div
            className="mt-6 mx-auto grid place-items-center"
            style={{
              width: 260,
              height: 260,
              borderRadius: 24,
              background: "#fff",
              padding: 14,
              border: "1px solid var(--border)",
            }}
          >
            <canvas
              ref={canvasRef}
              style={{ width: "100%", height: "100%", imageRendering: "pixelated" }}
              aria-label="QR-код для входа"
            />
          </div>

          <div
            className="mt-4 text-[11.5px] text-muted rounded-xl px-3 py-2"
            style={{ background: "var(--faint)" }}
          >
            Ссылка: <span className="font-mono text-text">{target}</span>
          </div>

          <div className="mt-5 flex flex-wrap gap-2 justify-center">
            <Button variant="secondary" onClick={downloadPng}>
              <Download className="w-3.5 h-3.5" /> Скачать PNG
            </Button>
            <Button variant="ghost" onClick={() => setTick((v) => v + 1)}>
              <RefreshCw className="w-3.5 h-3.5" /> Перерисовать
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
