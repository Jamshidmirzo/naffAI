import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Download, LogIn, RefreshCw } from "lucide-react";
import qrcode from "qrcode-generator";
import { Button, Eyebrow } from "../components/ui";

/**
 * Public kiosk screen shown at the office entrance. It renders a QR that
 * points to the login page — operators scan it with their own phone
 * camera, land in the web app on the phone, and mark check-in from there.
 *
 * No browser camera permission is needed here — the phone does the
 * scanning; the kiosk just displays the code.
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
