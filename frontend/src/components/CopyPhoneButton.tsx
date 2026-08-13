/**
 * Copy a catalog phone entry (formatted text + cover photo) to the clipboard
 * as a single ClipboardItem. Operator then paste in TG chat: text + image
 * arrive together.
 *
 * Returns one of:
 *   "full"                — text + image in clipboard (Chrome desktop/Android,
 *                            recent Safari, Firefox 127+ with ClipboardItem)
 *   "text_only"           — text only in clipboard (image fetch/CORS/browser
 *                            support failed; no auto-open, we do not disrupt
 *                            the user with a new tab)
 *
 * NOTE: we intentionally do NOT open the photo in a new tab as a fallback
 * anymore — user feedback (2026-08-13): opening the image forces a manual
 * copy step that defeats the point of the button.
 */

export type PhoneQuoteData = {
  text: string;
  cover_image_url: string | null;
};

async function fetchImageAsPng(url: string): Promise<Blob> {
  // `mode: "cors"` forces the browser to enforce CORS; without ACAO header
  // on the media endpoint this will throw (caught by caller → text_only).
  const resp = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!resp.ok) throw new Error(`image http ${resp.status}`);
  const blob = await resp.blob();
  if (blob.type === "image/png") return blob;
  // Convert on-canvas to PNG so ClipboardItem accepts it — Chrome/Safari
  // only reliably support image/png in navigator.clipboard.write.
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      if (!ctx) {
        reject(new Error("no canvas ctx"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      c.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
        "image/png",
      );
    };
    img.onerror = () => reject(new Error("image element failed to load"));
    img.src = URL.createObjectURL(blob);
  });
}

export type CopyOutcome = "full" | "text_only";

export async function copyPhoneToClipboard(
  data: PhoneQuoteData,
): Promise<CopyOutcome> {
  const textBlob = new Blob([data.text], { type: "text/plain" });
  const items: Record<string, Blob> = { "text/plain": textBlob };

  if (data.cover_image_url) {
    try {
      items["image/png"] = await fetchImageAsPng(data.cover_image_url);
    } catch (err) {
      // Common causes:
      //  - CORS: media origin != frontend origin and nginx has no
      //    Access-Control-Allow-Origin header (nginx serves /media/
      //    directly, bypassing Django's CORS middleware).
      //  - Network error / 403 / 404.
      // In all cases we degrade gracefully to text-only copy.
      if (typeof console !== "undefined") {
        console.warn("[copy] image fetch failed, falling back to text-only:", err);
      }
    }
  }

  const hasImage = "image/png" in items;
  const ClipboardItemCtor = (globalThis as { ClipboardItem?: unknown })
    .ClipboardItem as
    | (new (items: Record<string, Blob>) => unknown)
    | undefined;

  if (hasImage && typeof ClipboardItemCtor === "function") {
    try {
      await navigator.clipboard.write([
        new ClipboardItemCtor(items) as ClipboardItem,
      ]);
      return "full";
    } catch (err) {
      if (typeof console !== "undefined") {
        console.warn(
          "[copy] clipboard.write failed, falling back to text-only:",
          err,
        );
      }
    }
  }

  // Text-only path.
  try {
    await navigator.clipboard.writeText(data.text);
  } catch {
    // ignore — user can still select+copy manually
  }
  return "text_only";
}
