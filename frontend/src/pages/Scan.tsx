import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Download, LogIn, RefreshCw } from "lucide-react";
import qrcode from "qrcode-generator";
import { Button, Eyebrow } from "../components/ui";
import ScanPhotoFlow from "./ScanPhotoFlow";

/**
 * Two-mode entry point:
 *
 * 1. `/scan?qr=<hmac-token>` — the operator opened this URL via their
 *    phone camera QR. Delegate to `ScanPhotoFlow` (photo-first check-in
 *    with face detection + Framer Motion success animation).
 *
 * 2. `/scan` with no `?qr=` param — kiosk poster mode: renders the QR
 *    that opens the scan-photo flow for the operator scanning it. The
 *    QR now embeds `/scan?qr=<token>` (not `/login?src=qr`) — the
 *    dedicated `/kiosk` route below serves the same public poster.
 */
export default function Scan() {
  const [search] = useSearchParams();
  const qrFromUrl = search.get("qr");
  if (qrFromUrl) return <ScanPhotoFlow />;
  return <KioskMode />;
}

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

/**
 * Public poster QR that a Team Lead prints and puts on the wall. It
 * points to `/scan?qr=<individual-operator-token>` — but this generic
 * poster is only useful as an entry-point placeholder. The proper
 * per-operator QR lives on the Operator detail page (dedicated PNG
 * download served by `operator_qr_png_bytes`). This poster is kept for
 * the "here's what a scan link looks like" demo.
 */
function KioskMode() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [tick, setTick] = useState(0);

  const target = useMemo(() => {
    if (typeof window === "undefined") return "https://naff.flek.uz/scan";
    return `${window.location.origin}/scan`;
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
    <div className="min-h-dvh relative overflow-hidden">
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

      <div className="relative z-10 min-h-dvh grid place-items-center px-4 py-10">
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
            Распечатайте свой QR
            <br />
            и наклейте на бейдж
          </h1>
          <p className="text-[13px] text-muted mt-2 max-w-[280px] mx-auto">
            Персональный QR оператора — на странице «Оператор → QR». Ниже — общий
            заглушка-код, ведущий на страницу /scan.
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
