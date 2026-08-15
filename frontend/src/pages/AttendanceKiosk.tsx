/**
 * AttendanceKiosk — manager-facing dual-mode check-in station.
 *
 * Проблема: не у всех рабочих компов есть камера. Раньше единственный
 * способ отметиться — через `/scan?qr=` на телефоне, а для этого
 * каждому оператору нужно распечатывать/носить свой QR. Здесь мы даём
 * менеджеру одно окно, из которого:
 *
 *  1. Выбирается оператор из dropdown-а (активные + trainee).
 *  2. Менеджер жмёт один из двух режимов:
 *      • «Камера» — открывается CameraCapture поверх, снимок → POST
 *        /attendance/me/scan-with-photo/ с `qr_payload`, полученным
 *        из /attendance/operators/<id>/qr-token/ (мы никогда не
 *        логинимся оператором — payload это самодостаточный HMAC).
 *      • «QR-код» — рендерим большой персональный QR (из того же
 *        payload'а обернутого в `${QR_CHECKIN_URL}?qr=...`).
 *        Оператор наводит камеру телефона, попадает на /scan?qr=,
 *        и ScanPhotoFlow отрабатывает без логина.
 *  3. После успешной камеры → показывается success-оверлей → авто-возврат
 *     на выбор оператора через 4 секунды.
 *
 * Access: manager+superadmin (RoleGate allow=["manager"] в App.tsx).
 * Endpoint `/operators/<id>/qr-token/` тоже манагер-only.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import qrcode from "qrcode-generator";
import {
  ArrowLeft,
  Camera as CameraIcon,
  CheckCircle2,
  QrCode as QrCodeIcon,
  RotateCcw,
  Smartphone,
  User as UserIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { api } from "../lib/api";
import { apiErrorMessage } from "../lib/api-types";
import { Button, Eyebrow, toast } from "../components/ui";
import { usePageHeader } from "../store/page";
import { useT } from "../lib/i18n";
import CameraCapture from "../components/CameraCapture";

type Operator = {
  id: number;
  full_name: string;
  status: "active" | "trainee" | "inactive";
};

type QrPreview = {
  operator: { id: number; full_name: string };
  on_shift: boolean;
  checked_in_at: string | null;
  expected_action: "check_in" | "check_out";
};

type QrToken = {
  operator_id: number;
  operator_name: string;
  payload: string;
  url: string;
};

type ScanResult = {
  action: "check_in" | "check_out";
  operator: { id: number; full_name: string };
  was_late?: boolean;
  checked_in_at?: string;
  checked_out_at?: string;
  duration_min?: number;
  photo_url?: string;
};

type Stage = "pick" | "mode" | "camera" | "qr" | "success";

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

export default function AttendanceKiosk() {
  const t = useT();
  usePageHeader(
    {
      title: t("attendance.kiosk.title"),
      subtitle: t("attendance.kiosk.subtitle"),
    },
    [t("attendance.kiosk.title")],
  );

  const [stage, setStage] = useState<Stage>("pick");
  const [operatorId, setOperatorId] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);

  // Активные + trainee операторы. Inactive скрываем — менеджер не должен
  // случайно отмечать уволенного.
  const operatorsQuery = useQuery({
    queryKey: ["kiosk-operators"],
    queryFn: () =>
      api
        .get<Operator[] | { results: Operator[] }>("/operators/")
        .then((r) => (Array.isArray(r.data) ? r.data : r.data.results ?? []))
        .then((rows) => rows.filter((o) => o.status !== "inactive")),
    staleTime: 5 * 60_000,
  });

  const operator = useMemo(
    () =>
      operatorId
        ? operatorsQuery.data?.find((o) => o.id === operatorId) ?? null
        : null,
    [operatorId, operatorsQuery.data],
  );

  // QR-token: fetch on demand когда выбран оператор — используется и
  // для рендера картинки, и как `qr_payload` для camera-режима.
  const qrTokenQuery = useQuery<QrToken>({
    queryKey: ["kiosk-qr-token", operatorId],
    queryFn: () =>
      api
        // Pass current SPA origin so the QR URL points at whichever host
        // the manager is actually looking at (prod vs demo), regardless
        // of where the API base URL is pinned.
        .get<QrToken>(`/attendance/operators/${operatorId}/qr-token/`, {
          params: { origin: window.location.origin },
        })
        .then((r) => r.data),
    enabled: !!operatorId,
    staleTime: 60_000,
  });

  // Preview для показа «сейчас будет check-in» или «check-out».
  const previewQuery = useQuery<QrPreview>({
    queryKey: ["kiosk-qr-preview", qrTokenQuery.data?.payload],
    queryFn: () =>
      api
        .get<QrPreview>(
          `/attendance/qr-preview/?qr=${encodeURIComponent(
            qrTokenQuery.data!.payload,
          )}`,
        )
        .then((r) => r.data),
    enabled: !!qrTokenQuery.data?.payload,
    staleTime: 15_000,
  });

  const resetToPick = () => {
    setStage("pick");
    setOperatorId(null);
    setScanResult(null);
  };

  const backToMode = () => {
    setStage("mode");
    setScanResult(null);
  };

  const handleCameraSnap = async (file: File) => {
    if (!qrTokenQuery.data) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("qr_payload", qrTokenQuery.data.payload);
      fd.append("photo", file);
      const r = await api.post<ScanResult>(
        "/attendance/me/scan-with-photo/",
        fd,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      setScanResult(r.data);
      setStage("success");
    } catch (e) {
      toast.error(apiErrorMessage(e));
      setStage("mode");
    } finally {
      setUploading(false);
    }
  };

  // Success auto-return после 4.2s.
  useEffect(() => {
    if (stage !== "success") return;
    const timer = window.setTimeout(() => resetToPick(), 4200);
    return () => window.clearTimeout(timer);
  }, [stage]);

  return (
    <div className="mx-auto max-w-[900px] flex flex-col gap-5">
      {/* Sticky header for context — оператор + step navigation */}
      {operator && stage !== "pick" && stage !== "success" && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={stage === "mode" ? resetToPick : backToMode}
            className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-text transition"
          >
            <ArrowLeft className="w-4 h-4" />
            {stage === "mode"
              ? t("attendance.kiosk.change_operator")
              : t("attendance.kiosk.reset")}
          </button>
          <div className="text-[13px] text-muted">
            {t("attendance.kiosk.pick_operator")}:{" "}
            <span className="text-text font-semibold">{operator.full_name}</span>
          </div>
        </div>
      )}

      {stage === "pick" && (
        <PickOperatorStage
          operators={operatorsQuery.data ?? []}
          loading={operatorsQuery.isPending}
          onPick={(id) => {
            setOperatorId(id);
            setStage("mode");
          }}
        />
      )}

      {stage === "mode" && operator && (
        <ModeStage
          operator={operator}
          preview={previewQuery.data}
          onPickCamera={() => setStage("camera")}
          onPickQr={() => setStage("qr")}
        />
      )}

      {stage === "camera" && operator && qrTokenQuery.data && (
        <CameraCapture
          onCapture={handleCameraSnap}
          onCancel={() => setStage("mode")}
        />
      )}

      {stage === "qr" && operator && (
        <QrStage
          token={qrTokenQuery.data}
          preview={previewQuery.data}
          loading={qrTokenQuery.isPending}
        />
      )}

      <AnimatePresence>
        {stage === "success" && scanResult && (
          <SuccessOverlay result={scanResult} onDismiss={resetToPick} />
        )}
      </AnimatePresence>

      {uploading && (
        <div className="fixed inset-0 z-[150] grid place-items-center bg-black/40 pointer-events-none">
          <div className="nf-card px-6 py-4 text-[14px] font-medium">
            {t("scan_photo.uploading")}
          </div>
        </div>
      )}
    </div>
  );
}

function PickOperatorStage({
  operators,
  loading,
  onPick,
}: {
  operators: Operator[];
  loading: boolean;
  onPick: (id: number) => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return operators;
    return operators.filter((o) => o.full_name.toLowerCase().includes(term));
  }, [operators, q]);

  return (
    <section className="nf-card p-6" style={{ borderRadius: 20 }}>
      <div className="flex items-center gap-3 mb-5">
        <div
          className="grid place-items-center rounded-full"
          style={{
            width: 48,
            height: 48,
            background: "var(--faint)",
          }}
        >
          <UserIcon className="w-6 h-6" />
        </div>
        <div>
          <Eyebrow>KIOSK · STEP 1</Eyebrow>
          <div
            className="font-semibold mt-1"
            style={{ fontSize: 22, letterSpacing: "-0.02em" }}
          >
            {t("attendance.kiosk.pick_operator")}
          </div>
          <div className="text-[13px] text-muted">
            {t("attendance.kiosk.pick_hint")}
          </div>
        </div>
      </div>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("attendance.kiosk.pick_operator")}
        className="nf-input py-2.5 px-3.5 text-[14px] mb-4"
        autoFocus
      />
      {loading && (
        <div className="p-6 text-center text-[13px] text-muted">…</div>
      )}
      {!loading && filtered.length === 0 && (
        <div className="p-6 text-center text-[13px] text-muted">
          {t("attendance.kiosk.no_operators")}
        </div>
      )}
      <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((op) => (
          <button
            key={op.id}
            type="button"
            onClick={() => onPick(op.id)}
            className="text-left p-3.5 rounded-xl border transition hover:border-[var(--accent)] hover:bg-[color:var(--faint)]"
            style={{ borderColor: "var(--border)" }}
          >
            <div className="text-[14.5px] font-semibold truncate">
              {op.full_name}
            </div>
            <div className="text-[11px] uppercase tracking-widest text-muted mt-0.5">
              {op.status}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function ModeStage({
  operator,
  preview,
  onPickCamera,
  onPickQr,
}: {
  operator: Operator;
  preview: QrPreview | undefined;
  onPickCamera: () => void;
  onPickQr: () => void;
}) {
  const t = useT();
  const isCheckOut = preview?.expected_action === "check_out";
  const actionLabel = isCheckOut
    ? t("attendance.kiosk.qr_expected_checkout")
    : t("attendance.kiosk.qr_expected_checkin");
  const accent = isCheckOut ? "#f97316" : "#16a34a";

  return (
    <section className="flex flex-col gap-5">
      {/* Greeting */}
      <div
        className="nf-card p-5 flex items-center gap-4"
        style={{
          borderRadius: 20,
          borderLeft: `4px solid ${accent}`,
        }}
      >
        <div
          className="grid place-items-center rounded-full"
          style={{
            width: 56,
            height: 56,
            background: `${accent}18`,
          }}
        >
          <UserIcon className="w-7 h-7" style={{ color: accent }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-widest text-muted">
            {actionLabel}
          </div>
          <div className="text-[22px] font-bold tracking-tight truncate">
            {operator.full_name}
          </div>
        </div>
      </div>

      {/* Two big mode cards */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
        <ModeCard
          icon={<CameraIcon className="w-8 h-8" />}
          title={t("attendance.kiosk.mode_camera_title")}
          hint={t("attendance.kiosk.mode_camera_hint")}
          buttonLabel={t("attendance.kiosk.btn_camera")}
          accent="#0ea5e9"
          onClick={onPickCamera}
        />
        <ModeCard
          icon={<QrCodeIcon className="w-8 h-8" />}
          title={t("attendance.kiosk.mode_qr_title")}
          hint={t("attendance.kiosk.mode_qr_hint")}
          buttonLabel={t("attendance.kiosk.btn_qr")}
          accent="#8b5cf6"
          onClick={onPickQr}
        />
      </div>
    </section>
  );
}

function ModeCard({
  icon,
  title,
  hint,
  buttonLabel,
  accent,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  buttonLabel: string;
  accent: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left nf-card p-6 flex flex-col gap-4 transition hover:shadow-lg hover:-translate-y-0.5"
      style={{ borderRadius: 20 }}
    >
      <div
        className="grid place-items-center rounded-2xl"
        style={{
          width: 64,
          height: 64,
          background: `${accent}18`,
          color: accent,
        }}
      >
        {icon}
      </div>
      <div>
        <div
          className="font-semibold"
          style={{ fontSize: 17, letterSpacing: "-0.015em" }}
        >
          {title}
        </div>
        <div className="text-[13px] text-muted mt-1.5 leading-snug">{hint}</div>
      </div>
      <div>
        <span
          className="inline-flex items-center gap-2 rounded-full px-4 py-2 font-semibold text-white"
          style={{
            background: accent,
            fontSize: 13,
          }}
        >
          {buttonLabel}
        </span>
      </div>
    </button>
  );
}

function QrStage({
  token,
  preview,
  loading,
}: {
  token: QrToken | undefined;
  preview: QrPreview | undefined;
  loading: boolean;
}) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isCheckOut = preview?.expected_action === "check_out";
  const accent = isCheckOut ? "#f97316" : "#16a34a";

  useEffect(() => {
    if (canvasRef.current && token?.url) {
      renderQrToCanvas(canvasRef.current, token.url);
    }
  }, [token?.url]);

  return (
    <section
      className="nf-card p-8 flex flex-col items-center gap-5 text-center"
      style={{ borderRadius: 24 }}
    >
      <div className="flex items-center gap-2 text-[13px]">
        <Smartphone className="w-4 h-4" style={{ color: accent }} />
        <span className="font-semibold" style={{ color: accent }}>
          {isCheckOut
            ? t("attendance.kiosk.qr_expected_checkout")
            : t("attendance.kiosk.qr_expected_checkin")}
        </span>
      </div>
      <div
        className="font-semibold"
        style={{ fontSize: 24, letterSpacing: "-0.02em" }}
      >
        {t("attendance.kiosk.qr_show_title")}
      </div>
      {loading && (
        <div className="text-[13px] text-muted">
          {t("attendance.kiosk.loading_qr")}
        </div>
      )}
      {token && (
        <div
          className="grid place-items-center"
          style={{
            width: 360,
            height: 360,
            maxWidth: "80vw",
            maxHeight: "80vw",
            padding: 16,
            background: "#fff",
            borderRadius: 24,
            border: "1px solid var(--border)",
            boxShadow: "0 20px 50px -20px rgba(0,0,0,.25)",
          }}
        >
          <canvas
            ref={canvasRef}
            style={{
              width: "100%",
              height: "100%",
              imageRendering: "pixelated",
            }}
            aria-label="QR"
          />
        </div>
      )}
      <div className="text-[13px] text-muted max-w-[440px]">
        {t("attendance.kiosk.qr_hint_after_scan")}
      </div>
      {token && (
        <div
          className="text-[11px] font-mono text-muted rounded-lg px-3 py-1.5 break-all max-w-[560px]"
          style={{ background: "var(--faint)" }}
        >
          {token.url}
        </div>
      )}
    </section>
  );
}

function SuccessOverlay({
  result,
  onDismiss,
}: {
  result: ScanResult;
  onDismiss: () => void;
}) {
  const t = useT();
  const isCheckIn = result.action === "check_in";
  const accent = isCheckIn ? "#16a34a" : "#f97316";
  const bg = isCheckIn ? "rgba(22,163,74,.16)" : "rgba(249,115,22,.16)";

  return (
    <motion.div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,.55)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onDismiss}
    >
      <motion.div
        className="w-full max-w-[400px] rounded-3xl p-8 text-center relative"
        style={{ background: "var(--surface)" }}
        initial={{ scale: 0.85, y: 20, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        transition={{ type: "spring", damping: 18, stiffness: 220 }}
        onClick={(e) => e.stopPropagation()}
      >
        <motion.div
          className="mx-auto grid place-items-center rounded-full"
          style={{ width: 112, height: 112, background: bg }}
          initial={{ scale: 0 }}
          animate={{ scale: [0, 1.15, 1] }}
          transition={{ duration: 0.55, times: [0, 0.7, 1] }}
        >
          <CheckCircle2 className="w-16 h-16" style={{ color: accent }} />
        </motion.div>
        <div
          className="mt-5 text-[12px] font-bold uppercase tracking-widest"
          style={{ color: accent }}
        >
          {t("attendance.kiosk.done_title")}
        </div>
        <div className="mt-2 text-[22px] font-bold tracking-tight">
          {result.operator.full_name}
        </div>
        <div className="mt-3 text-[15px] text-muted">
          {isCheckIn
            ? t("attendance.kiosk.done_checkin")
            : t("attendance.kiosk.done_checkout")}
        </div>
        <div className="mt-1 text-[12px] text-muted">
          {t("attendance.kiosk.done_next")}
        </div>
        <div className="mt-6">
          <Button onClick={onDismiss}>
            <RotateCcw className="w-3.5 h-3.5" /> {t("attendance.kiosk.reset")}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
