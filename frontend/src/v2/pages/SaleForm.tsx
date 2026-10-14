import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, CheckCircle2, Loader2, Plus, X } from "lucide-react";
import NumericInput from "../../components/NumericInput";
import { toast } from "../../components/ui";
import { LEAD_STATUS_LABEL } from "../../lib/leads";
import { imeiLuhnStatus } from "../../lib/validation";
import { useT2 } from "../i18n";
import { cx, ErrorState, fmtNum, LoadingBlock, PageHeader } from "../ui";
import {
  confirmSale,
  fetchLeadForSale,
  lookupImei,
  saveSale,
  searchLeadsByPhone,
  useModelSuggest,
  useSaleForEdit,
  useSaleFormOperators,
  useSaleFormPartners,
  type SaleFormBody,
  type SaleFormLeadMatch,
} from "../api/managerDaily";

/**
 * /sales/new (MgSaleFormNew) and /sales/:id/edit (MgSaleForm).
 * Behaviour mirrors the old SaleCreate page: multi-operator / multi-partner
 * split, discount, bonus note, duplicate-IMEI override, phone → lead link,
 * TAC lookup. Errors are shown at the fields (MgSheetSaleForm), the save
 * button locks while saving, and «Сохранить и одобрить» = PUT then confirm.
 */

type OpLine = { operator_id?: number; operator_name?: string; amount: string };
type PLine = { partner_id?: number; partner_name?: string; amount: string };
type Opt = { id: number; label: string; isActive?: boolean };

const MAX_PARTNERS = 2; // backend MAX_PAYMENT_CHANNELS
const MIN_LINE = 1000;

type Errs = {
  imei?: string;
  dup?: string;
  ops: Record<number, string>;
  partners: Record<number, string>;
  opsGroup?: string;
  partnersGroup?: string;
  mismatch?: boolean;
  discount?: string;
  bonus?: string;
};
const NO_ERRS: Errs = { ops: {}, partners: {} };

function hasErrs(e: Errs) {
  return !!(e.imei || e.dup || e.opsGroup || e.partnersGroup || e.mismatch || e.discount || e.bonus || Object.keys(e.ops).length || Object.keys(e.partners).length);
}

function leadTone(code: string) {
  if (code === "won") return "b-ok";
  if (code === "lost" || code === "has_debt") return "b-bad";
  if (code === "callback_scheduled" || code === "no_answer_2" || code === "needs_review") return "b-warn";
  if (code === "new" || code === "assigned" || code === "in_progress") return "b-info";
  return "";
}
const statusLabel = (code: string) => LEAD_STATUS_LABEL[code] || code;

/* ── phone with fixed +998 prefix (canonical "+998XXXXXXXXX") ─────────── */
function toDigits9(raw: string) {
  const d = raw.replace(/\D+/g, "");
  return (d.startsWith("998") ? d.slice(3) : d).slice(0, 9);
}
function fmtLocal(d: string) {
  return [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)].filter(Boolean).join(" ");
}
function UzPhoneField({ id, value, onChange, onFocus, warn, after }: { id: string; value: string; onChange: (v: string) => void; onFocus?: () => void; warn?: boolean; after?: ReactNode }) {
  const d = toDigits9(value);
  return (
    <div className="row g8">
      <span className="pfx" style={{ height: 40, fontSize: 14, borderRadius: 8 }} aria-hidden="true">+998</span>
      <input
        id={id}
        className={cx("input num grow", warn && "is-warn")}
        type="tel"
        inputMode="numeric"
        autoComplete="tel"
        placeholder="90 123 45 67"
        value={fmtLocal(d)}
        onFocus={onFocus}
        onChange={(e) => {
          const next = toDigits9(e.target.value);
          onChange(next ? `+998${next}` : "");
        }}
      />
      {after}
    </div>
  );
}

/* ── operator / partner picker: list + free text («новый») ─────────────── */
function LinePicker({ options, value, onChange, invalid, ariaLabel, placeholder }: { options: Opt[]; value: number | string | null; onChange: (v: number | string) => void; invalid?: boolean; ariaLabel: string; placeholder: string }) {
  const t = useT2();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  // Filter only after the user types: on focus the whole list is shown.
  const [typed, setTyped] = useState(false);
  const byId = typeof value === "number" ? options.find((o) => o.id === value) : undefined;
  const label = byId ? byId.label : typeof value === "string" ? value : "";
  const isNew = typeof value === "string" && value.trim() !== "";
  const needle = typed ? q.trim().toLowerCase() : "";
  const filtered = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;
  const exact = options.find((o) => o.label.toLowerCase() === needle);
  const showAdd = !!needle && !exact;
  const total = filtered.length + (showAdd ? 1 : 0);

  const commit = (text: string) => {
    const v = text.trim();
    const ex = options.find((o) => o.label.toLowerCase() === v.toLowerCase());
    onChange(ex ? ex.id : v);
    setOpen(false);
  };
  const pick = (i: number) => {
    if (i < filtered.length) {
      onChange(filtered[i].id);
      setOpen(false);
    } else if (showAdd) commit(q);
  };

  return (
    <span className="inwrap grow" style={{ position: "relative" }}>
      <input
        className={cx("input", invalid && "is-bad")}
        style={{ paddingLeft: 12, paddingRight: isNew && !open ? 76 : 12, width: "100%" }}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        placeholder={placeholder}
        value={open ? q : label}
        onFocus={() => {
          setQ(label);
          setTyped(false);
          setHi(Math.max(0, options.findIndex((o) => o.id === value)));
          setOpen(true);
        }}
        onChange={(e) => {
          setQ(e.target.value);
          setTyped(true);
          setHi(0);
          setOpen(true);
        }}
        onBlur={() => {
          if (!open) return;
          if (q.trim() !== label.trim()) commit(q);
          else setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi((h) => Math.min(h + 1, Math.max(total - 1, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (total > 0) pick(hi);
            else commit(q);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {isNew && !open ? <span className="badge b-info" style={{ position: "absolute", right: 8, height: 20 }}>{t("v2.saleForm.newBadge")}</span> : null}
      {open ? (
        <div className="card col" role="listbox" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 30, boxShadow: "var(--shadow)", maxHeight: 260, overflowY: "auto", padding: 4 }}>
          {filtered.map((o, i) => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={value === o.id}
              className="row between g8 s"
              style={{ flex: "none", width: "100%", textAlign: "left", padding: "8px 10px", border: 0, borderRadius: 8, background: i === hi ? "var(--brand-soft)" : "transparent", color: "var(--ink)", opacity: o.isActive === false ? 0.6 : 1, cursor: "pointer" }}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(i)}
            >
              <span className="trunc">{o.label}</span>
              {o.isActive === false ? <span className="badge" style={{ height: 18, fontSize: 11 }}>{t("v2.saleForm.inactive")}</span> : value === o.id ? <Check className="ic" /> : null}
            </button>
          ))}
          {showAdd ? (
            <button
              type="button"
              className="row g8 s"
              style={{ flex: "none", width: "100%", textAlign: "left", padding: "8px 10px", border: 0, borderRadius: 8, background: hi === filtered.length ? "var(--ok-bg)" : "transparent", color: "var(--ok)", cursor: "pointer" }}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHi(filtered.length)}
              onClick={() => commit(q)}
            >
              <Plus className="ic" />
              {t("v2.saleForm.addNew", { q: q.trim() })}
            </button>
          ) : null}
          {total === 0 ? <span className="xs c3" style={{ padding: "8px 10px" }}>{t("v2.saleForm.noOptions")}</span> : null}
        </div>
      ) : null}
    </span>
  );
}

function LinesCard<L extends { amount: string }>({
  title,
  sub,
  lines,
  setLines,
  options,
  getId,
  getName,
  patchPick,
  empty,
  max,
  errors,
  groupError,
}: {
  title: string;
  sub?: string;
  lines: L[];
  setLines: (v: L[]) => void;
  options: Opt[];
  getId: (l: L) => number | undefined;
  getName: (l: L) => string;
  patchPick: (l: L, v: number | string) => L;
  empty: () => L;
  max?: number;
  errors: Record<number, string>;
  groupError?: string;
}) {
  const t = useT2();
  const full = max !== undefined && lines.length >= max;
  const hasNew = lines.some((l) => !getId(l) && getName(l).trim());
  return (
    <section className="card">
      <div className="card-h">
        <span className="h3">{title}</span>
        <span className="row g8">
          {sub ? <span className="xs c3">{sub}</span> : null}
          <button className="btn btn-ghost btn-sm" type="button" disabled={full} onClick={() => setLines([...lines, empty()])}>
            <Plus className="ic" />
            {t("sale_create.line_add")}
          </button>
        </span>
      </div>
      <div className="col g8" style={{ padding: "16px 20px" }}>
        {lines.map((line, i) => {
          const id = getId(line);
          const name = getName(line);
          const value: number | string | null = id ?? (name.trim() ? name : null);
          const hasName = !!(id || name.trim());
          const amt = Number(line.amount);
          const lowAmt = hasName && line.amount !== "" && amt < MIN_LINE;
          const err = errors[i];
          const n = i + 1;
          return (
            <div key={i} className="col g4">
              <div className="row g8" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
                <span className="grow" style={{ minWidth: 200, display: "flex" }}>
                  <LinePicker
                    options={options}
                    value={value}
                    invalid={!!err && !hasName}
                    ariaLabel={`${title} ${n}`}
                    placeholder={t("sale_create.line_pick_ph")}
                    onChange={(v) => {
                      const next = [...lines];
                      next[i] = patchPick(line, v);
                      setLines(next);
                    }}
                  />
                </span>
                <span className="col g4" style={{ width: 180 }}>
                  <NumericInput
                    className={cx("input num", (lowAmt || (!!err && hasName)) && "is-bad")}
                    placeholder={t("sale_create.line_amount_ph")}
                    value={line.amount}
                    onChange={(raw) => {
                      const next = [...lines];
                      next[i] = { ...line, amount: raw };
                      setLines(next);
                    }}
                  />
                  {lowAmt && !err ? <span className="hint" style={{ color: "var(--bad)" }}>{t("sale_create.line_min")}</span> : null}
                </span>
                {lines.length > 1 ? (
                  <button
                    className="btn btn-ghost btn-sq"
                    type="button"
                    aria-label={t("v2.saleForm.removeLine", { n })}
                    onClick={() => setLines(lines.filter((_, j) => j !== i))}
                  >
                    <X className="ic" />
                  </button>
                ) : null}
              </div>
              {err ? <span className="err">{err}</span> : null}
            </div>
          );
        })}
        {groupError ? <span className="err">{groupError}</span> : null}
        {hasNew ? <span className="hint">{t("v2.saleForm.newNames")}</span> : null}
      </div>
    </section>
  );
}

export default function SaleForm() {
  const t = useT2();
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const nav = useNavigate();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const preloadLeadId = searchParams.get("lead");

  const [imei, setImei] = useState("");
  const [model, setModel] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [operators, setOperators] = useState<OpLine[]>([{ amount: "" }]);
  const [partners, setPartners] = useState<PLine[]>([{ amount: "" }]);
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [comment, setComment] = useState("");
  const [discount, setDiscount] = useState("");
  const [allowDup, setAllowDup] = useState(false);
  const [dupComment, setDupComment] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [hasBonus, setHasBonus] = useState(false);
  const [bonusNote, setBonusNote] = useState("");
  const [leadId, setLeadId] = useState<number | null>(null);
  const [matchedLead, setMatchedLead] = useState<SaleFormLeadMatch | null>(null);
  const [phoneMatches, setPhoneMatches] = useState<SaleFormLeadMatch[]>([]);
  const [searchedDigits, setSearchedDigits] = useState("");
  const [phoneDropdownOpen, setPhoneDropdownOpen] = useState(false);
  const phoneWrapRef = useRef<HTMLDivElement | null>(null);

  const [errs, setErrs] = useState<Errs>(NO_ERRS);
  const [serverError, setServerError] = useState<{ title: string; body: string } | null>(null);
  const [saving, setSaving] = useState<null | "save" | "approve">(null);
  const savingRef = useRef(false);

  const saleQ = useSaleForEdit(id);
  const opsQ = useSaleFormOperators();
  const partnersQ = useSaleFormPartners();
  const modelsQ = useModelSuggest(model);

  // Prefill in edit mode (same reverse-discount maths as the old page).
  useEffect(() => {
    if (!isEdit || !saleQ.data || loaded) return;
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
    setDiscount(Number(s.discount) > 0 ? String(Math.round(Number(s.discount))) : "");
    if (s.operator_lines?.length) {
      // Stored operator amounts are NET; the form shows GROSS (gross_i = net_i × amount / (amount − discount)).
      const gross = Number(s.amount) || 0;
      const disc = Number(s.discount) || 0;
      const net = gross - disc;
      const ratio = net > 0 ? gross / net : 1;
      setOperators(s.operator_lines.map((l) => ({ operator_id: l.operator, amount: String(Math.round(Number(l.amount) * ratio)) })));
    }
    if (s.partner_lines?.length) {
      setPartners(s.partner_lines.map((l) => ({ partner_id: l.partner, amount: String(Math.round(Number(l.amount))) })));
    }
    setLoaded(true);
  }, [isEdit, saleQ.data, loaded]);

  // TAC lookup on a full IMEI (new sales only, as before).
  useEffect(() => {
    if (isEdit || imei.length !== 15 || !/^\d+$/.test(imei)) return;
    let alive = true;
    lookupImei(imei)
      .then((d) => {
        if (alive && (d.brand || d.model)) setModel(`${d.brand ?? ""} ${d.model ?? ""}`.trim());
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [imei, isEdit]);

  // Phone → lead autocomplete, debounced 300 ms, from 4 digits; paused while a lead is linked.
  useEffect(() => {
    if (leadId) return;
    const digits = clientPhone.replace(/\D/g, "");
    if (digits.length < 4) {
      setPhoneMatches([]);
      setSearchedDigits("");
      setPhoneDropdownOpen(false);
      return;
    }
    const h = window.setTimeout(() => {
      searchLeadsByPhone(digits)
        .then((rows) => {
          setPhoneMatches(rows);
          setSearchedDigits(digits);
          setPhoneDropdownOpen(rows.length > 0);
        })
        .catch(() => {
          setPhoneMatches([]);
          setSearchedDigits("");
        });
    }, 300);
    return () => window.clearTimeout(h);
  }, [clientPhone, leadId]);

  // ?lead=<id> preload (new sale only).
  useEffect(() => {
    if (isEdit || !preloadLeadId) return;
    const lid = Number(preloadLeadId);
    if (!Number.isFinite(lid) || lid <= 0) return;
    fetchLeadForSale(lid)
      .then((lead) => {
        if (!lead) return;
        setLeadId(lead.id);
        setMatchedLead({ id: lead.id, full_name: lead.full_name || "", phone: lead.phone || "", phone_raw: lead.phone_raw, status: lead.status, product_hint: lead.product_hint, operator_name: lead.operator_name, sheet_source_name: lead.sheet_source_name });
        setClientName(lead.full_name || "");
        setClientPhone(lead.phone || "");
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!phoneDropdownOpen) return;
    const h = (e: MouseEvent) => {
      if (phoneWrapRef.current && !phoneWrapRef.current.contains(e.target as Node)) setPhoneDropdownOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [phoneDropdownOpen]);

  const pickLead = (lead: SaleFormLeadMatch) => {
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

  const opTotal = useMemo(() => operators.reduce((s, o) => s + (Number(o.amount) || 0), 0), [operators]);
  const partnerTotal = useMemo(() => partners.reduce((s, p) => s + (Number(p.amount) || 0), 0), [partners]);
  const mismatch = opTotal > 0 && partnerTotal > 0 && opTotal !== partnerTotal;
  const total = partnerTotal;
  const discountNum = Number(discount) || 0;
  const netTotal = Math.max(0, total - discountNum);
  const discountTooBig = discountNum > 0 && total > 0 && discountNum >= total;

  const opOptions: Opt[] = (opsQ.data || []).map((o) => ({ id: o.id, label: o.full_name, isActive: o.status !== "inactive" }));
  const partnerOptions: Opt[] = (partnersQ.data || []).map((p) => ({ id: p.id, label: p.name, isActive: p.is_active !== false }));

  // Clear a field's error as soon as it is edited.
  const clearErr = (patch: Partial<Errs>) => setErrs((e) => (hasErrs(e) ? { ...e, ...patch } : e));

  function validate(): Errs {
    const e: Errs = { ops: {}, partners: {} };
    if (!/^\d+$/.test(imei) || imei.length < 6 || imei.length > 15) {
      e.imei = imei.length > 0 && imei.length < 6 ? t("v2.saleForm.imeiCount", { n: imei.length }) : t("sale_create.imei_digits_only");
    }
    const checkLines = (lines: Array<{ amount: string }>, named: (i: number) => boolean, out: Record<number, string>) => {
      lines.forEach((l, i) => {
        const amt = Number(l.amount);
        if (named(i)) {
          if (!(amt > 0)) out[i] = t("v2.saleForm.lineAmount");
          else if (amt < MIN_LINE) out[i] = t("sale_create.min_amount_line");
        } else if (amt > 0) {
          out[i] = t("v2.saleForm.pickLine");
        }
      });
    };
    checkLines(operators, (i) => !!(operators[i].operator_id || operators[i].operator_name?.trim()), e.ops);
    checkLines(partners, (i) => !!(partners[i].partner_id || partners[i].partner_name?.trim()), e.partners);
    const okOps = operators.filter((o) => (o.operator_id || o.operator_name?.trim()) && Number(o.amount) > 0);
    const okPartners = partners.filter((p) => (p.partner_id || p.partner_name?.trim()) && Number(p.amount) > 0);
    if (okOps.length === 0) e.opsGroup = t("sale_create.min_operator");
    if (okPartners.length === 0) e.partnersGroup = t("sale_create.min_partner");
    if (mismatch) e.mismatch = true;
    if (discountNum < 0) e.discount = t("sale_create.discount_negative");
    else if (discountTooBig) e.discount = t("sale_create.discount_too_big");
    if (hasBonus && bonusNote.trim().length < 3) e.bonus = t("v2.saleForm.bonusErr");
    if (allowDup && !dupComment.trim()) e.dup = t("v2.saleForm.dupReasonRequired");
    return e;
  }

  function buildBody(): SaleFormBody {
    const okOps = operators.filter((o) => (o.operator_id || o.operator_name?.trim()) && Number(o.amount) > 0);
    const okPartners = partners.filter((p) => (p.partner_id || p.partner_name?.trim()) && Number(p.amount) > 0);
    return {
      imei,
      phone_model: model,
      quantity: Math.max(1, Number(quantity) || 1),
      operators: okOps.map((o) => ({ operator_id: o.operator_id, operator_name: o.operator_name?.trim(), amount: Number(o.amount).toFixed(2) })),
      partners: okPartners.map((p) => ({ partner_id: p.partner_id, partner_name: p.partner_name?.trim(), amount: Number(p.amount).toFixed(2) })),
      discount: discountNum.toFixed(2),
      client_name: clientName.trim(),
      client_phone: clientPhone.trim(),
      comment,
      allow_duplicate_imei: allowDup,
      duplicate_override_comment: dupComment,
      bonus_note: hasBonus ? bonusNote.trim() : "",
      lead_id: leadId,
    };
  }

  function scrollToFirstError() {
    window.requestAnimationFrame(() => {
      const el = document.querySelector(".page .is-bad, .page .err, .page .banner.b-bad");
      (el as HTMLElement | null)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  async function submit(mode: "save" | "approve") {
    if (savingRef.current) return; // no double submit
    setServerError(null);
    const e = validate();
    setErrs(e);
    if (hasErrs(e)) {
      scrollToFirstError();
      return;
    }
    savingRef.current = true;
    setSaving(mode);
    try {
      const saved = await saveSale(id, buildBody());
      if (isEdit) {
        qc.invalidateQueries({ queryKey: ["sale", id] });
        qc.invalidateQueries({ queryKey: ["sales"] });
        if (mode === "approve") {
          try {
            await confirmSale(id!);
            qc.invalidateQueries({ queryKey: ["sale", id] });
            qc.invalidateQueries({ queryKey: ["sales-pending"] });
            qc.invalidateQueries({ queryKey: ["sales-pending-count"] });
            toast.success(t("v2.saleForm.savedApproved"));
          } catch {
            toast.error(t("v2.saleForm.savedNotApproved"));
          }
        } else {
          toast.success(t("sale_create.saved"));
        }
        nav(`/sales/${id}`);
      } else {
        qc.invalidateQueries({ queryKey: ["sales"] });
        const newId = saved?.id;
        toast.success(t("sale_create.saved"), newId ? { action: { label: t("v2.saleForm.open"), onClick: () => nav(`/sales/${newId}`) } } : undefined);
        nav("/sales");
      }
    } catch (err: unknown) {
      const resp = (err as { response?: { data?: Record<string, unknown> } }).response;
      if (!resp) {
        setServerError({ title: t("v2.saleForm.errTitle"), body: t("v2.saleForm.errNetwork") });
      } else {
        const d = (resp.data || {}) as Record<string, unknown>;
        const first = (k: string) => (Array.isArray(d[k]) ? String((d[k] as unknown[])[0]) : undefined);
        const fallback = t("sale_create.save_error");
        const raw = (typeof d.detail === "string" ? d.detail : undefined) || first("imei") || first("amount") || first("non_field_errors") || fallback;
        const msg = typeof raw === "string" ? raw : fallback;
        if (d.duplicate_count) {
          setAllowDup(true);
          setErrs((x) => ({ ...x, dup: t("sale_create.dup_hint") }));
        } else if (d.field === "imei" || first("imei")) {
          setErrs((x) => ({ ...x, imei: msg }));
        } else if (d.field === "duplicate_override_comment") {
          setAllowDup(true);
          setErrs((x) => ({ ...x, dup: msg }));
        } else {
          setServerError({ title: t("v2.saleForm.errTitle"), body: msg });
        }
      }
      scrollToFirstError();
    } finally {
      savingRef.current = false;
      setSaving(null);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit("save");
  };

  /* ── loading / error for edit ─────────────────────────────────────── */
  if (isEdit && saleQ.isLoading) {
    return (
      <>
        <PageHeader title={t("v2.saleForm.titleEdit", { n: fmtNum(Number(id)) })} back={() => nav(-1)} />
        <main className="page">
          <section className="card"><LoadingBlock rows={6} onRetry={() => saleQ.refetch()} /></section>
        </main>
      </>
    );
  }
  if (isEdit && saleQ.isError) {
    return (
      <>
        <PageHeader title={t("v2.saleForm.titleEdit", { n: fmtNum(Number(id)) })} back={() => nav(-1)} />
        <main className="page">
          <section className="card"><ErrorState error={saleQ.error} onRetry={() => saleQ.refetch()} /></section>
        </main>
      </>
    );
  }

  const status = saleQ.data?.status;
  const statusTone = status === "pending" ? "b-warn" : status === "rejected" ? "b-bad" : status === "confirmed" ? "b-ok" : "";
  const canApprove = isEdit && status === "pending";
  const phoneDigits = clientPhone.replace(/\D/g, "");
  const notInLeads = !matchedLead && phoneDigits.length >= 9 && searchedDigits === phoneDigits && phoneMatches.length === 0;
  const luhn = imeiLuhnStatus(imei);
  const busy = saving !== null;

  const imeiHint = (() => {
    if (errs.imei) return <span className="err">{errs.imei}</span>;
    if (!imei) return null;
    if (imei.length < 15) return <span className="xs c3">{t("sale_create.imei_digits_min", { n: imei.length })}</span>;
    return (
      <>
        {model ? (
          <span className="row g6 xs w6" style={{ color: "var(--ok)" }}><Check className="ic" style={{ width: 14, height: 14 }} />{t("sale_create.imei_arrow", { model })}</span>
        ) : (
          <span className="xs w6" style={{ color: "var(--warn)" }}>{t("sale_create.imei_not_recognised")}</span>
        )}
        {luhn === "warn" ? <span className="xs w6" style={{ color: "var(--warn)" }}>{t("validation.imei_luhn_warn")}</span> : null}
      </>
    );
  })();
  const imeiClass = errs.imei || errs.dup ? "is-bad" : imei.length === 15 ? (model && luhn !== "warn" ? "is-ok" : "is-warn") : undefined;

  const saveLabel = (m: "save" | "approve", idle: string) =>
    saving === m ? (
      <>
        <Loader2 className="ic animate-spin" />
        {t("v2.saleForm.saving")}
      </>
    ) : (
      idle
    );

  return (
    <>
      <PageHeader
        title={isEdit ? t("v2.saleForm.titleEdit", { n: fmtNum(Number(id)) }) : t("sale_create.title_new")}
        meta={
          isEdit ? (
            status ? (
              <span className={cx("badge", statusTone)}>
                <i className="dot" />
                {t(`v2.saleForm.st.${status}`)}
              </span>
            ) : undefined
          ) : (
            t("v2.saleForm.metaNew")
          )
        }
        back={() => nav(-1)}
      >
        <button className="btn btn-ghost" type="button" onClick={() => nav(-1)} disabled={busy}>{t("common.cancel")}</button>
      </PageHeader>

      <main className="page">
        <form className="split" onSubmit={onSubmit} noValidate>
          <div className="list col g16">
            {/* Device */}
            <section className="card">
              <div className="card-h"><span className="h3">{t("sale_create.section_device")}</span></div>
              <div className="row g16" style={{ flexWrap: "wrap", alignItems: "flex-start", padding: "18px 20px" }}>
                <div className="field" style={{ flex: "2 1 280px" }}>
                  <label htmlFor="sf-imei">{t("sale_create.imei_label")}</label>
                  <input
                    id="sf-imei"
                    className={cx("input num", imeiClass)}
                    type="text"
                    inputMode="numeric"
                    maxLength={15}
                    placeholder={t("sale_create.imei_ph_full")}
                    value={imei}
                    onChange={(e) => {
                      setImei(e.target.value.replace(/\D/g, "").slice(0, 15));
                      clearErr({ imei: undefined });
                    }}
                  />
                  {imeiHint}
                  {allowDup ? (
                    <div className="banner b-warn" style={{ flexDirection: "column", alignItems: "stretch", marginTop: 6 }}>
                      <span className="w6">{errs.dup && errs.dup !== t("v2.saleForm.dupReasonRequired") ? errs.dup : t("sale_create.dup_hint")}</span>
                      <input
                        className={cx("input", errs.dup === t("v2.saleForm.dupReasonRequired") && "is-bad")}
                        type="text"
                        aria-label={t("sale_create.dup_reason_ph")}
                        placeholder={t("sale_create.dup_reason_ph")}
                        value={dupComment}
                        onChange={(e) => {
                          setDupComment(e.target.value);
                          clearErr({ dup: undefined });
                        }}
                      />
                      {errs.dup === t("v2.saleForm.dupReasonRequired") ? <span className="err">{errs.dup}</span> : null}
                    </div>
                  ) : null}
                </div>
                <div className="field" style={{ flex: "1 1 140px" }}>
                  <label htmlFor="sf-qty">{t("sale_create.quantity_label")}</label>
                  <input id="sf-qty" className="input num" inputMode="numeric" placeholder="1" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/\D/g, "").slice(0, 5))} />
                  <span className="hint">{t("sale_create.quantity_hint")}</span>
                </div>
                <div className="field" style={{ flex: "1 1 100%" }}>
                  <label htmlFor="sf-model">{t("sale_create.phone_model")}</label>
                  <input id="sf-model" className="input" list="sf-models" autoComplete="off" value={model} onChange={(e) => setModel(e.target.value)} />
                  <datalist id="sf-models">
                    {(modelsQ.data?.results || []).map((m) => <option key={m} value={m} />)}
                  </datalist>
                  <span className="hint">{t("sale_create.model_ph")}</span>
                </div>
              </div>
            </section>

            {/* Client */}
            <section className="card">
              <div className="card-h">
                <span className="h3">{t("sale_create.section_customer")}</span>
                <span className="xs c3">{t("v2.saleForm.clientHint")}</span>
              </div>
              <div className="row g16" style={{ flexWrap: "wrap", alignItems: "flex-start", padding: "18px 20px" }}>
                <div className="field" style={{ flex: "1 1 240px" }}>
                  <label htmlFor="sf-name">{t("sale_create.client_name")}</label>
                  <input id="sf-name" className="input" type="text" placeholder={t("sale_create.client_name_ph")} value={clientName} onChange={(e) => setClientName(e.target.value)} />
                </div>
                <div className="field" ref={phoneWrapRef} style={{ flex: "1 1 280px", position: "relative" }}>
                  <label htmlFor="sf-phone">{t("sale_create.client_phone")}</label>
                  {matchedLead ? (
                    <div className="input row g8" style={{ height: "auto", padding: "8px 8px 8px 12px", alignItems: "flex-start" }}>
                      <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                        <span className="s w6 trunc">{matchedLead.full_name || t("sale_create.lead_no_name")}</span>
                        <span className="row g6 xs wrap">
                          <span className="num c3">{matchedLead.phone}</span>
                          {matchedLead.sheet_source_name ? <span className="badge b-info" style={{ height: 18, fontSize: 11 }}>{matchedLead.sheet_source_name}</span> : null}
                        </span>
                        <span className="xs c3 trunc">
                          {t("sale_create.lead_linked_status", { status: statusLabel(matchedLead.status) })}
                          {matchedLead.operator_name ? ` · ${matchedLead.operator_name}` : ""}
                        </span>
                      </span>
                      <button className="btn btn-ghost btn-sq btn-sm" type="button" aria-label={t("v2.saleForm.unlink")} title={t("v2.saleForm.unlink")} onClick={unlinkLead}>
                        <X className="ic" />
                      </button>
                    </div>
                  ) : (
                    <UzPhoneField
                      id="sf-phone"
                      value={clientPhone}
                      onChange={setClientPhone}
                      warn={notInLeads}
                      onFocus={() => phoneMatches.length > 0 && setPhoneDropdownOpen(true)}
                      after={isEdit && saleQ.data?.sheet_source_name ? <span className="badge b-ok" style={{ alignSelf: "center" }}>{t("v2.saleForm.leadFrom", { src: saleQ.data.sheet_source_name })}</span> : null}
                    />
                  )}
                  {notInLeads ? (
                    <span className="row g6 xs" style={{ color: "var(--bad)", alignItems: "flex-start" }}>
                      <AlertTriangle className="ic" style={{ width: 14, height: 14, flex: "none", marginTop: 1 }} />
                      <span>{t("v2.saleForm.notInLeads")}</span>
                    </span>
                  ) : null}
                  {phoneDropdownOpen && phoneMatches.length > 0 && !matchedLead ? (
                    <div className="card col" role="listbox" aria-label={t("v2.saleForm.leadsFound")} style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, zIndex: 30, boxShadow: "var(--shadow)", maxHeight: 300, overflowY: "auto" }}>
                      {phoneMatches.map((lead) => (
                        <button
                          key={lead.id}
                          type="button"
                          role="option"
                          aria-selected={false}
                          className="li"
                          style={{ flex: "none", width: "100%", border: 0, borderBottom: "1px solid var(--line)", background: "var(--surface)", textAlign: "left", minHeight: 0, padding: "9px 14px", cursor: "pointer" }}
                          onClick={() => pickLead(lead)}
                        >
                          <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                            <span className="s w6 trunc">{lead.full_name || t("sale_create.lead_no_name")}</span>
                            <span className="row g6 xs c3 wrap">
                              <span className="num">{lead.phone}</span>
                              {lead.sheet_source_name ? <span className="badge b-info" style={{ height: 18, fontSize: 11 }}>{lead.sheet_source_name}</span> : null}
                              {lead.product_hint ? <span>· {lead.product_hint}</span> : null}
                              {lead.operator_name ? <span>· {lead.operator_name}</span> : null}
                            </span>
                          </span>
                          <span className={cx("badge", leadTone(lead.status))} style={{ height: 20, fontSize: 11 }}>{statusLabel(lead.status)}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </section>

            <LinesCard<OpLine>
              title={t("sale_create.section_operators")}
              sub={isEdit ? t("v2.saleForm.opsHint") : undefined}
              lines={operators}
              setLines={(v) => {
                setOperators(v);
                clearErr({ ops: {}, opsGroup: undefined, mismatch: undefined });
              }}
              options={opOptions}
              getId={(l) => l.operator_id}
              getName={(l) => l.operator_name || ""}
              patchPick={(l, v) => (typeof v === "number" ? { ...l, operator_id: v, operator_name: undefined } : { ...l, operator_id: undefined, operator_name: v })}
              empty={() => ({ amount: "" })}
              errors={errs.ops}
              groupError={errs.opsGroup}
            />

            <LinesCard<PLine>
              title={t("sale_create.section_partners")}
              sub={t("v2.saleForm.partnersMax")}
              lines={partners}
              setLines={(v) => {
                setPartners(v);
                clearErr({ partners: {}, partnersGroup: undefined, mismatch: undefined });
              }}
              options={partnerOptions}
              getId={(l) => l.partner_id}
              getName={(l) => l.partner_name || ""}
              patchPick={(l, v) => (typeof v === "number" ? { ...l, partner_id: v, partner_name: undefined } : { ...l, partner_id: undefined, partner_name: v })}
              empty={() => ({ amount: "" })}
              max={MAX_PARTNERS}
              errors={errs.partners}
              groupError={errs.partnersGroup}
            />
          </div>

          <aside className="panel col g16">
            <section className="card col">
              <div className="card-h"><span className="h3">{t("v2.saleForm.reconcile")}</span></div>
              <div className="col g8" style={{ padding: "16px 20px" }}>
                <div className="row between s"><span className="c3">{t("sale_create.sum_by_operators")}</span><span className="num">{fmtNum(opTotal)}</span></div>
                <div className="row between s"><span className="c3">{t("sale_create.sum_by_partners")}</span><span className={cx("num", mismatch && "w6")} style={mismatch ? { color: "var(--bad)" } : undefined}>{fmtNum(partnerTotal)}</span></div>
                {discountNum > 0 ? (
                  <div className="row between s"><span className="w6">{t("sale_create.grand_total")}</span><span className="num w6">{fmtNum(total)}</span></div>
                ) : null}
                {discountNum > 0 ? (
                  <div className="row between s"><span className="c3">{t("sale_create.discount_line")}</span><span className="num" style={{ color: "var(--bad)" }}>{t("sale_create.discount_neg_line", { n: fmtNum(discountNum) })}</span></div>
                ) : null}
                <hr className="hr" style={{ margin: "6px 0" }} />
                <div className="row between" style={{ alignItems: "baseline" }}>
                  <span className="s w6">{discountNum > 0 ? t("sale_create.net_total") : t("sale_create.grand_total")}</span>
                  <span className="kpi" style={{ fontSize: 24 }}>{fmtNum(netTotal)}</span>
                </div>
                {discountNum > 0 ? <span className="xs c3">{t("sale_create.discount_operators_hint")}</span> : null}
                {mismatch ? (
                  <div className="banner b-bad" style={{ marginTop: 8 }}>
                    <AlertTriangle className="ic" />
                    <span>{errs.mismatch ? t("sale_create.sum_mismatch_error", { op: fmtNum(opTotal), partner: fmtNum(partnerTotal) }) : t("sale_create.sums_mismatch", { n: fmtNum(Math.abs(opTotal - partnerTotal)) })}</span>
                  </div>
                ) : opTotal > 0 && partnerTotal > 0 ? (
                  <div className="banner b-ok" style={{ marginTop: 8 }}>
                    <CheckCircle2 className="ic" />
                    <span>{t("v2.saleForm.sumsOk")}</span>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="card col g12" style={{ padding: "16px 20px" }}>
              <div className="field">
                <label htmlFor="sf-disc">{t("sale_create.discount_optional")}</label>
                <NumericInput
                  className={cx("input num", (errs.discount || discountTooBig) && "is-bad")}
                  placeholder="0"
                  value={discount}
                  onChange={(v) => {
                    setDiscount(v);
                    clearErr({ discount: undefined });
                  }}
                />
                {errs.discount ? <span className="err">{errs.discount}</span> : discountTooBig ? <span className="err">{t("sale_create.discount_too_big")}</span> : null}
                <span className="hint">{t("sale_create.discount_hint")}</span>
              </div>
              <div className="field">
                <label htmlFor="sf-note">{t("sale_create.comment_label")}</label>
                <textarea id="sf-note" className="input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
              </div>
              <label className="row g8 s" style={{ cursor: "pointer" }}>
                <input
                  className="check"
                  type="checkbox"
                  checked={hasBonus}
                  onChange={(e) => {
                    setHasBonus(e.target.checked);
                    clearErr({ bonus: undefined });
                  }}
                />
                {t("sale_create.bonus_toggle")}
              </label>
              {hasBonus ? (
                <div className="field">
                  <textarea
                    className={cx("input", errs.bonus && "is-bad")}
                    rows={2}
                    aria-label={t("sale_create.bonus_toggle")}
                    placeholder={t("sale_create.bonus_ph")}
                    value={bonusNote}
                    autoFocus={!isEdit}
                    onChange={(e) => {
                      setBonusNote(e.target.value);
                      clearErr({ bonus: undefined });
                    }}
                  />
                  {errs.bonus ? <span className="err">{errs.bonus}</span> : null}
                  <span className="hint">{t("sale_create.bonus_hint")}</span>
                </div>
              ) : null}
            </section>

            {serverError ? (
              <div className="banner b-bad" role="alert">
                <AlertTriangle className="ic" />
                <span className="col g4"><span className="w6">{serverError.title}</span><span>{serverError.body}</span></span>
              </div>
            ) : hasErrs(errs) ? (
              <div className="banner b-bad" role="alert">
                <AlertTriangle className="ic" />
                <span>{t("v2.saleForm.fixFields")}</span>
              </div>
            ) : null}

            {canApprove ? (
              <section className="card col g8" style={{ padding: "16px 20px 20px" }}>
                <button className="btn btn-ok btn-lg btn-block" type="button" disabled={busy} onClick={() => void submit("approve")}>
                  {saveLabel("approve", t("v2.saleForm.saveApprove"))}
                </button>
                <button className="btn btn-block" type="submit" disabled={busy}>
                  {saveLabel("save", t("v2.saleForm.onlySave"))}
                </button>
                <span className="xs c3">{t("v2.saleForm.journalNote")}</span>
              </section>
            ) : (
              <div className="col g8">
                <div className="row g8">
                  <button className="btn" type="button" style={{ flex: "1 1 0" }} disabled={busy} onClick={() => nav(-1)}>{t("common.cancel")}</button>
                  <button className="btn btn-pri" type="submit" style={{ flex: "1 1 0" }} disabled={busy}>
                    {saveLabel("save", isEdit ? t("sale_create.save_changes") : t("common.save"))}
                  </button>
                </div>
                {isEdit ? <span className="xs c3">{t("v2.saleForm.journalNote")}</span> : null}
              </div>
            )}
          </aside>
        </form>
      </main>
    </>
  );
}
