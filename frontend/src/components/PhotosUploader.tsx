import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Plus, Upload, X } from "lucide-react";
import { useT } from "../lib/i18n";
import CameraCapture from "./CameraCapture";

interface Props {
  value: File[];
  onChange: (files: File[]) => void;
  max?: number;
  required?: boolean;
  label?: string;
  hint?: string;
  /** If true, listens to window-level paste while mounted. */
  captureGlobalPaste?: boolean;
  /**
   * Existing photos URLs (edit mode) shown alongside the freshly-added
   * File previews. These are display-only — removing one here does NOT
   * touch the server; the caller decides how to reconcile.
   */
  existingUrls?: string[];
}

/**
 * PhotosUploader — multi-file variant of PhotoUploader (up to `max` files).
 *
 * Three ways to add each photo, same as the single-file component:
 *   1. Click the "+" tile in the grid → native file picker (multi-select).
 *   2. Drag & drop file(s) onto the grid.
 *   3. Cmd/Ctrl + V while mounted → pastes clipboard image as one photo.
 *
 * Each thumbnail has a remove button; drag-reorder is intentionally NOT
 * built here — 5 photos is small enough to just re-pick if the order matters,
 * and touch-DnD adds ~50 lines with poor mobile ergonomics.
 *
 * Object URLs are revoked on unmount / value change so blob leaks don't
 * pile up on a long operator session.
 */
export default function PhotosUploader({
  value,
  onChange,
  max = 5,
  required = false,
  label,
  hint,
  captureGlobalPaste = true,
  existingUrls,
}: Props) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  // Generate previews as blob URLs; revoke them cleanly on the next
  // value swap to avoid mounting up leaked blob:… entries in memory.
  const previews = useMemo(
    () => value.map((f) => URL.createObjectURL(f)),
    [value],
  );
  useEffect(() => {
    return () => previews.forEach((u) => URL.revokeObjectURL(u));
  }, [previews]);

  const canAddMore = value.length < max;

  const addFiles = useCallback(
    (incoming: File[] | FileList | null) => {
      if (!incoming) return;
      const list = Array.from(incoming).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (list.length === 0) return;
      // Never overrun the max — silently truncate. The caller can inspect
      // the resulting length and show a hint if they want.
      const slots = Math.max(0, max - value.length);
      const next = [...value, ...list.slice(0, slots)];
      onChange(next);
    },
    [max, onChange, value],
  );

  const removeAt = (idx: number) => {
    const next = value.filter((_, i) => i !== idx);
    onChange(next);
  };

  // Global paste — pulls a clipboard image and appends it. Skips the
  // browser's native text-paste path when the operator is typing in
  // another field.
  useEffect(() => {
    if (!captureGlobalPaste) return;
    const handler = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      if (!canAddMore) return;
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
      addFiles([file]);
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [captureGlobalPaste, addFiles, canAddMore]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (!canAddMore) return;
    addFiles(e.dataTransfer.files);
  };

  const hasAnything = value.length > 0 || (existingUrls?.length ?? 0) > 0;

  return (
    <div>
      {label && (
        <label className="nf-col mb-1.5 block">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
          <span className="ml-2 text-[11px] text-muted font-normal">
            {value.length}/{max}
          </span>
        </label>
      )}

      <div
        onDragOver={(e) => {
          if (!canAddMore) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`grid grid-cols-3 gap-2 rounded-2xl border-2 border-dashed p-2 transition ${
          dragOver
            ? "border-[var(--accent)] bg-[var(--accent-pale-bg,rgba(228,87,27,0.06))]"
            : "border-[var(--border)] bg-[var(--surface2)]"
        }`}
      >
        {existingUrls?.map((url, i) => (
          <div
            key={`existing-${i}`}
            className="relative aspect-square rounded-xl overflow-hidden border border-[var(--border)] bg-[var(--surface2)]"
          >
            <img
              src={url}
              alt={`existing ${i + 1}`}
              className="w-full h-full object-cover"
            />
            <div className="absolute top-1 left-1 text-[10px] px-1.5 py-0.5 rounded bg-black/60 text-white">
              #{i + 1}
            </div>
          </div>
        ))}

        {previews.map((url, i) => (
          <div
            key={`new-${i}-${value[i]?.name}`}
            className="relative aspect-square rounded-xl overflow-hidden border border-[var(--border)] bg-[var(--surface2)]"
          >
            <img
              src={url}
              alt={`photo ${i + 1}`}
              className="w-full h-full object-cover"
            />
            <button
              type="button"
              onClick={() => removeAt(i)}
              className="absolute top-1 right-1 rounded-full bg-black/60 hover:bg-black/80 text-white p-1 transition"
              title={t("common.remove")}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}

        {canAddMore && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="aspect-square rounded-xl border-2 border-dashed border-[var(--border)] hover:border-[var(--accent)] flex flex-col items-center justify-center gap-1 text-muted hover:text-[var(--accent)] transition"
          >
            <Plus className="w-6 h-6" />
            <span className="text-[10.5px]">
              {t("photos.add_more")}
            </span>
          </button>
        )}
      </div>

      {canAddMore && (
        <div className="mt-2 flex items-center gap-3 text-[12px]">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-1.5 text-[var(--accent)]"
          >
            <Upload className="w-3.5 h-3.5" /> {t("photo.pick_file")}
          </button>
          <span className="text-muted">·</span>
          <button
            type="button"
            onClick={() => setCameraOpen(true)}
            className="inline-flex items-center gap-1.5 text-[var(--accent)] hover:underline"
          >
            <Camera className="w-3.5 h-3.5" /> {t("photo.use_camera")}
          </button>
        </div>
      )}

      {hint && !hasAnything && (
        <div className="text-[11.5px] text-muted mt-1.5">{hint}</div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          addFiles(e.target.files);
          // Reset so picking the same file again fires onChange.
          e.target.value = "";
        }}
      />

      {cameraOpen && (
        <CameraCapture
          onCapture={(f) => {
            addFiles([f]);
            setCameraOpen(false);
          }}
          onCancel={() => setCameraOpen(false)}
        />
      )}
    </div>
  );
}
