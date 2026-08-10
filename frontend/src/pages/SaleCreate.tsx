import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { SingleSelectCombobox } from "../components/SingleSelectCombobox";
import NumericInput from "../components/NumericInput";
import { useT } from "../lib/i18n";
import { formatNumber } from "../lib/format";

type OpLine = { operator_id?: number; operator_name?: string; amount: string };
type PLine = { partner_id?: number; partner_name?: string; amount: string };

export default function SaleCreate() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const nav = useNavigate();
  const qc = useQueryClient();

  const [imei, setImei] = useState("");
  const [model, setModel] = useState("");
  // Quantity of devices in this sale. Default 1; the amount is entered as
  // the TOTAL for the whole sale, not per-unit — quantity is informational
  // for reporting only (see Sale.quantity model help_text).
  const [quantity, setQuantity] = useState("1");
  const [operators, setOperators] = useState<OpLine[]>([{ amount: "" }]);
  const [partners, setPartners] = useState<PLine[]>([{ amount: "" }]);
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [comment, setComment] = useState("");
  const [discount, setDiscount] = useState("");
  const [error, setError] = useState("");
  const [allowDup, setAllowDup] = useState(false);
  const [dupComment, setDupComment] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [hasBonus, setHasBonus] = useState(false);
  const [bonusNote, setBonusNote] = useState("");

  const saleQ = useQuery({
    queryKey: ["sale", id],
    queryFn: () => api.get(`/sales/${id}/`).then((r) => r.data),
    enabled: isEdit,
  });

  useEffect(() => {
    if (isEdit && saleQ.data && !loaded) {
      const s = saleQ.data;
      setImei(s.imei || "");
      setModel(s.phone_model || "");
      setQuantity(String(s.quantity ?? 1));
      setClientName(s.client_name || "");
      setClientPhone(s.client_phone || "");
      setComment(s.comment || "");
      if (s.bonus_note) {
        setBonusNote(s.bonus_note);
        setHasBonus(true);
      }
      setDiscount(
        Number(s.discount) > 0 ? String(Math.round(Number(s.discount))) : "",
      );
      if (s.operator_lines?.length) {
        // Stored amounts are NET (post-discount). The form's operator
        // input shows the GROSS share that matches the partner total —
        // backend re-applies the discount on save. Reverse:
        //   gross_i = net_i × amount / (amount − discount)
        const gross = Number(s.amount) || 0;
        const disc = Number(s.discount) || 0;
        const net = gross - disc;
        const ratio = net > 0 ? gross / net : 1;
        setOperators(
          s.operator_lines.map((l: any) => ({
            operator_id: l.operator,
            amount: String(Math.round(Number(l.amount) * ratio)),
          }))
        );
      }
      if (s.partner_lines?.length) {
        setPartners(
          s.partner_lines.map((l: any) => ({
            partner_id: l.partner,
            amount: String(Math.round(Number(l.amount))),
          }))
        );
      }
      setLoaded(true);
    }
  }, [isEdit, saleQ.data, loaded]);

  const opsQ = useQuery({
    queryKey: ["operators-list-all"],
    queryFn: () => api.get("/operators/?limit=200").then((r) => r.data),
  });
  const partnersQ = useQuery({
    queryKey: ["partners-list-all"],
    queryFn: () => api.get("/channels/?limit=200").then((r) => r.data),
  });
  const modelsQ = useQuery({
    queryKey: ["models-suggest", model],
    queryFn: () =>
      api
        .get(`/imei/models/`, { params: model ? { q: model } : undefined })
        .then((r) => r.data),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!isEdit && imei.length >= 6 && /^\d+$/.test(imei) && imei.length === 15) {
      api
        .get(`/imei/${imei}/lookup/`)
        .then((r) => {
          if (r.data.brand || r.data.model) {
            setModel(`${r.data.brand} ${r.data.model}`.trim());
          }
        })
        .catch(() => {});
    }
  }, [imei, isEdit]);

  const opTotal = useMemo(
    () => operators.reduce((s, o) => s + (Number(o.amount) || 0), 0),
    [operators],
  );
  const partnerTotal = useMemo(
    () => partners.reduce((s, p) => s + (Number(p.amount) || 0), 0),
    [partners],
  );
  const mismatch = opTotal > 0 && partnerTotal > 0 && opTotal !== partnerTotal;
  const total = partnerTotal;
  const discountNum = Number(discount) || 0;
  const netTotal = Math.max(0, total - discountNum);
  const discountTooBig = discountNum > 0 && total > 0 && discountNum >= total;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (imei.length < 6 || imei.length > 15 || !/^\d+$/.test(imei)) {
      setError(t("sale_create.imei_digits_only"));
      return;
    }
    const okOps = operators.filter((o) => (o.operator_id || o.operator_name?.trim()) && Number(o.amount) > 0);
    const okPartners = partners.filter((p) => (p.partner_id || p.partner_name?.trim()) && Number(p.amount) > 0);
    if (okOps.length === 0) {
      setError(t("sale_create.min_operator"));
      return;
    }
    if (okPartners.length === 0) {
      setError(t("sale_create.min_partner"));
      return;
    }
    if (operators.some((o) => (o.operator_id || o.operator_name?.trim()) && !(Number(o.amount) > 0))) {
      setError(t("sale_create.all_operators_positive"));
      return;
    }
    if (partners.some((p) => (p.partner_id || p.partner_name?.trim()) && !(Number(p.amount) > 0))) {
      setError(t("sale_create.all_partners_positive"));
      return;
    }
    if ([...operators, ...partners].some((l) => Number(l.amount) > 0 && Number(l.amount) < 1000)) {
      setError(t("sale_create.min_amount_line"));
      return;
    }
    if (mismatch) {
      setError(
        t("sale_create.sum_mismatch_error", {
          op: formatNumber(opTotal),
          partner: formatNumber(partnerTotal),
        }),
      );
      return;
    }
    if (discountNum < 0) {
      setError(t("sale_create.discount_negative"));
      return;
    }
    if (discountTooBig) {
      setError(t("sale_create.discount_too_big"));
      return;
    }
    if (hasBonus && bonusNote.trim().length < 3) {
      setError(t("sale_create.bonus_required"));
      return;
    }

    const qtyNum = Math.max(1, Number(quantity) || 1);
    const body = {
      imei,
      phone_model: model,
      quantity: qtyNum,
      operators: okOps.map((o) => ({
        operator_id: o.operator_id,
        operator_name: o.operator_name?.trim(),
        amount: Number(o.amount).toFixed(2),
      })),
      partners: okPartners.map((p) => ({
        partner_id: p.partner_id,
        partner_name: p.partner_name?.trim(),
        amount: Number(p.amount).toFixed(2),
      })),
      discount: discountNum.toFixed(2),
      client_name: clientName.trim(),
      client_phone: clientPhone.trim(),
      comment,
      allow_duplicate_imei: allowDup,
      duplicate_override_comment: dupComment,
      bonus_note: hasBonus ? bonusNote.trim() : "",
    };

    try {
      if (isEdit) {
        await api.put(`/sales/${id}/`, body);
        qc.invalidateQueries({ queryKey: ["sale", id] });
        qc.invalidateQueries({ queryKey: ["sales"] });
        nav(`/sales/${id}`);
      } else {
        await api.post("/sales/", body);
        nav("/sales");
      }
    } catch (err: any) {
      const d = err.response?.data || {};
      const fallback = t("sale_create.save_error");
      const msg = d.detail || d.imei?.[0] || d.amount?.[0] || fallback;
      setError(typeof msg === "string" ? msg : fallback);
      if (d.duplicate_count) setAllowDup(true);
    }
  };

  const opOptions: { id: number; full_name: string; status?: string }[] = opsQ.data?.results || [];
  const partnerOptions: { id: number; name: string; is_active?: boolean }[] = partnersQ.data?.results || [];

  if (isEdit && saleQ.isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <div className="nf-eyebrow mb-2">{isEdit ? "EDIT" : "NEW"}</div>
        <h1 className="text-[32px] leading-tight font-semibold tracking-tight">
          {isEdit ? t("sale_create.title_edit") : t("sale_create.title_new")}
        </h1>
      </div>
      <form onSubmit={onSubmit} className="nf-card p-6 md:p-7 space-y-6">
        <div>
          <label className="nf-col mb-1.5 block">{t("sale_create.imei_label")}</label>
          <input
            className="nf-input font-mono tracking-wide"
            value={imei}
            onChange={(e) => setImei(e.target.value.replace(/\D/g, ""))}
            minLength={6}
            maxLength={15}
            placeholder={t("sale_create.imei_ph_full")}
            required
          />
          {imei.length >= 6 && (
            <div className="text-xs text-muted mt-1">
              {imei.length === 15 && model
                ? t("sale_create.imei_arrow", { model })
                : imei.length === 15
                ? t("sale_create.imei_not_recognised")
                : t("sale_create.imei_digits_min", { n: imei.length })}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_8rem] gap-4">
          <div>
            <label className="nf-col mb-1.5 block">{t("sale_create.phone_model")}</label>
            <input
              className="nf-input"
              list="phone-models-list"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t("sale_create.model_ph")}
              autoComplete="off"
            />
            <datalist id="phone-models-list">
              {((modelsQ.data?.results as string[]) || []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="nf-col mb-1.5 block">{t("sale_create.quantity_label")}</label>
            <input
              className="nf-input"
              inputMode="numeric"
              value={quantity}
              onChange={(e) => {
                // Only digits; empty string collapses to "1" on submit.
                const next = e.target.value.replace(/\D/g, "");
                setQuantity(next);
              }}
              placeholder="1"
            />
            <div className="text-[11px] text-muted mt-1">
              {t("sale_create.quantity_hint")}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="nf-col mb-1.5 block">{t("sale_create.client_name")}</label>
            <input
              className="nf-input"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder={t("sale_create.client_name_ph")}
            />
          </div>
          <div>
            <label className="nf-col mb-1.5 block">{t("sale_create.client_phone")}</label>
            <input
              className="nf-input"
              value={clientPhone}
              onChange={(e) => setClientPhone(e.target.value)}
              placeholder={t("sale_create.client_phone_ph")}
            />
          </div>
        </div>

        <LineEditor
          title={t("sale_create.section_operators")}
          lines={operators}
          setLines={setOperators}
          options={opOptions.map((o) => ({
            id: o.id,
            label: o.full_name,
            isActive: o.status !== "inactive",
          }))}
          getId={(l) => l.operator_id}
          getName={(l) => l.operator_name || ""}
          setLine={(l, patch) => ({ ...l, ...patch })}
          empty={() => ({ amount: "" }) as OpLine}
          idKey="operator_id"
          nameKey="operator_name"
        />

        <LineEditor
          title={t("sale_create.section_partners")}
          lines={partners}
          setLines={setPartners}
          options={partnerOptions.map((p) => ({
            id: p.id,
            label: p.name,
            isActive: p.is_active !== false,
          }))}
          getId={(l) => l.partner_id}
          getName={(l) => l.partner_name || ""}
          setLine={(l, patch) => ({ ...l, ...patch })}
          empty={() => ({ amount: "" }) as PLine}
          idKey="partner_id"
          nameKey="partner_name"
        />

        <div
          className={`nf-tile p-4 text-[13.5px] ${
            mismatch || discountTooBig ? "ring-1 ring-amber-500/40" : ""
          }`}
        >
          <div className="flex justify-between items-baseline">
            <span className="text-muted">{t("sale_create.sum_by_operators")}</span>
            <span className="font-medium tabular-nums">{formatNumber(opTotal)} сум</span>
          </div>
          <div className="flex justify-between items-baseline mt-1.5">
            <span className="text-muted">{t("sale_create.sum_by_partners")}</span>
            <span className="font-medium tabular-nums">{formatNumber(partnerTotal)} сум</span>
          </div>
          {mismatch && (
            <div className="mt-2 text-[12px] text-amber-500">
              {t("sale_create.sums_mismatch", { n: formatNumber(Math.abs(opTotal - partnerTotal)) })}
            </div>
          )}
          <div className="border-t border-[var(--border)] mt-3 pt-3 flex justify-between items-baseline">
            <span className="font-medium">{t("sale_create.grand_total")}</span>
            <span className="text-[20px] font-semibold tabular-nums">{formatNumber(total)} сум</span>
          </div>
          {discountNum > 0 && (
            <>
              <div className="flex justify-between items-baseline mt-2 text-red-500">
                <span>{t("sale_create.discount_line")}</span>
                <span className="tabular-nums">{t("sale_create.discount_neg_line", { n: formatNumber(discountNum) })}</span>
              </div>
              <div className="flex justify-between items-baseline mt-1">
                <span className="font-medium">{t("sale_create.net_total")}</span>
                <span className="text-[18px] font-semibold text-emerald-500 tabular-nums">
                  {formatNumber(netTotal)} сум
                </span>
              </div>
              <div className="text-[11.5px] text-muted mt-1.5">
                {t("sale_create.discount_operators_hint")}
              </div>
            </>
          )}
        </div>

        <div>
          <label className="nf-col mb-1.5 block">{t("sale_create.discount_optional")}</label>
          <NumericInput
            className={`nf-input ${discountTooBig ? "is-invalid" : ""}`}
            placeholder="0"
            value={discount}
            onChange={setDiscount}
          />
          <div className="text-[11px] text-muted mt-1">
            {t("sale_create.discount_hint")}
          </div>
        </div>

        <div>
          <label className="nf-col mb-1.5 block">{t("sale_create.comment_label")}</label>
          <textarea className="nf-input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>

        <div className="rounded-xl border p-3 space-y-2" style={{ borderColor: "var(--border)" }}>
          <label className="flex items-center gap-2 text-[13.5px] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={hasBonus}
              onChange={(e) => setHasBonus(e.target.checked)}
            />
            🎁 {t("sale_create.bonus_toggle")}
          </label>
          {hasBonus && (
            <>
              <textarea
                className="nf-input"
                rows={2}
                value={bonusNote}
                onChange={(e) => setBonusNote(e.target.value)}
                placeholder={t("sale_create.bonus_ph")}
                autoFocus
              />
              <div className="text-[11.5px] text-muted">
                {t("sale_create.bonus_hint")}
              </div>
            </>
          )}
        </div>

        {allowDup && (
          <div className="nf-tile p-4 space-y-2 ring-1 ring-amber-500/40">
            <div className="text-[13px] text-amber-500">
              {t("sale_create.dup_hint")}
            </div>
            <input
              className="nf-input"
              placeholder={t("sale_create.dup_reason_ph")}
              value={dupComment}
              onChange={(e) => setDupComment(e.target.value)}
            />
          </div>
        )}

        {error && (
          <div className="text-[13px] text-red-500 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-2.5">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border)]">
          <button type="button" className="nf-btn nf-btn--ghost" onClick={() => nav(-1)}>
            {t("common.cancel")}
          </button>
          <button className="nf-btn nf-btn--primary" type="submit">
            {isEdit ? t("sale_create.save_changes") : t("common.save")}
          </button>
        </div>
      </form>
    </div>
  );
}

type LineEditorProps<L> = {
  title: string;
  lines: L[];
  setLines: (v: L[]) => void;
  options: { id: number; label: string; isActive?: boolean }[];
  getId: (l: L) => number | undefined;
  getName: (l: L) => string;
  setLine: (l: L, patch: Partial<L>) => L;
  empty: () => L;
  idKey: keyof L;
  nameKey: keyof L;
};

function LineEditor<L extends { amount: string }>(props: LineEditorProps<L>) {
  const { title, lines, setLines, options, getId, getName, setLine, empty, idKey, nameKey } = props;
  return (
    <div>
      <div className="flex items-center justify-between mb-2.5">
        <div className="text-[15px] font-semibold tracking-tight">{title}</div>
        <button
          type="button"
          className="nf-btn nf-btn--ghost text-[12px] !py-1.5 !px-3"
          onClick={() => setLines([...lines, empty()])}
        >
          <Plus className="w-3.5 h-3.5" /> добавить
        </button>
      </div>
      <div className="space-y-2">
        {lines.map((line, i) => {
          const id = getId(line);
          const name = getName(line);
          const value: number | string | null = id ?? (name.trim() ? name : null);
          return (
            <div key={i} className="flex gap-2 items-start">
              <div className="flex-1 min-w-0">
                <SingleSelectCombobox
                  options={options}
                  value={value}
                  allowFreeText
                  placeholder="Выбрать или ввести имя…"
                  onChange={(next) => {
                    const patch: any = {};
                    if (typeof next === "number") {
                      patch[idKey] = next;
                      patch[nameKey] = undefined;
                    } else {
                      patch[idKey] = undefined;
                      patch[nameKey] = next;
                    }
                    const arr = [...lines];
                    arr[i] = setLine(line, patch);
                    setLines(arr);
                  }}
                />
              </div>
              {(() => {
                const hasName = !!(id || name.trim());
                const amt = Number(line.amount);
                const invalid = hasName && (line.amount === "" || amt < 1000);
                return (
                  <div className="w-48 flex-shrink-0">
                    <NumericInput
                      className={`nf-input ${invalid ? "is-invalid" : ""}`}
                      placeholder="Сумма"
                      value={line.amount}
                      onChange={(raw) => {
                        const next = [...lines];
                        next[i] = setLine(line, { amount: raw } as any);
                        setLines(next);
                      }}
                    />
                    {invalid && line.amount !== "" && (
                      <div className="text-[10px] text-red-500 mt-0.5 text-right">
                        мин 1 000
                      </div>
                    )}
                  </div>
                );
              })()}
              {lines.length > 1 && (
                <button
                  type="button"
                  className="nf-btn nf-btn--ghost flex-shrink-0 !p-2.5"
                  onClick={() => setLines(lines.filter((_, j) => j !== i))}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="text-xs text-muted mt-2">
        {lines.filter((l) => !getId(l) && getName(l).trim()).length > 0 &&
          "Новые имена добавятся автоматически при сохранении."}
      </div>
    </div>
  );
}
