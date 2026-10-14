import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { Calculator as CalcIcon, ChevronDown, ChevronUp, Copy, Search, X } from "lucide-react";
import { toast } from "../../components/ui";
import NumericInput from "../../components/NumericInput";
import { useAuth } from "../../store/auth";
import { normaliseRole } from "../../components/RoleGate";
import { useT2 } from "../i18n";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, cx, fmtNum } from "../ui";
import {
  useCalcPhones,
  useCalculate,
  usePhoneQuote,
  type CalcPhone,
  type CalcResponse,
  type CalcTierRow,
  type InstallmentRow,
} from "../api/personal";

type T = ReturnType<typeof useT2>;

function useDebounced<V>(value: V, ms = 250): V {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

const pct = (v: string) => String(Number(v));
const phoneName = (p: { brand: string; model_name: string }) => `${p.brand} ${p.model_name}`;
const phoneLabel = (p: CalcPhone) => `${phoneName(p)}${p.storage_gb ? ` ${p.storage_gb}GB` : ""}`;

/* ------------------------------ product search ------------------------------ */

function PhoneSearch({
  t, id, selected, onPick, onText,
}: {
  t: T; id: string; selected: CalcPhone | null; onPick: (p: CalcPhone) => void; onText: (s: string) => void;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = useDebounced(selected ? "" : text, 250);
  const phones = useCalcPhones(q);
  const list = (phones.data ?? []).slice(0, 8);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) setText(phoneLabel(selected));
  }, [selected]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const pick = (p: CalcPhone) => {
    onPick(p);
    setText(phoneLabel(p));
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") return setOpen(false);
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) return setOpen(true);
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(list.length - 1, a + 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    if (e.key === "Enter" && open && list[active]) { e.preventDefault(); pick(list[active]); }
  };

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <div className="inwrap">
        <Search className="ic" />
        <input
          id={id}
          className="input"
          type="text"
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          placeholder={t("v2.personal.calc.search")}
          value={text}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            setOpen(true);
            onText(e.target.value);
          }}
          style={selected ? { paddingRight: 40 } : undefined}
        />
        {selected || text ? (
          <button
            type="button"
            className="btn btn-ghost btn-sq btn-sm"
            aria-label={t("v2.personal.calc.clear")}
            style={{ position: "absolute", right: 5 }}
            onClick={() => { setText(""); onText(""); setOpen(false); }}
          >
            <X className="ic" />
          </button>
        ) : null}
      </div>
      {open ? (
        <div id={`${id}-list`} role="listbox" className="card col" style={{ position: "absolute", top: 46, left: 0, right: 0, zIndex: 5, boxShadow: "var(--shadow)", padding: 4 }}>
          {phones.isLoading ? (
            <span className="xs c3" style={{ padding: "8px 10px" }}>{t("common.loading")}</span>
          ) : list.length === 0 ? (
            <span className="xs c3" style={{ padding: "8px 10px" }}>{t("v2.personal.calc.nothing")}</span>
          ) : (
            list.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={selected?.id === p.id}
                className="row between"
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(p)}
                style={{ padding: "8px 10px", borderRadius: 8, border: 0, textAlign: "left", background: i === active ? "var(--brand-soft)" : "transparent", opacity: p.is_active ? 1 : 0.6 }}
              >
                <span className="s trunc">{phoneLabel(p)}</span>
                <span className="num xs c3" style={{ flex: "none" }}>{fmtNum(p.price)} {t("v2.personal.calc.sum")}</span>
              </button>
            ))
          )}
          <div className="xs c3" style={{ padding: "8px 10px", borderTop: "1px solid var(--line)" }}>{t("v2.personal.calc.free")}</div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ copy text ------------------------------ */

function buildText(t: T, data: CalcResponse, phone: CalcPhone | null, tier: CalcTierRow | null): string {
  const sum = t("v2.personal.calc.sum");
  const lines: string[] = [phone ? phoneLabel(phone) : t("calculator.title")];
  lines.push(`${t("v2.personal.calc.price_l")}: ${fmtNum(data.amount)} ${sum}`);
  if (Number(data.down_payment) > 0) lines.push(`${t("v2.personal.calc.first_l")}: ${fmtNum(data.down_payment)} ${sum}`);
  lines.push(`${t("v2.personal.calc.ariza")}: ${fmtNum(data.ariza)} ${sum}`);
  if (tier) {
    lines.push(`${t("v2.personal.calc.term_l")}: ${t("v2.personal.calc.monthsN", { n: tier.months })} · ${pct(tier.commission_pct)}%`);
    lines.push(`${t("v2.personal.calc.monthly_l")}: ${fmtNum(tier.sum_per_month)} ${sum}`);
    lines.push(`${t("v2.personal.calc.total_l")}: ${fmtNum(tier.total)} ${sum}`);
  } else {
    lines.push("");
    for (const r of data.tiers) {
      lines.push(`• ${t("v2.personal.calc.monthsN", { n: r.months })} · ${pct(r.commission_pct)}% → ${fmtNum(r.sum_per_month)} ${sum} ${t("catalog.per_month")}`);
    }
  }
  return lines.join("\n");
}

/* ------------------------------ page ------------------------------ */

export default function Calculator() {
  const t = useT2();
  const isOp = normaliseRole(useAuth((s) => s.role)) === "operator";

  const [phone, setPhone] = useState<CalcPhone | null>(null);
  const [amountRaw, setAmountRaw] = useState("");
  const [downRaw, setDownRaw] = useState("");
  const [tierId, setTierId] = useState<number | null>(null);

  const downTooBig = !!downRaw && Number(downRaw) > 0 && Number(downRaw) > Number(amountRaw || (phone ? Math.round(Number(phone.price)) : 0));

  const dAmount = useDebounced(amountRaw);
  const dDown = useDebounced(downRaw);
  const dPhone = useDebounced(phone?.id ?? null);
  // «Взнос больше суммы» — no request, the server would silently clamp to 0.
  const calc = useCalculate(dAmount, dDown, dPhone, !downTooBig);
  const data = downTooBig ? undefined : calc.data;
  const tiers = data?.tiers ?? [];
  const tier = tiers.find((r) => r.tier_id === tierId) ?? null;
  const text = useMemo(() => (data && tiers.length ? buildText(t, data, phone, tier) : ""), [data, tiers.length, phone, tier, t]);

  const pickPhone = (p: CalcPhone) => {
    setPhone(p);
    setAmountRaw(String(Math.round(Number(p.price))));
  };
  const onText = () => {
    if (phone) setPhone(null);
  };

  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("calculator.copied"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const nothing = !phone && !amountRaw;
  const tiersBlock = calc.isError && !downTooBig ? (
    <section className="card"><ErrorState error={calc.error} onRetry={() => calc.refetch()} /></section>
  ) : calc.isLoading && !downTooBig ? (
    <section className="card"><LoadingBlock rows={3} /></section>
  ) : downTooBig ? null : tiers.length === 0 ? (
    <section className="card">
      <EmptyState
        icon={<CalcIcon className="ic ic-l" />}
        title={t("calculator.empty_tiers")}
        action={!isOp ? <Link className="btn btn-sm" to="/catalog/tiers">{t("v2.personal.calc.openTiers")}</Link> : undefined}
      />
    </section>
  ) : null;

  const amountField = (
    <div className="field">
      <label>{isOp ? t("v2.personal.calc.price") : t("v2.personal.calc.amountMg")}</label>
      <NumericInput className="input num" value={amountRaw} onChange={setAmountRaw} placeholder={t("calculator.amount_ph")} />
    </div>
  );
  const downField = (
    <div className="field">
      <label>{isOp ? t("v2.personal.calc.first") : t("v2.personal.calc.downMg")}</label>
      <NumericInput className={cx("input num", downTooBig && "is-bad")} value={downRaw} onChange={setDownRaw} placeholder={t("calculator.down_payment_ph")} />
      {downTooBig ? <span className="err" role="alert">{t("v2.personal.calc.downTooBig")}</span> : null}
    </div>
  );

  if (isOp) {
    return (
      <>
        <PageHeader title={t("calculator.title")} meta={t("calculator.subtitle")} />
        <main className="page">
          <div className="split">
            <section className="panel card col" style={{ flex: "1 1 340px" }}>
              <div className="card-h"><span className="h3">{t("v2.personal.calc.calc")}</span></div>
              <div className="col g16" style={{ padding: "18px 20px 20px" }}>
                <div className="field">
                  <label htmlFor="c-model">{t("v2.personal.calc.phone")}</label>
                  <PhoneSearch t={t} id="c-model" selected={phone} onPick={pickPhone} onText={onText} />
                </div>
                {amountField}
                {downField}
                <div className="well row between">
                  <span className="s c3">{t("v2.personal.calc.financed")}</span>
                  <span className="num w6">{fmtNum(data?.ariza ?? 0)} {t("v2.personal.calc.sum")}</span>
                </div>
                {nothing ? <span className="hint">{t("calculator.pick_or_type")}</span> : null}
              </div>
            </section>

            <section className="list col g12">
              {tiersBlock}
              {tiers.length ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12 }}>
                    {tiers.map((r) => (
                      <button
                        key={r.tier_id}
                        type="button"
                        aria-pressed={tierId === r.tier_id}
                        className={cx("card col g6", tierId === r.tier_id && "pick-on")}
                        onClick={() => setTierId((c) => (c === r.tier_id ? null : r.tier_id))}
                        style={{ padding: 16, textAlign: "left" }}
                      >
                        <span className="row between" style={{ width: "100%" }}>
                          <span className="h3">{t("v2.personal.calc.monthsN", { n: r.months })}</span>
                          <span className="badge">{t("v2.personal.calc.pct", { pct: pct(r.commission_pct) })}</span>
                        </span>
                        <span className="kpi" style={{ fontSize: 22, lineHeight: "28px" }}>{fmtNum(r.sum_per_month)}</span>
                        <span className="xs c3">{t("v2.personal.calc.perMonthTotal", { total: fmtNum(r.total) })}</span>
                      </button>
                    ))}
                  </div>
                  {Number(data?.ariza ?? 0) > 0 ? <section className="card col">
                    <div className="card-h">
                      <span className="h3">{t("v2.personal.calc.clientText")}</span>
                      <button className="btn btn-pri btn-sm" type="button" onClick={copy} disabled={!text}>
                        <Copy className="ic" />{t("v2.personal.calc.copy")}
                      </button>
                    </div>
                    <p className="num s" style={{ padding: "16px 20px", whiteSpace: "pre-line", lineHeight: "22px" }}>{text}</p>
                    {!tier ? <p className="xs c3" style={{ padding: "0 20px 16px" }}>{t("v2.personal.calc.pickTier")}</p> : null}
                  </section> : null}
                </>
              ) : null}
            </section>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t("calculator.title")} meta={t("calculator.subtitle")}>
        <Link className="btn" to="/catalog/tiers">{t("v2.personal.calc.tiers")}</Link>
      </PageHeader>
      <main className="page">
        <section className="card col">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, padding: "18px 20px" }}>
            <div className="field" style={{ gridColumn: "span 1" }}>
              <label htmlFor="k1">{t("calculator.product_placeholder")}</label>
              <PhoneSearch t={t} id="k1" selected={phone} onPick={pickPhone} onText={onText} />
            </div>
            {amountField}
            {downField}
          </div>
          <div className="row g16 wrap" style={{ padding: "0 20px 18px", justifyContent: "flex-end" }}>
            <span className="s c3">
              {t("v2.personal.calc.ariza")}:{" "}
              <span className="num w6" style={{ fontSize: 16, color: "var(--ink)" }}>{fmtNum(data?.ariza ?? 0)} {t("v2.personal.calc.sum")}</span>
            </span>
            <button className="btn" type="button" onClick={copy} disabled={!text}>
              <Copy className="ic" />{t("calculator.copy_computation")}
            </button>
          </div>
        </section>

        {tiersBlock}
        {tiers.length ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
            {tiers.map((r) => {
              const on = tierId === r.tier_id;
              return (
                <button
                  key={r.tier_id}
                  type="button"
                  aria-pressed={on}
                  className={cx("card col g12", on && "pick-on")}
                  onClick={() => setTierId((c) => (c === r.tier_id ? null : r.tier_id))}
                  style={{ padding: "18px 20px", textAlign: "left" }}
                >
                  <span className="row between" style={{ width: "100%", alignItems: "flex-start" }}>
                    <span className="col">
                      <span className="lbl">{t("catalog.months")}</span>
                      <span className="display" style={{ fontSize: 28, lineHeight: "32px" }}>{r.months}</span>
                    </span>
                    <span aria-hidden="true" style={{ width: 20, height: 20, borderRadius: "50%", border: `2px solid ${on ? "var(--brand)" : "var(--line-2)"}`, background: on ? "var(--brand)" : "transparent" }} />
                  </span>
                  <span className="col">
                    <span className="lbl">{t("v2.personal.calc.perMonth")}</span>
                    <span className="num w7 c-brand" style={{ fontSize: 20 }}>{fmtNum(r.sum_per_month)} {t("v2.personal.calc.sum")}</span>
                  </span>
                  <span className="col g4" style={{ width: "100%" }}>
                    <span className="row between xs"><span className="c3">{t("v2.personal.calc.ariza")}</span><span className="num">{fmtNum(r.ariza_narxi)}</span></span>
                    <span className="row between xs"><span className="c3">{t("calculator.komissiya")} {pct(r.commission_pct)}%</span><span className="num">{fmtNum(r.komissiya_sum)}</span></span>
                    <span className="row between xs" style={{ borderTop: "1px solid var(--line)", paddingTop: 4 }}>
                      <span className="c3">{t("calculator.muttadli_total")}</span><span className="num w6">{fmtNum(r.total)}</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        {phone ? <BankMatrix t={t} phone={phone} /> : nothing ? (
          <section className="card">
            <EmptyState icon={<CalcIcon className="ic ic-l" />} title={t("calculator.pick_or_type")} />
          </section>
        ) : null}
      </main>
    </>
  );
}

/* ------------------------------ banks (old InstallmentPanel) ------------------------------ */

function BankMatrix({ t, phone }: { t: T; phone: CalcPhone }) {
  const [open, setOpen] = useState(true);
  const quote = usePhoneQuote(phone.id, open);
  const m = useMemo(() => {
    const rows = quote.data?.installments ?? [];
    const banks = Array.from(new Set(rows.map((r) => r.bank)));
    const terms = Array.from(new Set(rows.map((r) => r.term_months))).sort((a, b) => a - b);
    const by = new Map<string, Map<number, InstallmentRow>>();
    const icon = new Map<string, string>();
    for (const r of rows) {
      if (!by.has(r.bank)) by.set(r.bank, new Map());
      by.get(r.bank)!.set(r.term_months, r);
      icon.set(r.bank, r.bank_icon);
    }
    return { banks, terms, by, icon };
  }, [quote.data]);
  const cols = `minmax(160px, 1.2fr) repeat(${Math.max(1, m.terms.length)}, minmax(110px, 1fr))`;

  return (
    <section className="card col">
      <div className="card-h">
        <div className="col">
          <span className="h3">{t("v2.personal.calc.banks")}</span>
          <span className="xs c3">{t("v2.personal.calc.banksSub", { phone: phoneName(phone) })}</span>
        </div>
        <button className="btn btn-ghost btn-sm" type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronUp className="ic ic-s" /> : <ChevronDown className="ic ic-s" />}
          {t("catalog.installment")}
        </button>
      </div>
      {!open ? null : quote.isLoading ? (
        <LoadingBlock rows={3} />
      ) : quote.isError ? (
        <ErrorState title={t("catalog.installment_failed")} error={quote.error} onRetry={() => quote.refetch()} />
      ) : m.banks.length === 0 ? (
        <EmptyState title={t("catalog.installment_empty")} />
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 160 + m.terms.length * 120 }}>
            <div className="tr th" style={{ gridTemplateColumns: cols }}>
              <span>{t("catalog.installment_bank")}</span>
              {m.terms.map((term) => <span key={term} className="r">{term} {t("catalog.months")}</span>)}
            </div>
            {m.banks.map((bank) => (
              <div key={bank} className="tr" style={{ gridTemplateColumns: cols }}>
                <span className="row g8" style={{ minWidth: 0 }}>
                  <span className="icon-tile t-info" style={{ width: 26, height: 26, fontSize: 12, fontWeight: 700 }}>
                    {m.icon.get(bank) || bank.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="s w6 trunc">{bank}</span>
                </span>
                {m.terms.map((term) => {
                  const c = m.by.get(bank)?.get(term);
                  return c ? (
                    <span key={term} className="r col" style={{ alignItems: "flex-end" }} title={`${t("catalog.installment_overpay")}: +${fmtNum(c.overpay)}`}>
                      <span className="num s w6">{fmtNum(c.monthly)}</span>
                      <span className="xs c3">{t("catalog.per_month")}</span>
                    </span>
                  ) : (
                    <span key={term} className="r c3">—</span>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
