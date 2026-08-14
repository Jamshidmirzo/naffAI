/**
 * Small pure-function validators for sale-form inputs. No external deps.
 * Backend still re-validates everything — this file just gates the UI
 * so we never fire off a request that we already know will 400.
 *
 * All functions return `null` on success, or a locale-key string on
 * failure. Callers translate the key via `useT()` so error text stays
 * in one place (`src/lib/i18n.ts`).
 */

/** Luhn checksum on a 15-digit IMEI (final digit is the check digit). */
export function isLuhnValid(imei: string): boolean {
  if (!/^\d{15}$/.test(imei)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let n = imei.charCodeAt(i) - 48;
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** Strip anything that isn't a digit — used by phone/imei normalizers. */
export function digitsOnly(s: string): string {
  return (s || "").replace(/\D/g, "");
}

/**
 * Uzbek mobile number in canonical form. Backend accepts anything as
 * a string, but we want operators to always type the international
 * form so the phone is dial-ready and dedup works.
 *
 *   +998 XX XXX XX XX  →  +998XXXXXXXXX (12 digits total after +)
 */
export function normalizeUzPhone(raw: string): string {
  const d = digitsOnly(raw);
  if (!d) return "";
  // Accept "8XXXXXXXXX" (9 digits, no country code — legacy paste),
  // "998XXXXXXXXX" (already CC-prefixed), or "XXXXXXXXX" (bare 9).
  if (d.length === 9) return `+998${d}`;
  if (d.length === 12 && d.startsWith("998")) return `+${d}`;
  if (d.length === 13 && d.startsWith("9989")) return `+${d.slice(0, 12)}`;
  return `+${d}`;
}

export type FieldError = string | null;

/**
 * Hard-error validator for IMEI. Luhn mismatch is intentionally NOT
 * a hard error — real-world IMEIs on refurb/grey-market phones sometimes
 * fail Luhn even though the device is legit. The UI shows a yellow
 * warning (via `imeiLuhnStatus` below) so the operator can double-check
 * a typo, but submit stays enabled.
 */
export function validateImei(imei: string): FieldError {
  if (!imei) return "validation.imei_required";
  if (!/^\d+$/.test(imei)) return "validation.imei_digits_only";
  if (imei.length !== 15) return "validation.imei_length";
  return null;
}

/**
 * Soft state for the 15-digit IMEI, used purely to drive a hint line
 * under the input. Only meaningful once we have 15 digits — otherwise
 * the character-counter hint takes over.
 *
 *  - "ok"    → 15 digits + Luhn passes  (green, "IMEI валиден")
 *  - "warn"  → 15 digits + Luhn fails   (yellow, "может быть опечатка")
 *  - null    → too short / non-digits — nothing to say yet
 */
export function imeiLuhnStatus(imei: string): "ok" | "warn" | null {
  if (!/^\d{15}$/.test(imei)) return null;
  return isLuhnValid(imei) ? "ok" : "warn";
}

export function validatePhoneModel(model: string): FieldError {
  const v = (model || "").trim();
  if (!v) return "validation.model_required";
  if (v.length < 2) return "validation.model_short";
  if (v.length > 128) return "validation.model_long";
  return null;
}

export function validateAmount(amount: string): FieldError {
  if (!amount) return "validation.amount_required";
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return "validation.amount_positive";
  if (n < 1000) return "validation.amount_min";
  if (n > 1_000_000_000) return "validation.amount_max";
  if (!Number.isInteger(n)) return "validation.amount_integer";
  return null;
}

export function validateChannel(channelId: number | null): FieldError {
  if (channelId == null) return "validation.channel_required";
  return null;
}

export function validateClientName(name: string): FieldError {
  const v = (name || "").trim();
  if (!v) return "validation.name_required";
  if (v.length < 2) return "validation.name_short";
  if (v.length > 128) return "validation.name_long";
  return null;
}

/**
 * Client phone: must be +998 + 9 digits after normalization.
 * We validate against the normalized form so users can paste any of
 * the common variants and still pass.
 */
export function validateClientPhone(raw: string): FieldError {
  const v = (raw || "").trim();
  if (!v) return "validation.phone_required";
  const norm = normalizeUzPhone(v);
  if (!/^\+998\d{9}$/.test(norm)) return "validation.phone_uz_format";
  return null;
}

export function validateComment(comment: string): FieldError {
  if (!comment) return null; // optional
  if (comment.length > 500) return "validation.comment_long";
  return null;
}

/** Max ~10 MB, image/* only. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const ALLOWED_PHOTO_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

export function validateContractPhoto(file: File | null): FieldError {
  if (!file) return "validation.photo_required";
  if (file.size > MAX_PHOTO_BYTES) return "validation.photo_too_big";
  // Some browsers report empty type for pasted blobs — fall back to
  // "starts with image/" check we already do inside PhotoUploader, so
  // here we only reject non-image files that made it through.
  if (file.type && !file.type.startsWith("image/")) {
    return "validation.photo_type";
  }
  if (file.type && !ALLOWED_PHOTO_TYPES.includes(file.type)) {
    // Not fatal — allow unknown image/* subtypes (browser will render).
  }
  return null;
}
