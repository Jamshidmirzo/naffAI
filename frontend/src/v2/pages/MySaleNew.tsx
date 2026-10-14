import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Camera, Check, ImagePlus, Link2, Upload, X } from "lucide-react";
import { api } from "../../lib/api";
import { toast } from "../../components/ui";
import NumericInput from "../../components/NumericInput";
import CameraCapture from "../../components/CameraCapture";
import {
  imeiLuhnStatus,
  validateAmount,
  validateClientName,
  validateClientPhone,
  validateComment,
  validateContractPhotos,
  validateImei,
  validatePartnerSplit,
  validatePhoneModel,
} from "../../lib/validation";
import { useLang } from "../../store/lang";
import { useAuth } from "../../store/auth";
import { normaliseRole } from "../../components/RoleGate";
import { useT2 } from "../i18n";
import { cx, fmtNum, useConfirm } from "../ui";
import {
  invalidateLeadQueries,
  useLeadStatuses,
  usePaymentChannels,
  useSale,
  type Lead,
  type LeadMatch,
  type MyResponse,
} from "../api/operatorWork";

const MAX_CHANNELS = 2;
const MAX_PHOTOS = 5;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const LOCAL_PHONE_LEN = 9;

type FieldName = "imei" | "phone_model" | "amount" | "partners" | "client_name" | "client_phone" | "comment" | "contract_photos";
const FIELD_ORDER: FieldName[] = ["imei", "phone_model", "amount", "partners", "client_name", "client_phone", "comment", "contract_photos"];
type PartnerRow = { channel_id: number | null; amount: string };

function groupImei(s: string) {
  // 35 693108 123456 7 — TAC/serial/check grouping, display only
  if (s.length <= 2) return s;
  if (s.length <= 8) return `${s.slice(0, 2)} ${s.slice(2)}`;
  if (s.length <= 14) return `${s.slice(0, 2)} ${s.slice(2, 8)} ${s.slice(8)}`;
  return `${s.slice(0, 2)} ${s.slice(2, 8)} ${s.slice(8, 14)} ${s.slice(14)}`;
}
function groupLocalPhone(d: string) {
  // 90 123 45 67
  const p = [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)].filter(Boolean);
  return p.join(" ");
}
function localDigitsOf(phone: string) {
  const d = (phone || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("998")) return d.slice(3);
  return d.slice(-LOCAL_PHONE_LEN);
}

/** Finds a lead in the /my caches (the operator cannot GET /leads/:id/). */
function leadFromCache(qc: ReturnType<typeof useQueryClient>, id: number): Lead | null {
  for (const key of [["leads-my"], ["leads-my-by-status"]]) {
    for (const [, data] of qc.getQueriesData<MyResponse>({ queryKey: key })) {
      const l = data?.results?.find((x) => x.id === id);
      if (l) return l;
    }
  }
  return null;
}

export default function MySaleNew() {
  const t = useT2();
  const nav = useNavigate();
  const qc = useQueryClient();
  const loc = useLocation();
  const [sp] = useSearchParams();
  const confirm = useConfirm();
  const lang = useLang((s) => s.lang);
  const statuses = useLeadStatuses();
  const statusLabel = (code: string) => {
    const r = statuses.data?.find((s) => s.code === code);
    if (!r) return code;
    return lang === "uz" && r.label_uz ? r.label_uz : r.label_ru;
  };

  const [imei, setImei] = useState("");
  const [model, setModel] = useState("");
  const [tacModel, setTacModel] = useState("");
  const [amount, setAmount] = useState("");
  const [clientName, setClientName] = useState("");
  const [phoneLocal, setPhoneLocal] = useState("");
  const [comment, setComment] = useState("");
  const [rows, setRows] = useState<PartnerRow[]>([{ channel_id: null, amount: "" }]);
  const [photos, setPhotos] = useState<File[]>([]);
  const [photoMsgs, setPhotoMsgs] = useState<string[]>([]);
  const [lead, setLead] = useState<LeadMatch | null>(null);
  const [matches, setMatches] = useState<LeadMatch[] | null>(null);
  const [dropdown, setDropdown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ title: string; body?: string } | null>(null);
  const [serverErrors, setServerErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [dirty, setDirty] = useState(false);
  const refs = useRef<Partial<Record<FieldName, HTMLElement | null>>>({});
  const setRef = (f: FieldName) => (el: HTMLElement | null) => {
    refs.current[f] = el;
  };

  const channelsQ = usePaymentChannels();
  const channels: { id: number; name: string }[] = channelsQ.data?.results ?? [];

  /* ── prefill: ?lead=<id> (from /my) ── */
  const leadParam = Number(sp.get("lead")) || null;
  useEffect(() => {
    if (!leadParam) return;
    const fromState = (loc.state as { lead?: Lead } | null)?.lead;
    const l = fromState && fromState.id === leadParam ? fromState : leadFromCache(qc, leadParam);
    if (l) {
      setLead({ id: l.id, full_name: l.full_name, phone: l.phone, status: l.status, sheet_source_name: l.sheet_source_name ?? undefined, product_hint: l.product_hint });
      setClientName((v) => v || l.full_name || "");
      setPhoneLocal((v) => v || localDigitsOf(l.phone));
      if (l.product_hint) setModel((v) => v || l.product_hint);
    } else {
      // reload of a deep link: keep the link by id; the operator sees «по лиду #id»
      setLead({ id: leadParam, full_name: "", phone: "", status: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadParam]);

  /* ── prefill: ?from=<saleId> («Исправить и отправить снова») ── */
  const fromId = sp.get("from") || undefined;
  const fromQ = useSale(fromId);
  const fromDone = useRef(false);
  useEffect(() => {
    const s = fromQ.data;
    if (!s || fromDone.current) return;
    fromDone.current = true;
    setImei((s.imei || "").replace(/\D/g, "").slice(0, 15));
    setModel(s.phone_model || "");
    setAmount(String(Math.round(Number(s.amount) || 0) || ""));
    setClientName(s.client_name || "");
    setPhoneLocal(localDigitsOf(s.client_phone || ""));
    setComment(s.comment || "");
    const pl = s.partner_lines ?? [];
    if (pl.length) setRows(pl.slice(0, MAX_CHANNELS).map((p) => ({ channel_id: p.partner, amount: String(Math.round(Number(p.amount) || 0)) })));
    else if (s.channel) setRows([{ channel_id: s.channel, amount: "" }]);
  }, [fromQ.data]);

  /* ── IMEI → model (TAC lookup) ──
   * /imei/:imei/lookup/ is IsTeamLeadOrManagerReadOnly on the backend, so for
   * an operator it only produced a 403 and a «Доступ запрещён» toast in the
   * old page. Call it only for roles that may read it. */
  const canTac = normaliseRole(useAuth((s) => s.role)) !== "operator";
  useEffect(() => {
    if (!canTac || imei.length !== 15) {
      setTacModel("");
      return;
    }
    let off = false;
    api
      .get(`/imei/${imei}/lookup/`)
      .then((r) => {
        if (off) return;
        const m = `${r.data?.brand ?? ""} ${r.data?.model ?? ""}`.trim();
        if (m) {
          setTacModel(m);
          setModel(m);
        }
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [imei, canTac]);

  /* ── phone → lead search (debounced) ── */
  useEffect(() => {
    if (lead) return;
    if (phoneLocal.length < 4) {
      setMatches(null);
      setDropdown(false);
      return;
    }
    const h = window.setTimeout(() => {
      api
        .get(`/leads/phone-search/`, { params: { q: phoneLocal } })
        .then((r) => {
          const res: LeadMatch[] = r.data?.results ?? [];
          setMatches(res);
          setDropdown(res.length > 0);
        })
        .catch(() => setMatches([]));
    }, 300);
    return () => window.clearTimeout(h);
  }, [phoneLocal, lead]);

  const edit = () => {
    setDirty(true);
    if (Object.keys(serverErrors).length) setServerErrors({});
    if (banner) setBanner(null);
  };
  const touch = (f: FieldName) => setTouched((p) => (p[f] ? p : { ...p, [f]: true }));

  /* ── validation ── */
  const split = rows.length > 1;
  const fullPhone = `+998${phoneLocal}`;
  const errors: Record<FieldName, string | null> = {
    imei: validateImei(imei),
    phone_model: validatePhoneModel(model),
    amount: validateAmount(amount),
    partners: validatePartnerSplit(rows, amount, MAX_CHANNELS),
    client_name: validateClientName(clientName),
    client_phone: lead?.phone ? null : validateClientPhone(fullPhone),
    comment: validateComment(comment),
    contract_photos: validateContractPhotos(photos, MAX_PHOTOS),
  };
  const msg = (f: FieldName): string | null => {
    const e = errors[f];
    if (!e) return null;
    if (f === "imei" && e === "validation.imei_length") return t("v2.opsale.imeiLen", { n: imei.length });
    if (f === "imei" && e === "validation.imei_required") return t("v2.opsale.imeiRequired");
    if (f === "client_phone" && e === "validation.phone_uz_format" && phoneLocal.length < LOCAL_PHONE_LEN) return t("v2.opsale.phoneLen", { n: phoneLocal.length });
    if (f === "contract_photos" && e === "validation.photo_required") return t("v2.opsale.photoRequired");
    return t(e);
  };
  const shown = (f: FieldName): string | null => {
    if (errors[f]) return submitted || touched[f] ? msg(f) : null;
    return serverErrors[f] ?? null;
  };
  const problems = FIELD_ORDER.filter((f) => errors[f] !== null || !!serverErrors[f]);

  const jump = (f: FieldName) => {
    touch(f);
    const el = refs.current[f];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const focusable = (el.matches("input,textarea,select,button") ? el : el.querySelector("input,textarea,select,button")) as HTMLElement | null;
    try {
      focusable?.focus({ preventScroll: true });
    } catch {
      /* old browsers */
    }
  };

  /* ── partners ── */
  const total = Number(amount) || 0;
  const splitSum = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const remaining = total - splitSum;
  const setMode = (two: boolean) => {
    edit();
    touch("partners");
    if (two && rows.length < MAX_CHANNELS) setRows((r) => [...r, { channel_id: null, amount: "" }]);
    if (!two && rows.length > 1) setRows((r) => [{ ...r[0], amount: "" }]);
  };
  const setRow = (i: number, patch: Partial<PartnerRow>) => {
    edit();
    touch("partners");
    setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  };
  const chName = (id: number | null) => channels.find((c) => c.id === id)?.name ?? "";

  /* ── photos ── */
  const addFiles = (incoming: File[] | FileList | null) => {
    if (!incoming) return;
    const list = Array.from(incoming);
    const notes: string[] = [];
    const ok: File[] = [];
    for (const f of list) {
      if (f.type && !f.type.startsWith("image/")) {
        notes.push(t("v2.opsale.photoType", { name: f.name }));
        continue;
      }
      if (f.size > MAX_PHOTO_BYTES) {
        notes.push(t("v2.opsale.photoBig", { name: f.name, mb: Math.round(f.size / 1024 / 1024) }));
        continue;
      }
      ok.push(f);
    }
    const slots = Math.max(0, MAX_PHOTOS - photos.length);
    if (ok.length > slots) notes.push(t("v2.opsale.photoMax", { n: ok.length - slots }));
    if (ok.length && slots) {
      setPhotos((p) => [...p, ...ok.slice(0, slots)]);
      edit();
    }
    touch("contract_photos");
    setPhotoMsgs(notes);
  };

  /* ── submit ── */
  const onSubmit = async () => {
    setSubmitted(true);
    setServerErrors({});
    setBanner(null);
    const bad = FIELD_ORDER.filter((f) => errors[f] !== null);
    if (bad.length) {
      jump(bad[0]);
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("imei", imei);
      fd.append("phone_model", model.trim());
      fd.append("amount", amount);
      fd.append("client_name", clientName.trim());
      fd.append("client_phone", lead?.phone ? lead.phone : fullPhone);
      if (comment.trim()) fd.append("comment", comment.trim());
      if (lead) fd.append("lead_id", String(lead.id));
      rows.forEach((r, i) => {
        if (r.channel_id == null) return;
        fd.append(`partners[${i}][channel_id]`, String(r.channel_id));
        fd.append(`partners[${i}][amount]`, split ? r.amount : amount);
      });
      if (rows[0]?.channel_id != null) fd.append("channel_id", String(rows[0].channel_id));
      photos.forEach((f) => fd.append("contract_photos", f));
      if (photos[0]) fd.append("contract_photo", photos[0]);

      const r = await api.post("/sales/", fd);
      qc.invalidateQueries({ queryKey: ["my-sales"] });
      invalidateLeadQueries(qc);
      toast.success(t("op_sale.sent_for_review"));
      setDirty(false);
      nav(`/sales/${r.data.id}`);
    } catch (err) {
      const d = (err as { response?: { data?: Record<string, unknown> } })?.response?.data ?? {};
      const localize = (raw: string) => {
        const s = (raw || "").trim();
        if (s === "Not a valid string.") return t("validation.generic_invalid");
        if (s === "This field is required." || s === "This field may not be blank.") return t("validation.generic_required");
        return s;
      };
      const got: Partial<Record<FieldName, string>> = {};
      for (const f of FIELD_ORDER) {
        const raw = d[f];
        if (!raw) continue;
        const first = Array.isArray(raw) ? raw[0] : raw;
        if (typeof first === "string") got[f] = localize(first);
      }
      if (typeof d.field === "string" && typeof d.detail === "string") {
        let k = d.field;
        if (k === "contract_photo") k = "contract_photos";
        if (k === "channel_id") k = "partners";
        if ((FIELD_ORDER as string[]).includes(k) && !got[k as FieldName]) got[k as FieldName] = localize(d.detail);
      }
      if (Object.keys(got).length) {
        setServerErrors(got);
        const names = FIELD_ORDER.filter((f) => got[f]).map((f) => t(`v2.opsale.f.${f}`)).join(", ");
        setBanner({ title: t("v2.opsale.serverBad"), body: t("v2.opsale.serverBadBody", { fields: names }) });
        const first = FIELD_ORDER.find((f) => got[f]);
        if (first) jump(first);
      } else {
        const nf = d.non_field_errors as string[] | undefined;
        const detail = typeof d.detail === "string" ? d.detail : typeof nf?.[0] === "string" ? nf[0] : null;
        setBanner({ title: t("v2.opsale.serverFail"), body: detail || t("op_sale.save_failed") });
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (dirty) {
      const ok = await confirm({ title: t("v2.opsale.leaveTitle"), body: t("v2.opsale.leaveBody"), confirm: t("v2.opsale.leave") });
      if (!ok) return;
    }
    if (window.history.length > 1) nav(-1);
    else nav("/my");
  };

  const luhn = imeiLuhnStatus(imei);
  const imeiHint: { tone: "ok" | "warn" | "muted"; text: string } | null = !imei
    ? null
    : imei.length < 15
      ? { tone: "muted", text: `${imei.length}/15` }
      : luhn === "warn"
        ? { tone: "warn", text: t("v2.opsale.imeiWarn") }
        : { tone: "ok", text: tacModel ? t("v2.opsale.imeiOkModel", { model: tacModel }) : t("v2.opsale.imeiOk") };

  const leadTitle = lead ? lead.full_name || (lead.phone ? lead.phone : `#${lead.id}`) : "";
  const noLeadWarn = !lead && phoneLocal.length === LOCAL_PHONE_LEN && matches !== null && matches.length === 0;

  const checks: Array<{ f: FieldName; okText: string }> = [
    { f: "imei", okText: luhn === "warn" ? t("v2.opsale.chk.imeiWarn") : t("v2.opsale.chk.imei") },
    { f: "phone_model", okText: t("v2.opsale.chk.model") },
    { f: "amount", okText: t("v2.opsale.chk.amount") },
    { f: "partners", okText: split ? t("v2.opsale.chk.split") : t("v2.opsale.chk.channel") },
    { f: "client_name", okText: t("v2.opsale.chk.name") },
    { f: "client_phone", okText: lead ? t("v2.opsale.chk.lead") : t("v2.opsale.chk.phone") },
    { f: "contract_photos", okText: t("v2.opsale.chk.photos", { n: photos.length }) },
  ];
  if (errors.comment || serverErrors.comment) checks.push({ f: "comment", okText: "" });

  return (
    <>
      <header className="top" style={{ flexWrap: "wrap" }}>
        <button className="btn btn-ghost btn-sq" type="button" aria-label={t("v2.opsale.backToLeads")} onClick={() => void leave()}>
          <ArrowLeft className="ic" />
        </button>
        <h1 className="h1">{t("op_sale.title_new")}</h1>
        {lead ? <span className="badge">{t("v2.opsale.byLead", { name: leadTitle })}</span> : null}
        {fromId ? <span className="badge b-warn">{t("v2.opsale.resubmitBadge", { id: fromId })}</span> : null}
        <span className="grow" />
        <button className="btn btn-ghost" type="button" onClick={() => void leave()}>{t("common.cancel")}</button>
      </header>

      <main className="page">
        {fromQ.data?.rejection_reason ? (
          <div className="banner b-warn">
            <AlertTriangle className="ic" />
            <span className="col g4">
              <span className="w6">{t("v2.opsale.resubmitTitle", { id: fromQ.data.id })}</span>
              <span>{t("v2.opsale.resubmitBody", { reason: fromQ.data.rejection_reason })}</span>
            </span>
          </div>
        ) : null}
        {banner ? (
          <div className="banner b-bad" role="alert">
            <AlertTriangle className="ic" />
            <span className="col g4">
              <span className="w6">{banner.title}</span>
              {banner.body ? <span>{banner.body}</span> : null}
            </span>
          </div>
        ) : null}

        <div className="split">
          <form
            className="list col g16"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void onSubmit();
            }}
          >
            {/* 1 · Товар */}
            <section className="card">
              <div className="card-h">
                <span className="h3">{t("v2.opsale.s1")}</span>
                {canTac ? <span className="xs c3">{t("v2.opsale.s1hint")}</span> : null}
              </div>
              <div className="pad row g16 wrap" style={{ alignItems: "flex-start" }}>
                <div className="field" style={{ flex: "1 1 100%" }}>
                  <label htmlFor="f-imei">{t("v2.opsale.imei")}</label>
                  <input
                    ref={setRef("imei")}
                    id="f-imei"
                    className={cx("input num", shown("imei") ? "is-bad" : imeiHint?.tone === "ok" ? "is-ok" : imeiHint?.tone === "warn" ? "is-warn" : null)}
                    style={{ fontSize: 16 }}
                    value={groupImei(imei)}
                    placeholder={t("v2.opsale.imeiPh")}
                    inputMode="numeric"
                    autoComplete="off"
                    onKeyDown={(e) => {
                      if (e.key.length === 1 && !/[0-9]/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault();
                    }}
                    onChange={(e) => {
                      setImei(e.target.value.replace(/\D/g, "").slice(0, 15));
                      edit();
                    }}
                    onBlur={() => touch("imei")}
                  />
                  {shown("imei") ? (
                    <span className="err">{shown("imei")}</span>
                  ) : imeiHint ? (
                    <span className="hint row g6" style={{ color: imeiHint.tone === "ok" ? "var(--ok)" : imeiHint.tone === "warn" ? "var(--warn)" : undefined }}>
                      {imeiHint.tone === "ok" ? <Check className="ic ic-s" /> : imeiHint.tone === "warn" ? <AlertTriangle className="ic ic-s" /> : null}
                      {imeiHint.text}
                    </span>
                  ) : null}
                </div>
                <div className="field" style={{ flex: "1 1 260px" }}>
                  <label htmlFor="f-model">{t("sale_create.phone_model")}</label>
                  <input
                    ref={setRef("phone_model")}
                    id="f-model"
                    className={cx("input", shown("phone_model") && "is-bad")}
                    value={model}
                    maxLength={128}
                    placeholder={t("v2.opsale.modelPh")}
                    onChange={(e) => {
                      setModel(e.target.value);
                      edit();
                    }}
                    onBlur={() => touch("phone_model")}
                  />
                  {shown("phone_model") ? <span className="err">{shown("phone_model")}</span> : null}
                </div>
                <div className="field" ref={setRef("amount")} style={{ flex: "1 1 260px" }}>
                  <label htmlFor="f-sum">{t("v2.opsale.amount")}</label>
                  <NumericInput
                    className={cx("input num", shown("amount") && "is-bad")}
                    value={amount}
                    maxDigits={10}
                    placeholder="5 000 000"
                    onChange={(v) => {
                      setAmount(v);
                      edit();
                      if (v) touch("amount");
                    }}
                  />
                  {shown("amount") ? <span className="err">{shown("amount")}</span> : null}
                </div>
              </div>
            </section>

            {/* 2 · Клиент */}
            <section className="card">
              <div className="card-h">
                <span className="h3">{t("v2.opsale.s2")}</span>
                {lead ? (
                  <span className="badge b-ok">
                    <Check className="ic ic-s" />
                    {t("v2.opsale.linked")}
                  </span>
                ) : null}
              </div>
              <div className="pad row g16 wrap" style={{ alignItems: "flex-start" }}>
                <div className="field" style={{ flex: "1 1 260px" }}>
                  <label htmlFor="f-name">{t("sale_create.client_name")}</label>
                  <input
                    ref={setRef("client_name")}
                    id="f-name"
                    className={cx("input", shown("client_name") && "is-bad")}
                    value={clientName}
                    maxLength={128}
                    placeholder={t("sale_create.client_name_ph")}
                    onChange={(e) => {
                      setClientName(e.target.value);
                      edit();
                    }}
                    onBlur={() => touch("client_name")}
                  />
                  {shown("client_name") ? <span className="err">{shown("client_name")}</span> : null}
                </div>
                <div className="field" style={{ position: "relative", flex: "1 1 260px" }} ref={setRef("client_phone")}>
                  <label htmlFor="f-phone">{t("sale_create.client_phone")}</label>
                  {lead && lead.phone ? (
                    <div className="input row g8" style={{ height: "auto", minHeight: 40, padding: "6px 8px 6px 12px" }}>
                      <Link2 className="ic c3" />
                      <span className="col grow" style={{ minWidth: 0 }}>
                        <span className="s w6 trunc">
                          {lead.full_name || "—"} <span className="num c3" style={{ fontWeight: 400 }}>{lead.phone}</span>
                        </span>
                        <span className="xs c3 trunc">
                          {[lead.status ? statusLabel(lead.status) : "", lead.sheet_source_name].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      <button
                        className="btn btn-ghost btn-sq btn-sm"
                        type="button"
                        aria-label={t("v2.opsale.unlink")}
                        title={t("v2.opsale.unlink")}
                        onClick={() => {
                          setLead(null);
                          setPhoneLocal("");
                          edit();
                        }}
                      >
                        <X className="ic" />
                      </button>
                    </div>
                  ) : (
                    <div className="row g8">
                      <span className="pfx" style={{ height: 40, fontSize: 14, borderRadius: 8 }} aria-hidden="true">+998</span>
                      <input
                        id="f-phone"
                        className={cx("input num grow", shown("client_phone") && "is-bad")}
                        type="tel"
                        inputMode="tel"
                        autoComplete="off"
                        value={groupLocalPhone(phoneLocal)}
                        placeholder="90 123 45 67"
                        onKeyDown={(e) => {
                          if (e.key.length === 1 && !/[0-9]/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault();
                        }}
                        onChange={(e) => {
                          const d = e.target.value.replace(/\D/g, "");
                          setPhoneLocal(d.length > LOCAL_PHONE_LEN && d.startsWith("998") ? d.slice(3, 3 + LOCAL_PHONE_LEN) : d.slice(0, LOCAL_PHONE_LEN));
                          edit();
                        }}
                        onFocus={() => matches?.length && setDropdown(true)}
                        onBlur={() => {
                          touch("client_phone");
                          window.setTimeout(() => setDropdown(false), 150);
                        }}
                      />
                    </div>
                  )}
                  {lead && !lead.phone ? (
                    <span className="hint row g6">
                      <Link2 className="ic ic-s" />
                      {t("v2.opsale.linkedById", { id: lead.id })}
                      <button className="btn btn-ghost btn-sm" type="button" onClick={() => setLead(null)}>{t("v2.opsale.unlink")}</button>
                    </span>
                  ) : null}
                  {shown("client_phone") ? <span className="err">{shown("client_phone")}</span> : null}
                  {dropdown && !lead && matches?.length ? (
                    <div className="card col" style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 30, marginTop: 4, boxShadow: "var(--shadow)", maxHeight: 280, overflowY: "auto" }}>
                      {matches.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className="li"
                          style={{ minHeight: 52, width: "100%", background: "none", border: 0, textAlign: "left" }}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setLead(m);
                            setClientName(m.full_name || clientName);
                            setPhoneLocal(localDigitsOf(m.phone));
                            setDropdown(false);
                            touch("client_name");
                            touch("client_phone");
                            edit();
                          }}
                        >
                          <span className="col grow" style={{ minWidth: 0 }}>
                            <span className="s w6 trunc">{m.full_name || "—"}</span>
                            <span className="num xs c3 trunc">{[m.phone, m.sheet_source_name].filter(Boolean).join(" · ")}</span>
                          </span>
                          <span className="badge">{statusLabel(m.status)}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                {noLeadWarn ? (
                  <div className="banner b-warn" style={{ flex: "1 1 100%" }}>
                    <AlertTriangle className="ic" />
                    <span>{t("v2.opsale.noLead")}</span>
                  </div>
                ) : null}
              </div>
            </section>

            {/* 3 · Оплата и договор */}
            <section className="card">
              <div className="card-h" style={{ flexWrap: "wrap", gap: 8 }}>
                <span className="h3">{t("v2.opsale.s3")}</span>
                <div className="seg" role="group" aria-label={t("v2.opsale.partners")}>
                  <button type="button" className={cx(!split && "is-on")} onClick={() => setMode(false)}>{t("v2.opsale.one")}</button>
                  <button type="button" className={cx(split && "is-on")} onClick={() => setMode(true)}>{t("v2.opsale.two")}</button>
                </div>
              </div>
              <div className="pad col g16">
                <div className="col g8" ref={setRef("partners")}>
                  <span className="flabel">{t("v2.opsale.partners")}</span>
                  {rows.map((r, i) => (
                    <div key={i} className="row g8 wrap">
                      <select
                        className={cx("input", shown("partners") && r.channel_id == null && "is-bad")}
                        aria-label={t("v2.opsale.partnerN", { n: i + 1 })}
                        style={{ width: 200, flex: "1 1 160px" }}
                        value={r.channel_id ?? ""}
                        onChange={(e) => setRow(i, { channel_id: e.target.value ? Number(e.target.value) : null })}
                      >
                        <option value="">{channelsQ.isLoading ? t("common.loading") : t("op_sale.channel_ph")}</option>
                        {channels
                          .filter((c) => !rows.some((x, j) => j !== i && x.channel_id === c.id))
                          .map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                      </select>
                      {split ? (
                        <div style={{ flex: "2 1 160px", minWidth: 0 }}>
                          <NumericInput
                            className="input num"
                            value={r.amount}
                            maxDigits={10}
                            placeholder={t("v2.opsale.partnerSum")}
                            onChange={(v) => setRow(i, { amount: v })}
                          />
                        </div>
                      ) : (
                        <input className="input num grow" disabled value={total ? fmtNum(total) : ""} placeholder={t("v2.opsale.partnerSumAuto")} aria-label={t("v2.opsale.partnerSum")} style={{ flex: "2 1 160px" }} />
                      )}
                    </div>
                  ))}
                  {split && total > 0 ? (
                    remaining === 0 ? (
                      <span className="hint row g6" style={{ color: "var(--ok)" }}>
                        <Check className="ic ic-s" />
                        {t("v2.opsale.splitOk", { a: fmtNum(splitSum), b: fmtNum(total) })}
                      </span>
                    ) : remaining > 0 ? (
                      <span className="hint row g6 wrap" style={{ color: "var(--warn)" }}>
                        {t("v2.opsale.splitLeft", { n: fmtNum(remaining) })}
                        {(() => {
                          const i = rows.findIndex((r) => !(Number(r.amount) > 0));
                          const target = i >= 0 ? i : rows.length - 1;
                          return (
                            <button
                              className="btn btn-ghost btn-sm"
                              type="button"
                              onClick={() => setRow(target, { amount: String((Number(rows[target].amount) || 0) + remaining) })}
                            >
                              {chName(rows[target].channel_id) ? t("v2.opsale.addTo", { name: chName(rows[target].channel_id) }) : t("v2.opsale.fillRest")}
                            </button>
                          );
                        })()}
                      </span>
                    ) : (
                      <span className="err">{t("v2.opsale.splitOver", { n: fmtNum(-remaining) })}</span>
                    )
                  ) : null}
                  {shown("partners") ? <span className="err">{shown("partners")}</span> : null}
                  <span className="hint">{t("v2.opsale.maxTwo")}</span>
                </div>

                <PhotoBlock
                  photos={photos}
                  onAdd={addFiles}
                  onRemove={(i) => {
                    setPhotos((p) => p.filter((_, j) => j !== i));
                    edit();
                    touch("contract_photos");
                  }}
                  bad={!!shown("contract_photos")}
                  innerRef={setRef("contract_photos")}
                />
                {photoMsgs.map((m, i) => (
                  <span key={i} className="err">{m}</span>
                ))}
                {shown("contract_photos") ? <span className="err">{shown("contract_photos")}</span> : null}

                <div className="field">
                  <label htmlFor="f-note">{t("sale_create.comment_label")}</label>
                  <textarea
                    ref={setRef("comment")}
                    id="f-note"
                    className={cx("input", shown("comment") && "is-bad")}
                    rows={2}
                    maxLength={500}
                    value={comment}
                    onChange={(e) => {
                      setComment(e.target.value);
                      edit();
                    }}
                    onBlur={() => touch("comment")}
                  />
                  <span className="hint row between">
                    <span className="row g6 wrap">
                      {["v2.opsale.c1", "v2.opsale.c2", "v2.opsale.c3"].map((k) => (
                        <button key={k} type="button" className="chip" onClick={() => setComment((c) => (c.trim() ? `${c.trim()}. ${t(k)}` : t(k)).slice(0, 500))}>
                          {t(k)}
                        </button>
                      ))}
                    </span>
                    <span className="num">{comment.length}/500</span>
                  </span>
                  {shown("comment") ? <span className="err">{shown("comment")}</span> : null}
                </div>
              </div>
            </section>
            <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
          </form>

          <aside className="panel card col" style={{ position: "sticky", top: 16 }}>
            <div className="card-h">
              <span className="h3">{t("v2.opsale.summary")}</span>
              {problems.length ? (
                <span className="badge b-bad">{t(`v2.opsale.problems.${plural(problems.length)}`, { n: problems.length })}</span>
              ) : (
                <span className="badge b-warn"><i className="dot" />{t("v2.opsale.toReview")}</span>
              )}
            </div>
            <div className="col g8" style={{ padding: "16px 20px" }}>
              <SumRow label={t("v2.opsale.sumProduct")} value={model || "—"} />
              <SumRow label="IMEI" value={imei ? groupImei(imei) : "—"} num />
              <SumRow label={t("v2.opsale.sumClient")} value={clientName || (lead ? leadTitle : "—")} />
              <SumRow label={t("v2.opsale.partners")} value={rows.map((r) => chName(r.channel_id)).filter(Boolean).join(" + ") || "—"} />
              <SumRow label={t("op_sale.contract_photos")} value={String(photos.length)} num />
              <hr className="hr" style={{ margin: "6px 0" }} />
              <div className="row between" style={{ alignItems: "baseline" }}>
                <span className="s w6">{t("op_sale.amount")}</span>
                <span className="kpi" style={{ fontSize: 24 }}>{total ? fmtNum(total) : "—"}</span>
              </div>
            </div>
            <hr className="hr" />
            <div className="col g12" style={{ padding: "16px 20px 20px" }}>
              <div className="col g6">
                {checks.map((c) => {
                  const bad = errors[c.f] !== null || !!serverErrors[c.f];
                  return bad ? (
                    <button key={c.f} type="button" className="row g8 s c-bad" style={{ background: "none", border: 0, padding: 0, textAlign: "left", cursor: "pointer" }} onClick={() => jump(c.f)}>
                      <X className="ic" style={{ flex: "none" }} />
                      <span>{t(`v2.opsale.f.${c.f}`)}: {serverErrors[c.f] ?? msg(c.f)}</span>
                    </button>
                  ) : (
                    <div key={c.f} className="row g8 s">
                      {c.f === "imei" && luhn === "warn" ? <AlertTriangle className="ic c-warn" /> : <Check className="ic c-ok" />}
                      {c.okText}
                    </div>
                  );
                })}
              </div>
              <button className="btn btn-pri btn-lg btn-block" type="button" disabled={busy || problems.length > 0} onClick={() => void onSubmit()}>
                {busy ? t("v2.opsale.sending") : t("v2.opsale.send")}
              </button>
              <p className="xs c3">{problems.length ? t("v2.opsale.clickHint") : t("v2.opsale.footnote")}</p>
            </div>
          </aside>
        </div>
      </main>
      {confirm.node}
    </>
  );
}

function plural(n: number) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "one";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "few";
  return "many";
}

function SumRow({ label, value, num }: { label: string; value: ReactNode; num?: boolean }) {
  return (
    <div className="row between g12">
      <span className="s c3" style={{ flex: "none" }}>{label}</span>
      <span className={cx("s trunc", num ? "num" : "w6")} style={{ textAlign: "right" }}>{value}</span>
    </div>
  );
}

function PhotoBlock({
  photos,
  onAdd,
  onRemove,
  bad,
  innerRef,
}: {
  photos: File[];
  onAdd: (f: File[] | FileList | null) => void;
  onRemove: (i: number) => void;
  bad: boolean;
  innerRef: (el: HTMLElement | null) => void;
}) {
  const t = useT2();
  const input = useRef<HTMLInputElement | null>(null);
  const [cam, setCam] = useState(false);
  const [over, setOver] = useState(false);
  const urls = useMemo(() => photos.map((f) => URL.createObjectURL(f)), [photos]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  const canAdd = photos.length < MAX_PHOTOS;

  // Cmd/Ctrl+V of an image anywhere on the page (not into a text field)
  const addRef = useRef(onAdd);
  addRef.current = onAdd;
  useEffect(() => {
    const h = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((it) => it.kind === "file" && it.type.startsWith("image/"));
      if (!item) return;
      const f = item.getAsFile();
      if (!f) return;
      e.preventDefault();
      addRef.current([f]);
    };
    window.addEventListener("paste", h);
    return () => window.removeEventListener("paste", h);
  }, []);

  return (
    <div className="col g8" ref={innerRef}>
      <div className="row between wrap g8">
        <span className="flabel">{t("op_sale.contract_photos")}</span>
        <span className="xs c3">{t("v2.opsale.photosHint", { n: photos.length, max: MAX_PHOTOS })}</span>
      </div>
      <div
        className="row g8 wrap"
        onDragOver={(e) => {
          if (!canAdd) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onAdd(e.dataTransfer.files);
        }}
        style={{ borderRadius: 12, outline: over ? "2px dashed var(--brand)" : undefined, outlineOffset: 4 }}
      >
        {photos.length === 0 ? (
          <button
            type="button"
            className="ph"
            style={{ height: 110, flex: "1 1 280px", cursor: "pointer", ...(bad ? { borderColor: "var(--bad-solid)", background: "var(--bad-bg)", color: "var(--bad)" } : {}) }}
            onClick={() => input.current?.click()}
          >
            <Upload className="ic" />
            <span className="w6">{t("v2.opsale.photoRequired")}</span>
            <span>{t("v2.opsale.photoDrop")}</span>
          </button>
        ) : (
          urls.map((u, i) => (
            <div key={u} className="ph" style={{ width: 120, height: 88, position: "relative", overflow: "hidden", padding: 0, borderStyle: "solid" }}>
              <img src={u} alt={t("v2.opsale.photoN", { n: i + 1 })} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              <button
                type="button"
                className="btn btn-sq btn-sm"
                aria-label={t("v2.opsale.photoRemove", { n: i + 1 })}
                onClick={() => onRemove(i)}
                style={{ position: "absolute", top: 4, right: 4, width: 26, height: 26, minHeight: 0, padding: 0 }}
              >
                <X className="ic ic-s" />
              </button>
            </div>
          ))
        )}
        {photos.length > 0 && canAdd ? (
          <button className="btn" type="button" style={{ width: 120, height: 88, flexDirection: "column", gap: 4, borderStyle: "dashed" }} onClick={() => input.current?.click()}>
            <ImagePlus className="ic" />
            <span className="xs">{t("v2.opsale.add")}</span>
          </button>
        ) : null}
        {canAdd ? (
          <button className="btn" type="button" style={{ width: 120, height: photos.length ? 88 : 110, flexDirection: "column", gap: 4 }} onClick={() => setCam(true)}>
            <Camera className="ic" />
            <span className="xs">{t("v2.opsale.camera")}</span>
          </button>
        ) : null}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          onAdd(e.target.files);
          e.target.value = "";
        }}
      />
      {cam ? (
        <CameraCapture
          onCapture={(f) => {
            onAdd([f]);
            setCam(false);
          }}
          onCancel={() => setCam(false)}
        />
      ) : null}
    </div>
  );
}
