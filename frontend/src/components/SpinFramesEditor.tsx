import { useEffect, useRef, useState } from "react";
import { FolderOpen, Loader2, Rotate3d, Trash2, TriangleAlert, Upload } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import {
  SPIN_MAX_FRAMES,
  SPIN_MIN_FRAMES,
  filesFromDrop,
  isImageFile,
  naturalCompare,
  prepareSpinFrames,
} from "../lib/spinFrames";

/**
 * Inline 360° preview: drag horizontally over the thumbnail to turn the
 * phone. Frames are preloaded on first hover/touch, not on mount — the
 * editor can hold several colors × 120 frames.
 */
function SpinPreview({ frames }: { frames: string[] }) {
  const t = useT();
  const [idx, setIdx] = useState(0);
  const drag = useRef<{ x: number; start: number } | null>(null);
  const preloaded = useRef(false);
  const n = frames.length;
  // ~one full turn per 240 px of drag, but never less than 3 px per frame.
  const step = Math.max(3, Math.round(240 / Math.max(1, n)));

  useEffect(() => {
    setIdx(0);
    preloaded.current = false;
  }, [frames]);

  const preload = () => {
    if (preloaded.current) return;
    preloaded.current = true;
    for (const url of frames) {
      const img = new Image();
      img.src = url;
    }
  };

  if (n === 0) return null;
  return (
    <div
      className="relative w-36 h-28 shrink-0 rounded-xl overflow-hidden border border-[var(--border)] bg-white cursor-ew-resize select-none touch-none"
      title={t("catalog.spin_drag_hint")}
      onPointerEnter={preload}
      onPointerDown={(e) => {
        preload();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, start: idx };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const delta = Math.round((e.clientX - drag.current.x) / step);
        setIdx((((drag.current.start + delta) % n) + n) % n);
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      <img
        src={frames[Math.min(idx, n - 1)]}
        alt=""
        draggable={false}
        className="w-full h-full object-contain pointer-events-none"
      />
      <span className="absolute bottom-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-black/60 text-white tabular-nums">
        {idx + 1}/{n}
      </span>
      <Rotate3d className="absolute top-1 left-1 w-3.5 h-3.5 text-black/50" />
    </div>
  );
}

type Busy =
  | { stage: "prepare"; done: number; total: number }
  | { stage: "upload"; pct: number }
  | { stage: "delete" };

interface Props {
  phoneId: number;
  /** null → the colorless set (phones without colors). */
  colorId: number | null;
  label: string;
  hex?: string;
  frames: string[];
  /** Shown when the color was renamed in the draft (save would drop it). */
  warning?: string;
}

/**
 * One 360° set (phone × color). Upload / delete go straight to the server
 * — independent of the editor's Save button — and replace the whole set.
 */
export default function SpinFramesEditor({ phoneId, colorId, label, hex, frames: initial, warning }: Props) {
  const t = useT();
  const qc = useQueryClient();
  // Seeded once: the editor modal remounts on every open, and after an
  // upload / delete this local copy is the freshest state (the list query
  // refetches in the background, the editor draft doesn't).
  const [frames, setFrames] = useState<string[]>(initial);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const filesRef = useRef<HTMLInputElement | null>(null);
  const folderRef = useRef<HTMLInputElement | null>(null);

  const upload = async (picked: File[]) => {
    if (busy) return;
    const images = picked.filter(isImageFile).sort((a, b) => naturalCompare(a.name, b.name));
    if (images.length < SPIN_MIN_FRAMES || images.length > SPIN_MAX_FRAMES) {
      toast.error(
        t("catalog.spin_count_error", {
          min: SPIN_MIN_FRAMES,
          max: SPIN_MAX_FRAMES,
          n: images.length,
        }),
      );
      return;
    }
    try {
      setBusy({ stage: "prepare", done: 0, total: images.length });
      const prepared = await prepareSpinFrames(images, (done, total) =>
        setBusy({ stage: "prepare", done, total }),
      );
      const fd = new FormData();
      for (const f of prepared) fd.append("frames", f, f.name);
      if (colorId !== null) fd.append("color_id", String(colorId));
      setBusy({ stage: "upload", pct: 0 });
      const r = await api.post<{ color_id: number | null; frames: string[] }>(
        `/catalog/phones/${phoneId}/spin/`,
        fd,
        {
          onUploadProgress: (e) =>
            setBusy({
              stage: "upload",
              pct: e.total ? Math.round((e.loaded / e.total) * 100) : 0,
            }),
        },
      );
      setFrames(r.data.frames);
      qc.invalidateQueries({ queryKey: ["catalog-phones"] });
      toast.success(t("catalog.spin_uploaded"));
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : t("catalog.spin_upload_failed"));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy || !confirm(t("catalog.spin_confirm_delete", { name: label }))) return;
    try {
      setBusy({ stage: "delete" });
      const q = colorId !== null ? `?color_id=${colorId}` : "";
      await api.delete(`/catalog/phones/${phoneId}/spin/${q}`);
      setFrames([]);
      qc.invalidateQueries({ queryKey: ["catalog-phones"] });
      toast.success(t("catalog.spin_deleted"));
    } catch {
      toast.error(t("catalog.save_failed"));
    } finally {
      setBusy(null);
    }
  };

  const onInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || []);
    e.target.value = ""; // same folder can be picked again
    if (list.length) void upload(list);
  };

  const status =
    busy?.stage === "prepare"
      ? t("catalog.spin_preparing", { done: busy.done, total: busy.total })
      : busy?.stage === "upload"
        ? t("catalog.spin_uploading", { pct: busy.pct })
        : null;

  return (
    <div
      onDragOver={(e) => {
        if (busy) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (busy) return;
        // Must run synchronously inside the drop handler (DataTransfer dies after).
        void filesFromDrop(e.dataTransfer).then(upload);
      }}
      className={`rounded-xl border-2 border-dashed p-3 flex gap-3 items-start transition ${
        dragOver
          ? "border-[var(--accent)] bg-[var(--accent-pale-bg,rgba(228,87,27,0.06))]"
          : "border-[var(--border)] bg-[var(--surface2)]"
      }`}
    >
      <SpinPreview frames={frames} />
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex items-center gap-1.5 text-[13px] font-medium">
          {hex && (
            <span
              className="w-3 h-3 rounded-full inline-block border border-[var(--border)]"
              style={{ background: hex }}
            />
          )}
          <span className="truncate">{label}</span>
          <span className="text-[11.5px] text-muted font-normal">
            · {t("catalog.spin_frames_count", { n: frames.length })}
          </span>
        </div>
        {warning && (
          <div className="text-[11.5px] text-amber-500 flex items-center gap-1">
            <TriangleAlert className="w-3.5 h-3.5 shrink-0" /> {warning}
          </div>
        )}
        {status ? (
          <div className="text-[12px] text-muted flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> {status}
          </div>
        ) : (
          <div className="text-[11.5px] text-muted">{t("catalog.spin_drop")}</div>
        )}
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className="nf-btn nf-btn--secondary !py-1 !px-2 !text-[12px]"
            onClick={() => filesRef.current?.click()}
            disabled={!!busy}
          >
            <Upload className="w-3.5 h-3.5" /> {t("catalog.spin_pick_files")}
          </button>
          <button
            type="button"
            className="nf-btn nf-btn--secondary !py-1 !px-2 !text-[12px]"
            onClick={() => folderRef.current?.click()}
            disabled={!!busy}
          >
            <FolderOpen className="w-3.5 h-3.5" /> {t("catalog.spin_pick_folder")}
          </button>
          {frames.length > 0 && (
            <button
              type="button"
              className="nf-btn nf-btn--ghost !py-1 !px-2 !text-[12px] text-red-500"
              onClick={remove}
              disabled={!!busy}
            >
              {busy?.stage === "delete" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}{" "}
              {t("catalog.spin_delete")}
            </button>
          )}
        </div>
        <input
          ref={filesRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={onInput}
        />
        <input
          ref={(el) => {
            folderRef.current = el;
            // Not in React's typings; Chrome/Safari/Firefox all support it.
            if (el) el.setAttribute("webkitdirectory", "");
          }}
          type="file"
          multiple
          className="hidden"
          onChange={onInput}
        />
      </div>
    </div>
  );
}
