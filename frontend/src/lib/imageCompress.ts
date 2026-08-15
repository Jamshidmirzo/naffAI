/**
 * Client-side JPEG compression helper for attendance photo uploads.
 *
 * Why: raw phone photos are 2-5 MB. On the shop's mobile Wi-Fi that
 * takes 3-10 s per upload — and any hiccup mid-transfer means the user
 * taps «Отправить» again, backend gets the same phash, and hits our
 * "photo already used" reject unless we also debounce server-side.
 *
 * By downscaling to 1024 px on the longer side + JPEG quality 0.8 we
 * shrink to ~120-350 KB with no visible loss for a selfie thumbnail.
 * Combined with the backend idempotency guard (30s phash window) this
 * makes the flow feel snappy and eliminates double-submit rejections.
 *
 * Falls back to the original file on any exception so a broken decoder
 * (Live Photos, HEIC without polyfill, etc.) doesn't block check-in.
 */

export interface CompressOptions {
  /** Longest side in px. Default 1024. */
  maxSide?: number;
  /** JPEG quality 0..1. Default 0.8. */
  quality?: number;
  /** Skip compression if input already smaller than this (bytes). Default 300 KB. */
  minBytesToCompress?: number;
}

const DEFAULTS: Required<CompressOptions> = {
  maxSide: 1024,
  quality: 0.8,
  minBytesToCompress: 300 * 1024,
};

export async function compressImageFile(
  file: File,
  opts: CompressOptions = {},
): Promise<File> {
  const { maxSide, quality, minBytesToCompress } = { ...DEFAULTS, ...opts };

  // Skip work for already-tiny photos (client-camera path pre-shrinks).
  if (file.size <= minBytesToCompress) return file;

  const bitmap = await loadBitmap(file);
  if (!bitmap) return file;

  const { width, height } = bitmap;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : (() => {
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          return c;
        })();

  const ctx = (canvas as any).getContext("2d");
  if (!ctx) {
    (bitmap as ImageBitmap).close?.();
    return file;
  }
  ctx.drawImage(bitmap as any, 0, 0, w, h);
  (bitmap as ImageBitmap).close?.();

  const blob = await canvasToJpeg(canvas as any, quality);
  if (!blob) return file;

  // Only return the compressed file if it's actually smaller.
  if (blob.size >= file.size) return file;

  const baseName = file.name.replace(/\.(jpe?g|png|heic|webp)$/i, "");
  return new File([blob], `${baseName || "photo"}.jpg`, {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement | null> {
  // createImageBitmap is fast + off-main-thread on modern browsers.
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through */
    }
  }
  // Fallback: <img> via object URL.
  return await new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

async function canvasToJpeg(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  quality: number,
): Promise<Blob | null> {
  if ("convertToBlob" in canvas) {
    try {
      return await (canvas as OffscreenCanvas).convertToBlob({
        type: "image/jpeg",
        quality,
      });
    } catch {
      return null;
    }
  }
  return await new Promise((resolve) => {
    (canvas as HTMLCanvasElement).toBlob((b) => resolve(b), "image/jpeg", quality);
  });
}
