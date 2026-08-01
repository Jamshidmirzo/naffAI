import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  CheckCircle2,
  Download,
  LogIn,
  LogOut,
  PlayCircle,
  RefreshCw,
  XCircle,
} from "lucide-react";
import qrcode from "qrcode-generator";
import { api } from "../lib/api";
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

type OpenLog = {
  id: number;
  checked_in_at: string;
  was_late: boolean;
} | null;

type MeCurrentResp = {
  open_log: OpenLog;
  today_events: Array<{
    id: number;
    checked_in_at: string;
    checked_out_at: string | null;
    was_late: boolean;
  }>;
};

const QR_LS_KEY = "naff_kiosk_qr";

export default function Scan() {
  const [search] = useSearchParams();
  const qrFromUrl = search.get("qr");
  // Persist the last-scanned QR so the operator can toggle check-in/out
  // without rescanning between shifts on the same phone/kiosk device.
  const savedQr = typeof window !== "undefined" ? localStorage.getItem(QR_LS_KEY) : null;
  const qrPayload = qrFromUrl || savedQr;

  useEffect(() => {
    if (qrFromUrl) localStorage.setItem(QR_LS_KEY, qrFromUrl);
  }, [qrFromUrl]);

  if (qrPayload) return <KioskCheckMode qrPayload={qrPayload} initialAuto={!!qrFromUrl} />;
  return <KioskMode />;
}

function fmtDuration(from: string): string {
  const ms = Date.now() - new Date(from).getTime();
  if (ms < 0) return "0 мин";
  const total = Math.floor(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h <= 0) return `${m} мин`;
  return `${h} ч ${m} мин`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Persistent kiosk view: shows current shift state (in/out) and a single
 * big button to toggle. Auto-fires the scan once when the operator lands
 * from a fresh QR (initialAuto), then stays put so they can check-out
 * later without opening the CRM on the phone.
 */
function KioskCheckMode({
  qrPayload,
  initialAuto,
}: {
  qrPayload: string;
  initialAuto: boolean;
}) {
  const { scan } = useAttendanceScan();
  const [current, setCurrent] = useState<MeCurrentResp | null>(null);
  const [lastEvent, setLastEvent] = useState<ScanResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>("");
  const [, tick] = useState(0);
  // Backend enforces a 30 s cooldown between scans per operator; mirror
  // it here so the button visibly ticks down instead of firing a 429.
  const [cooldownUntil, setCooldownUntil] = useState<number>(0);

  // Live tick every 1 s so the shift counter + cooldown update.
  useEffect(() => {
    const id = setInterval(() => tick((v) => v + 1), 1_000);
    return () => clearInterval(id);
  }, []);

  const cooldownLeft = Math.max(
    0,
    Math.ceil((cooldownUntil - Date.now()) / 1000),
  );

  const loadCurrent = useCallback(async () => {
    try {
      const r = await api.get<MeCurrentResp>("/attendance/me/current/");
      setCurrent(r.data);
      return r.data;
    } catch {
      // If token isn't valid yet (before first check-in) OR was just
      // invalidated by check-out — quietly ignore, UI falls back to
      // `lastEvent`.
      setCurrent(null);
      return null;
    }
  }, []);

  const doScan = useCallback(async () => {
    if (Date.now() < cooldownUntil) return;
    setError("");
    setPending(true);
    try {
      const data = await scan(qrPayload);
      setLastEvent(data);
      setCooldownUntil(Date.now() + 30_000);
      // check-out invalidates the token — loadCurrent would 401. Skip
      // it and rely on lastEvent for the closed-shift render.
      if (data.action === "check_in") await loadCurrent();
      else setCurrent({ open_log: null, today_events: [] });
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setPending(false);
    }
  }, [qrPayload, scan, loadCurrent, cooldownUntil]);

  // First mount: always start by loading current state so we know which
  // way to flip. Auto-fire scan ONLY when the operator just landed from
  // a fresh ?qr= URL AND has no open shift — that's the intended
  // "clock-in on scan" flow. If they already have an open shift, show
  // them the "Завершить смену" button and let them tap it deliberately;
  // auto-firing here would silently clock them out on every rescan.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    (async () => {
      const cur = await loadCurrent();
      if (initialAuto && !cur?.open_log) {
        await doScan();
      }
    })();
  }, [initialAuto, doScan, loadCurrent]);

  const openLog = current?.open_log;
  // Prefer `current.open_log` (server truth); if the API is 401'd because
  // of a just-fired check-out, fall back to lastEvent so the UI still
  // reflects reality.
  const isIn = openLog
    ? true
    : lastEvent?.action === "check_in"
      ? true
      : false;

  return (
    <div className="min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 nf-hero" />
      <div className="relative z-10 min-h-screen grid place-items-center px-4 py-6">
        <div
          className="w-full text-center animate-nfPop"
          style={{
            maxWidth: 380,
            borderRadius: 28,
            padding: "28px 24px 24px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            boxShadow: "0 40px 90px -40px rgba(0,0,0,.4)",
          }}
        >
          <Eyebrow>{isIn ? "СМЕНА ИДЁТ" : "СМЕНА ЗАКРЫТА"}</Eyebrow>

          {/* Big status icon */}
          <div
            className="mt-3 mx-auto grid place-items-center animate-nfPop"
            style={{
              width: 108,
              height: 108,
              borderRadius: 999,
              background: isIn ? "rgba(34,197,94,.14)" : "rgba(148,163,184,.14)",
            }}
          >
            {isIn ? (
              <PlayCircle className="w-16 h-16" style={{ color: "#16a34a" }} />
            ) : (
              <LogOut className="w-16 h-16" style={{ color: "#94a3b8" }} />
            )}
          </div>

          {/* Name + shift state */}
          <div
            className="mt-4 text-[24px] font-bold tracking-tight"
            title={lastEvent?.operator.full_name}
          >
            {lastEvent?.operator.full_name || " "}
          </div>

          {isIn && openLog ? (
            <>
              <div className="mt-3 text-[14px]" style={{ color: "var(--muted)" }}>
                Пришёл в{" "}
                <b className="text-text tabular-nums">
                  {fmtTime(openLog.checked_in_at)}
                </b>
                {openLog.was_late && (
                  <span
                    className="ml-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold"
                    style={{
                      background: "rgba(220,38,38,.14)",
                      color: "#dc2626",
                    }}
                  >
                    ⚠ ОПОЗДАНИЕ
                  </span>
                )}
              </div>
              <div className="mt-2 text-[13.5px] text-muted">
                Работает{" "}
                <b className="text-text tabular-nums">
                  {fmtDuration(openLog.checked_in_at)}
                </b>
              </div>
            </>
          ) : lastEvent?.action === "check_out" && lastEvent.checked_out_at ? (
            <div className="mt-3 text-[14px] text-muted">
              Ушёл в{" "}
              <b className="text-text tabular-nums">
                {fmtTime(lastEvent.checked_out_at)}
              </b>
              {lastEvent.duration_min ? (
                <div className="mt-1">
                  Смена:{" "}
                  <b className="text-text">
                    {Math.round(lastEvent.duration_min / 60 * 10) / 10} ч
                  </b>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="mt-3 text-[13.5px] text-muted">
              Нажмите кнопку чтобы начать смену
            </div>
          )}

          {/* Big single toggle button */}
          <button
            onClick={doScan}
            disabled={pending}
            className="mt-6 w-full grid place-items-center rounded-2xl font-bold text-white transition-all active:scale-[.98] disabled:opacity-60"
            style={{
              height: 68,
              fontSize: 18,
              background: isIn
                ? "linear-gradient(180deg, #dc2626, #b91c1c)"
                : "linear-gradient(180deg, #16a34a, #15803d)",
              boxShadow: isIn
                ? "0 12px 30px -12px rgba(220,38,38,.55)"
                : "0 12px 30px -12px rgba(34,197,94,.55)",
            }}
          >
            {pending ? (
              "Отмечаем…"
            ) : (
              <span className="inline-flex items-center gap-2">
                {isIn ? <LogOut className="w-5 h-5" /> : <LogIn className="w-5 h-5" />}
                {isIn ? "Завершить смену" : "Начать смену"}
              </span>
            )}
          </button>

          {error && (
            <div
              className="mt-4 text-[12.5px] rounded-xl px-3 py-2 text-left"
              style={{
                background: "rgba(220,60,40,.10)",
                color: "#dc2626",
              }}
            >
              <XCircle className="w-4 h-4 inline mr-1 -mt-0.5" />
              {error}
            </div>
          )}

          {/* Small footer with the last event confirmation */}
          {lastEvent && !error && (
            <div className="mt-4 text-[11.5px] text-muted">
              <CheckCircle2 className="w-3.5 h-3.5 inline mr-1 -mt-0.5" style={{ color: "#16a34a" }} />
              {lastEvent.action === "check_in" ? "Приход зафиксирован" : "Уход зафиксирован"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Legacy CheckInMode kept only for backwards-URL compatibility (unused).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _LegacyCheckInMode({ qrPayload }: { qrPayload: string }) {
  const { scan } = useAttendanceScan();
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
      })
      .catch((err) => {
        if (!alive) return;
        setState({ kind: "error", message: apiErrorMessage(err) });
      });
    return () => {
      alive = false;
    };
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
