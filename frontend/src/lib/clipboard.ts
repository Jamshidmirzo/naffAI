import { fetchImageAsPng } from "../components/CopyPhoneButton";

/**
 * Copy text to the clipboard in a way that survives Safari/iOS quirks.
 *
 * The modern `navigator.clipboard.writeText` returns a Promise, so a sync
 * try/catch around it never catches the "not allowed" rejection. Worse,
 * on iOS Safari the promise-based API refuses the write if the click
 * handler awaits anything before calling it — the user-gesture flag
 * expires the moment execution suspends.
 *
 * Strategy:
 *  1. Prefer `navigator.clipboard.writeText` when the page is secure and
 *     the API exists. Return its Promise so callers can `await` it.
 *  2. On rejection (permission blocked, non-secure iframe, etc.) fall
 *     back to the ancient `document.execCommand('copy')` textarea trick,
 *     which is officially deprecated but still works reliably in every
 *     browser that has ever shipped a clipboard, including iOS Safari
 *     as long as the call happens inside a user-gesture handler.
 *  3. If both paths fail, reject so the caller can toast an error.
 */
export async function copyText(text: string): Promise<void> {
  const value = text ?? "";
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function" &&
    window.isSecureContext
  ) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (err) {
      // fall through to legacy path
      if (!legacyCopy(value)) throw err;
      return;
    }
  }
  if (legacyCopy(value)) return;
  throw new Error("Clipboard API unavailable");
}

/**
 * Copy an arbitrary image URL to the clipboard as `image/png`. Reuses
 * the fetch → canvas → PNG transcoder from CopyPhoneButton so we don't
 * ship the same clipboard shape twice. Callers only need to pass the
 * URL — no PhoneQuoteData wrapper required.
 */
export async function copyImageByUrl(url: string): Promise<void> {
  if (!url) throw new Error("empty_url");
  const ClipboardItemCtor = (
    globalThis as { ClipboardItem?: unknown }
  ).ClipboardItem as
    | (new (items: Record<string, Blob>) => ClipboardItem)
    | undefined;
  if (typeof ClipboardItemCtor !== "function") {
    throw new Error("ClipboardItem_not_supported");
  }
  const png = await fetchImageAsPng(url);
  await navigator.clipboard.write([
    new ClipboardItemCtor({ "image/png": png }),
  ]);
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  // Off-screen but focusable — needed for execCommand('copy') to see a
  // valid selection.
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.width = "1px";
  ta.style.height = "1px";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  document.body.appendChild(ta);
  const prevSelection = document.getSelection()?.rangeCount
    ? document.getSelection()!.getRangeAt(0)
    : null;
  try {
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    return ok;
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
    if (prevSelection) {
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(prevSelection);
    }
  }
}
