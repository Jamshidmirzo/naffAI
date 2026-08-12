/**
 * Copy a catalog phone entry (formatted text + cover photo) to the clipboard
 * as a single ClipboardItem. Operator then paste in TG chat: text + image
 * arrive together.
 *
 * Returns one of:
 *   "full"                — text + image in clipboard (Chrome desktop/Android)
 *   "text_photo_opened"   — text only in clipboard, photo opened in new tab
 *                            as fallback (Safari mobile)
 *   "text_only"           — text only, no photo attached
 */

export type PhoneQuoteData = {
  text: string;
  cover_image_url: string | null;
};

async function fetchImageAsPng(url: string): Promise<Blob> {
  const resp = await fetch(url, { mode: "cors" });
  const blob = await resp.blob();
  if (blob.type === "image/png") return blob;
  // Convert on-canvas to PNG so ClipboardItem accepts it — Chrome only
  // supports image/png in navigator.clipboard.write.
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      if (!ctx) {
        reject(new Error("no canvas"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png");
    };
    img.onerror = () => reject(new Error("img load"));
    img.src = URL.createObjectURL(blob);
  });
}

export async function copyPhoneToClipboard(
  data: PhoneQuoteData,
): Promise<"full" | "text_photo_opened" | "text_only"> {
  const textBlob = new Blob([data.text], { type: "text/plain" });

  const items: Record<string, Blob> = { "text/plain": textBlob };

  if (data.cover_image_url) {
    try {
      const imgBlob = await fetchImageAsPng(data.cover_image_url);
      items["image/png"] = imgBlob;
    } catch {
      // fallthrough to text-only + open-photo fallback below
    }
  }

  const hasImage = "image/png" in items;

  if (hasImage && typeof (globalThis as any).ClipboardItem === "function") {
    try {
      const ClipboardItemCtor = (globalThis as any).ClipboardItem as {
        new (items: Record<string, Blob>): unknown;
      };
      await navigator.clipboard.write([new ClipboardItemCtor(items) as any]);
      return "full";
    } catch {
      // fall through to text-only
    }
  }

  // Text-only path.
  try {
    await navigator.clipboard.writeText(data.text);
  } catch {
    // ignore — user can select+copy manually
  }

  if (data.cover_image_url) {
    try {
      window.open(data.cover_image_url, "_blank");
    } catch {
      /* noop */
    }
    return "text_photo_opened";
  }
  return "text_only";
}
