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
  // Defensive: even though our `NumericInput` stores raw digits only, the
  // form state could still receive a pasted "2 345 654" string in edit-mode
  // or from a stale keydown handler. Strip whitespace before parsing so we
  // never emit a "required numeric" error on what the operator sees as a
  // perfectly-typed amount.
  const clean = (amount || "").replace(/\s+/g, "");
  if (!clean) return "validation.amount_required";
  const n = Number(clean);
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

// Any Unicode letter (Cyrillic / Latin / Uzbek diacritics). We match on
// letter-*presence* rather than a strict pattern so users can freely mix
// hyphens, apostrophes, and multi-part names ("O'zodbek", "Anna-Maria").
// The RegExp uses the `u` flag + `\p{L}` — supported everywhere we ship
// (Chrome ≥64, Safari ≥12, all modern mobile browsers).
const HAS_LETTER_RE = /\p{L}/u;

export function validateClientName(name: string): FieldError {
  const v = (name || "").trim();
  if (!v) return "validation.name_required";
  if (v.length < 2) return "validation.name_short";
  if (v.length > 128) return "validation.name_long";
  // Reject names that are digits/punctuation only ("2345432fdsa" fails here
  // because backend accepted it silently, letting garbage into leads).
  if (!HAS_LETTER_RE.test(v)) return "validation.name_letters_required";
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

/**
 * Multi-photo variant used by the new PhotosUploader on OperatorSaleCreate.
 * Requires ≥ 1 photo (operator submits pending sale — proof of contract),
 * caps at `max`, and verifies each individual file.
 */
export function validateContractPhotos(
  files: File[],
  max: number = 5,
): FieldError {
  if (!files || files.length === 0) return "validation.photo_required";
  if (files.length > max) return "validation.photos_too_many";
  for (const f of files) {
    const single = validateContractPhoto(f);
    if (single) return single;
  }
  return null;
}

/**
 * Multi-channel payment-split validator. Rules:
 *   - at least one row with a chosen channel
 *   - length ≤ `max` (backend cap: 2)
 *   - no duplicate channels across rows
 *   - in split-mode (>1 row) each row's amount must be positive AND the
 *     sum of row amounts must equal the total `amount` — otherwise the
 *     backend rejects the sale with a hard error
 * Single-channel rows don't need a per-row amount — the total field is
 * authoritative and the backend copies it via the `channel_id` fallback.
 */
export function validatePartnerSplit(
  rows: { channel_id: number | null; amount: string }[],
  totalAmount: string,
  max: number = 2,
): FieldError {
  if (!rows || rows.length === 0) return "validation.channel_required";
  if (rows.length > max) return "validation.payment_split_too_many";
  const chosen = rows.filter((r) => r.channel_id != null);
  if (chosen.length === 0) return "validation.channel_required";
  if (chosen.length !== rows.length) return "validation.channel_required";
  const uniqueChannels = new Set(chosen.map((r) => r.channel_id));
  if (uniqueChannels.size !== chosen.length) {
    return "validation.payment_split_dup_channel";
  }
  // Single-channel: skip the per-row amount check — total is authoritative.
  if (rows.length <= 1) return null;
  const total = Number((totalAmount || "").replace(/\s+/g, ""));
  if (!Number.isFinite(total) || total <= 0) return null; // amount-field owns this
  let sum = 0;
  for (const r of rows) {
    const n = Number((r.amount || "").replace(/\s+/g, ""));
    if (!Number.isFinite(n) || n <= 0) return "validation.payment_split_amount_required";
    if (!Number.isInteger(n)) return "validation.payment_split_amount_integer";
    sum += n;
  }
  if (sum !== total) return "validation.payment_split_sum_mismatch";
  return null;
}
