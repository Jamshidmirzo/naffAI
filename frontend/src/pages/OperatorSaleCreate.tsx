import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { usePageHeader } from "../store/page";
import { formatNumber } from "../lib/format";
import NumericInput from "../components/NumericInput";
import PhotoUploader from "../components/PhotoUploader";
import { SingleSelectCombobox } from "../components/SingleSelectCombobox";
import { LEAD_STATUS_BADGE, LEAD_STATUS_LABEL } from "../lib/leads";
import {
  imeiLuhnStatus,
  normalizeUzPhone,
  validateAmount,
  validateChannel,
  validateClientName,
  validateClientPhone,
  validateComment,
  validateContractPhoto,
  validateImei,
  validatePhoneModel,
} from "../lib/validation";

type LeadMatch = {
  id: number;
  full_name: string;
  phone: string;
  status: string;
};

type FieldName =
  | "imei"
  | "phone_model"
  | "amount"
  | "channel_id"
  | "client_name"
  | "client_phone"
  | "comment"
  | "contract_photo";

/**
 * Operator's own "New sale" form. Compact + mobile-first.
 * Submits multipart POST /api/sales/ — backend forces status=pending
 * and requires contract_photo for operator role.
 *
 * All fields are validated on the client BEFORE the request goes out —
 * inline errors appear on blur (or on submit for untouched fields), the
 * submit button stays disabled until every rule passes, and on submit
 * we scroll to the first invalid field so the operator can see what's
 * wrong on a phone screen. Optional empty strings are NOT appended to
 * the FormData so the backend serializer doesn't have to special-case
 * "null-as-string" values.
 */
export default function OperatorSaleCreate() {
  const t = useT();
  const nav = useNavigate();
  usePageHeader(
    { title: t("op_sale.title_new"), subtitle: t("op_sale.subtitle") },
    [t("op_sale.title_new")],
  );

  // Client phone always keeps the +998 country-code prefix so the operator
  // types only the local 9 digits. See `handleClientPhoneChange` below.
  const CLIENT_PHONE_PREFIX = "+998 ";

  const [imei, setImei] = useState("");
  const [model, setModel] = useState("");
  const [amount, setAmount] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState(CLIENT_PHONE_PREFIX);
  const [comment, setComment] = useState("");
  const [channelId, setChannelId] = useState<number | null>(null);
  const [contractPhoto, setContractPhoto] = useState<File | null>(null);
  const [leadId, setLeadId] = useState<number | null>(null);
  const [matchedLead, setMatchedLead] = useState<LeadMatch | null>(null);
  const [phoneMatches, setPhoneMatches] = useState<LeadMatch[]>([]);
  const [phoneDropdownOpen, setPhoneDropdownOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Per-field server-side errors (from DRF 400 response). Cleared when the
  // user edits the corresponding field so they don't linger after a fix.
  const [serverErrors, setServerErrors] = useState<
    Partial<Record<FieldName, string>>
  >({});
  const [touched, setTouched] = useState<Record<FieldName, boolean>>({
    imei: false,
    phone_model: false,
    amount: false,
    channel_id: false,
    client_name: false,
    client_phone: false,
    comment: false,
    contract_photo: false,
  });
  const [submitAttempted, setSubmitAttempted] = useState(false);

  // Reset one field's server-side error — call from every onChange so the
  // red inline message disappears the moment the operator edits the field.
  // Also clears the shared error banner once no server errors remain so
  // the operator gets clean feedback that the fix landed.
  const clearServerError = (f: FieldName) => {
    setServerErrors((prev) => {
      if (!prev[f]) return prev;
      const next = { ...prev };
      delete next[f];
      if (Object.keys(next).length === 0) setError("");
      return next;
    });
  };

  // Keep the "+998 " prefix locked in — the operator types only local
  // digits. If they backspace into the prefix we snap it back so they
  // can't accidentally submit "998 XXX ..." or bare digits.
  const handleClientPhoneChange = (raw: string) => {
    clearServerError("client_phone");
    let v = raw;
    if (!v.startsWith(CLIENT_PHONE_PREFIX)) {
      // Try to preserve the trailing digits the operator was typing.
      const tail = v.replace(/^\+?9?9?8?\s*/, "");
      v = CLIENT_PHONE_PREFIX + tail;
    }
    // Cap total length so the field can't grow unbounded.
    if (v.length > 32) v = v.slice(0, 32);
    setClientPhone(v);
  };

  // Refs to jump to the first invalid field on submit.
  const fieldRefs = useRef<Record<FieldName, HTMLElement | null>>({
    imei: null,
    phone_model: null,
    amount: null,
    channel_id: null,
    client_name: null,
    client_phone: null,
    comment: null,
    contract_photo: null,
  });

  const partnersQ = useQuery({
    queryKey: ["op-partners"],
    queryFn: () => api.get("/channels/?limit=200").then((r) => r.data),
  });
  const partners: { id: number; name: string }[] = partnersQ.data?.results || [];

  // TAC autofill on 15-digit IMEI.
  useEffect(() => {
    if (imei.length === 15 && /^\d+$/.test(imei)) {
      api
        .get(`/imei/${imei}/lookup/`)
        .then((r) => {
          if (r.data.brand || r.data.model) {
            setModel(`${r.data.brand} ${r.data.model}`.trim());
          }
        })
        .catch(() => {});
    }
  }, [imei]);

  // Lead phone-search (debounced 300ms).
  useEffect(() => {
    if (leadId) return;
    // Strip the locked-in "998" country code — search on local digits only
    // so the dropdown doesn't fire on the prefix alone.
    const digits = clientPhone.replace(/\D/g, "").replace(/^998/, "");
    if (digits.length < 4) {
      setPhoneMatches([]);
      setPhoneDropdownOpen(false);
      return;
    }
    const h = window.setTimeout(() => {
      api
        .get(`/leads/phone-search/`, { params: { q: digits } })
        .then((r) => {
          const rows: LeadMatch[] = r.data?.results || [];
          setPhoneMatches(rows);
          setPhoneDropdownOpen(rows.length > 0);
        })
        .catch(() => setPhoneMatches([]));
    }, 300);
    return () => window.clearTimeout(h);
  }, [clientPhone, leadId]);

  // Compute all errors up-front so we can drive both `canSubmit` and the
  // inline messages from the same source of truth.
  const errors: Record<FieldName, string | null> = {
    imei: validateImei(imei),
    phone_model: validatePhoneModel(model),
    amount: validateAmount(amount),
    channel_id: validateChannel(channelId),
    client_name: validateClientName(clientName),
    // If the operator picked a lead, we trust the lead's phone even if
    // it doesn't match the +998 format (legacy imports).
    client_phone: matchedLead ? null : validateClientPhone(clientPhone),
    comment: validateComment(comment),
    contract_photo: validateContractPhoto(contractPhoto),
  };

  const showError = (f: FieldName): string | null => {
    // Client-side error wins if the current value is invalid RIGHT NOW —
    // that's the freshest signal. A stale server-side error on a value
    // that already passes client validation is misleading (the field is
    // "green" as far as we can tell, and we'd otherwise show a red banner
    // that only disappears once the operator re-touches the field).
    if (errors[f]) {
      if (submitAttempted || touched[f]) return t(errors[f] as string);
      return null;
    }
    // Client validation passes → surface any server-side error we still
    // have on file. `onSubmit` wipes serverErrors before validating, so
    // anything left here is from the *most recent* backend response.
    if (serverErrors[f]) return serverErrors[f] as string;
    return null;
  };

  const markTouched = (f: FieldName) =>
    setTouched((prev) => (prev[f] ? prev : { ...prev, [f]: true }));

  const setRef = (f: FieldName) => (el: HTMLElement | null) => {
    fieldRefs.current[f] = el;
  };

  const canSubmit =
    !busy && Object.values(errors).every((e) => e === null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitAttempted(true);
    // Wipe previous server-side errors and banner: we're about to make a
    // fresh POST, so any leftover red messages from an earlier attempt
    // ("channel_id — не число", "amount — required") are guaranteed to
    // be stale. If the new POST also fails we'll repopulate serverErrors
    // from the response; if it succeeds we redirect away.
    setServerErrors({});
    setError("");
    if (!canSubmit) {
      // Find first invalid field and scroll into view.
      const order: FieldName[] = [
        "imei",
        "phone_model",
        "amount",
        "channel_id",
        "client_name",
        "client_phone",
        "comment",
        "contract_photo",
      ];
      const firstBad = order.find((f) => errors[f] !== null);
      if (firstBad) {
        const el = fieldRefs.current[firstBad];
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          if (typeof (el as HTMLInputElement).focus === "function") {
            try {
              (el as HTMLInputElement).focus({ preventScroll: true });
            } catch {
              /* older browsers */
            }
          }
        }
        setError(t(errors[firstBad] as string));
      }
      return;
    }
    setError("");
    setBusy(true);
    try {
      const fd = new FormData();
      // Required scalars — validators above guarantee non-empty.
      fd.append("imei", imei);
      fd.append("phone_model", model.trim());
      fd.append("channel_id", String(channelId));
      fd.append("amount", amount);
      fd.append("client_name", clientName.trim());
      // Send phone in canonical form so backend + dedup see the same thing.
      const phoneOut = matchedLead
        ? matchedLead.phone
        : normalizeUzPhone(clientPhone);
      fd.append("client_phone", phoneOut);
      // Optional — skip the key entirely if empty so the backend
      // serializer's `allow_blank=True` default kicks in cleanly.
      if (comment.trim()) fd.append("comment", comment.trim());
      if (leadId) fd.append("lead_id", String(leadId));
      if (contractPhoto) fd.append("contract_photo", contractPhoto);

      const r = await api.post("/sales/", fd);
      toast.success(t("op_sale.sent_for_review"));
      nav(`/sales/${r.data.id}`);
    } catch (err: any) {
      // Map DRF's per-field error dict onto our inline-error state so
      // the operator sees a red message right under the offending input,
      // not just a vague banner. Backend already uses snake_case that
      // matches our FieldName union, so no camelCase translation needed.
      const d = err.response?.data || {};
      const fields: FieldName[] = [
        "imei",
        "phone_model",
        "amount",
        "channel_id",
        "client_name",
        "client_phone",
        "comment",
        "contract_photo",
      ];
      const collected: Partial<Record<FieldName, string>> = {};
      const localizeMsg = (raw: string): string => {
        const s = (raw || "").trim();
        // DRF's default English messages — localize the two most common,
        // pass the rest through (backend already returns Russian for our
        // custom validators).
        if (s === "Not a valid string.") return t("validation.generic_invalid");
        if (s === "This field is required.")
          return t("validation.generic_required");
        if (s === "This field may not be blank.")
          return t("validation.generic_required");
        return s;
      };
      for (const f of fields) {
        const raw = d[f];
        if (!raw) continue;
        const first = Array.isArray(raw) ? raw[0] : raw;
        if (typeof first === "string") collected[f] = localizeMsg(first);
      }
      // Backend `ApplicationError` returns `{"detail": "...", "field": "amount"}`
      // (single-field, not the DRF per-field dict). Route it into the same
      // inline-error map so the operator gets a red message under the exact
      // input instead of a vague top-banner.
      if (typeof d.field === "string" && typeof d.detail === "string") {
        const f = d.field as FieldName;
        if (fields.includes(f) && !collected[f]) {
          collected[f] = localizeMsg(d.detail);
        }
      }
      if (Object.keys(collected).length > 0) {
        setServerErrors(collected);
        setError(t("op_sale.check_marked_fields"));
        // Scroll to the first offending field so a phone-screen operator
        // sees the red inline message without hunting.
        const firstBad = fields.find((f) => collected[f]);
        if (firstBad) {
          const el = fieldRefs.current[firstBad];
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            if (typeof (el as HTMLInputElement).focus === "function") {
              try {
                (el as HTMLInputElement).focus({ preventScroll: true });
              } catch {
                /* older browsers */
              }
            }
          }
        }
      } else {
        // Non-field error (permissions, 5xx, network) — fall back to a
        // banner-only message.
        const detail =
          typeof d.detail === "string"
            ? d.detail
            : typeof d.non_field_errors?.[0] === "string"
              ? d.non_field_errors[0]
              : null;
        setError(detail || t("op_sale.save_failed"));
      }
    } finally {
      setBusy(false);
    }
  };

  const pickLead = (lead: LeadMatch) => {
    setLeadId(lead.id);
    setMatchedLead(lead);
    setClientName(lead.full_name || clientName);
    setClientPhone(lead.phone || clientPhone);
    setPhoneDropdownOpen(false);
    setPhoneMatches([]);
    clearServerError("client_name");
    clearServerError("client_phone");
    markTouched("client_name");
    markTouched("client_phone");
  };
  const unlinkLead = () => {
    setLeadId(null);
    setMatchedLead(null);
    // If we had preserved the lead's phone verbatim (might not match the
    // +998 canonical form), reset the input to the locked prefix so the
    // operator sees the familiar placeholder-like state again.
    setClientPhone(CLIENT_PHONE_PREFIX);
  };

  // Live IMEI status hint (before/at 15 digits).
  // NB: Luhn failure is a *warning*, not an error — submit stays enabled.
  // Real-world refurb/grey-market IMEIs sometimes fail Luhn but are valid.
  const imeiHint = (() => {
    if (!imei) return null;
    if (imei.length < 15)
      return { tone: "muted", text: `${imei.length}/15` } as const;
    const st = imeiLuhnStatus(imei);
    if (st === "warn")
      return { tone: "warn", text: t("validation.imei_luhn_warn") } as const;
    return { tone: "ok", text: t("validation.imei_valid") } as const;
  })();

  return (
    <div className="max-w-xl mx-auto">
      <form
        onSubmit={onSubmit}
        noValidate
        className="nf-card p-5 md:p-7 space-y-5"
      >
        <div>
          <label className="nf-col mb-1.5 block">
            {t("sale_create.imei_label")}{" "}
            <span className="text-red-500">*</span>
          </label>
          <input
            ref={setRef("imei")}
            className={`nf-input font-mono tracking-wide ${
              showError("imei") ? "border-red-500" : ""
            }`}
            value={imei}
            onChange={(e) => {
              setImei(e.target.value.replace(/\D/g, ""));
              clearServerError("imei");
            }}
            onBlur={() => markTouched("imei")}
            maxLength={15}
            placeholder="490154203237518"
            inputMode="numeric"
            autoComplete="off"
          />
          {imeiHint && !showError("imei") && (
            <div
              className={`text-[11.5px] mt-1 ${
                imeiHint.tone === "warn"
                  ? "text-amber-500"
                  : imeiHint.tone === "ok"
                    ? "text-emerald-500"
                    : "text-muted"
              }`}
            >
              {imeiHint.text}
            </div>
          )}
          {showError("imei") && (
            <div className="text-[11.5px] text-red-500 mt-1">
              {showError("imei")}
            </div>
          )}
        </div>

        <div>
          <label className="nf-col mb-1.5 block">
            {t("sale_create.phone_model")}{" "}
            <span className="text-red-500">*</span>
          </label>
          <input
            ref={setRef("phone_model")}
            className={`nf-input ${
              showError("phone_model") ? "border-red-500" : ""
            }`}
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              clearServerError("phone_model");
            }}
            onBlur={() => markTouched("phone_model")}
            placeholder={t("sale_create.model_ph")}
            maxLength={128}
          />
          {showError("phone_model") && (
            <div className="text-[11.5px] text-red-500 mt-1">
              {showError("phone_model")}
            </div>
          )}
        </div>

        <div>
          <label className="nf-col mb-1.5 block">
            {t("op_sale.amount")} <span className="text-red-500">*</span>
          </label>
          <div ref={setRef("amount")}>
            <NumericInput
              className={`nf-input ${
                showError("amount") ? "border-red-500" : ""
              }`}
              value={amount}
              onChange={(v) => {
                setAmount(v);
                clearServerError("amount");
                if (!touched.amount && v) markTouched("amount");
              }}
              placeholder="5 000 000"
            />
          </div>
          {showError("amount") && (
            <div className="text-[11.5px] text-red-500 mt-1">
              {showError("amount")}
            </div>
          )}
        </div>

        <div>
          <label className="nf-col mb-1.5 block">
            {t("sale_create.channel")}{" "}
            <span className="text-red-500">*</span>
          </label>
          <div ref={setRef("channel_id")}>
            <SingleSelectCombobox
              options={partners.map((p) => ({ id: p.id, label: p.name }))}
              value={channelId}
              allowFreeText={false}
              placeholder={t("op_sale.channel_ph")}
              onChange={(v) => {
                setChannelId(typeof v === "number" ? v : null);
                clearServerError("channel_id");
                markTouched("channel_id");
              }}
            />
          </div>
          {showError("channel_id") && (
            <div className="text-[11.5px] text-red-500 mt-1">
              {showError("channel_id")}
            </div>
          )}
        </div>

        <div>
          <label className="nf-col mb-1.5 block">
            {t("sale_create.client_name")}{" "}
            <span className="text-red-500">*</span>
          </label>
          <input
            ref={setRef("client_name")}
            className={`nf-input ${
              showError("client_name") ? "border-red-500" : ""
            }`}
            value={clientName}
            onChange={(e) => {
              setClientName(e.target.value);
              clearServerError("client_name");
            }}
            onBlur={() => markTouched("client_name")}
            placeholder={t("sale_create.client_name_ph")}
            maxLength={128}
          />
          {showError("client_name") && (
            <div className="text-[11.5px] text-red-500 mt-1">
              {showError("client_name")}
            </div>
          )}
        </div>

        <div className="relative">
          <label className="nf-col mb-1.5 block">
            {t("sale_create.client_phone")}{" "}
            <span className="text-red-500">*</span>
          </label>
          {matchedLead ? (
            <div
              ref={setRef("client_phone")}
              className="nf-input flex items-center justify-between gap-2 !py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium truncate">
                  {matchedLead.full_name || "—"}
                  <span className="text-muted font-normal ml-2">
                    {matchedLead.phone}
                  </span>
                </div>
                <div className="text-[11px] text-muted mt-0.5">
                  {LEAD_STATUS_LABEL[matchedLead.status] || matchedLead.status}
                </div>
              </div>
              <button
                type="button"
                onClick={unlinkLead}
                className="text-muted hover:text-text"
              >
                ✕
              </button>
            </div>
          ) : (
            <input
              ref={setRef("client_phone")}
              className={`nf-input ${
                showError("client_phone") ? "border-red-500" : ""
              }`}
              value={clientPhone}
              onChange={(e) => handleClientPhoneChange(e.target.value)}
              onFocus={(e) => {
                // If the field is at its default prefix, park the caret
                // at the end so the operator starts typing digits, not
                // in the middle of "+998 ".
                if (clientPhone === CLIENT_PHONE_PREFIX) {
                  const el = e.currentTarget;
                  requestAnimationFrame(() => {
                    try {
                      el.setSelectionRange(el.value.length, el.value.length);
                    } catch {
                      /* selection API not supported */
                    }
                  });
                }
              }}
              onBlur={() => markTouched("client_phone")}
              placeholder={t("sale_create.client_phone_ph")}
              inputMode="tel"
              autoComplete="off"
              maxLength={32}
            />
          )}
          {!matchedLead && showError("client_phone") && (
            <div className="text-[11.5px] text-red-500 mt-1">
              {showError("client_phone")}
            </div>
          )}
          {phoneDropdownOpen && !matchedLead && phoneMatches.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 z-30 nf-card overflow-hidden">
              <div className="max-h-64 overflow-y-auto py-1">
                {phoneMatches.map((lead) => (
                  <button
                    key={lead.id}
                    type="button"
                    onClick={() => pickLead(lead)}
                    className="w-full text-left px-3.5 py-2.5 hover:bg-[var(--faint)] transition"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-[13.5px] font-medium truncate">
                          {lead.full_name || "—"}
                        </div>
                        <div className="text-[11.5px] text-muted truncate mt-0.5">
                          {lead.phone}
                        </div>
                      </div>
                      <span
                        className={`text-[10.5px] px-2 py-0.5 rounded-full flex-shrink-0 ${
                          LEAD_STATUS_BADGE[lead.status] ||
                          "bg-[var(--faint2)] text-muted"
                        }`}
                      >
                        {LEAD_STATUS_LABEL[lead.status] || lead.status}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div>
          <label className="nf-col mb-1.5 block">
            {t("sale_create.comment_label")}
          </label>
          <textarea
            ref={setRef("comment")}
            className={`nf-input ${
              showError("comment") ? "border-red-500" : ""
            }`}
            rows={2}
            value={comment}
            onChange={(e) => {
              setComment(e.target.value);
              clearServerError("comment");
            }}
            onBlur={() => markTouched("comment")}
            maxLength={500}
          />
          <div className="flex justify-between items-center mt-1 gap-2">
            <div className="text-[11.5px] text-red-500">
              {showError("comment")}
            </div>
            <div className="text-[11px] text-muted tabular-nums">
              {comment.length}/500
            </div>
          </div>
        </div>

        <div ref={setRef("contract_photo")}>
          <PhotoUploader
            value={contractPhoto}
            onChange={(f) => {
              setContractPhoto(f);
              clearServerError("contract_photo");
              markTouched("contract_photo");
            }}
            required
            label={t("op_sale.contract_photo")}
            hint={t("op_sale.contract_photo_hint")}
          />
          {showError("contract_photo") && (
            <div className="text-[11.5px] text-red-500 mt-1">
              {showError("contract_photo")}
            </div>
          )}
        </div>

        {Number(amount) > 0 && (
          <div className="nf-tile p-3.5 flex justify-between items-baseline">
            <span className="text-muted text-[13px]">
              {t("op_sale.amount_summary")}
            </span>
            <span className="text-[18px] font-semibold tabular-nums">
              {formatNumber(Number(amount))} сум
            </span>
          </div>
        )}

        {error && (
          <div className="text-[13px] text-red-500 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-2.5">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-3 border-t border-[var(--border)]">
          <button
            type="button"
            className="nf-btn nf-btn--ghost"
            onClick={() => nav(-1)}
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            className="nf-btn nf-btn--primary"
            disabled={!canSubmit}
          >
            {busy ? t("common.loading") : t("op_sale.send_for_review")}
          </button>
        </div>
      </form>
    </div>
  );
}
