import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Upload, X } from "lucide-react";
import { useT } from "../lib/i18n";
import CameraCapture from "./CameraCapture";

interface Props {
  value: File | null;
  onChange: (file: File | null) => void;
  required?: boolean;
  label?: string;
  hint?: string;
  /** If true, listens to window-level paste while mounted. */
  captureGlobalPaste?: boolean;
  /** Optional: existing photo URL (edit mode) shown when `value` is null. */
  existingUrl?: string;
}

/**
 * PhotoUploader — three ways to attach a photo:
 *   1. Click / tap the dropzone → opens native file picker.
 *   2. Drag & drop a file onto the dropzone.
 *   3. Cmd/Ctrl + V anywhere while this widget is mounted (with
 *      captureGlobalPaste=true) → pulls image/* from the clipboard.
 *
 * Preview is generated via URL.createObjectURL and revoked on unmount /
 * value change to avoid leaking blob URLs.
 */
export default function PhotoUploader({
  value,
  onChange,
  required = false,
  label,
  hint,
  captureGlobalPaste = true,
  existingUrl,
}: Props) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  const previewUrl = useMemo(() => {
    if (value) return URL.createObjectURL(value);
    return existingUrl || null;
  }, [value, existingUrl]);

  useEffect(() => {
    if (!value || !previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [value, previewUrl]);

  const pickFile = useCallback(
    (file: File | null) => {
      if (!file) return;
      if (!file.type.startsWith("image/")) return;
      onChange(file);
    },
    [onChange],
  );

  // Global paste: intercept image/* items from the clipboard while mounted.
  useEffect(() => {
    if (!captureGlobalPaste) return;
    const handler = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      // Skip if user is pasting into an input/textarea and there's actual
      // text — the browser should handle that natively without hijacking.
      const target = e.target as HTMLElement | null;
      const isTextField =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.getAttribute("contenteditable") === "true");
      const items = Array.from(e.clipboardData.items);
      const imageItem = items.find(
        (it) => it.kind === "file" && it.type.startsWith("image/"),
      );
      if (!imageItem) return;
      if (isTextField && !e.clipboardData.files.length) return;
      const file = imageItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      pickFile(file);
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [captureGlobalPaste, pickFile]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    pickFile(file || null);
  };

  return (
    <div>
      {label && (
        <label className="nf-col mb-1.5 block">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}

      {previewUrl ? (
        <div className="relative rounded-2xl overflow-hidden border border-[var(--border)] bg-[var(--surface2)]">
          <img
            src={previewUrl}
            alt="preview"
            className="w-full max-h-[320px] object-contain"
          />
          <button
            type="button"
            onClick={() => onChange(null)}
            className="absolute top-2 right-2 rounded-full bg-black/60 hover:bg-black/80 text-white p-1.5 transition"
            title={t("common.remove")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`cursor-pointer rounded-2xl border-2 border-dashed p-6 text-center transition ${
            dragOver
              ? "border-[var(--accent)] bg-[var(--accent-pale-bg,rgba(228,87,27,0.06))]"
              : "border-[var(--border)] hover:border-[var(--accent)] bg-[var(--surface2)]"
          }`}
        >
          <div className="flex flex-col items-center gap-2">
            <div className="rounded-full bg-[var(--faint)] p-3">
              <Camera className="w-6 h-6 text-muted" />
            </div>
            <div className="text-[14px] font-medium">
              {t("photo.dropzone_title")}
            </div>
            <div className="text-[12px] text-muted max-w-[280px]">
              {t("photo.dropzone_hint")}
            </div>
            <div className="mt-1 flex items-center gap-3 text-[12px] justify-center">
              <span className="inline-flex items-center gap-1.5 text-[var(--accent)]">
                <Upload className="w-3.5 h-3.5" /> {t("photo.pick_file")}
              </span>
              <span className="text-muted">·</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setCameraOpen(true);
                }}
                className="inline-flex items-center gap-1.5 text-[var(--accent)] hover:underline"
              >
                <Camera className="w-3.5 h-3.5" /> {t("photo.use_camera")}
              </button>
            </div>
          </div>
        </div>
      )}

      {hint && !previewUrl && (
        <div className="text-[11.5px] text-muted mt-1.5">{hint}</div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => pickFile(e.target.files?.[0] || null)}
      />

      {cameraOpen && (
        <CameraCapture
          onCapture={(f) => {
            pickFile(f);
            setCameraOpen(false);
          }}
          onCancel={() => setCameraOpen(false)}
        />
      )}
    </div>
  );
}
