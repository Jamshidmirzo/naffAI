/**
 * Clipboard helpers for a catalog phone card.
 *
 * We expose TWO flows because Telegram Desktop (and some other messengers)
 * silently drops one of the payloads (image OR text) when both sit in the
 * same `ClipboardItem` — which one gets dropped is unpredictable across TG
 * versions and platforms. Splitting the UX into "text-only" and "image-only"
 * buttons is the only reliable workaround.
 *
 * Fetch strategy: we pull the cover image via `fetch(url, { mode: "cors" })`
 * → `blob` → `createImageBitmap(blob)` → canvas → PNG blob → ClipboardItem.
 * We never rely on a DOM `<img>` element for the copy path: a cached `<img>`
 * response can lack CORS metadata and taint the canvas, and cross-origin
 * `<img>` state is generally brittle. `cache: "reload"` forces a fresh
 * network request so CORS is re-evaluated cleanly.
 */

export type PhoneQuoteData = {
  text: string;
  cover_image_url: string | null;
};

export type CopyOutcome = "text_only" | "image_only";

type ClipboardItemCtor = new (items: Record<string, Blob>) => ClipboardItem;

function getClipboardItemCtor(): ClipboardItemCtor | undefined {
  return (globalThis as { ClipboardItem?: unknown }).ClipboardItem as
    | ClipboardItemCtor
    | undefined;
}

async function fetchImageAsPng(url: string): Promise<Blob> {
  console.info("[copy] fetch image", url);
  const resp = await fetch(url, {
    mode: "cors",
    credentials: "omit",
    cache: "reload",
  });
  console.info(
    "[copy] fetch status",
    resp.status,
    resp.type,
    resp.headers.get("content-type"),
  );
  if (!resp.ok) throw new Error(`image http ${resp.status}`);
  const blob = await resp.blob();
  console.info("[copy] blob size", blob.size, "type", blob.type);
  if (blob.type === "image/png") return blob;

  // Chrome/Safari only reliably accept `image/png` in `navigator.clipboard.write`,
  // so we transcode JPEG/WEBP → PNG via canvas. We decode the blob with
  // `createImageBitmap` (no DOM `<img>` involved, no CORS state to reason about).
  const bitmap = await createImageBitmap(blob);
  console.info("[copy] bitmap decoded", bitmap.width, "x", bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("no canvas ctx");
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const png: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error("toBlob returned null"));
    }, "image/png");
  });
  console.info("[copy] canvas → png", png.size);
  return png;
}

/**
 * Copy formatted TEXT ONLY. Works everywhere.
 */
export async function copyPhoneTextOnly(
  data: PhoneQuoteData,
): Promise<CopyOutcome> {
  await navigator.clipboard.writeText(data.text);
  return "text_only";
}

/**
 * Copy IMAGE ONLY (no text/plain payload in the ClipboardItem). The operator
 * pastes the image into Telegram as an attachment, then pastes the text as a
 * caption (or as a separate message).
 *
 * Throws on failure — caller should show a specific error message so the
 * operator understands why (CORS, network, missing image).
 */
export async function copyPhoneImageOnly(
  data: PhoneQuoteData,
): Promise<CopyOutcome> {
  if (!data.cover_image_url) {
    throw new Error("no_image");
  }
  const ClipboardItemCtor = getClipboardItemCtor();
  if (typeof ClipboardItemCtor !== "function") {
    throw new Error("ClipboardItem_not_supported");
  }
  const png = await fetchImageAsPng(data.cover_image_url);
  console.info("[copy] writing image-only ClipboardItem", png.size);
  await navigator.clipboard.write([
    new ClipboardItemCtor({ "image/png": png }),
  ]);
  console.info("[copy] image-only write ok");
  return "image_only";
}
