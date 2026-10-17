/**
 * 360° spin upload helpers (catalog editor → POST /catalog/phones/<id>/spin/).
 *
 * A turntable shoot is 8–120 photos straight from a camera (5–20 MB each).
 * Before upload every frame is downscaled in the browser to ≤1600 px wide
 * and re-encoded as WebP 0.85 (JPEG where the browser can't encode WebP),
 * so a 72-frame set goes up as ~10 MB instead of ~700 MB. The backend
 * re-encodes to its own 1200 px WebP anyway — this is purely about the
 * request size (nginx body limit, shop Wi-Fi).
 *
 * File names are kept (only the extension changes): the server orders
 * frames by natural sort of the original names (1, 2, … 10).
 */

export const SPIN_MIN_FRAMES = 8;
export const SPIN_MAX_FRAMES = 120;
const MAX_WIDTH = 1600;
const QUALITY = 0.85;
const PARALLEL = 4;

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif|avif)$/i;

export function isImageFile(f: File): boolean {
  return f.type.startsWith("image/") || IMAGE_EXT_RE.test(f.name);
}

/** `frame2.jpg` before `frame10.jpg` — same order the server uses. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

/**
 * Downscale one frame. Falls back to the original file if the browser
 * can't decode it (HEIC on Chrome, broken file) — the server then
 * decides (and answers 400 with the file name if Pillow can't read it).
 */
export async function downscaleSpinFrame(file: File): Promise<File> {
  let bitmap: ImageBitmap;
  try {
    // Applies EXIF orientation by default ("from-image").
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = Math.min(1, MAX_WIDTH / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return file;
  }
  // Transparent PNG → white, same as the server does (JPEG has no alpha).
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  let blob = await canvasToBlob(canvas, "image/webp", QUALITY);
  let ext = "webp";
  // Old Safari silently returns PNG for an unsupported type.
  if (!blob || blob.type !== "image/webp") {
    blob = await canvasToBlob(canvas, "image/jpeg", QUALITY);
    ext = "jpg";
  }
  if (!blob) return file;
  if (scale === 1 && blob.size >= file.size) return file;
  const base = file.name.replace(/\.[^.]+$/, "") || "frame";
  return new File([blob], `${base}.${ext}`, { type: blob.type, lastModified: Date.now() });
}

/** Downscale all frames (a few in parallel), keeping the input order. */
export async function prepareSpinFrames(
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<File[]> {
  const out: File[] = new Array(files.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      out[i] = await downscaleSpinFrame(files[i]);
      done += 1;
      onProgress?.(done, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, files.length) }, worker));
  return out;
}

// --- Drag & drop of a whole folder -----------------------------------------

function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    // readEntries returns results in batches (100 in Chrome) — call until empty.
    const step = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        step();
      }, reject);
    step();
  });
}

async function entryFiles(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve) =>
      (entry as FileSystemFileEntry).file(
        (f) => resolve([f]),
        () => resolve([]),
      ),
    );
  }
  if (entry.isDirectory) {
    const children = await readAllEntries(entry as FileSystemDirectoryEntry);
    const nested = await Promise.all(children.map(entryFiles));
    return nested.flat();
  }
  return [];
}

/** Files from a drop — plain files and/or folders (recursively). */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items || [])
    .filter((it) => it.kind === "file")
    .map((it) => it.webkitGetAsEntry?.() ?? null);
  if (entries.length > 0 && entries.every((e) => e !== null)) {
    const nested = await Promise.all((entries as FileSystemEntry[]).map(entryFiles));
    return nested.flat();
  }
  return Array.from(dt.files || []);
}
