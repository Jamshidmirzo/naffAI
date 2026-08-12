import { useEffect, useState } from "react";
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

type LeadMatch = {
  id: number;
  full_name: string;
  phone: string;
  status: string;
};

/**
 * Operator's own "New sale" form. Compact + mobile-first.
 * Submits multipart POST /api/sales/ — backend forces status=pending
 * and requires contract_photo for operator role.
 */
export default function OperatorSaleCreate() {
  const t = useT();
  const nav = useNavigate();
  usePageHeader(
    { title: t("op_sale.title_new"), subtitle: t("op_sale.subtitle") },
    [t("op_sale.title_new")],
  );

  const [imei, setImei] = useState("");
  const [model, setModel] = useState("");
  const [amount, setAmount] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [comment, setComment] = useState("");
  const [channelId, setChannelId] = useState<number | null>(null);
  const [contractPhoto, setContractPhoto] = useState<File | null>(null);
  const [leadId, setLeadId] = useState<number | null>(null);
  const [matchedLead, setMatchedLead] = useState<LeadMatch | null>(null);
  const [phoneMatches, setPhoneMatches] = useState<LeadMatch[]>([]);
  const [phoneDropdownOpen, setPhoneDropdownOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
    const digits = clientPhone.replace(/\D/g, "");
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

  const canSubmit =
    imei.length >= 6 &&
    imei.length <= 15 &&
    /^\d+$/.test(imei) &&
    Number(amount) >= 1000 &&
    channelId !== null &&
    !!contractPhoto &&
    !busy;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) {
      setError(t("op_sale.fill_all_fields"));
      return;
    }
    setError("");
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("imei", imei);
      fd.append("phone_model", model || "Не определена");
      fd.append("channel_id", String(channelId));
      fd.append("amount", amount);
      fd.append("client_name", clientName.trim());
      fd.append("client_phone", clientPhone.trim());
      fd.append("comment", comment);
      if (leadId) fd.append("lead_id", String(leadId));
      if (contractPhoto) fd.append("contract_photo", contractPhoto);
      const r = await api.post("/sales/", fd);
      toast.success(t("op_sale.sent_for_review"));
      nav(`/sales/${r.data.id}`);
    } catch (err: any) {
      const d = err.response?.data || {};
      const msg =
        d.detail || d.imei?.[0] || d.contract_photo?.[0] || t("op_sale.save_failed");
      setError(typeof msg === "string" ? msg : t("op_sale.save_failed"));
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
  };
  const unlinkLead = () => {
    setLeadId(null);
    setMatchedLead(null);
  };

  return (
    <div className="max-w-xl mx-auto">
      <form onSubmit={onSubmit} className="nf-card p-5 md:p-7 space-y-5">
        <div>
          <label className="nf-col mb-1.5 block">
            {t("sale_create.imei_label")}
          </label>
          <input
            className="nf-input font-mono tracking-wide"
            value={imei}
            onChange={(e) => setImei(e.target.value.replace(/\D/g, ""))}
            minLength={6}
            maxLength={15}
            placeholder="490154203237518"
            inputMode="numeric"
            autoComplete="off"
            required
          />
        </div>

        <div>
          <label className="nf-col mb-1.5 block">
            {t("sale_create.phone_model")}
          </label>
          <input
            className="nf-input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={t("sale_create.model_ph")}
          />
        </div>

        <div>
          <label className="nf-col mb-1.5 block">{t("op_sale.amount")}</label>
          <NumericInput
            className="nf-input"
            value={amount}
            onChange={setAmount}
            placeholder="5 000 000"
          />
          {Number(amount) > 0 && Number(amount) < 1000 && (
            <div className="text-[11px] text-red-500 mt-1">
              {t("sale_create.min_amount_line")}
            </div>
          )}
        </div>

        <div>
          <label className="nf-col mb-1.5 block">
            {t("sale_create.channel")}
          </label>
          <SingleSelectCombobox
            options={partners.map((p) => ({ id: p.id, label: p.name }))}
            value={channelId}
            allowFreeText={false}
            placeholder={t("op_sale.channel_ph")}
            onChange={(v) => setChannelId(typeof v === "number" ? v : null)}
          />
        </div>

        <div>
          <label className="nf-col mb-1.5 block">
            {t("sale_create.client_name")}
          </label>
          <input
            className="nf-input"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            placeholder={t("sale_create.client_name_ph")}
          />
        </div>

        <div className="relative">
          <label className="nf-col mb-1.5 block">
            {t("sale_create.client_phone")}
          </label>
          {matchedLead ? (
            <div className="nf-input flex items-center justify-between gap-2 !py-2.5">
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
              className="nf-input"
              value={clientPhone}
              onChange={(e) => setClientPhone(e.target.value)}
              placeholder={t("sale_create.client_phone_ph")}
              inputMode="tel"
              autoComplete="off"
            />
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
            className="nf-input"
            rows={2}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>

        <PhotoUploader
          value={contractPhoto}
          onChange={setContractPhoto}
          required
          label={t("op_sale.contract_photo")}
          hint={t("op_sale.contract_photo_hint")}
        />

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
