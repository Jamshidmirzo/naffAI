/**
 * Clipboard helpers for a catalog phone card.
 *
 * We expose THREE flows because Telegram Desktop (and some other messengers)
 * silently drops the `image/*` payload when a `text/plain` payload sits in
 * the same ClipboardItem — they prioritise text on paste. Splitting the UX
 * into "text-only" and "image-only" buttons is the only reliable workaround
 * that works across every messenger we care about.
 *
 * Outcomes:
 *   "full"      — text + image in a single ClipboardItem (works for
 *                 Preview.app / Finder / Word / most desktop apps; MAY be
 *                 stripped to text-only on paste into TG Desktop macOS).
 *   "text_only" — text alone in clipboard.
 *   "image_only"— image alone (no text/plain payload → TG will attach the
 *                 image on paste).
 *
 * Fetch strategy: we always use `cache: "reload"` when pulling the cover
 * image, because a previously cached `<img>` request may have been made
 * WITHOUT `crossOrigin="anonymous"` and therefore carries no CORS metadata
 * in the browser's http cache. A canvas painted from that cached image
 * would be tainted; `fetch` from that cache would look CORS-OK but produce
 * a stale/opaque blob depending on browser. `cache: "reload"` forces a
 * fresh network request with the proper `Origin` header so CORS is
 * evaluated correctly.
 */

export type PhoneQuoteData = {
  text: string;
  cover_image_url: string | null;
};

export type CopyOutcome = "full" | "text_only" | "image_only";

type ClipboardItemCtor = new (items: Record<string, Blob>) => ClipboardItem;

function getClipboardItemCtor(): ClipboardItemCtor | undefined {
  return (globalThis as { ClipboardItem?: unknown }).ClipboardItem as
    | ClipboardItemCtor
    | undefined;
}

async function fetchImageAsPng(url: string): Promise<Blob> {
  // `cache: "reload"` — bypass any prior `<img>`-triggered cache entry that
  // may lack CORS metadata. `mode: "cors"` forces the browser to honour the
  // Access-Control-Allow-Origin header; without it we'd get an opaque blob.
  console.info("[copy] fetch image", url);
  const resp = await fetch(url, {
    mode: "cors",
    credentials: "omit",
    cache: "reload",
  });
  console.info("[copy] fetch status", resp.status, resp.type, resp.headers.get("content-type"));
  if (!resp.ok) throw new Error(`image http ${resp.status}`);
  const blob = await resp.blob();
  console.info("[copy] blob size", blob.size, "type", blob.type);
  if (blob.type === "image/png") return blob;
  // Chrome/Safari only reliably accept image/png in navigator.clipboard.write,
  // so we transcode JPEG/WEBP → PNG via canvas.
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      console.info("[copy] image element loaded", img.width, "x", img.height);
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      if (!ctx) {
        reject(new Error("no canvas ctx"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      c.toBlob((b) => {
        if (b) {
          console.info("[copy] canvas → png", b.size);
          resolve(b);
        } else {
          reject(new Error("toBlob returned null"));
        }
      }, "image/png");
    };
    img.onerror = () => reject(new Error("image element failed to load"));
    img.src = URL.createObjectURL(blob);
  });
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
 * Copy IMAGE ONLY (no text/plain payload in the ClipboardItem). Use this
 * when the operator plans to paste into Telegram — TG prefers text over
 * image when both are present, so a pure-image ClipboardItem is the only
 * way to guarantee the image actually attaches.
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

/**
 * Copy TEXT + IMAGE in a single ClipboardItem. Best for Preview.app / Word /
 * Finder. In Telegram Desktop macOS, image is likely to be dropped on paste
 * (TG chooses text). Falls back to text-only if the image cannot be fetched.
 */
export async function copyPhoneToClipboard(
  data: PhoneQuoteData,
): Promise<CopyOutcome> {
  const textBlob = new Blob([data.text], { type: "text/plain" });
  const items: Record<string, Blob> = { "text/plain": textBlob };

  if (data.cover_image_url) {
    try {
      items["image/png"] = await fetchImageAsPng(data.cover_image_url);
    } catch (err) {
      console.warn("[copy] image fetch failed, falling back to text-only:", err);
    }
  }

  const hasImage = "image/png" in items;
  const ClipboardItemCtor = getClipboardItemCtor();

  if (hasImage && typeof ClipboardItemCtor === "function") {
    try {
      console.info("[copy] writing combined ClipboardItem (text+image)");
      await navigator.clipboard.write([new ClipboardItemCtor(items)]);
      console.info("[copy] combined write ok");
      return "full";
    } catch (err) {
      console.warn("[copy] clipboard.write failed, falling back to text-only:", err);
    }
  }

  try {
    await navigator.clipboard.writeText(data.text);
  } catch (err) {
    console.warn("[copy] writeText fallback failed:", err);
  }
  return "text_only";
}
