/**
 * One still frame of the operator's own camera track, as a JPEG — the
 * answer to a manager's snapshot request (see livePublisher).
 *
 * `ImageCapture.grabFrame()` reads the track directly, so it works in a
 * background tab; browsers without it (Safari, Firefox) get the frame
 * from a muted off-DOM <video>.
 */

const MAX_SIDE = 1280;
const JPEG_QUALITY = 0.85;
const GRAB_TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`${what} timeout`)), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function grabWithImageCapture(track: MediaStreamTrack): Promise<ImageBitmap | null> {
  const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> } })
    .ImageCapture;
  if (!IC) return null;
  try {
    return await withTimeout(new IC(track).grabFrame(), GRAB_TIMEOUT_MS, "grabFrame");
  } catch {
    return null;
  }
}

async function videoFromTrack(track: MediaStreamTrack): Promise<HTMLVideoElement> {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.srcObject = new MediaStream([track]);
  const ready = new Promise<void>((resolve) => {
    if (v.readyState >= 2 && v.videoWidth > 0) resolve();
    else v.addEventListener("loadeddata", () => resolve(), { once: true });
  });
  await v.play().catch(() => {});
  await withTimeout(ready, GRAB_TIMEOUT_MS, "video frame");
  return v;
}

export async function captureVideoFrame(track: MediaStreamTrack): Promise<Blob> {
  if (!track || track.readyState !== "live") throw new Error("camera track is not live");
  const bitmap = await grabWithImageCapture(track);
  let video: HTMLVideoElement | null = null;
  try {
    let src: CanvasImageSource;
    let w: number;
    let h: number;
    if (bitmap) {
      src = bitmap;
      w = bitmap.width;
      h = bitmap.height;
    } else {
      video = await videoFromTrack(track);
      src = video;
      w = video.videoWidth;
      h = video.videoHeight;
    }
    if (!w || !h) throw new Error("empty frame");
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", JPEG_QUALITY),
    );
  } finally {
    bitmap?.close();
    if (video) {
      video.pause();
      video.srcObject = null;
    }
  }
}
