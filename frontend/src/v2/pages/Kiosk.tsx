import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import qrcode from "qrcode-generator";
import { ArrowLeft, Camera, Check, QrCode, RotateCcw, Search, Smartphone, User } from "lucide-react";
import { toast } from "../../components/ui";
import CameraCapture from "../../components/CameraCapture";
import OldScan from "../../pages/Scan";
import { apiErrorMessage } from "../../lib/api-types";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, PageSkeleton, cx } from "../ui";
import {
  attFmtTime,
  attTashkentDate,
  kioskScanWithPhoto,
  useAttDayReport,
  useKioskOperators,
  useKioskQrPreview,
  useKioskQrToken,
  type KioskScanResult,
} from "../api/team/attendance";
import { AttSeg } from "./AttendanceToday";

/* ── /kiosk (public) → the v2 Scan page when it exists, else the old one ── */

const scanV2Loader = import.meta.glob<{ default: ComponentType }>("./Scan.tsx")["./Scan.tsx"];
const ScanV2 = scanV2Loader ? lazy(scanV2Loader) : null;

function PublicKiosk() {
  if (!ScanV2) return <OldScan />;
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ScanV2 />
    </Suspense>
  );
}

export default function Kiosk() {
  const { pathname } = useLocation();
  if (pathname.replace(/\/+$/, "") === "/kiosk") return <PublicKiosk />;
  return <KioskStation />;
}

/* ── /attendance/kiosk (manager station) ─────────────────────────────── */

type Stage = "pick" | "mode" | "camera" | "qr" | "success";

const QR_CELL = 8;
const QR_MARGIN = 2;

function renderQr(canvas: HTMLCanvasElement, text: string) {
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

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}

/** Accent for check-in (green) vs check-out (orange). */
function tone(isOut: boolean) {
  return isOut ? { fg: "var(--hot)", bg: "var(--hot-bg)" } : { fg: "var(--ok)", bg: "var(--ok-bg)" };
}

function KioskStation() {
  const t = useT2();
  const qc = useQueryClient();
  const [stage, setStage] = useState<Stage>("pick");
  const [operatorId, setOperatorId] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<KioskScanResult | null>(null);

  const opsQ = useKioskOperators();
  const dayQ = useAttDayReport(attTashkentDate());
  const tokenQ = useKioskQrToken(operatorId);
  const previewQ = useKioskQrPreview(tokenQ.data?.payload);

  const operator = useMemo(() => (operatorId ? opsQ.data?.find((o) => o.id === operatorId) ?? null : null), [operatorId, opsQ.data]);

  const resetToPick = () => {
    setStage("pick");
    setOperatorId(null);
    setResult(null);
  };
  const backToMode = () => {
    setStage("mode");
    setResult(null);
  };

  const onSnap = async (file: File) => {
    if (!tokenQ.data) return;
    setUploading(true);
    try {
      const r = await kioskScanWithPhoto(tokenQ.data.payload, file);
      setResult(r);
      setStage("success");
      qc.invalidateQueries({ queryKey: ["attendance-report"] });
      qc.invalidateQueries({ queryKey: ["kiosk-qr-preview"] });
    } catch (e) {
      toast.error(apiErrorMessage(e));
      setStage("mode");
    } finally {
      setUploading(false);
    }
  };

  // success → back to step 1 after 4.2 s
  useEffect(() => {
    if (stage !== "success") return;
    const id = window.setTimeout(resetToPick, 4200);
    return () => window.clearTimeout(id);
  }, [stage]);

  const preview = previewQ.data;
  const previewKnown = !!preview;
  const isOut = preview?.expected_action === "check_out";
  const actionLabel = !previewKnown
    ? t("v2.team.attendance.kiosk.previewLoading")
    : isOut
      ? t("attendance.kiosk.qr_expected_checkout")
      : t("attendance.kiosk.qr_expected_checkin");

  return (
    <>
      <PageHeader title={t("v2.team.attendance.title")} meta={t("attendance.kiosk.title")}>
        <AttSeg />
      </PageHeader>
      <main className="page" style={{ maxWidth: 960, width: "100%", margin: "0 auto" }}>
        {operator && (stage === "mode" || stage === "camera" || stage === "qr") ? (
          <div className="row between wrap g8">
            <button className="btn btn-ghost btn-sm" type="button" onClick={stage === "mode" ? resetToPick : backToMode}>
              <ArrowLeft className="ic" />
              {stage === "mode" ? t("attendance.kiosk.change_operator") : t("attendance.kiosk.reset")}
            </button>
            <span className="xs c3">{t("v2.team.attendance.kiosk.chosen")} <b className="c2">{operator.full_name}</b></span>
          </div>
        ) : null}

        {stage === "pick" ? (
          <PickStage
            ops={opsQ.data ?? []}
            loading={opsQ.isPending}
            error={opsQ.isError ? opsQ.error : null}
            onRetry={() => opsQ.refetch()}
            statusOf={(id) => {
              const ev = dayQ.data?.present.filter((e) => e.operator_id === id) ?? [];
              if (ev.some((e) => !e.checked_out_at && !e.auto_closed)) return "on";
              if (ev.length) return "gone";
              return dayQ.data ? "none" : null;
            }}
            onPick={(id) => {
              setOperatorId(id);
              setStage("mode");
            }}
          />
        ) : null}

        {stage === "mode" && operator ? (
          <div className="col g12">
            <div className="card row g12" style={{ padding: "14px 16px", borderLeft: `4px solid ${previewKnown ? tone(isOut).fg : "var(--line-2)"}` }}>
              <span className="icon-tile" style={{ width: 44, height: 44, borderRadius: "50%", background: previewKnown ? tone(isOut).bg : "var(--surface-3)", color: previewKnown ? tone(isOut).fg : "var(--ink-3)" }}>
                <User className="ic ic-l" />
              </span>
              <span className="col" style={{ minWidth: 0 }}>
                <span className="lbl">{actionLabel}</span>
                <span className="h2 trunc">{operator.full_name}</span>
              </span>
            </div>
            {tokenQ.isError ? <ErrorState title={t("v2.team.attendance.kiosk.qrError")} error={tokenQ.error} onRetry={() => tokenQ.refetch()} /> : null}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 12 }}>
              <ModeCard icon={<Camera className="ic ic-l" />} title={t("attendance.kiosk.mode_camera_title")} hint={t("attendance.kiosk.mode_camera_hint")} btn={t("attendance.kiosk.btn_camera")} primary onClick={() => setStage("camera")} />
              <ModeCard icon={<QrCode className="ic ic-l" />} title={t("attendance.kiosk.mode_qr_title")} hint={t("attendance.kiosk.mode_qr_hint")} btn={t("attendance.kiosk.btn_qr")} onClick={() => setStage("qr")} />
            </div>
          </div>
        ) : null}

        {stage === "camera" && operator ? (
          tokenQ.data ? (
            <CameraCapture onCapture={onSnap} onCancel={() => setStage("mode")} />
          ) : tokenQ.isError ? (
            <section className="card"><ErrorState title={t("v2.team.attendance.kiosk.qrError")} error={tokenQ.error} onRetry={() => tokenQ.refetch()} /></section>
          ) : (
            <section className="card col g8">
              <div className="banner b-info" style={{ margin: "16px 20px 0" }}><Camera className="ic" /><span>{t("v2.team.attendance.kiosk.cameraWait")}</span></div>
              <LoadingBlock rows={2} onRetry={() => tokenQ.refetch()} />
            </section>
          )
        ) : null}

        {stage === "qr" && operator ? (
          <QrStage
            url={tokenQ.data?.url}
            loading={tokenQ.isPending}
            error={tokenQ.isError ? tokenQ.error : null}
            onRetry={() => tokenQ.refetch()}
            label={actionLabel}
            known={previewKnown}
            isOut={isOut}
          />
        ) : null}

        {stage === "success" && result ? <SuccessCard r={result} onReset={resetToPick} /> : null}
      </main>

      {uploading ? (
        <div style={{ position: "fixed", inset: 0, zIndex: 150, display: "grid", placeItems: "center", background: "rgba(0,0,0,.4)", pointerEvents: "none" }}>
          <div className="card s w5" style={{ padding: "16px 24px" }}>{t("scan_photo.uploading")}</div>
        </div>
      ) : null}
    </>
  );
}

function PickStage({
  ops,
  loading,
  error,
  onRetry,
  statusOf,
  onPick,
}: {
  ops: Array<{ id: number; full_name: string; status?: string }>;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  statusOf: (id: number) => "on" | "gone" | "none" | null;
  onPick: (id: number) => void;
}) {
  const t = useT2();
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? ops.filter((o) => o.full_name.toLowerCase().includes(n)) : ops;
  }, [ops, q]);
  return (
    <section className="card col">
      <div className="col g4" style={{ padding: "16px 16px 0" }}>
        <span className="h3">{t("attendance.kiosk.pick_operator")}</span>
        <span className="xs c3">{t("attendance.kiosk.pick_hint")}</span>
      </div>
      <div className="pad">
        <div className="inwrap">
          <Search className="ic" />
          <input className="input" type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("attendance.kiosk.pick_operator")} aria-label={t("attendance.kiosk.pick_operator")} />
        </div>
      </div>
      {loading ? (
        <LoadingBlock rows={3} onRetry={onRetry} />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : filtered.length === 0 ? (
        <EmptyState icon={<User className="ic ic-l" />} title={t("attendance.kiosk.no_operators")} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8, padding: "0 16px 16px" }}>
          {filtered.map((o) => {
            const st = statusOf(o.id);
            return (
              <button key={o.id} className="bcard" type="button" onClick={() => onPick(o.id)} style={{ textAlign: "left" }}>
                <span className="ava">{initials(o.full_name)}</span>
                <span className="col" style={{ minWidth: 0 }}>
                  <span className="s w6 trunc">{o.full_name}</span>
                  <span className="row g6 xs">
                    {st === "on" ? <span className="c-ok">{t("v2.team.attendance.kiosk.onShift")}</span> : null}
                    {st === "gone" ? <span className="c3">{t("v2.team.attendance.kiosk.gone")}</span> : null}
                    {st === "none" ? <span className="c3">{t("v2.team.attendance.kiosk.notMarked")}</span> : null}
                    {o.status === "trainee" ? <span className="c3">· {t("v2.team.attendance.kiosk.trainee")}</span> : null}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ModeCard({ icon, title, hint, btn, primary, onClick }: { icon: ReactNode; title: string; hint: string; btn: string; primary?: boolean; onClick: () => void }) {
  return (
    <div className="card col g6" style={{ padding: "14px 16px" }}>
      <span className="row g8 c-brand">{icon}<b className="s" style={{ color: "var(--ink)" }}>{title}</b></span>
      <span className="xs c3">{hint}</span>
      <button className={cx("btn btn-sm", primary && "btn-pri")} type="button" onClick={onClick} style={{ alignSelf: "flex-start", marginTop: 4 }}>{btn}</button>
    </div>
  );
}

function QrStage({ url, loading, error, onRetry, label, known, isOut }: { url?: string; loading: boolean; error: unknown; onRetry: () => void; label: string; known: boolean; isOut: boolean }) {
  const t = useT2();
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (ref.current && url) renderQr(ref.current, url);
  }, [url]);
  return (
    <section className="card col g12" style={{ padding: 24, alignItems: "center", textAlign: "center" }}>
      <span className="row g6 s w6" style={{ color: known ? tone(isOut).fg : "var(--ink-3)" }}><Smartphone className="ic" />{label}</span>
      <span className="h2">{t("attendance.kiosk.qr_show_title")}</span>
      {error ? (
        <ErrorState title={t("v2.team.attendance.kiosk.qrError")} error={error} onRetry={onRetry} />
      ) : loading ? (
        <span className="s c3">{t("attendance.kiosk.loading_qr")}</span>
      ) : url ? (
        <div style={{ width: 360, height: 360, maxWidth: "80vw", maxHeight: "80vw", padding: 16, background: "#FFFFFF", borderRadius: 20, border: "1px solid var(--line)", boxShadow: "var(--shadow)" }}>
          <canvas ref={ref} aria-label="QR" style={{ width: "100%", height: "100%", imageRendering: "pixelated" }} />
        </div>
      ) : null}
      <span className="xs c3" style={{ maxWidth: 440 }}>{t("attendance.kiosk.qr_hint_after_scan")}</span>
      {url ? (
        <span className="num xs c3" style={{ background: "var(--surface-3)", borderRadius: 8, padding: "6px 10px", wordBreak: "break-all", textAlign: "left", maxWidth: 560 }}>{url}</span>
      ) : null}
    </section>
  );
}

function SuccessCard({ r, onReset }: { r: KioskScanResult; onReset: () => void }) {
  const t = useT2();
  const isOut = r.action === "check_out";
  const c = tone(isOut);
  const at = isOut ? r.checked_out_at : r.checked_in_at;
  return (
    <section className="card col" role="status" aria-live="polite" style={{ overflow: "hidden", alignItems: "center", textAlign: "center", paddingBottom: 24, maxWidth: 420, width: "100%", alignSelf: "center" }}>
      <i className="ikat" style={{ height: 10, alignSelf: "stretch" }} aria-hidden="true" />
      <span className="icon-tile" style={{ width: 64, height: 64, borderRadius: 18, marginTop: 24, background: c.bg, color: c.fg }}><Check className="ic ic-l" /></span>
      <span className="display" style={{ fontSize: 20, marginTop: 12 }}>{t("attendance.kiosk.done_title")}</span>
      <span className="s w6" style={{ color: c.fg }}>{isOut ? t("attendance.kiosk.done_checkout") : t("attendance.kiosk.done_checkin")}</span>
      <span className="s c2">
        {r.operator.full_name}
        {at ? <> · <span className="num">{attFmtTime(at)}</span></> : null}
      </span>
      {!isOut && r.was_late ? <span className="badge b-bad" style={{ marginTop: 6 }}>{t("v2.team.attendance.late")}</span> : null}
      <span className="xs c3" style={{ marginTop: 6 }}>{t("attendance.kiosk.done_next")}</span>
      <button className="btn btn-ghost btn-sm" type="button" onClick={onReset} style={{ marginTop: 8 }}><RotateCcw className="ic ic-s" />{t("attendance.kiosk.reset")}</button>
    </section>
  );
}
